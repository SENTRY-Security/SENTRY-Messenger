// Share controller (Signal-style): QR carries inviteId + owner metadata + prekey bundle.
// Flow: generate invite -> scan -> sealed dropbox deliver -> owner consume (X3DH).

import { invitesCreate, invitesDeliver, invitesConsume, invitesConfirm, invitesStatus, invitesLookupCode } from '../../../api/invites.js';
import { prekeysPublish } from '../../../api/prekeys.js';
import { devkeysStore } from '../../../api/devkeys.js';
import { encodeFriendInvite, decodeFriendInvite } from '../../../lib/invite.js';
import { generateQR } from '../../../lib/qr.js';
import QrScanner from '../../../lib/vendor/qr-scanner.min.js';
import { log, logCapped } from '../../../core/log.js';
import { genX25519Keypair } from '../../../crypto/nacl.js';
import { b64 } from '../../../crypto/nacl.js';
import { x3dhInitiate, x3dhRespond } from '../../../crypto/dr.js';
import { sealInviteEnvelope, openInviteEnvelope } from '../../../crypto/invite-dropbox.js';
import {
  setDevicePriv,
  getMkRaw,
  getAccountDigest,
  getDeviceId,
  ensureDeviceId,
  clearDrState,
  drState,
  normalizePeerIdentity
} from '../../../core/store.js';
import { normalizeNickname, persistProfileForAccount, PROFILE_WRITE_SOURCE } from '../../../features/profile.js';
import { deriveConversationContextFromSecret } from '../../../features/conversation.js';
import { decryptContactPayload } from '../../../features/contact-share.js';
import { flushPendingContactShares, uplinkContactToD1 } from '../../../features/contacts.js';
import { triggerContactSecretsBackup } from '../../../features/contact-backup.js';
import { setContactSecret, getContactSecret, restoreContactSecrets } from '../../../core/contact-secrets.js';
import { sessionStore, restorePendingInvites, persistPendingInvites, upsertDeliveryIntent, markDeliveryIntentDelivered, removeDeliveryIntent } from '../session-store.js';
import { upsertContactCore, findContactCoreByAccountDigest, migrateContactCorePeerDevice, removeContactCore } from '../contact-core-store.js';
import { bootstrapDrFromGuestBundle, copyDrState, persistDrSnapshot, snapshotDrState, sendDrPlaintext } from '../../../features/dr-session.js';
import { ensureDevicePrivAvailable } from '../../../features/device-priv.js';
import { generateOpksFrom, wrapDevicePrivWithMK } from '../../../crypto/prekeys.js';
import { logMsgEvent, logUiNoise } from '../../../lib/logging.js';
import { appendUserMessage } from '../../../features/timeline-store.js';
import { updateSecureConversationStatus, SECURE_CONVERSATION_STATUS } from '../../../features/secure-conversation-manager.js';
import { resolveContactAvatarUrl } from '../contact-core-store.js';
import { DEBUG } from '../debug-flags.js';

const CONTACT_UPDATE_REASONS = new Set(['update', 'nickname', 'avatar', 'profile', 'manual']);
// 手動標記目前 QR/聯絡人分享流程的版本，用來追蹤是否為最新部署
const QR_BUILD_VERSION = 'qr-20260221-bin';
const INVITE_PROTOCOL_VERSION = 4;
const INVITE_QR_TYPE = 'invite_dropbox';
const INVITE_STATUS_POLL_MS = 12000;
const CONTACT_INIT_VERSION = 1;
const CONTACT_INIT_TYPE = 'contact-init';
const ACCOUNT_DIGEST_REGEX = /^[0-9A-F]{64}$/;
const contactCoreVerbose = DEBUG.contactCoreVerbose === true;
const queueNoiseEnabled = DEBUG.queueNoise === true;

/**
 * Check if a contact has a complete DR state (can communicate).
 */
function isContactComplete(peerAccountDigest, peerDeviceId) {
  if (!peerAccountDigest) return false;
  const holder = drState({ peerAccountDigest, peerDeviceId });
  return !!(holder?.rk instanceof Uint8Array);
}

/**
 * Cleanup incomplete contact state for a given account digest (without pending invites).
 * Used when retrying friend invite flow.
 */
function cleanupIncompleteContactCore(peerAccountDigest, { sourceTag = 'cleanup' } = {}) {
  if (!peerAccountDigest) return;
  const matches = findContactCoreByAccountDigest(peerAccountDigest);
  for (const match of matches) {
    const peerKey = match?.peerKey;
    const peerDeviceId = match?.entry?.peerDeviceId || (peerKey?.includes('::') ? peerKey.split('::')[1] : null);

    // Only cleanup if NOT complete
    if (!isContactComplete(peerAccountDigest, peerDeviceId)) {
      // Remove from contact-core
      if (peerKey) {
        removeContactCore(peerKey, `${sourceTag}:incomplete`);
      }
      // Clear DR state
      if (peerDeviceId) {
        clearDrState({ peerAccountDigest, peerDeviceId }, { __drDebugTag: `${sourceTag}:cleanup-dr` });
      }
      // Clear contact-secrets
      const selfDeviceId = ensureDeviceId();
      if (selfDeviceId) {
        setContactSecret(peerAccountDigest, { deviceId: selfDeviceId, peerDeviceId, dr: null, meta: { source: sourceTag } });
      }
      logCapped('cleanupIncompleteContact', {
        peerAccountDigestSuffix4: peerAccountDigest?.slice?.(-4) || null,
        peerDeviceIdSuffix4: peerDeviceId?.slice?.(-4) || null,
        sourceTag
      }, 5);
    }
  }
}

export function setupShareController(options) {
  const {
    dom,
    shareState,
    getProfileState,
    profileInitPromise,
    ensureAvatarThumbnail,
    addContactEntry,
    switchTab,
    updateProfileStats,
    getCurrentTab,
    showToast: showToastOption,
    wsSend
  } = options;

  if (!dom) throw new Error('分享控制器缺少必要的 DOM 參照');

  const notifyToast = typeof showToastOption === 'function' ? showToastOption : null;
  let wsTransport = typeof wsSend === 'function' ? wsSend : null;
  const CONTACT_BROADCAST_DEBOUNCE_MS = 600;
  const pendingContactUpdates = new Map();
  const PROFILE_PREFLIGHT_TRACE_CAP = 5;
  let profilePreflightTraceCount = 0;

  const LOG_CAP = 5;
  const safeSuffix = (value, len) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(-len);
  };
  const safePrefix = (value, len) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, len);
  };

  function shouldTraceProfilePreflight(reasonKey) {
    return reasonKey === 'nickname' || reasonKey === 'avatar';
  }

  function logProfilePreflightTrace(payload) {
    if (profilePreflightTraceCount >= PROFILE_PREFLIGHT_TRACE_CAP) return;
    profilePreflightTraceCount += 1;
    log({ profilePreflightTrace: payload });
  }

  const pendingInviteTimers = new Map();
  const pendingInviteConsumes = new Map();

  function ensurePendingInviteStore() {
    const store = restorePendingInvites();
    return store instanceof Map ? store : new Map();
  }

  function ensureConversationIndex() {
    if (!(sessionStore.conversationIndex instanceof Map)) {
      const entries = sessionStore.conversationIndex && typeof sessionStore.conversationIndex.entries === 'function'
        ? Array.from(sessionStore.conversationIndex.entries())
        : [];
      sessionStore.conversationIndex = new Map(entries);
    }
    return sessionStore.conversationIndex;
  }

  function notifyPendingInvitesChanged() {
    try {
      document.dispatchEvent(new CustomEvent('contacts:pending-invites-updated'));
    } catch { }
  }

  function schedulePendingInviteExpiry(entry) {
    if (!entry?.inviteId || !entry?.expiresAt) return;
    const inviteId = String(entry.inviteId).trim();
    if (!inviteId) return;
    const expiresAt = Number(entry.expiresAt);
    if (!Number.isFinite(expiresAt)) return;
    const existingTimer = pendingInviteTimers.get(inviteId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      pendingInviteTimers.delete(inviteId);
    }
    const delayMs = Math.max(0, expiresAt * 1000 - Date.now());
    if (delayMs === 0) {
      markPendingInviteExpired(inviteId);
      return;
    }
    const timer = setTimeout(() => {
      pendingInviteTimers.delete(inviteId);
      markPendingInviteExpired(inviteId);
    }, delayMs);
    pendingInviteTimers.set(inviteId, timer);
  }

  function markPendingInviteExpired(inviteId) {
    const store = ensurePendingInviteStore();
    const id = String(inviteId || '').trim();
    if (!id) return;
    if (!store.has(id)) return;
    notifyPendingInvitesChanged();
  }

  function upsertPendingInvite(entry) {
    const store = ensurePendingInviteStore();
    const id = typeof entry?.inviteId === 'string' ? entry.inviteId.trim() : '';
    if (!id) return null;
    const expiresAt = Number(entry?.expiresAt || 0);
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;
    const identity = normalizePeerIdentity({
      peerAccountDigest: entry?.ownerAccountDigest || null,
      peerDeviceId: entry?.ownerDeviceId || null
    });
    const ownerAccountDigest = identity.accountDigest || null;
    const ownerDeviceId = identity.deviceId || null;
    const conversationId = typeof entry?.conversationId === 'string' ? entry.conversationId.trim() : '';
    const conversationToken = typeof entry?.conversationToken === 'string' ? entry.conversationToken.trim() : '';
    const next = {
      inviteId: id,
      expiresAt,
      ...(ownerAccountDigest ? { ownerAccountDigest } : null),
      ...(ownerDeviceId ? { ownerDeviceId } : null),
      ...(conversationId ? { conversationId } : null),
      ...(conversationToken ? { conversationToken } : null)
    };
    store.set(id, next);
    persistPendingInvites();
    schedulePendingInviteExpiry(next);
    notifyPendingInvitesChanged();
    logCapped('pendingInviteUpserted', { inviteId: id, expiresAt, state: 'pending' }, LOG_CAP);
    return next;
  }

  function findPendingInviteByPeer({ peerAccountDigest, peerDeviceId } = {}) {
    const identity = normalizePeerIdentity({ peerAccountDigest, peerDeviceId });
    const digest = identity.accountDigest || null;
    const deviceId = identity.deviceId || null;
    if (!digest || !deviceId) return null;
    const store = ensurePendingInviteStore();
    for (const entry of store.values()) {
      if (entry?.ownerAccountDigest === digest && entry?.ownerDeviceId === deviceId) {
        return entry;
      }
    }
    return null;
  }

  function findPendingInviteByDigest(peerAccountDigest) {
    const identity = normalizePeerIdentity({ peerAccountDigest });
    const digest = identity.accountDigest || null;
    if (!digest) return null;
    const store = ensurePendingInviteStore();
    let match = null;
    for (const entry of store.values()) {
      if (entry?.ownerAccountDigest !== digest) continue;
      if (!match || Number(entry?.expiresAt || 0) > Number(match?.expiresAt || 0)) {
        match = entry;
      }
    }
    return match;
  }

  function removePendingInviteByPeer({ peerAccountDigest, peerDeviceId } = {}) {
    const identity = normalizePeerIdentity({ peerAccountDigest, peerDeviceId });
    const digest = identity.accountDigest || null;
    const deviceId = identity.deviceId || null;
    if (!digest || !deviceId) return 0;
    const store = ensurePendingInviteStore();
    const ids = [];
    for (const [inviteId, entry] of store.entries()) {
      if (entry?.ownerAccountDigest === digest && entry?.ownerDeviceId === deviceId) {
        ids.push(inviteId);
      }
    }
    if (!ids.length) return 0;
    for (const inviteId of ids) {
      store.delete(inviteId);
      const timer = pendingInviteTimers.get(inviteId);
      if (timer) {
        clearTimeout(timer);
        pendingInviteTimers.delete(inviteId);
      }
    }
    persistPendingInvites();
    notifyPendingInvitesChanged();
    return ids.length;
  }

  function removePendingInvite(inviteId) {
    const store = ensurePendingInviteStore();
    const id = typeof inviteId === 'string' ? inviteId.trim() : '';
    if (!id) return;
    store.delete(id);
    const timer = pendingInviteTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      pendingInviteTimers.delete(id);
    }
    persistPendingInvites();
    notifyPendingInvitesChanged();
  }

  const {
    inviteBtn,
    inviteCountdownEl,
    inviteQrBox,
    inviteRefreshBtn,
    inviteRetryBtn,
    inviteConsumeBtn,
    btnShareModal,
    shareModal,
    shareModalBackdrop,
    btnShareSwitchScan,
    btnShareSwitchQr,
    shareFlip,
    inviteScanVideo,
    inviteScanStatus,
    // Pairing code elements
    addFriendMenu,
    btnAddFriendQr,
    btnAddFriendCode,
    pairingCodeModal,
    pairingDigits,
    pairingCountdownEl,
    pairingRefreshBtn,
    pairingStatusEl,
    btnPairingToggle,
    btnPairingConfirm
  } = dom;

  shareState.mode = shareState.mode || 'qr';
  shareState.open = shareState.open || false;
  shareState.currentInvite = null;
  const qrErrorSilenceMs = 2000;

  // ─── Pairing Code State ───
  let pairingState = {
    open: false,
    inputMode: false, // false = show my code, true = enter peer code
    currentInvite: null,
    pairingCode: null,
    timerId: null,
    confirming: false
  };

  if (shareModal) shareModal.setAttribute('data-share-mode', shareState.mode);

  const shareModalCloseButtons = shareModal
    ? Array.from(shareModal.querySelectorAll('[data-share-close-btn]'))
    : [];
  const shareBackdrop = shareModalBackdrop || (shareModal ? shareModal.querySelector('.modal-backdrop') : null);
  const pairingCloseButtons = pairingCodeModal
    ? Array.from(pairingCodeModal.querySelectorAll('[data-pairing-close-btn]'))
    : [];
  const pairingBackdrop = pairingCodeModal ? pairingCodeModal.querySelector('[data-pairing-close]') : null;
  const pairingInputs = pairingDigits ? Array.from(pairingDigits.querySelectorAll('input')) : [];

  // ─── Add Friend Menu ───
  function toggleAddFriendMenu() {
    if (!addFriendMenu) return;
    const visible = addFriendMenu.style.display !== 'none';
    addFriendMenu.style.display = visible ? 'none' : 'flex';
  }
  function hideAddFriendMenu() {
    if (addFriendMenu) addFriendMenu.style.display = 'none';
  }

  if (btnShareModal && addFriendMenu) {
    btnShareModal.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAddFriendMenu();
    });
    document.addEventListener('click', (e) => {
      if (addFriendMenu.style.display === 'none') return;
      if (!addFriendMenu.contains(e.target) && !btnShareModal.contains(e.target)) {
        hideAddFriendMenu();
      }
    });
    btnAddFriendQr?.addEventListener('click', () => {
      hideAddFriendMenu();
      openShareModal('qr');
    });
    btnAddFriendCode?.addEventListener('click', () => {
      hideAddFriendMenu();
      openPairingCodeModal();
    });
  } else if (btnShareModal) {
    // Fallback: no menu elements, keep original behavior
    btnShareModal.addEventListener('click', () => openShareModal('qr'));
  }

  shareBackdrop?.addEventListener('click', closeShareModal);
  btnShareSwitchQr?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); showShareMode('qr'); });
  btnShareSwitchScan?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); showShareMode('scan'); });
  shareModalCloseButtons.forEach((btn) => btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); closeShareModal(); }));
  document.addEventListener('keydown', handleEscapeKey);
  ensureQrPlaceholder();
  setInviteActionState({ hasInvite: false, expired: false, loading: false });
  shareState.inviteStatusNextPollAt = 0;
  shareState.inviteStatusPollInFlight = false;
  const pendingInviteStore = ensurePendingInviteStore();
  if (pendingInviteStore instanceof Map) {
    for (const entry of pendingInviteStore.values()) {
      schedulePendingInviteExpiry(entry);
    }
  }

  inviteRefreshBtn?.addEventListener('click', () => {
    if (inviteRefreshBtn.disabled) return;
    inviteRefreshBtn.disabled = true;
    onGenerateInvite().finally(() => {
      inviteRefreshBtn.disabled = false;
    });
  });
  // inviteRetryBtn event listener removed - button no longer exists
  // inviteConsumeBtn event listener removed - WS auto-consume is sufficient

  // ─── Pairing Code Modal Logic ───

  function setPairingStatus(text, { isError = false, isSuccess = false } = {}) {
    if (!pairingStatusEl) return;
    pairingStatusEl.textContent = text || '';
    pairingStatusEl.classList.toggle('is-error', isError);
    pairingStatusEl.classList.toggle('is-success', isSuccess);
  }

  function renderPairingDigits(code) {
    if (!pairingInputs.length) return;
    const digits = String(code || '').split('');
    for (let i = 0; i < pairingInputs.length; i++) {
      pairingInputs[i].value = digits[i] || '';
      pairingInputs[i].readOnly = true;
    }
    pairingDigits?.classList.remove('is-input-mode');
  }

  function clearPairingDigits() {
    for (const inp of pairingInputs) {
      inp.value = '';
      inp.readOnly = false;
    }
    pairingDigits?.classList.add('is-input-mode');
    if (pairingInputs[0]) pairingInputs[0].focus();
  }

  function getPairingInput() {
    return pairingInputs.map(inp => inp.value).join('');
  }

  // Auto-advance PIN inputs
  for (let i = 0; i < pairingInputs.length; i++) {
    const inp = pairingInputs[i];
    inp.addEventListener('input', () => {
      if (inp.readOnly) return;
      // Keep only last digit
      inp.value = inp.value.replace(/\D/g, '').slice(-1);
      if (inp.value && i < pairingInputs.length - 1) {
        pairingInputs[i + 1].focus();
      }
    });
    inp.addEventListener('keydown', (e) => {
      if (inp.readOnly) return;
      if (e.key === 'Backspace' && !inp.value && i > 0) {
        pairingInputs[i - 1].focus();
        pairingInputs[i - 1].value = '';
        e.preventDefault();
      }
      if (e.key === 'Enter') {
        const code = getPairingInput();
        if (code.length === 6) onPairingConfirm();
      }
    });
    // Handle paste
    inp.addEventListener('paste', (e) => {
      if (inp.readOnly) return;
      e.preventDefault();
      const pasted = (e.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, 6);
      for (let j = 0; j < pairingInputs.length; j++) {
        pairingInputs[j].value = pasted[j] || '';
      }
      const focusIdx = Math.min(pasted.length, pairingInputs.length - 1);
      pairingInputs[focusIdx].focus();
    });
  }

  function formatCountdownPairing(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function startPairingCountdown() {
    clearPairingCountdown();
    updatePairingCountdown();
    pairingState.timerId = setInterval(updatePairingCountdown, 1000);
  }

  function clearPairingCountdown() {
    if (pairingState.timerId) {
      clearInterval(pairingState.timerId);
      pairingState.timerId = null;
    }
  }

  function updatePairingCountdown() {
    const invite = pairingState.currentInvite;
    if (!invite || !Number.isFinite(invite.expiresAt)) return;
    const now = Date.now();
    const remaining = Math.max(0, Math.ceil(invite.expiresAt - now / 1000));
    if (remaining <= 0) {
      // Auto-refresh on expiry
      clearPairingCountdown();
      setPairingStatus('配對碼已過期，正在刷新…');
      refreshPairingCode();
      return;
    }
    if (pairingCountdownEl) {
      pairingCountdownEl.textContent = formatCountdownPairing(remaining);
      pairingCountdownEl.classList.remove('is-error', 'is-loading');
    }
  }

  async function generatePairingCode() {
    const ownerAccountDigest = currentOwnerDigest();
    const ownerDeviceId = ensureDeviceId();
    if (!ownerAccountDigest || !ownerDeviceId) {
      setPairingStatus('尚未登入，無法產生配對碼。', { isError: true });
      return;
    }
    setPairingStatus('正在產生配對碼…');
    if (pairingCountdownEl) {
      pairingCountdownEl.textContent = '';
      pairingCountdownEl.classList.add('is-loading');
    }
    try {
      await ensureOwnerPrekeys({ force: false, reason: 'pairing-code' });
      const invite = await invitesCreate({ wantPairingCode: true });
      if (!invite?.invite_id || !invite?.pairing_code || !invite?.expires_at) {
        throw new Error('伺服器回傳內容不完整');
      }
      pairingState.currentInvite = {
        inviteId: String(invite.invite_id),
        expiresAt: Number(invite.expires_at),
        ownerAccountDigest: invite.owner_account_digest || ownerAccountDigest,
        ownerDeviceId: invite.owner_device_id || ownerDeviceId,
        ownerPublicKeyB64: String(invite.owner_public_key_b64 || ''),
        v: INVITE_PROTOCOL_VERSION,
        msgType: INVITE_QR_TYPE,
        prekeyBundle: invite.prekey_bundle || null
      };
      pairingState.pairingCode = invite.pairing_code;
      renderPairingDigits(invite.pairing_code);
      startPairingCountdown();
      setPairingStatus('');
      console.log('[share-controller] pairing code generated', { pairingCode: invite.pairing_code, inviteId: invite.invite_id });
    } catch (err) {
      setPairingStatus(err?.message || '配對碼產生失敗', { isError: true });
      console.error('[share-controller] pairing code generation failed', err);
    }
  }

  function refreshPairingCode() {
    pairingState.currentInvite = null;
    pairingState.pairingCode = null;
    // Stay in show-my-code mode on refresh
    if (pairingState.inputMode) {
      togglePairingMode();
    }
    generatePairingCode();
  }

  function togglePairingMode() {
    pairingState.inputMode = !pairingState.inputMode;
    if (pairingState.inputMode) {
      // Switch to input mode
      clearPairingDigits();
      if (btnPairingToggle) btnPairingToggle.textContent = '顯示我的配對碼';
      if (btnPairingConfirm) btnPairingConfirm.style.display = '';
      setPairingStatus('');
    } else {
      // Switch back to show mode
      renderPairingDigits(pairingState.pairingCode || '');
      if (btnPairingToggle) btnPairingToggle.textContent = '輸入對方配對碼';
      if (btnPairingConfirm) btnPairingConfirm.style.display = 'none';
      setPairingStatus('');
    }
  }

  async function onPairingConfirm() {
    if (pairingState.confirming) return;
    const code = getPairingInput();
    if (!/^\d{6}$/.test(code)) {
      setPairingStatus('請輸入完整的 6 位配對碼', { isError: true });
      return;
    }
    pairingState.confirming = true;
    if (btnPairingConfirm) btnPairingConfirm.disabled = true;
    setPairingStatus('正在查詢配對碼…');
    try {
      const data = await invitesLookupCode({ pairingCode: code });
      if (!data?.invite_id || !data?.owner_public_key_b64 || !data?.prekey_bundle) {
        throw new Error('配對碼資料不完整');
      }
      setPairingStatus('配對成功，正在建立連線…', { isSuccess: true });
      // Construct the same invite object that handleInviteScan expects
      const inviteData = {
        v: INVITE_PROTOCOL_VERSION,
        type: INVITE_QR_TYPE,
        inviteId: data.invite_id,
        ownerAccountDigest: data.owner_account_digest,
        ownerDeviceId: data.owner_device_id,
        ownerPublicKeyB64: data.owner_public_key_b64,
        expiresAt: data.expires_at,
        prekeyBundle: data.prekey_bundle
      };
      // Encode as base64url so handleInviteScan can decode it
      const encoded = encodeFriendInvite(inviteData);
      closePairingCodeModal();
      await handleInviteScan(encoded);
    } catch (err) {
      const msg = err?.data?.message || err?.message || '配對碼查詢失敗';
      const isRateLimited = err?.status === 429;
      setPairingStatus(isRateLimited ? '嘗試次數過多，請稍後再試' : msg, { isError: true });
      console.error('[share-controller] pairing code lookup failed', err);
    } finally {
      pairingState.confirming = false;
      if (btnPairingConfirm) btnPairingConfirm.disabled = false;
    }
  }

  function openPairingCodeModal() {
    if (!pairingCodeModal) return;
    pairingState.open = true;
    pairingState.inputMode = false;
    pairingCodeModal.style.display = 'flex';
    pairingCodeModal.setAttribute('aria-hidden', 'false');
    lockBodyScroll();
    if (btnPairingToggle) btnPairingToggle.textContent = '輸入對方配對碼';
    if (btnPairingConfirm) btnPairingConfirm.style.display = 'none';
    setPairingStatus('');
    generatePairingCode();
  }

  function closePairingCodeModal() {
    if (!pairingCodeModal) return;
    pairingState.open = false;
    pairingCodeModal.style.display = 'none';
    pairingCodeModal.setAttribute('aria-hidden', 'true');
    clearPairingCountdown();
    unlockBodyScroll();
  }

  // Pairing code event listeners
  pairingBackdrop?.addEventListener('click', closePairingCodeModal);
  pairingCloseButtons.forEach(btn => btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); closePairingCodeModal(); }));
  btnPairingToggle?.addEventListener('click', togglePairingMode);
  btnPairingConfirm?.addEventListener('click', onPairingConfirm);
  pairingRefreshBtn?.addEventListener('click', () => {
    if (pairingRefreshBtn.disabled) return;
    pairingRefreshBtn.disabled = true;
    generatePairingCode().finally(() => {
      pairingRefreshBtn.disabled = false;
    });
  });

  function lockBodyScroll() {
    document.body.classList.add('modal-open');
  }
  function unlockBodyScroll() {
    document.body.classList.remove('modal-open');
  }

  function currentOwnerDigest() {
    const digest = getAccountDigest();
    return digest ? String(digest).toUpperCase() : null;
  }

  function normalizePeerKey(value, { peerDeviceId } = {}) {
    const identity = normalizePeerIdentity({
      peerAccountDigest: value?.peerAccountDigest ?? value,
      peerDeviceId
    });
    if (!identity.key || !identity.deviceId) return null;
    return identity.key;
  }

  function hasLiveDrState(peerDigest) {
    const identity = normalizePeerIdentity(peerDigest);
    const digest = identity.accountDigest || normalizePeerKey(peerDigest);
    const peerDeviceId = identity.deviceId || null;
    if (!digest || !peerDeviceId) return false;
    const holder = sessionStore.drStates?.get?.(`${digest}::${peerDeviceId}`) || null;
    return !!(
      holder?.rk &&
      holder?.myRatchetPriv instanceof Uint8Array &&
      holder?.myRatchetPub instanceof Uint8Array &&
      ((holder?.ckR instanceof Uint8Array && holder.ckR.length > 0) ||
        (holder?.ckS instanceof Uint8Array && holder.ckS.length > 0))
    );
  }

  function storeContactSecretMapping({ peerAccountDigest, peerDeviceId, sessionKey, conversation, drState, role }) {
    const hasPersistableSnapshot = (snapshot) => {
      if (!snapshot || typeof snapshot !== 'object') return false;
      // [FIX] theirRatchetPub_b64 is NULL for fresh Initiator (x3dh-initiate)
      const required = ['rk_b64', 'myRatchetPriv_b64', 'myRatchetPub_b64'];
      for (const key of required) {
        const value = snapshot[key];
        if (typeof value !== 'string' || !value.trim()) return false;
      }
      return true;
    };
    const peerDeviceResolved = peerDeviceId ? peerDeviceId : null;
    const key = normalizePeerKey(peerAccountDigest, { peerDeviceId: peerDeviceResolved });
    const selfDeviceId = ensureDeviceId();
    if (!key || !sessionKey || !peerDeviceResolved || !selfDeviceId) {
      console.warn('[share-controller]', {
        contactSecretStoreSkipped: true,
        reason: 'missing-key-or-device',
        peerAccountDigest,
        peerDeviceId: peerDeviceResolved,
        selfDeviceId,
        hasConversation: !!conversation?.conversation_id && !!conversation?.token_b64
      });
      throw new Error('contact secret requires peer device id, self device id, and session key');
    }
    const existing = getContactSecret(key, { deviceId: selfDeviceId }) || {};
    const conversationPeerDeviceId = conversation?.peerDeviceId || existing?.peerDeviceId || null;
    try {
      console.log('[share-controller]', {
        contactSecretStoreStart: {
          key,
          peerAccountDigest,
          peerDeviceId: peerDeviceResolved,
          selfDeviceId,
          hasExisting: !!existing?.conversationToken,
          hasConversation: !!conversation?.conversation_id && !!conversation?.token_b64
        }
      });
    } catch { }
    const convIdCandidate = conversation?.conversation_id || conversation?.conversationId || null;
    const convIsContacts = typeof convIdCandidate === 'string' && convIdCandidate.startsWith('contacts-');
    const existingConvId = existing?.conversationId || null;
    const existingIsContacts = typeof existingConvId === 'string' && existingConvId.startsWith('contacts-');
    const finalConvId = (() => {
      if (convIsContacts && existingConvId && !existingIsContacts) return existingConvId;
      if (convIsContacts && !existingConvId) return null; // 不保存 contacts-* 假 ID
      return convIdCandidate || existingConvId || null;
    })();
    if (!finalConvId && convIsContacts) {
      console.warn('[contact-secret]', { dropContactsConvId: true, peerAccountDigest, peerDeviceId: peerDeviceResolved });
    }
    const incomingRole = role ? String(role).toLowerCase() : null;
    const existingRole = existing?.role || null;
    let chosenRole = incomingRole || existingRole || null;
    const hasConflict = existingRole && incomingRole && incomingRole !== existingRole;
    if (hasConflict) {
      console.warn('[share-controller]', {
        contactSecretRoleConflict: true,
        peerAccountDigest,
        peerDeviceId: peerDeviceResolved,
        existingRole,
        incomingRole
      });
      chosenRole = existingRole;
      try {
        console.log('[share-controller]', {
          contactSecretRoleConflictResolved: {
            peerKey: key,
            existingRole,
            incomingRole,
            chosenRole,
            hasConversationId: !!finalConvId,
            hasToken: !!(conversation?.token_b64 || sessionKey || existing?.conversationToken)
          }
        });
      } catch { }
    }
    if (!chosenRole) {
      console.warn('[share-controller]', {
        contactSecretRoleMissing: true,
        peerAccountDigest,
        peerDeviceId: peerDeviceResolved,
        existingRole,
        incomingRole,
        derivedRole: chosenRole
      });
      return;
    }
    const update = {
      conversation: {
        token: conversation?.token_b64 || sessionKey || existing.conversationToken || null,
        id: finalConvId,
        drInit: conversation?.dr_init || existing.conversationDrInit || null,
        peerDeviceId: conversationPeerDeviceId || null
      },
      meta: { source: 'share-controller:storeContactSecret' }
    };
    if (chosenRole) update.role = chosenRole;
    if (drState) {
      const snapshot = snapshotDrState(drState);
      if (hasPersistableSnapshot(snapshot)) {
        update.dr = { state: snapshot };
      }
    }
    setContactSecret(key, { ...update, deviceId: selfDeviceId });
    const flushTask = flushPendingContactShares({ mk: getMkRaw() });
    if (flushTask && typeof flushTask.catch === 'function') {
      flushTask.catch(() => { });
    }
    try {
      console.log('[share-controller]', {
        contactSecretStored: {
          key,
          peerAccountDigest,
          peerDeviceId: peerDeviceResolved,
          selfDeviceId,
          conversationId: finalConvId,
          hasDr: !!update.dr
        }
      });
    } catch { }
  }

  async function ensureOwnerPrekeys({ force = false, reason = 'invite' } = {}) {
    const devicePriv = await ensureDevicePrivLoaded();
    if (!devicePriv) throw new Error('找不到裝置金鑰，請重新登入完成初始化');
    const mk = getMkRaw();
    if (!mk) throw new Error('尚未解鎖主金鑰，請重新登入完成初始化');
    const opkCount = devicePriv.opk_priv_map && typeof devicePriv.opk_priv_map === 'object'
      ? Object.keys(devicePriv.opk_priv_map).length
      : 0;
    if (!force && opkCount >= 20) {
      return true;
    }
    const startId = Number(devicePriv.next_opk_id || 1);
    const { opks, opkPrivMap, next } = await generateOpksFrom(startId, 24);
    if (!opks.length) {
      throw new Error('交友金鑰生成失敗');
    }
    const deviceId = ensureDeviceId();
    if (!deviceId) throw new Error('找不到裝置 ID，請重新登入完成初始化');
    const signedPrekey = {
      id: devicePriv.spk_id || devicePriv.spkId || 1,
      pub: devicePriv.spk_pub_b64,
      sig: devicePriv.spk_sig_b64,
      ik_pub: devicePriv.ik_pub_b64
    };
    const payload = {
      deviceId,
      signedPrekey,
      opks
    };
    const { r, data } = await prekeysPublish(payload);
    if (!r.ok) {
      const detail = typeof data === 'string'
        ? data
        : (data?.details || data?.message || data?.error || '');
      const err = new Error(detail || 'prekey publish failed');
      err.status = r.status;
      err.payload = data;
      throw err;
    }
    devicePriv.next_opk_id = next;
    if (!devicePriv.opk_priv_map) devicePriv.opk_priv_map = {};
    Object.assign(devicePriv.opk_priv_map, opkPrivMap || {});
    setDevicePriv(devicePriv);
    const wrapped = await wrapDevicePrivWithMK(devicePriv, mk);
    await devkeysStore({ wrapped_dev: wrapped });
    return true;
  }

  function ensureQrPlaceholder() {
    if (!inviteQrBox) return;
    if (!inviteQrBox.querySelector('.qr-placeholder')) {
      const div = document.createElement('div');
      div.className = 'qr-placeholder';
      div.textContent = '伺服端無法解密，掃描 QR 即可安全交換';
      inviteQrBox.appendChild(div);
    }
  }

  function removeQrPlaceholder() {
    if (!inviteQrBox) return;
    const placeholder = inviteQrBox.querySelector('.qr-placeholder');
    if (placeholder) placeholder.remove();
  }

  function setInviteStatus(message, opts = {}) {
    const {
      isError = false,
      loading = false
    } = opts || {};
    if (!inviteCountdownEl) return;
    inviteCountdownEl.textContent = message || '伺服端無法解密，僅雙方裝置可還原內容。';
    inviteCountdownEl.classList.toggle('is-error', !!isError && !!message);
    inviteCountdownEl.classList.toggle('is-loading', !!loading && !!message);
  }

  function formatInviteConsumeError(err) {
    const status = Number(err?.status || err?.response?.status || 0);
    const code = err?.code || err?.data?.error || err?.data?.code || null;
    if (status === 404 || code === 'NotFound') return '沒有可取回的邀請。';
    if (status === 409 || code === 'AlreadyConsumed') return '邀請已取回。';
    if (status === 410 || code === 'Expired') return '邀請已過期，無法取回。';
    if (status === 401 || status === 403) return '需要登入才能取回邀請。';
    if (code === 'InviteEnvelopeInvalid') return '邀請密文格式不符，請請好友重新生成。';
    if (code === 'InvitePayloadInvalid' || code === 'InvitePayloadUnexpectedField') return '邀請內容格式不符，請請好友重新生成。';
    if (code === 'InvitePayloadVersionMismatch' || code === 'InvitePayloadTypeMismatch') return '邀請版本不符，請請好友重新生成。';
    if (code === 'InvitePayloadBundleInvalid') return '邀請內容缺少必要金鑰資訊。';
    return err?.message || '取回邀請失敗。';
  }

  function invitePayloadError(code, message, details) {
    const err = new Error(message);
    err.code = code;
    if (details) err.details = details;
    return err;
  }

  function assertNoAliasKeys(obj, aliasKeys, code) {
    for (const key of Object.keys(obj)) {
      if (aliasKeys.has(key)) {
        throw invitePayloadError(code, `alias field not allowed: ${key}`, { field: key });
      }
    }
  }

  function assertNoExtraKeys(obj, allowedKeys, code) {
    for (const key of Object.keys(obj)) {
      if (!allowedKeys.has(key)) {
        throw invitePayloadError(code, `unexpected field: ${key}`, { field: key });
      }
    }
  }

  function requireStringField(value, field, code) {
    if (typeof value !== 'string') {
      throw invitePayloadError(code, `${field} required`);
    }
    const trimmed = value.trim();
    if (!trimmed) {
      throw invitePayloadError(code, `${field} required`);
    }
    return trimmed;
  }

  function requireAccountDigest(value, field, code) {
    const raw = requireStringField(value, field, code);
    const cleaned = raw.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    if (!ACCOUNT_DIGEST_REGEX.test(cleaned)) {
      throw invitePayloadError(code, `${field} invalid`);
    }
    return cleaned;
  }

  function normalizeGuestBundleStrict(bundle) {
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
      throw invitePayloadError('InvitePayloadBundleInvalid', 'guestBundle required');
    }
    const aliasKeys = new Set(['ikPubB64', 'spkPubB64', 'spkSigB64', 'signatureB64', 'opkId', 'opkPubB64', 'ekPubB64']);
    assertNoAliasKeys(bundle, aliasKeys, 'InvitePayloadUnexpectedField');
    const allowed = new Set(['ik_pub', 'spk_pub', 'spk_sig', 'opk_id', 'opk_pub', 'ek_pub']);
    assertNoExtraKeys(bundle, allowed, 'InvitePayloadUnexpectedField');
    const ik_pub = requireStringField(bundle.ik_pub, 'guestBundle.ik_pub', 'InvitePayloadBundleInvalid');
    const spk_pub = requireStringField(bundle.spk_pub, 'guestBundle.spk_pub', 'InvitePayloadBundleInvalid');
    const ek_pub = requireStringField(bundle.ek_pub, 'guestBundle.ek_pub', 'InvitePayloadBundleInvalid');
    const spk_sig = requireStringField(bundle.spk_sig, 'guestBundle.spk_sig', 'InvitePayloadBundleInvalid');
    const opkIdRaw = bundle.opk_id;
    if (opkIdRaw === null || opkIdRaw === undefined || opkIdRaw === '') {
      throw invitePayloadError('InvitePayloadBundleInvalid', 'guestBundle.opk_id required');
    }
    const opkId = Number(opkIdRaw);
    if (!Number.isFinite(opkId) || opkId < 0) {
      throw invitePayloadError('InvitePayloadBundleInvalid', 'guestBundle.opk_id invalid');
    }
    const opk_pub = requireStringField(bundle.opk_pub, 'guestBundle.opk_pub', 'InvitePayloadBundleInvalid');
    return {
      ik_pub,
      spk_pub,
      spk_sig,
      opk_id: opkId,
      opk_pub,
      ek_pub
    };
  }

  function normalizeGuestBundleForInit(bundle) {
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
      throw invitePayloadError('InvitePayloadBundleInvalid', 'guestBundle required');
    }
    const aliasKeys = new Set(['ik_pub', 'spk_pub', 'spk_sig', 'opk_id', 'opk_pub', 'ek_pub', 'spkSigB64']);
    assertNoAliasKeys(bundle, aliasKeys, 'InvitePayloadUnexpectedField');
    const allowed = new Set(['ikPubB64', 'spkPubB64', 'signatureB64', 'opkId', 'opkPubB64', 'ekPubB64']);
    assertNoExtraKeys(bundle, allowed, 'InvitePayloadUnexpectedField');
    const ik_pub = requireStringField(bundle.ikPubB64, 'guestBundle.ikPubB64', 'InvitePayloadBundleInvalid');
    const spk_pub = requireStringField(bundle.spkPubB64, 'guestBundle.spkPubB64', 'InvitePayloadBundleInvalid');
    const ek_pub = requireStringField(bundle.ekPubB64, 'guestBundle.ekPubB64', 'InvitePayloadBundleInvalid');
    const spk_sig = requireStringField(bundle.signatureB64, 'guestBundle.signatureB64', 'InvitePayloadBundleInvalid');
    const opkIdRaw = bundle.opkId;
    if (opkIdRaw === null || opkIdRaw === undefined || opkIdRaw === '') {
      throw invitePayloadError('InvitePayloadBundleInvalid', 'guestBundle.opkId required');
    }
    const opkId = Number(opkIdRaw);
    if (!Number.isFinite(opkId) || opkId < 0) {
      throw invitePayloadError('InvitePayloadBundleInvalid', 'guestBundle.opkId invalid');
    }
    const opk_pub = requireStringField(bundle.opkPubB64, 'guestBundle.opkPubB64', 'InvitePayloadBundleInvalid');
    return {
      ik_pub,
      spk_pub,
      spk_sig,
      opk_id: opkId,
      opk_pub,
      ek_pub
    };
  }

  function toDrGuestBundle(bundle) {
    if (!bundle) return null;
    return { ...bundle };
  }

  function normalizeGuestProfileSnapshot(profile) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throw invitePayloadError('InvitePayloadProfileInvalid', 'guestProfile required');
    }
    const aliasKeys = new Set(['updated_at', 'added_at', 'display_name', 'nick']);
    assertNoAliasKeys(profile, aliasKeys, 'InvitePayloadUnexpectedField');
    const allowed = new Set(['nickname', 'avatar', 'updatedAt', 'addedAt']);
    assertNoExtraKeys(profile, allowed, 'InvitePayloadUnexpectedField');
    const nicknameRaw = typeof profile.nickname === 'string' ? profile.nickname : '';
    const nickname = normalizeNickname(nicknameRaw) || nicknameRaw.trim();
    const avatar = Object.prototype.hasOwnProperty.call(profile, 'avatar') ? profile.avatar : null;
    if (avatar !== null && avatar !== undefined && (typeof avatar !== 'object' || Array.isArray(avatar))) {
      throw invitePayloadError('InvitePayloadProfileInvalid', 'guestProfile.avatar invalid');
    }
    const updatedAtRaw = Number(profile.updatedAt || profile.addedAt || 0);
    const addedAtRaw = Number(profile.addedAt || 0);
    const updatedAt = Number.isFinite(updatedAtRaw) && updatedAtRaw > 0 ? updatedAtRaw : null;
    const addedAt = Number.isFinite(addedAtRaw) && addedAtRaw > 0 ? addedAtRaw : null;
    if (!nickname && !avatar) {
      throw invitePayloadError('InvitePayloadProfileInvalid', 'guestProfile missing nickname/avatar');
    }
    return {
      nickname: nickname || '',
      avatar: avatar ?? null,
      updatedAt,
      addedAt
    };
  }

  function normalizeContactInitPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw invitePayloadError('InvitePayloadInvalid', 'payload required');
    }
    const aliasKeys = new Set(['guest_account_digest', 'guest_device_id', 'guest_bundle', 'guest_profile']);
    assertNoAliasKeys(payload, aliasKeys, 'InvitePayloadUnexpectedField');
    const allowed = new Set([
      'v',
      'type',
      'msgType',
      'guestAccountDigest',
      'guestDeviceId',
      'guestBundle',
      'guestProfile'
    ]);
    assertNoExtraKeys(payload, allowed, 'InvitePayloadUnexpectedField');
    const v = Number(payload.v ?? 0);
    if (!Number.isFinite(v) || v !== CONTACT_INIT_VERSION) {
      throw invitePayloadError('InvitePayloadVersionMismatch', 'payload version mismatch');
    }
    const type = requireStringField(payload.type || payload.msgType, 'type', 'InvitePayloadInvalid');
    if (type !== CONTACT_INIT_TYPE) {
      throw invitePayloadError('InvitePayloadTypeMismatch', 'payload type mismatch');
    }
    const guestAccountDigest = requireAccountDigest(payload.guestAccountDigest, 'guestAccountDigest', 'InvitePayloadInvalid');
    const guestDeviceId = requireStringField(payload.guestDeviceId, 'guestDeviceId', 'InvitePayloadInvalid');
    const guestBundle = normalizeGuestBundleForInit(payload.guestBundle);
    const guestProfile = normalizeGuestProfileSnapshot(payload.guestProfile);
    return {
      v,
      type,
      guestAccountDigest,
      guestDeviceId,
      guestBundle,
      guestProfile
    };
  }

  function clearInviteCountdown() {
    if (shareState.inviteTimerId) {
      clearInterval(shareState.inviteTimerId);
      shareState.inviteTimerId = null;
    }
  }

  function formatCountdown(seconds) {
    const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
    const min = Math.floor(safe / 60);
    const sec = safe % 60;
    return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  function setInviteActionState({ hasInvite = false, expired = false, loading = false } = {}) {
    if (inviteRefreshBtn) inviteRefreshBtn.disabled = !!loading;
    // inviteRetryBtn removed - no longer exists
    // inviteConsumeBtn removed - WS auto-consume is sufficient
  }

  function renderInviteCountdown(remainingSec) {
    if (!inviteCountdownEl) return;
    const status = shareState.currentInvite?.status || '';
    const prefix = status === 'DELIVERED'
      ? '已投遞 '
      : status === 'CONSUMED'
        ? '已取回 '
        : '';
    inviteCountdownEl.textContent = `${prefix}${formatCountdown(remainingSec)}`;
    inviteCountdownEl.classList.remove('is-error', 'is-loading');
  }

  function markInviteExpired() {
    if (!shareState.currentInvite) return;
    shareState.currentInvite.expired = true;
    clearInviteCountdown();
    setInviteStatus('已過期', { isError: true });
    setInviteActionState({ hasInvite: true, expired: true, loading: false });
    if (inviteQrBox) {
      inviteQrBox.innerHTML = '';
      inviteQrBox.textContent = '邀請已過期';
    }
  }

  function applyInviteStatusSnapshot(snapshot) {
    if (!shareState.currentInvite || !snapshot) return;
    shareState.currentInvite.status = snapshot.status || shareState.currentInvite.status || null;
    shareState.currentInvite.deliveredAt = snapshot.delivered_at || null;
    shareState.currentInvite.consumedAt = snapshot.consumed_at || null;
    if (snapshot.is_expired) {
      markInviteExpired();
    }
  }

  async function refreshInviteStatus(inviteId, { source = 'poll' } = {}) {
    const id = String(inviteId || '').trim();
    if (!id) throw new Error('inviteId required');
    const snapshot = await invitesStatus({ inviteId: id });
    if (!snapshot || snapshot.invite_id !== id) {
      throw new Error('invite status response mismatch');
    }
    applyInviteStatusSnapshot(snapshot);
    log({
      inviteStatusRefreshed: {
        inviteId: snapshot.invite_id,
        status: snapshot.status || null,
        isExpired: !!snapshot.is_expired,
        source
      }
    });
    return snapshot;
  }

  function maybePollInviteStatus() {
    const invite = shareState.currentInvite;
    if (!invite || !invite.inviteId) return;
    if (shareState.inviteStatusPollInFlight) return;
    const now = Date.now();
    if (shareState.inviteStatusNextPollAt && now < shareState.inviteStatusNextPollAt) return;
    shareState.inviteStatusNextPollAt = now + INVITE_STATUS_POLL_MS;
    shareState.inviteStatusPollInFlight = true;
    refreshInviteStatus(invite.inviteId, { source: 'poll' })
      .catch((err) => {
        log({
          inviteStatusFailed: {
            inviteId: invite.inviteId,
            reasonCode: err?.code || err?.data?.error || err?.data?.code || 'InviteStatusFailed',
            message: err?.message || err
          }
        });
      })
      .finally(() => {
        shareState.inviteStatusPollInFlight = false;
      });
  }

  function updateInviteCountdown() {
    const invite = shareState.currentInvite;
    if (!invite || !Number.isFinite(invite.expiresAt)) return;
    const now = Date.now();
    const remaining = Math.max(0, Math.ceil(invite.expiresAt - now / 1000));
    if (remaining <= 0) {
      markInviteExpired();
      return;
    }
    renderInviteCountdown(remaining);
    maybePollInviteStatus();
  }

  function startInviteCountdown() {
    clearInviteCountdown();
    updateInviteCountdown();
    shareState.inviteTimerId = setInterval(updateInviteCountdown, 1000);
  }

  function isInviteExpired(invite) {
    if (!invite || !Number.isFinite(invite.expiresAt)) return true;
    const now = Math.floor(Date.now() / 1000);
    return invite.expiresAt <= now;
  }

  function renderInviteQr(invite) {
    if (!inviteQrBox) {
      console.warn('[share-controller] inviteQrBox missing');
      return;
    }
    inviteQrBox.innerHTML = '';
    try {
      const payload = encodeFriendInvite(invite);
      console.log('[share-controller] rendering QR', { payloadLen: payload?.length, inviteId: invite?.inviteId });
      if (!payload) throw new Error('invite payload empty');
      const canvas = generateQR(payload, 220);
      if (canvas) {
        removeQrPlaceholder();
        inviteQrBox.appendChild(canvas);
        inviteQrBox.setAttribute('data-qr-build-version', QR_BUILD_VERSION);
        console.log('[share-controller] canvas appended', {
          width: canvas.width,
          height: canvas.height,
          styleWidth: canvas.style.width,
          boxId: inviteQrBox.id
        });
      } else {
        inviteQrBox.textContent = '無法產生 QR，請稍後再試。';
      }
    } catch (err) {
      const msg = err?.message || String(err);
      console.error('[share-controller] qrRenderError', err);
      inviteQrBox.textContent = '生成 QR 時發生錯誤: ' + msg;
    }
  }

  async function onGenerateInvite() {
    const ownerAccountDigest = currentOwnerDigest();
    const ownerDeviceId = ensureDeviceId();
    if (!ownerAccountDigest || !ownerDeviceId) {
      setInviteStatus('尚未登入，無法生成交友邀請，請重新登入後再試。', { isError: true });
      setInviteActionState({ hasInvite: false, expired: false, loading: false });
      return;
    }
    clearInviteCountdown();
    setInviteActionState({ hasInvite: false, expired: false, loading: true });
    try {
      setInviteStatus('檢查交友金鑰配置…', { loading: true });
      await ensureOwnerPrekeys({ force: false, reason: 'invite' });
      setInviteStatus('交友金鑰已就緒，正在建立邀請…', { loading: true });
      const invite = await invitesCreate();
      if (!invite || !invite.invite_id || !invite.expires_at || !invite.owner_public_key_b64 || !invite.prekey_bundle) {
        throw new Error('伺服器回傳內容不完整');
      }
      shareState.currentInvite = {
        inviteId: String(invite.invite_id),
        expiresAt: Number(invite.expires_at),
        ownerAccountDigest: invite.owner_account_digest || ownerAccountDigest,
        ownerDeviceId: invite.owner_device_id || ownerDeviceId,
        ownerPublicKeyB64: String(invite.owner_public_key_b64 || ''),
        v: INVITE_PROTOCOL_VERSION,
        msgType: INVITE_QR_TYPE,
        prekeyBundle: invite.prekey_bundle || null
      };
      shareState.inviteStatusNextPollAt = 0;
      shareState.inviteStatusPollInFlight = false;
      shareState.currentInvite.expired = false;
      console.log('[share-controller]', {
        inviteGenerated: {
          inviteId: shareState.currentInvite.inviteId,
          expiresAt: shareState.currentInvite.expiresAt,
          ownerDeviceId,
          qrVersion: QR_BUILD_VERSION
        }
      });
      log({
        inviteGenerated: {
          inviteId: shareState.currentInvite.inviteId,
          expiresAt: shareState.currentInvite.expiresAt,
          ownerDeviceId,
          qrVersion: QR_BUILD_VERSION
        }
      });
      renderInviteQr(shareState.currentInvite);
      startInviteCountdown();
      setInviteActionState({ hasInvite: true, expired: false, loading: false });
    } catch (err) {
      const msg = err?.message || '邀請建立失敗';
      setInviteStatus(msg, { isError: true });
      setInviteActionState({ hasInvite: false, expired: false, loading: false });
      throw err;
    }
  }

  function ensureActiveInvite() {
    if (shareState.currentInvite) {
      if (shareState.currentInvite.ownerAccountDigest !== currentOwnerDigest()) {
        shareState.currentInvite = null;
      } else if (isInviteExpired(shareState.currentInvite)) {
        markInviteExpired();
        return Promise.resolve();
      }
      renderInviteQr(shareState.currentInvite);
      startInviteCountdown();
      setInviteActionState({ hasInvite: true, expired: false, loading: false });
      return Promise.resolve();
    }
    return onGenerateInvite();
  }

  function openShareModal(defaultMode = 'qr') {
    if (!shareModal) return;
    shareState.open = true;
    shareModal.style.display = 'flex';
    shareModal.setAttribute('aria-hidden', 'false');
    lockBodyScroll();
    const target = defaultMode === 'scan' ? 'scan' : 'qr';
    showShareMode(target);
    if (target === 'qr') {
      ensureActiveInvite().catch((err) => console.error('[share-controller]', { inviteEnsureError: err?.message || err }));
    }
  }

  function closeShareModal() {
    if (!shareModal) return;
    shareState.open = false;
    shareModal.style.display = 'none';
    shareModal.setAttribute('aria-hidden', 'true');
    shareFlip?.classList.remove('flipped');
    stopInviteScanner();
    clearInviteCountdown();
    unlockBodyScroll();
  }

  function showShareMode(mode) {
    if (!shareModal) return;
    const target = mode === 'scan' ? 'scan' : 'qr';
    shareState.mode = target;
    shareModal.setAttribute('data-share-mode', target);
    if (target === 'scan') {
      shareFlip?.classList.add('flipped');
      if (shareState.open) startInviteScanner();
    } else {
      shareFlip?.classList.remove('flipped');
      stopInviteScanner();
      ensureActiveInvite().catch((err) => console.error('[share-controller]', { inviteEnsureError: err?.message || err }));
    }
  }

  function handleEscapeKey(e) {
    if (e.key === 'Escape') {
      if (pairingState.open) { closePairingCodeModal(); return; }
      if (shareState.open) closeShareModal();
    }
  }

  async function ensureInviteScanner() {
    if (shareState.scanner) return shareState.scanner;
    if (!inviteScanVideo) throw new Error('找不到掃描相機的影片元素');
    QrScanner.WORKER_PATH = '/app/lib/vendor/qr-scanner-worker.min.js';
    shareState.scanner = new QrScanner(inviteScanVideo, (res) => {
      if (!res) return;
      const text = typeof res === 'string'
        ? res
        : typeof res?.data === 'string'
          ? res.data
          : Array.isArray(res)
            ? res.map((r) => r?.data || '').join('\n')
            : String(res?.data || '');
      handleInviteScan(text);
    }, {
      highlightScanRegion: true,
      highlightCodeOutline: true,
      returnDetailedScanResult: true,
      onDecodeError: (err) => {
        const qrDebug = typeof window !== 'undefined' && !!window.__DEBUG_QR_SCANNER__;
        const message = err?.message || err;
        if (qrDebug) {
          logUiNoise('qr-scan:error', { message }, { level: 'warn', force: true });
          return;
        }
        logUiNoise('qr-scan:noise', { message }, { throttleMs: qrErrorSilenceMs, throttleKey: 'qr-scan-noise' });
      }
    });
    return shareState.scanner;
  }

  async function startInviteScanner() {
    if (!inviteScanStatus) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      inviteScanStatus.textContent = '此裝置不支援相機存取。';
      console.warn('[share-controller] invite scanner not supported');
      shareState.scannerOpen = false;
      return;
    }
    inviteScanStatus.textContent = '請將好友的交友 QR 對準框線';
    try {
      const scanner = await ensureInviteScanner();
      await scanner.start();
      shareState.scannerActive = true;
      shareState.scannerOpen = true;
      console.log('[share-controller] invite scanner started');
    } catch (err) {
      const msg = err?.message || String(err);
      inviteScanStatus.textContent = `無法開啟相機：${msg}`;
      console.error('[share-controller]', { inviteScannerError: msg });
      shareState.scannerOpen = false;
    }
  }

  async function stopInviteScanner() {
    if (shareState.scanner && shareState.scannerActive) {
      try { await shareState.scanner.stop(); } catch (err) { console.error('[share-controller]', { inviteScannerStopError: err?.message || err }); }
    }
    shareState.scannerActive = false;
    shareState.scannerOpen = false;
    if (inviteScanStatus) inviteScanStatus.textContent = '';
  }

  async function handleInviteScan(raw) {
    if (!raw) return;
    console.log('[share-controller]', { inviteScanRaw: raw });
    if (shareState.scanner && shareState.scannerActive) {
      try { await shareState.scanner.stop(); } catch (err) { console.error('[share-controller]', { inviteScannerStopError: err?.message || err }); }
      shareState.scannerActive = false;
    }
    if (inviteScanStatus) inviteScanStatus.textContent = '解析中…';
    let parsed = null;
    let deliverAttempted = false;
    let deliverOk = false;
    try {
      parsed = decodeFriendInvite(raw);
      console.log('[share-controller]', { inviteScanParsed: parsed });
      console.log('[share-controller]', `[invite-scan] parsed=${JSON.stringify({
        inviteId: parsed?.inviteId || null,
        expiresAt: parsed?.expiresAt || null,
        ownerAccountDigest: parsed?.ownerAccountDigest || null,
        ownerDeviceId: parsed?.ownerDeviceId || null
      })}`);
      logCapped('inviteScanParsedV1', {
        inviteId: parsed?.inviteId || null,
        expiresAt: parsed?.expiresAt || null,
        ownerAccountDigestSuffix4: safeSuffix(parsed?.ownerAccountDigest || '', 4),
        ownerDeviceIdSuffix4: safeSuffix(parsed?.ownerDeviceId || '', 4),
        hasPrekeyBundle: !!parsed?.prekeyBundle
      }, LOG_CAP);
      const expiresAt = Number(parsed.expiresAt || 0);
      const now = Math.floor(Date.now() / 1000);
      if (!Number.isFinite(expiresAt)) {
        throw new Error('invite 缺少 expiresAt');
      }
      if (expiresAt <= now) {
        throw new Error('邀請已過期，請請好友重新生成 QR。');
      }
      const ownerIdentity = normalizePeerIdentity({
        peerAccountDigest: parsed.ownerAccountDigest,
        peerDeviceId: parsed.ownerDeviceId
      });
      const ownerAccountDigest = ownerIdentity.accountDigest || parsed.ownerAccountDigest || null;
      const ownerDeviceId = ownerIdentity.deviceId || parsed.ownerDeviceId || null;
      if (!ownerAccountDigest) throw new Error('invite 缺少 ownerAccountDigest');
      if (!ownerDeviceId) throw new Error('invite 缺少 ownerDeviceId');
      const ownerPublicKeyB64 = String(parsed.ownerPublicKeyB64 || '').trim();
      if (!ownerPublicKeyB64) throw new Error('invite 缺少 ownerPublicKeyB64');
      const ownerBundle = normalizeInviteOwnerBundle(parsed?.prekeyBundle || null);
      if (!ownerBundle?.opkId || !ownerBundle?.opkPubB64) throw new Error('invite prekey bundle 缺少 opk');
      const resolvedOwnerDigest = ownerAccountDigest;
      const resolvedOwnerDeviceId = ownerDeviceId;
      if (!resolvedOwnerDigest) throw new Error('owner digest 不完整，請重試');
      if (!resolvedOwnerDeviceId) throw new Error('owner device 不完整，請重試');

      // [FIX] Check for existing contact with this account digest
      const existingContacts = findContactCoreByAccountDigest(resolvedOwnerDigest);
      if (existingContacts.length > 0) {
        const anyComplete = existingContacts.some(c =>
          isContactComplete(resolvedOwnerDigest, c?.entry?.peerDeviceId || null)
        );
        if (anyComplete) {
          // Already friends - show message and navigate to chat
          const completeContact = existingContacts.find(c =>
            isContactComplete(resolvedOwnerDigest, c?.entry?.peerDeviceId || null)
          );
          const convId = completeContact?.entry?.conversationId || null;
          if (inviteScanStatus) inviteScanStatus.textContent = '你們已經是好友了';
          logCapped('inviteScanAlreadyFriends', {
            ownerDigestSuffix4: safeSuffix(resolvedOwnerDigest, 4),
            conversationId: convId ? safePrefix(convId, 8) : null
          }, 5);
          setTimeout(() => {
            if (pairingState.open) closePairingCodeModal();
            if (shareState.open) closeShareModal();
            if (convId && typeof switchTab === 'function') switchTab('messages');
          }, 1200);
          return;
        } else {
          // Incomplete contact - cleanup and retry
          cleanupIncompleteContactCore(resolvedOwnerDigest, { sourceTag: 'invite-scan:retry' });
          // Also cleanup pending invites
          const pendingList = listPendingInvites();
          for (const inv of pendingList) {
            if (inv?.ownerAccountDigest === resolvedOwnerDigest) {
              removePendingInvite(inv.inviteId);
            }
          }
          logCapped('inviteScanCleanupRetry', {
            ownerDigestSuffix4: safeSuffix(resolvedOwnerDigest, 4),
            cleanedCount: existingContacts.length
          }, 5);
          if (inviteScanStatus) inviteScanStatus.textContent = '清除舊狀態，重新建立連線…';
        }
      }

      const devicePriv = await ensureDevicePrivLoaded();
      if (!devicePriv) throw new Error('找不到裝置金鑰，請重新登入後再試');
      const guestAccountDigest = (getAccountDigest() || '').toUpperCase();
      if (!guestAccountDigest) throw new Error('缺少 guestAccountDigest，請重新登入後再試');
      const guestDeviceId = ensureDeviceId();
      if (!guestDeviceId) throw new Error('缺少 guestDeviceId，請重新登入後再試');
      const ekPair = await genX25519Keypair();
      const guestBundle = buildGuestBundleForAccept(devicePriv, ekPair, {
        id: ownerBundle?.opkId ?? null,
        pub: ownerBundle?.opkPubB64 || null
      });

      const profileSnapshot = await buildLocalContactPayload();
      const normalizedNick = normalizeNickname(profileSnapshot?.nickname || '') || '';
      const hasAvatar = !!profileSnapshot?.avatar;
      if (!normalizedNick && !hasAvatar) {
        throw new Error('請先設定暱稱或頭像後再投遞邀請。');
      }
      const guestProfile = {
        nickname: normalizedNick || profileSnapshot.nickname || '',
        avatar: profileSnapshot.avatar || null,
        updatedAt: profileSnapshot.updatedAt || profileSnapshot.addedAt || now,
        addedAt: profileSnapshot.addedAt || now
      };
      const contactInitPayload = {
        v: CONTACT_INIT_VERSION,
        type: CONTACT_INIT_TYPE,
        guestAccountDigest,
        guestDeviceId,
        guestBundle,
        guestProfile
      };
      if (inviteScanStatus) inviteScanStatus.textContent = '投遞中…';
      const envelope = await sealInviteEnvelope({
        ownerPublicKeyB64,
        payload: contactInitPayload,
        expiresAt
      });
      // Persist delivery intent BEFORE the deliver API call so we can replay
      // if the app crashes after deliver succeeds but before local processing.
      upsertDeliveryIntent({
        inviteId: parsed.inviteId,
        ownerAccountDigest: resolvedOwnerDigest,
        ownerDeviceId: resolvedOwnerDeviceId,
        ownerBundle,
        ekPrivB64: ekPair.priv,
        ekPubB64: ekPair.pub,
        guestBundle,
        guestProfile,
        deliverCompleted: false,
        createdAt: Date.now()
      });
      deliverAttempted = true;
      await invitesDeliver({ inviteId: parsed.inviteId, ciphertextEnvelope: envelope });
      markDeliveryIntentDelivered(parsed.inviteId);
      deliverOk = true;
      logCapped('inviteDeliverResult', { inviteId: parsed.inviteId, ok: true }, LOG_CAP);
      console.log('[share-controller]', { inviteDropboxDelivered: { inviteId: parsed.inviteId, targetDigest: resolvedOwnerDigest, targetDeviceId: resolvedOwnerDeviceId } });
      const ownerBundleForInit = mapOwnerBundleToX3dh(ownerBundle);
      const initiatorState = await x3dhInitiate(devicePriv, ownerBundleForInit, ekPair);
      if (!(initiatorState?.rk instanceof Uint8Array)) {
        throw new Error('contact-init preflight missing rk');
      }
      const conversationContext = await deriveConversationContextFromSecret(initiatorState.rk, { deviceId: resolvedOwnerDeviceId });
      const conversationId = conversationContext?.conversationId || null;
      const conversationToken = conversationContext?.tokenB64 || null;
      if (!conversationId || !conversationToken) {
        throw new Error('contact-init preflight missing conversation context');
      }
      const drInitPayload = guestBundle
        ? { guest_bundle: guestBundle, role: 'initiator' }
        : null;
      const conversationPayload = {
        token_b64: conversationToken,
        conversation_id: conversationId,
        peerDeviceId: resolvedOwnerDeviceId,
        ...(drInitPayload ? { dr_init: drInitPayload } : null)
      };
      const conversationIndex = ensureConversationIndex();
      const prevConvEntry = conversationIndex.get(conversationId) || {};
      conversationIndex.set(conversationId, {
        ...prevConvEntry,
        token_b64: conversationToken,
        peerAccountDigest: resolvedOwnerDigest,
        peerDeviceId: resolvedOwnerDeviceId,
        dr_init: prevConvEntry.dr_init || drInitPayload || null
      });
      logCapped('inviteSessionIndexWriteTrace', {
        inviteId: parsed?.inviteId || null,
        conversationIdPrefix8: safePrefix(conversationId, 8),
        hasToken: !!conversationToken,
        ownerDigestSuffix4: safeSuffix(resolvedOwnerDigest || '', 4),
        ownerDeviceSuffix4: safeSuffix(resolvedOwnerDeviceId || '', 4)
      }, LOG_CAP);
      const drHolder = drState({ peerAccountDigest: resolvedOwnerDigest, peerDeviceId: resolvedOwnerDeviceId });
      if (drHolder && !(drHolder.rk instanceof Uint8Array)) {
        copyDrState(drHolder, initiatorState, { callsiteTag: 'invite-scan:preflight' });
      }
      if (drHolder) {
        drHolder.baseKey = drHolder.baseKey || {};
        if (!drHolder.baseKey.role) drHolder.baseKey.role = 'initiator';
        if (!drHolder.baseKey.conversationId) drHolder.baseKey.conversationId = conversationId;
        if (!drHolder.baseKey.peerAccountDigest) drHolder.baseKey.peerAccountDigest = resolvedOwnerDigest;
        if (!drHolder.baseKey.peerDeviceId) drHolder.baseKey.peerDeviceId = resolvedOwnerDeviceId;
      }
      storeContactSecretMapping({
        peerAccountDigest: resolvedOwnerDigest,
        peerDeviceId: resolvedOwnerDeviceId,
        sessionKey: conversationToken,
        conversation: conversationPayload,
        drState: drHolder,
        // [FIX] Role must be 'initiator' (or 'responder') for DR logic to work.
        // 'guest' is a UI concept, not a cryptographic role.
        role: 'initiator'
      });

      // [FIX] Persist scanner-side contact to D1 so it survives storage clear + restore
      uplinkContactToD1({
        peerAccountDigest: resolvedOwnerDigest,
        conversation: conversationPayload
      }).catch(err => console.warn('[share-controller] scanner uplink failed', err));

      // [FIX] Backup contact-secrets (incl. DR state) to server immediately
      triggerContactSecretsBackup('invite-scan', { force: true, allowWithoutDrState: true })
        .catch(err => console.warn('[share-controller] scanner backup failed', err));

      logCapped('inviteSessionMaterialReady', {
        inviteId: parsed?.inviteId || null,
        conversationIdPrefix8: safePrefix(conversationId, 8),
        tokenB64Prefix6: safePrefix(conversationToken, 6),
        ownerDeviceIdSuffix4: safeSuffix(resolvedOwnerDeviceId || '', 4)
      }, LOG_CAP);
      console.log('[share-controller]', `[invite-scan] delivered=${JSON.stringify({
        inviteId: parsed?.inviteId || null,
        targetDigest: resolvedOwnerDigest || null,
        targetDeviceId: resolvedOwnerDeviceId || null
      })}`);
      console.log('[share-controller]', `[invite-scan] session-ready=${JSON.stringify({
        inviteId: parsed?.inviteId || null,
        peerAccountDigest: resolvedOwnerDigest || null,
        peerDeviceId: resolvedOwnerDeviceId || null,
        conversationId
      })}`);

      upsertPendingInvite({
        inviteId: parsed.inviteId,
        expiresAt,
        ownerAccountDigest: resolvedOwnerDigest,
        ownerDeviceId: resolvedOwnerDeviceId,
        conversationId,
        conversationToken
      });
      // Local processing complete – remove the delivery intent
      removeDeliveryIntent(parsed.inviteId);
      try { document.dispatchEvent(new CustomEvent('contacts:pending-invites-updated')); } catch { }

      if (inviteScanStatus) inviteScanStatus.textContent = '投遞成功，等待對方取回';
      switchTab('contacts');
      setTimeout(() => {
        if (pairingState.open) closePairingCodeModal();
        if (shareState.open) closeShareModal();
      }, 700);
    } catch (err) {
      const msg = err?.message || String(err);
      const status = Number(err?.status || err?.response?.status || 0);
      const code = err?.code || err?.data?.error || err?.data?.code || null;
      // If deliver never completed, clean up the delivery intent
      if (deliverAttempted && !deliverOk && parsed?.inviteId) {
        removeDeliveryIntent(parsed.inviteId);
      }
      if (deliverAttempted && !deliverOk) {
        logCapped('inviteDeliverResult', {
          inviteId: parsed?.inviteId || null,
          ok: false,
          status: status || null,
          errorCode: code ? String(code) : null
        }, LOG_CAP);
      }
      let friendly = msg;
      let shouldRestart = true;
      if (status === 409 || code === 'InviteAlreadyDelivered') {
        friendly = '邀請已被使用，請請好友重新生成 QR。';
        shouldRestart = false;
      } else if (status === 410 || code === 'Expired' || msg.toLowerCase().includes('expired')) {
        friendly = '邀請已過期，請請好友重新生成 QR。';
        shouldRestart = false;
      } else if (code && String(code).startsWith('InviteQr')) {
        friendly = '無法解析邀請內容，請請好友重新生成 QR。';
        shouldRestart = false;
      } else if (status === 401 || status === 403) {
        friendly = '需要登入才能投遞邀請，請重新登入後再試。';
        shouldRestart = false;
      }
      console.error('[share-controller]', { inviteScanError: msg, status, code });
      if (inviteScanStatus) inviteScanStatus.textContent = friendly || '無法解析邀請內容';
      if (shouldRestart) {
        setTimeout(() => {
          if (shareState.open && shareState.mode === 'scan') {
            restartInviteScannerWithMessage('請再試一次，將 QR 置中掃描');
          }
        }, 1600);
      }
    }
  }

  async function sendContactShare({ peerAccountDigest, conversation, sessionKey, peerDeviceId, drInit, overrides = null, reason = null }) {
    const targetIdentity = normalizePeerIdentity({ peerAccountDigest });
    const targetDigest = targetIdentity.accountDigest || targetIdentity.key || null;
    const senderDeviceId = ensureDeviceId();
    const selfDigest = (getAccountDigest() || '').toUpperCase();
    if (selfDigest && targetDigest && selfDigest === targetDigest) {
      throw new Error('contact-share target peer resolves to self');
    }
    const conversationToken = conversation?.token_b64 || conversation?.tokenB64 || sessionKey || null;
    const conversationId = conversation?.conversation_id || conversation?.conversationId || null;
    const resolvedPeerDeviceId = peerDeviceId || null;
    if (senderDeviceId && resolvedPeerDeviceId && String(resolvedPeerDeviceId) === String(senderDeviceId)) {
      throw new Error('contact-share target device resolves to self');
    }
    console.log('[share-controller]', {
      contactShareValidate: {
        peerAccountDigest: peerAccountDigest || null,
        targetDigest: targetDigest || null,
        conversationId: conversationId || null,
        hasToken: !!conversationToken,
        peerDeviceId: resolvedPeerDeviceId || null
      }
    });
    if (!targetDigest || !conversationToken || !conversationId) {
      throw new Error('contact-share missing required fields');
    }
    if (conversationId.startsWith('contacts-')) {
      throw new Error('contact-share 缺少安全對話 ID，請重新同步好友後重試');
    }
    if (!resolvedPeerDeviceId) {
      throw new Error('contact-share missing peerDeviceId (strict path)');
    }
    const reasonKey = typeof reason === 'string' ? reason.toLowerCase() : null;
    const shouldTracePreflight = shouldTraceProfilePreflight(reasonKey);
    const mkReady = !!getMkRaw();
    if (shouldTracePreflight) {
      logProfilePreflightTrace({
        operation: reasonKey,
        needsRk: false,
        hasRk: null,
        needsMk: false,
        mkReady,
        conversationId: conversationId || null,
        target: 'peer',
        errorCode: null
      });
    }
    const payload = await buildLocalContactPayload({ conversation, drInit, overrides });
    if (reason) {
      payload.reason = reason;
    }
    payload.reason = payload.reason || 'invite-consume';

    // [REFACTOR] Send via DR encryption instead of conversation-token encryption.
    // This ensures a vault key is stored, so the tombstone survives page reload / history replay.
    const messageId = crypto.randomUUID();
    const contactPayload = { ...payload, type: 'contact-share' };
    // [FIX] Pass the `conversation` object directly so sendDrPlaintextCore can use it
    // without re-deriving from contact-secrets (avoids lookup failures on fresh invites).
    const drConversation = (conversationToken && conversationId)
      ? { token_b64: conversationToken, conversation_id: conversationId }
      : (conversation || null);
    await sendDrPlaintext({
      text: JSON.stringify(contactPayload),
      peerAccountDigest: targetDigest,
      peerDeviceId: resolvedPeerDeviceId,
      conversation: drConversation,
      conversationId,
      messageId,
      metaOverrides: {
        msgType: 'contact-share'
      }
    });

    const nowSec = Date.now();
    const payloadTs = Number(payload?.updatedAt || payload?.addedAt || nowSec);
    const ts = Number.isFinite(payloadTs) ? payloadTs : nowSec;

    // Append local tombstone for sender side
    // Store JSON payload as text so the renderer can parse reason/nickname fields
    try {
      appendUserMessage(conversationId, {
        id: messageId,
        messageId,
        conversationId,
        ts,
        tsMs: ts,
        msgType: 'contact-share',
        direction: 'outgoing',
        text: JSON.stringify(contactPayload),
        reason: contactPayload.reason || 'invite-consume',
        senderDigest: selfDigest,
        senderDeviceId: senderDeviceId,
        status: 'pending',
        vaultPutCount: 1
      });
    } catch (e) {
      console.warn('[share-controller] failed to append contact-share tombstone', e);
    }

    // Force Secure Conversation Status to READY
    try {
      updateSecureConversationStatus(targetDigest, SECURE_CONVERSATION_STATUS.READY, {
        reason: 'initiator-contact-share-success',
        source: 'share-controller'
      });
      console.log('[share-controller] forced secure status to READY', { targetDigest });
    } catch (err) {
      console.warn('[share-controller] failed to update secure status', err);
    }

  }

  async function buildLocalContactPayload({ conversation, drInit, overrides } = {}) {
    const initialProfile = typeof getProfileState === 'function' ? getProfileState() : null;

    const pickPreferredProfile = (a, b) => {
      if (a && b) {
        const tsA = Number(a.updatedAt || a.ts || 0);
        const tsB = Number(b.updatedAt || b.ts || 0);
        if (tsB > tsA) return b;
        if (tsA > tsB) return a;
        const hasAvatarA = !!(a.avatar && (a.avatar.thumbDataUrl || a.avatar.previewDataUrl));
        const hasAvatarB = !!(b.avatar && (b.avatar.thumbDataUrl || b.avatar.previewDataUrl));
        if (hasAvatarA && !hasAvatarB) return a;
        if (hasAvatarB && !hasAvatarA) return b;
        return a;
      }
      return a || b || null;
    };

    let profileState = initialProfile;
    if (profileInitPromise) {
      try {
        await profileInitPromise;
      } catch (err) {
        console.error('[share-controller]', { profileInitAwaitError: err?.message || err });
      }
      const loadedProfile = typeof getProfileState === 'function' ? getProfileState() : null;
      profileState = pickPreferredProfile(initialProfile, loadedProfile);
      if (profileState && sessionStore.profileState !== profileState) {
        sessionStore.profileState = profileState;
      }
    }

    const nickname = profileState?.nickname || '';
    const profileUpdatedAt = Number.isFinite(profileState?.updatedAt) ? Number(profileState.updatedAt) : Math.floor(Date.now() / 1000);
    let avatar = null;
    const overrideAvatar = overrides?.avatar || null;
    const baseAvatar = overrideAvatar || profileState?.avatar || initialProfile?.avatar || null;
    if (baseAvatar) {
      let ensuredAvatar = null;
      if (!overrideAvatar && ensureAvatarThumbnail) {
        try {
          ensuredAvatar = await ensureAvatarThumbnail();
        } catch (err) {
          console.error('[share-controller]', { ensureAvatarThumbError: err?.message || err });
        }
      }
      const effectiveAvatar = overrideAvatar || ensuredAvatar || baseAvatar;
      const thumb = effectiveAvatar?.thumbDataUrl || effectiveAvatar?.previewDataUrl || null;
      if (thumb) {
        avatar = {
          ...effectiveAvatar,
          thumbDataUrl: thumb
        };
        if (!avatar.previewDataUrl && effectiveAvatar?.previewDataUrl) {
          avatar.previewDataUrl = effectiveAvatar.previewDataUrl;
        }
        if (!profileState?.avatar?.thumbDataUrl && thumb && !overrideAvatar) {
          sessionStore.profileState = {
            ...(sessionStore.profileState || {}),
            avatar: { ...(sessionStore.profileState?.avatar || effectiveAvatar), thumbDataUrl: thumb }
          };
          profileState = sessionStore.profileState;
        }
      } else if (overrideAvatar) {
        avatar = { ...overrideAvatar };
      }
    }

    let conversationInfo = null;
    if (conversation) {
      const convToken = conversation.tokenB64 || conversation.token_b64 || null;
      const convId = conversation.conversationId || conversation.conversation_id || null;
      const peerDeviceId = conversation.peerDeviceId || null;
      if (convToken && convId) {
        conversationInfo = {
          token_b64: convToken,
          conversation_id: convId
        };
        // Fix: Force peerDeviceId to be SELF (Sender) Device ID
        // This ensures the recipient sees the correct device ID for the contact they are upserting/updating
        const selfDeviceId = ensureDeviceId();
        if (selfDeviceId) {
          conversationInfo.peerDeviceId = selfDeviceId;
        } else if (peerDeviceId) {
          // Fallback (should typically be selfDeviceId if ensuring works)
          conversationInfo.peerDeviceId = peerDeviceId;
        }

        const drInitPayload = drInit || conversation.dr_init || conversation.drInit || null;
        if (!drInitPayload) {
          throw new Error('contact-share missing dr_init');
        }
        conversationInfo.dr_init = drInitPayload;
      }
    }
    const overrideNickname = overrides?.nickname;
    const effectiveNickname = overrideNickname || nickname || '';
    const profileVersion = Number(profileState?.profileVersion) || 0;
    const payload = {
      nickname: effectiveNickname,
      avatar,
      addedAt: Math.floor(Date.now() / 1000),
      updatedAt: profileUpdatedAt,
      profileVersion
    };
    if (conversationInfo) payload.conversation = conversationInfo;
    return payload;
  }

  function normalizeContactShareConversation(conversation) {
    if (!conversation || typeof conversation !== 'object' || Array.isArray(conversation)) {
      throw invitePayloadError('ContactSharePayloadInvalid', 'conversation required');
    }
    const allowed = new Set(['token_b64', 'conversation_id', 'peerDeviceId', 'dr_init']);
    assertNoExtraKeys(conversation, allowed, 'ContactSharePayloadInvalid');
    const token_b64 = requireStringField(conversation.token_b64, 'conversation.token_b64', 'ContactSharePayloadInvalid');
    const conversation_id = requireStringField(conversation.conversation_id, 'conversation.conversation_id', 'ContactSharePayloadInvalid');
    let peerDeviceId = null;
    if (Object.prototype.hasOwnProperty.call(conversation, 'peerDeviceId')) {
      peerDeviceId = requireStringField(conversation.peerDeviceId, 'conversation.peerDeviceId', 'ContactSharePayloadInvalid');
    }
    let dr_init = null;
    if (Object.prototype.hasOwnProperty.call(conversation, 'dr_init')) {
      if (!conversation.dr_init || typeof conversation.dr_init !== 'object' || Array.isArray(conversation.dr_init)) {
        throw invitePayloadError('ContactSharePayloadInvalid', 'conversation.dr_init invalid');
      }
      const drAllowed = new Set(['guest_bundle', 'role']);
      assertNoExtraKeys(conversation.dr_init, drAllowed, 'ContactSharePayloadInvalid');
      let guest_bundle = null;
      if (Object.prototype.hasOwnProperty.call(conversation.dr_init, 'guest_bundle')) {
        guest_bundle = normalizeGuestBundleStrict(conversation.dr_init.guest_bundle);
      }
      const roleRaw = typeof conversation.dr_init.role === 'string' ? conversation.dr_init.role.trim() : '';
      const role = roleRaw || null;
      if (guest_bundle || role) {
        dr_init = {
          ...(role ? { role } : null),
          ...(guest_bundle ? { guest_bundle } : null)
        };
      }
    }
    return {
      token_b64,
      conversation_id,
      peerDeviceId,
      dr_init
    };
  }

  function normalizeContactSharePayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw invitePayloadError('ContactSharePayloadInvalid', 'payload required');
    }
    const allowed = new Set(['nickname', 'avatar', 'updatedAt', 'addedAt', 'conversation', 'reason', 'profileVersion']);
    assertNoExtraKeys(payload, allowed, 'ContactSharePayloadInvalid');
    const nickname = requireStringField(payload.nickname, 'nickname', 'ContactSharePayloadInvalid');
    const avatar = Object.prototype.hasOwnProperty.call(payload, 'avatar') ? payload.avatar : null;
    if (avatar !== null && avatar !== undefined && (typeof avatar !== 'object' || Array.isArray(avatar))) {
      throw invitePayloadError('ContactSharePayloadInvalid', 'avatar invalid');
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'reason') && typeof payload.reason !== 'string') {
      throw invitePayloadError('ContactSharePayloadInvalid', 'reason invalid');
    }
    const updatedAtRaw = Object.prototype.hasOwnProperty.call(payload, 'updatedAt')
      ? Number(payload.updatedAt)
      : 0;
    const addedAtRaw = Object.prototype.hasOwnProperty.call(payload, 'addedAt')
      ? Number(payload.addedAt)
      : 0;
    if (Object.prototype.hasOwnProperty.call(payload, 'updatedAt') && !Number.isFinite(updatedAtRaw)) {
      throw invitePayloadError('ContactSharePayloadInvalid', 'updatedAt invalid');
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'addedAt') && !Number.isFinite(addedAtRaw)) {
      throw invitePayloadError('ContactSharePayloadInvalid', 'addedAt invalid');
    }
    const updatedAt = Number.isFinite(updatedAtRaw) && updatedAtRaw > 0 ? updatedAtRaw : null;
    const addedAt = Number.isFinite(addedAtRaw) && addedAtRaw > 0 ? addedAtRaw : null;
    const reason = typeof payload.reason === 'string' ? payload.reason.trim() : null;
    const profileVersionRaw = Object.prototype.hasOwnProperty.call(payload, 'profileVersion')
      ? Number(payload.profileVersion)
      : null;
    const profileVersion = Number.isFinite(profileVersionRaw) && profileVersionRaw >= 0 ? profileVersionRaw : null;
    const conversation = normalizeContactShareConversation(payload.conversation);
    return {
      nickname,
      avatar: avatar ?? null,
      updatedAt,
      addedAt,
      reason,
      profileVersion,
      conversation
    };
  }

  async function handleContactShareEvent(msg) {
    const selfDeviceId = ensureDeviceId();
    const rawPeerAccountDigest = msg?.peerAccountDigest || msg?.peer_account_digest || msg?.peerKey || msg?.peer || null;
    const rawPeerDeviceId = msg?.peerDeviceId || msg?.peer_device_id || msg?.peerDevice || null;
    const rawIdentity = normalizePeerIdentity({ peerAccountDigest: rawPeerAccountDigest || null });
    const peerDigest = rawIdentity.accountDigest || null;
    const normalizePeerDeviceCandidate = (value) => {
      if (!value) return null;
      const identity = normalizePeerIdentity({ peerAccountDigest: peerDigest || null, peerDeviceId: value });
      const deviceId = identity.deviceId || null;
      if (!deviceId) return null;
      if (selfDeviceId && deviceId === selfDeviceId) return null;
      return deviceId;
    };
    const eventSenderDeviceId = normalizePeerDeviceCandidate(
      msg?.senderDeviceId
      || msg?.sender_device_id
      || msg?.fromDeviceId
      || msg?.from_device_id
      || null
    );
    const headerSenderDeviceId = normalizePeerDeviceCandidate(
      msg?.header?.meta?.senderDeviceId
      || msg?.header?.meta?.sender_device_id
      || msg?.meta?.senderDeviceId
      || msg?.meta?.sender_device_id
      || msg?.header?.senderDeviceId
      || msg?.header?.sender_device_id
      || msg?.header?.device_id
      || msg?.envelope?.senderDeviceId
      || msg?.envelope?.sender_device_id
      || null
    );
    const peerDeviceIdFromEvent = normalizePeerDeviceCandidate(rawPeerDeviceId);
    const peerDeviceIdFromKey = normalizePeerDeviceCandidate(rawIdentity.deviceId);
    const pendingInviteByDigest = peerDigest ? findPendingInviteByDigest(peerDigest) : null;
    const pendingOwnerDeviceId = normalizePeerDeviceCandidate(pendingInviteByDigest?.ownerDeviceId || null);
    const resolvedPeerDeviceId = eventSenderDeviceId
      || headerSenderDeviceId
      || peerDeviceIdFromEvent
      || peerDeviceIdFromKey
      || pendingOwnerDeviceId
      || null;
    const resolvedIdentity = normalizePeerIdentity({ peerAccountDigest: peerDigest, peerDeviceId: resolvedPeerDeviceId });
    const resolvedPeerDigest = resolvedIdentity.accountDigest || peerDigest || null;
    const peerDeviceId = resolvedIdentity.deviceId || null;
    const peerKey = resolvedIdentity.key;
    const stored = resolvedPeerDigest && peerDeviceId
      ? getContactSecret(resolvedPeerDigest, { deviceId: selfDeviceId, peerDeviceId })
      : null;
    let pendingInvite = null;
    if (resolvedPeerDigest && peerDeviceId) {
      logCapped('contactSharePendingLookupTrace', {
        resolvedPeerDigestSuffix4: safeSuffix(resolvedPeerDigest || '', 4),
        resolvedPeerDeviceSuffix4: safeSuffix(peerDeviceId || '', 4),
        pendingFound: false,
        pendingInviteId: null
      }, LOG_CAP);
      pendingInvite = findPendingInviteByPeer({ peerAccountDigest: resolvedPeerDigest, peerDeviceId });
      logCapped('contactSharePendingLookupTrace', {
        resolvedPeerDigestSuffix4: safeSuffix(resolvedPeerDigest || '', 4),
        resolvedPeerDeviceSuffix4: safeSuffix(peerDeviceId || '', 4),
        pendingFound: !!pendingInvite,
        pendingInviteId: pendingInvite?.inviteId ? safeSuffix(String(pendingInvite.inviteId), 4) : null
      }, LOG_CAP);
    }
    let sessionKey = stored?.conversationToken || pendingInvite?.conversationToken || null;
    const conversationIdHint = stored?.conversationId
      || stored?.conversation?.conversation_id
      || pendingInvite?.conversationId
      || null;
    logCapped('contactSharePeerResolveTrace', {
      selfDeviceIdSuffix4: safeSuffix(selfDeviceId || '', 4),
      rawPeerAccountDigest: safePrefix(rawPeerAccountDigest || '', 16) || safeSuffix(rawPeerAccountDigest || '', 4),
      rawPeerDeviceIdSuffix4: safeSuffix(rawPeerDeviceId || '', 4),
      resolvedPeerDigestSuffix4: safeSuffix(resolvedPeerDigest || '', 4),
      resolvedPeerDeviceSuffix4: safeSuffix(peerDeviceId || '', 4),
      ownerDeviceIdFromPendingSuffix4: safeSuffix(pendingInviteByDigest?.ownerDeviceId || '', 4),
      hasTokenAfterResolve: !!sessionKey
    }, LOG_CAP);
    console.log('[share-controller]', {
      contactShareHandleStart: {
        peerAccountDigest: resolvedPeerDigest || null,
        peerDeviceId: peerDeviceId || null,
        hasEnvelope: !!msg?.envelope
      }
    });
    if (!resolvedPeerDigest || !peerDeviceId) {
      console.warn('[share-controller]', { contactShareMissingPeerDevice: true, peerAccountDigest: resolvedPeerDigest || null, peerDeviceId });
      if (notifyToast) {
        notifyToast('收到未知裝置的聯絡更新，請請好友重新掃碼', { variant: 'warning' });
      }
      return;
    }
    if (stored?.peerDeviceId && peerDeviceId && stored.peerDeviceId !== peerDeviceId) {
      console.warn('[share-controller]', {
        contactSharePeerDeviceConflict: true,
        peerAccountDigest: resolvedPeerDigest,
        storedPeerDeviceId: stored.peerDeviceId,
        incomingPeerDeviceId: peerDeviceId
      });
      // 將 peerDeviceId 置換為最新，避免卡在舊裝置紀錄。
      try {
        setContactSecret(resolvedPeerDigest, { peerDeviceId, meta: { source: 'contact-share-peer-device-update' } });
      } catch (err) {
        console.warn('[share-controller]', { contactSharePeerDeviceUpdateError: err?.message || err, peerAccountDigest: resolvedPeerDigest });
      }
    }
    logCapped('contactShareDecryptAttempt', {
      peerDigestSuffix4: safeSuffix(resolvedPeerDigest || '', 4),
      peerDeviceIdSuffix4: safeSuffix(peerDeviceId || '', 4),
      hasToken: !!sessionKey,
      conversationIdPrefix8: safePrefix(conversationIdHint || '', 8)
    }, LOG_CAP);
    if (!sessionKey) {
      console.warn('[share-controller]', { contactShareMissingSession: resolvedPeerDigest, peerDeviceId, selfDeviceId });
      return;
    }
    const envelope = msg?.envelope;
    if (!envelope?.iv || !envelope?.ct) {
      console.warn('[share-controller]', { contactShareMissingEnvelope: true, peerAccountDigest: resolvedPeerDigest, peerDeviceId });
      return;
    }
    try {
      const rawPayload = await decryptContactPayload(sessionKey, envelope);
      const payload = normalizeContactSharePayload(rawPayload);
      const normalizedNickname = normalizeNickname(payload.nickname || '');
      if (!normalizedNickname) {
        throw invitePayloadError('ContactSharePayloadInvalid', 'nickname invalid');
      }
      payload.nickname = normalizedNickname;
      try {
        console.log('[share-controller]', {
          contactSharePayload: {
            peerAccountDigest: resolvedPeerDigest,
            peerDeviceId,
            hasAvatar: !!payload.avatar,
            nickname: payload.nickname || null,
            conversationId: payload.conversation?.conversation_id || null
          }
        });
      } catch { }
      logCapped('contactShareDecryptSuccess', {
        peerDigestSuffix4: safeSuffix(resolvedPeerDigest || '', 4),
        peerDeviceIdSuffix4: safeSuffix(peerDeviceId || '', 4)
      }, LOG_CAP);
      const reasonRaw = typeof payload?.reason === 'string' ? payload.reason.trim() : '';
      const reasonKey = reasonRaw ? reasonRaw.toLowerCase() : null;
      const conversationRaw = payload.conversation;
      const conversationTokenB64 = conversationRaw.token_b64;
      const conversationIdFromPayload = conversationRaw.conversation_id;
      const conversation = {
        token_b64: conversationTokenB64,
        conversation_id: conversationIdFromPayload,
        dr_init: conversationRaw.dr_init || null,
        // 對端裝置必須存在，強制用 senderDeviceId 作為 peerDeviceId
        peerDeviceId
      };
      if (conversationRaw.peerDeviceId && peerDeviceId && conversationRaw.peerDeviceId !== peerDeviceId) {
        console.warn('[share-controller]', {
          contactSharePeerDeviceMismatch: true,
          peerAccountDigest: resolvedPeerDigest,
          fromEvent: peerDeviceId,
          fromPayload: conversationRaw.peerDeviceId
        });
        if (notifyToast) {
          notifyToast('對方裝置資訊不符，請請好友重新掃描 QR', { variant: 'warning' });
        }
        return;
      }

      try {
        if (contactCoreVerbose) {
          console.log('[contact-core] pre-upsert', {
            sourceTag: 'share-controller:contact-share',
            peerKey,
            peerAccountDigest: resolvedPeerDigest || null,
            peerDeviceId,
            conversationId: conversation.conversation_id || null,
            hasToken: !!conversation.token_b64
          });
        }
      } catch { }

      // [Diff Check] Pre-fetch existing contact to compare for system nitifications
      const existingScan = resolvedPeerDigest ? findContactCoreByAccountDigest(resolvedPeerDigest) : [];
      const existingEntry = existingScan.find(m => m.entry?.conversationId === conversation.conversation_id)?.entry || existingScan[0]?.entry;

      console.log('[share-controller] DEBUG: addContactEntry call', {
        digest: resolvedPeerDigest,
        nickname: payload.nickname,
        avatar: !!payload.avatar
      });

      const added = await addContactEntry({
        peerAccountDigest: resolvedPeerDigest,
        peerDeviceId,
        nickname: payload.nickname,
        avatar: payload.avatar || null,
        addedAt: payload.addedAt || null,
        updatedAt: payload.updatedAt || null,
        profileVersion: payload.profileVersion ?? null,
        conversation,
        contactSecret: conversation.token_b64
      });

      // [Diff Check] Insert System Message if profile changed
      if (existingEntry && conversation.conversation_id) {
        try {
          const oldName = existingEntry.nickname;
          const newName = payload.nickname;
          const oldAvatar = resolveContactAvatarUrl(existingEntry);
          const newAvatar = resolveContactAvatarUrl({ avatar: payload.avatar });

          if (typeof newName === 'string' && typeof oldName === 'string' && newName !== oldName) {
            appendUserMessage(conversation.conversation_id, {
              id: crypto.randomUUID(),
              msgType: 'system',
              text: `對方的暱稱已更改為 ${newName}`,
              ts: Date.now() / 1000,
              direction: 'incoming',
              status: 'sent'
            });
          }
          if (newAvatar !== oldAvatar) {
            appendUserMessage(conversation.conversation_id, {
              id: crypto.randomUUID(),
              msgType: 'system',
              text: '對方已更改頭像',
              ts: Date.now() / 1000,
              direction: 'incoming',
              status: 'sent'
            });
          }
        } catch (err) {
          console.warn('[share-controller] system notify failed', err);
        }
      }
      if (added) {
        removePendingInviteByPeer({ peerAccountDigest: resolvedPeerDigest, peerDeviceId });
      }
      const drRoleRaw = conversation?.dr_init?.role || conversation?.drInit?.role || null;
      const drRole = typeof drRoleRaw === 'string' ? drRoleRaw.toLowerCase() : null;
      const selfRole = (() => {
        if (drRole === 'initiator') return 'owner';
        if (drRole === 'responder') return 'guest';
        return stored?.role || null;
      })();
      storeContactSecretMapping({
        peerAccountDigest: resolvedPeerDigest,
        peerDeviceId,
        sessionKey: conversation.token_b64,
        conversation,
        role: selfRole || stored?.role || null
      });
      try {
        await persistProfileForAccount(
          {
            nickname: payload.nickname,
            avatar: payload.avatar || null,
            updatedAt: payload.updatedAt || payload.addedAt || Date.now(),
            sourceTag: PROFILE_WRITE_SOURCE.CONTACT_SHARE
          },
          resolvedPeerDigest
        );
      } catch (err) {
        log({ contactShareProfilePersistError: err?.message || err, peerAccountDigest: resolvedPeerDigest });
      }
      const drInitRaw = conversation.dr_init || null;
      const normalizedBundle = drInitRaw?.guest_bundle ? normalizeGuestBundle(drInitRaw.guest_bundle) : null;
      // 只有當對方裝置等於本機（owner/responder 端）才允許 responder bootstrap；guest 端禁止。
      const allowResponderBootstrap = !!(selfDeviceId && peerDeviceId && selfDeviceId === peerDeviceId);
      if (normalizedBundle && allowResponderBootstrap) {
        const alreadyLive = hasLiveDrState({ peerAccountDigest: resolvedPeerDigest, peerDeviceId });
        if (!alreadyLive) {
          try {
            await bootstrapDrFromGuestBundle({
              peerAccountDigest: resolvedPeerDigest,
              peerDeviceId,
              guestBundle: normalizedBundle
            });
          } catch (err) {
            console.error('[share-controller]', { drBootstrapError: err?.message || err });
          }
        }
      }

      const isProfileUpdateReason = reasonKey && CONTACT_UPDATE_REASONS.has(reasonKey);
      if (notifyToast) {
        if (!stored) {
          notifyToast('已成功加入好友', { variant: 'success' });
        } else if (isProfileUpdateReason) {
          const updateMessage =
            reasonKey === 'avatar'
              ? '好友頭像已更新'
              : reasonKey === 'nickname'
                ? '好友暱稱已更新'
                : '好友資料已更新';
          notifyToast(updateMessage, { variant: 'success' });
        }
      }
      const tab = typeof getCurrentTab === 'function' ? getCurrentTab() : null;
      if (typeof switchTab === 'function' && tab !== 'contacts') {
        switchTab('contacts');
      }
    } catch (err) {
      console.error('[share-controller]', { contactShareDecryptError: err?.message || err });
    }
  }

  function normalizeGuestBundle(bundle) {
    const normalized = normalizeGuestBundleStrict(bundle);
    return toDrGuestBundle(normalized);
  }

  async function handleContactInitEvent(msg = {}, opts = {}) {
    const inviteId = opts?.inviteId || null;
    const peerDigest = requireAccountDigest(msg?.guestAccountDigest, 'guestAccountDigest', 'InvitePayloadInvalid');
    const peerDeviceId = requireStringField(msg?.guestDeviceId, 'guestDeviceId', 'InvitePayloadInvalid');
    const guestBundleRaw = msg?.guestBundle || null;
    const guestProfileRaw = msg?.guestProfile || null;
    const normalizedBundle = normalizeGuestBundleStrict(guestBundleRaw);
    const guestProfile = normalizeGuestProfileSnapshot(guestProfileRaw);
    const profileUpdatedAt = guestProfile.updatedAt || guestProfile.addedAt || Date.now();
    const profileNickname = normalizeNickname(guestProfile.nickname || '') || null;
    const hasProfileAvatar = guestProfile.avatar !== null && guestProfile.avatar !== undefined;
    const profileAvatar = hasProfileAvatar ? guestProfile.avatar : null;
    const drGuestBundle = toDrGuestBundle(normalizedBundle);
    const selfDeviceId = ensureDeviceId();
    if (!selfDeviceId) {
      throw invitePayloadError('InvitePayloadInvalid', 'self deviceId missing');
    }
    const targetDeviceId = selfDeviceId;
    const directionComputed = selfDeviceId === targetDeviceId ? 'incoming' : 'unknown';
    if (queueNoiseEnabled) {
      logMsgEvent('contact-init:device-check', {
        conversationId: null,
        messageId: msg?.messageId || null,
        senderDeviceId: peerDeviceId || null,
        targetDeviceId: targetDeviceId || null,
        selfDeviceId: selfDeviceId || null,
        peerDeviceId: peerDeviceId || null,
        directionComputed
      });
    }
    if (selfDeviceId && peerDeviceId && selfDeviceId === peerDeviceId) {
      throw new Error('SELF_DEVICE_ID_CORRUPTED: selfDeviceId equals peerDeviceId');
    }
    const devicePriv = await ensureDevicePrivLoaded();
    const preflightState = await x3dhRespond(devicePriv, drGuestBundle);
    if (!(preflightState?.rk instanceof Uint8Array)) {
      throw new Error('contact-init preflight missing rk');
    }
    const conversationContext = await deriveConversationContextFromSecret(preflightState.rk, { deviceId: targetDeviceId });
    const conversation = {
      conversation_id: conversationContext.conversationId,
      token_b64: conversationContext.tokenB64,
      peerDeviceId: peerDeviceId,
      dr_init: { guest_bundle: normalizedBundle, role: 'initiator' }
    };
    const existingEntries = findContactCoreByAccountDigest(peerDigest);
    const existingMatch = existingEntries.length ? existingEntries[0] : null;
    const existingConversationId = existingMatch?.entry?.conversationId || null;
    const existingConversationToken = existingMatch?.entry?.conversationToken || null;
    const existingPeerDeviceId = existingMatch?.entry?.peerDeviceId
      || (typeof existingMatch?.peerKey === 'string' && existingMatch.peerKey.includes('::')
        ? existingMatch.peerKey.split('::')[1]
        : null);
    const incomingConversationId = conversation.conversation_id || null;
    const incomingConversationToken = conversation.token_b64 || null;
    const convMatch = !!(existingConversationId && incomingConversationId && existingConversationId === incomingConversationId);
    const tokenMatch = !!(existingConversationToken && incomingConversationToken && existingConversationToken === incomingConversationToken);
    let policy = 'C';
    let action = 'create';
    if (existingEntries.length > 0) {
      if (existingEntries.length > 1) {
        policy = 'B';
        action = 'hardblock';
      } else if (convMatch && tokenMatch) {
        policy = 'A';
        action = (existingPeerDeviceId && existingPeerDeviceId !== peerDeviceId) ? 'migrate' : 'create';
      } else {
        policy = 'B';
        action = 'hardblock';
      }
    }
    logCapped('contactCoreMismatchTrace', {
      inviteId,
      policyDecision: policy,
      peerAccountDigest: peerDigest,
      fromPeerDeviceId: existingPeerDeviceId || null,
      toPeerDeviceId: peerDeviceId || null,
      convIdMatch: convMatch,
      tokenMatch,
      peerDigest,
      incomingPeerDeviceId: peerDeviceId || null,
      existingPeerDeviceId,
      incomingConversationId,
      existingConversationId,
      convMatch,
      policy,
      action
    }, 5);
    if (policy === 'B') {
      const err = new Error('ContactCoreConflict');
      err.code = 'ContactCoreConflict';
      err.name = 'InviteConsumeConflict';
      err.inviteId = inviteId;
      throw err;
    }
    console.log('[share-controller]', { contactInitReceived: { peerDigest, peerDeviceId, conversationId: null } });
    const existingHolder = drState({ peerAccountDigest: peerDigest, peerDeviceId });
    const hasExistingRk = existingHolder?.rk instanceof Uint8Array;
    if (!hasExistingRk) {
      clearDrState(
        { peerAccountDigest: peerDigest, peerDeviceId },
        { __drDebugTag: 'web/src/app/ui/mobile/share-controller.js:1125:contact-init-handler-clear' }
      );
    }
    // 只有 owner/responder 端（對端裝置等於本機）才允許 responder bootstrap。
    console.log('[responder-bootstrap:enter]', {
      selfDeviceId: selfDeviceId || null,
      peerDeviceId: peerDeviceId || null,
      targetDeviceId: targetDeviceId || null
    });
    if (selfDeviceId && targetDeviceId && selfDeviceId === targetDeviceId && !hasExistingRk) {
      await bootstrapDrFromGuestBundle({
        peerAccountDigest: peerDigest,
        peerDeviceId,
        guestBundle: drGuestBundle,
        force: true
      });
    }
    const responderHolder = drState({ peerAccountDigest: peerDigest, peerDeviceId });
    if (!(responderHolder?.rk instanceof Uint8Array)) {
      console.error('[responder-bootstrap:invalid-rk]', {
        peerAccountDigest: peerDigest,
        peerDeviceId,
        callsite: 'contact-init-handler',
        rkType: responderHolder?.rk?.constructor?.name || typeof responderHolder?.rk || null,
        rkIsView: ArrayBuffer.isView(responderHolder?.rk),
        rkByteLength: typeof responderHolder?.rk?.byteLength === 'number' ? responderHolder.rk.byteLength : null
      });
      throw new Error('responder bootstrap missing rk');
    }
    console.log('[responder-bootstrap-ok]', {
      peerAccountDigest: peerDigest,
      peerDeviceId,
      callsite: 'contact-init-handler',
      rkByteLength: responderHolder.rk?.byteLength ?? null
    });
    if (responderHolder?.baseKey) {
      responderHolder.baseKey.conversationId = conversation.conversation_id;
      await persistDrSnapshot({ peerAccountDigest: peerDigest, peerDeviceId, state: responderHolder });
    }
    if (policy === 'A' && action === 'migrate' && existingMatch && existingPeerDeviceId) {
      const migrated = migrateContactCorePeerDevice({
        peerAccountDigest: peerDigest,
        fromPeerDeviceId: existingPeerDeviceId,
        toPeerDeviceId: peerDeviceId,
        sourceTag: 'share-controller:contact-init-received'
      });
      if (!migrated) {
        const err = new Error('ContactCoreConflict');
        err.code = 'ContactCoreConflict';
        err.name = 'InviteConsumeConflict';
        err.inviteId = inviteId;
        throw err;
      }
      logCapped('contactCorePeerDeviceMigrated', {
        inviteId,
        policyDecision: 'A',
        peerAccountDigest: peerDigest,
        fromPeerDeviceId: existingPeerDeviceId,
        toPeerDeviceId: peerDeviceId,
        convIdMatch: convMatch,
        tokenMatch,
        conversationId: conversation.conversation_id || null,
        peerDigest
      }, 5);
      const existingPeerKey = existingMatch.peerKey
        || (peerDigest && existingPeerDeviceId ? `${peerDigest}::${existingPeerDeviceId}` : null);
      const selfDeviceIdForSecrets = ensureDeviceId();
      if (existingPeerKey && selfDeviceIdForSecrets) {
        setContactSecret(existingPeerKey, {
          peerDeviceId,
          deviceId: selfDeviceIdForSecrets,
          meta: { source: 'share-controller:contact-init-received' }
        });
      }
    }
    try {
      if (contactCoreVerbose) {
        console.log('[contact-core] pre-upsert', {
          sourceTag: 'share-controller:contact-init-received',
          peerKey: peerDigest && peerDeviceId ? `${peerDigest}::${peerDeviceId}` : null,
          peerAccountDigest: peerDigest || null,
          peerDeviceId: peerDeviceId || null,
          conversationId: conversation.conversation_id || null,
          hasToken: !!conversation.token_b64
        });
      }
    } catch { }
    const contactCorePayload = {
      peerAccountDigest: peerDigest,
      peerDeviceId: peerDeviceId || null,
      conversationId: conversation.conversation_id,
      conversationToken: conversation.token_b64,
      conversation,
      profileUpdatedAt
    };
    if (profileNickname) contactCorePayload.nickname = profileNickname;
    if (hasProfileAvatar) contactCorePayload.avatar = profileAvatar;
    upsertContactCore(contactCorePayload, 'share-controller:contact-init-received');

    // [Phase 30] Host Contact Persistence
    // Uplink to D1 so it survives re-login.
    uplinkContactToD1(contactCorePayload).catch(err => {
      console.warn('[share-controller] failed to uplink contact-init', err);
    });
    try {
      const profilePayload = {
        updatedAt: profileUpdatedAt,
        sourceTag: PROFILE_WRITE_SOURCE.PROFILE_SNAPSHOT
      };
      if (profileNickname) profilePayload.nickname = profileNickname;
      if (hasProfileAvatar) profilePayload.avatar = profileAvatar;
      if (profilePayload.nickname || Object.prototype.hasOwnProperty.call(profilePayload, 'avatar')) {
        await persistProfileForAccount(profilePayload, peerDigest);
      }
    } catch (err) {
      log({ contactInitProfilePersistError: err?.message || err, peerAccountDigest: peerDigest });
    }
    storeContactSecretMapping({
      peerAccountDigest: peerDigest,
      peerDeviceId, // 這裡代表對端（guest）的裝置
      sessionKey: conversation.token_b64,
      conversation,
      // [FIX] Pass the bootstrapped DR state!
      // Previously 'null' wiped the session from disk (if setContactSecret strictly replaced).
      // Even with merge, passing 'responderHolder' ensures the 'responder' role is persisted.
      drState: responderHolder,
      role: 'owner'
    });
    try {
      await sendContactShare({
        peerAccountDigest: peerDigest,
        conversation,
        sessionKey: conversation.token_b64,
        peerDeviceId,
        drInit: conversation.dr_init || null,
        reason: 'invite-consume'
      });
    } catch (err) {
      log({ contactInitShareError: err?.message || err, peerAccountDigest: peerDigest });
    }

    // [FIX] Backup contact-secrets (incl. DR state) to server immediately
    // Without this, closing before any message exchange loses the DR session on restore
    triggerContactSecretsBackup('invite-consume', { force: true })
      .catch(err => console.warn('[share-controller] owner backup failed', err));

    if (inviteId) {
      invitesConfirm({ inviteId }).catch(err =>
        console.warn('[share-controller] invite confirm failed', err)
      );
    }

    return {
      inviteId,
      peerDigest,
      peerDeviceId,
      conversationId: conversation.conversation_id || null
    };
  }

  async function consumeInviteDropbox(inviteId, { source = 'manual' } = {}) {
    const id = String(inviteId || '').trim();
    if (!id) throw new Error('inviteId required');
    const existing = pendingInviteConsumes.get(id);
    if (existing) return existing;
    const task = (async () => {
      logCapped('inviteConsumeStart', { inviteId: id }, LOG_CAP);
      console.log('[share-controller]', `[invite-consume] start=${JSON.stringify({ inviteId: id, source })}`);
      const invite = shareState.currentInvite;
      if (invite && isInviteExpired(invite)) {
        throw new Error('邀請已過期，無法取回');
      }
      setInviteActionState({ hasInvite: !!invite, expired: false, loading: true });
      if (source === 'manual') {
        setInviteStatus('取回邀請中…', { loading: true });
      }
      try {
        const devicePriv = await ensureDevicePrivLoaded();
        if (!devicePriv?.spk_priv_b64) {
          throw new Error('裝置私鑰缺失，無法解密邀請');
        }
        const res = await invitesConsume({ inviteId: id });
        const envelope = res?.ciphertext_envelope || null;
        if (!envelope) {
          throw new Error('伺服器回傳內容不完整');
        }
        let payload = null;
        try {
          payload = await openInviteEnvelope({
            ownerPrivateKeyB64: devicePriv.spk_priv_b64,
            envelope
          });
        } catch (err) {
          throw invitePayloadError('InviteEnvelopeInvalid', err?.message || 'invite envelope invalid');
        }
        const normalized = normalizeContactInitPayload(payload);
        const msg = {
          guestAccountDigest: normalized.guestAccountDigest,
          guestDeviceId: normalized.guestDeviceId,
          guestBundle: normalized.guestBundle,
          guestProfile: normalized.guestProfile
        };
        const initResult = await handleContactInitEvent(msg, { inviteId: id });
        const refreshMeta = {
          inviteId: id,
          peerDigestSuffix4: safeSuffix(initResult?.peerDigest || '', 4),
          peerDeviceSuffix4: safeSuffix(initResult?.peerDeviceId || '', 4),
          conversationIdPrefix8: safePrefix(initResult?.conversationId || '', 8)
        };
        logCapped('inviteConsumeContactRefreshTrigger', { ...refreshMeta, stage: 'before' }, LOG_CAP);
        let refreshDispatchOk = false;
        let refreshDispatchError = null;
        try {
          document.dispatchEvent(new CustomEvent('contacts:refresh-after-consume', {
            detail: { inviteId: id }
          }));
          refreshDispatchOk = true;
        } catch (err) {
          refreshDispatchError = err?.message || err;
        }
        logCapped('inviteConsumeContactRefreshTrigger', {
          ...refreshMeta,
          stage: 'after',
          dispatchOk: refreshDispatchOk,
          error: refreshDispatchError
        }, LOG_CAP);
        logCapped('inviteConsumeResult', { inviteId: id, ok: true }, LOG_CAP);
        console.log('[share-controller]', `[invite-consume] result=${JSON.stringify({ inviteId: id, ok: true })}`);
        setInviteActionState({ hasInvite: !!invite, expired: false, loading: false });
        if (source === 'manual') {
          setInviteStatus('已取回邀請', { loading: false });
        }
        if (pairingState.open) {
          closePairingCodeModal();
        }
        if (shareState.open && source !== 'manual') {
          const tab = typeof getCurrentTab === 'function' ? getCurrentTab() : null;
          if (typeof switchTab === 'function' && tab !== 'contacts') {
            switchTab('contacts');
          }
          closeShareModal();
          logCapped('inviteConsumeUiExit', { inviteId: id, source }, LOG_CAP);
        }
        return msg;
      } catch (err) {
        const errorCode = err?.code || err?.data?.error || err?.data?.code || null;
        logCapped('inviteConsumeResult', {
          inviteId: id,
          ok: false,
          status: Number(err?.status || err?.response?.status || 0) || null,
          errorCode: errorCode ? String(errorCode) : null
        }, LOG_CAP);
        console.log('[share-controller]', `[invite-consume] result=${JSON.stringify({
          inviteId: id,
          ok: false,
          status: Number(err?.status || err?.response?.status || 0) || null,
          code: err?.code || err?.data?.error || err?.data?.code || null,
          error: err?.message || String(err)
        })}`);
        setInviteActionState({ hasInvite: !!invite, expired: false, loading: false });
        throw err;
      }
    })();
    pendingInviteConsumes.set(id, task);
    try {
      return await task;
    } finally {
      pendingInviteConsumes.delete(id);
    }
  }

  function normalizeInviteOwnerBundle(bundle) {
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
      throw invitePayloadError('InviteQrBundleInvalid', 'invite prekey bundle required');
    }
    const aliasKeys = new Set(['ik_pub', 'spk_pub', 'spk_sig', 'opk_id', 'opk_pub', 'opk', 'spkSigB64']);
    assertNoAliasKeys(bundle, aliasKeys, 'InviteQrBundleInvalid');
    const allowed = new Set(['ikPubB64', 'spkPubB64', 'signatureB64', 'opkId', 'opkPubB64', 'ekPubB64']);
    assertNoExtraKeys(bundle, allowed, 'InviteQrBundleInvalid');
    const ikPubB64 = requireStringField(bundle.ikPubB64, 'prekeyBundle.ikPubB64', 'InviteQrBundleInvalid');
    const spkPubB64 = requireStringField(bundle.spkPubB64, 'prekeyBundle.spkPubB64', 'InviteQrBundleInvalid');
    const signatureB64 = requireStringField(bundle.signatureB64, 'prekeyBundle.signatureB64', 'InviteQrBundleInvalid');
    let ekPubB64 = null;
    if (Object.prototype.hasOwnProperty.call(bundle, 'ekPubB64')) {
      ekPubB64 = requireStringField(bundle.ekPubB64, 'prekeyBundle.ekPubB64', 'InviteQrBundleInvalid');
    }
    const opkIdRaw = bundle.opkId;
    if (opkIdRaw === null || opkIdRaw === undefined || opkIdRaw === '') {
      throw invitePayloadError('InviteQrBundleInvalid', 'prekeyBundle.opkId required');
    }
    const opkId = Number(opkIdRaw);
    if (!Number.isFinite(opkId) || opkId < 0) {
      throw invitePayloadError('InviteQrBundleInvalid', 'prekeyBundle.opkId invalid');
    }
    const opkPubB64 = requireStringField(bundle.opkPubB64, 'prekeyBundle.opkPubB64', 'InviteQrBundleInvalid');
    return {
      ikPubB64,
      spkPubB64,
      signatureB64,
      opkId,
      opkPubB64,
      ...(ekPubB64 ? { ekPubB64 } : null)
    };
  }

  function mapOwnerBundleToX3dh(bundle = {}) {
    const ik_pub = requireStringField(bundle.ikPubB64, 'prekeyBundle.ikPubB64', 'InviteQrBundleInvalid');
    const spk_pub = requireStringField(bundle.spkPubB64, 'prekeyBundle.spkPubB64', 'InviteQrBundleInvalid');
    const spk_sig = requireStringField(bundle.signatureB64, 'prekeyBundle.signatureB64', 'InviteQrBundleInvalid');
    const opkIdRaw = bundle.opkId;
    if (opkIdRaw === null || opkIdRaw === undefined || opkIdRaw === '') {
      throw invitePayloadError('InviteQrBundleInvalid', 'prekeyBundle.opkId required');
    }
    const opkId = Number(opkIdRaw);
    if (!Number.isFinite(opkId) || opkId < 0) {
      throw invitePayloadError('InviteQrBundleInvalid', 'prekeyBundle.opkId invalid');
    }
    const opkPubB64 = requireStringField(bundle.opkPubB64, 'prekeyBundle.opkPubB64', 'InviteQrBundleInvalid');
    return {
      ik_pub,
      spk_pub,
      spk_sig,
      opk: { id: opkId, pub: opkPubB64 }
    };
  }

  function buildGuestBundleForAccept(devicePriv, ekPair, opkMeta) {
    const opkId = opkMeta?.id ?? null;
    const opkPubB64 = opkMeta?.pub ?? null;
    if (opkId === null || opkId === undefined || !opkPubB64) {
      throw new Error('opk required for guest bundle');
    }
    return {
      ikPubB64: devicePriv.ik_pub_b64,
      spkPubB64: devicePriv.spk_pub_b64,
      signatureB64: devicePriv.spk_sig_b64,
      ekPubB64: b64(ekPair?.publicKey || new Uint8Array()),
      opkId,
      opkPubB64
    };
  }

  async function ensureDevicePrivLoaded() {
    try {
      return await ensureDevicePrivAvailable();
    } catch (err) {
      const msg = err?.message || '找不到裝置金鑰，請重新登入完成初始化';
      throw new Error(msg);
    }
  }

  function restartInviteScannerWithMessage(message) {
    if (inviteScanStatus) inviteScanStatus.textContent = message;
    startInviteScanner();
  }

  function enqueueContactBroadcast(params = {}) {
    const { digest, peerDeviceId, conversation, sessionKey, drInit, reason, overrides } = params;
    if (!digest || !conversation || !sessionKey || !peerDeviceId) return null;
    const overridesCopy = overrides && typeof overrides === 'object' ? { ...overrides } : null;
    const payload = { digest, peerDeviceId, conversation, sessionKey, drInit, reason, overrides: overridesCopy };
    let pending = pendingContactUpdates.get(digest) || null;
    let resolveFn = pending?.resolve;
    let rejectFn = pending?.reject;
    const promise = pending?.promise || new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    if (!resolveFn && pending?.resolve) resolveFn = pending.resolve;
    if (!rejectFn && pending?.reject) rejectFn = pending.reject;
    if (pending?.timer) clearTimeout(pending.timer);
    const entry = {
      payload,
      promise,
      resolve: resolveFn,
      reject: rejectFn,
      timer: null
    };
    entry.timer = setTimeout(async () => {
      pendingContactUpdates.delete(digest);
      const MAX_RETRIES = 3;
      const sendParams = {
        peerAccountDigest: payload.digest,
        conversation: payload.conversation,
        sessionKey: payload.sessionKey,
        peerDeviceId: payload.peerDeviceId,
        drInit: payload.drInit,
        overrides: payload.overrides,
        reason: payload.reason
      };
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          if (attempt > 0) {
            // Exponential backoff: 2s, 4s
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
          }
          await sendContactShare(sendParams);
          entry.resolve?.(true);
          return;
        } catch (err) {
          console.error('[share-controller]', {
            contactBroadcastError: err?.message || err,
            peerAccountDigest: payload.digest,
            peerDeviceId: payload.peerDeviceId,
            reason: payload.reason,
            attempt: attempt + 1,
            maxRetries: MAX_RETRIES
          });
          if (attempt === MAX_RETRIES - 1) {
            entry.reject?.(err);
          }
        }
      }
    }, CONTACT_BROADCAST_DEBOUNCE_MS);
    pendingContactUpdates.set(digest, entry);
    return promise;
  }

  async function broadcastContactUpdate({ reason = 'manual', targetPeers = null, overrides = null } = {}) {
    const reasonKey = typeof reason === 'string' ? reason.toLowerCase() : 'manual';
    const map = restoreContactSecrets();
    if (!(map instanceof Map)) return;
    const targetSet = Array.isArray(targetPeers) && targetPeers.length
      ? new Set(
        targetPeers
          .map((p) => normalizePeerIdentity(p).key)
          .filter(Boolean)
      )
      : null;
    const deviceId = ensureDeviceId();
    const tasks = [];
    for (const peerKey of map.keys()) {
      const identity = normalizePeerIdentity(peerKey);
      const digest = identity.key;
      if (!digest) continue;
      if (targetSet && !targetSet.has(digest)) continue;
      const record = getContactSecret(digest, { deviceId });
      if (!record) continue;
      const token = record.conversationToken || record.conversation?.token || null;
      const convId = record.conversationId || record.conversation?.id || null;
      const peerDeviceId = record.peerDeviceId || identity.deviceId || null;
      if (!token || !convId || !peerDeviceId) {
        console.warn('[share-controller] broadcastContactUpdate: skipping peer (missing fields)', {
          digest: digest?.slice(0, 12),
          hasToken: !!token,
          hasConvId: !!convId,
          hasPeerDeviceId: !!peerDeviceId,
          reason: reasonKey
        });
        continue;
      }
      const drInit = record.conversationDrInit || record.conversation?.drInit || null;
      const conversation = {
        token_b64: token,
        conversation_id: convId,
        dr_init: drInit,
        peerDeviceId
      };
      const overridesCopy = overrides && typeof overrides === 'object' ? { ...overrides } : null;
      try {
        console.log('[share-controller]', {
          contactBroadcastEntry: {
            peerAccountDigest: digest,
            peerDeviceId,
            conversationId: convId,
            hasDrInit: !!drInit,
            reason: reasonKey,
            debounceMs: CONTACT_BROADCAST_DEBOUNCE_MS
          }
        });
      } catch { }
      const promise = enqueueContactBroadcast({
        digest,
        peerDeviceId,
        conversation,
        sessionKey: token,
        drInit,
        overrides: overridesCopy,
        reason: reasonKey
      });
      if (promise) tasks.push(promise);
    }
    if (tasks.length) {
      await Promise.allSettled(tasks);
    }
  }

  /**
   * Replay a delivery intent: re-derive the scanner-side session from stored material.
   * Called by the reconciler when the app crashed after deliver but before local processing.
   */
  async function replayDeliveryIntent(intent) {
    const {
      inviteId,
      ownerAccountDigest,
      ownerDeviceId,
      ownerBundle: storedOwnerBundle,
      ekPrivB64,
      ekPubB64,
      guestBundle: storedGuestBundle,
      guestProfile: storedGuestProfile
    } = intent || {};
    if (!inviteId || !ownerAccountDigest || !ownerDeviceId || !storedOwnerBundle || !ekPrivB64 || !ekPubB64) {
      throw new Error('replayDeliveryIntent: missing required fields');
    }
    const resolvedOwnerDigest = ownerAccountDigest;
    const resolvedOwnerDeviceId = ownerDeviceId;
    if (!resolvedOwnerDigest || !resolvedOwnerDeviceId) {
      throw new Error('replayDeliveryIntent: invalid owner identity');
    }

    const devicePriv = await ensureDevicePrivLoaded();
    if (!devicePriv) throw new Error('replayDeliveryIntent: device key unavailable');

    const ekPair = { priv: ekPrivB64, pub: ekPubB64 };
    const ownerBundleForInit = mapOwnerBundleToX3dh(storedOwnerBundle);
    const initiatorState = await x3dhInitiate(devicePriv, ownerBundleForInit, ekPair);
    if (!(initiatorState?.rk instanceof Uint8Array)) {
      throw new Error('replayDeliveryIntent: x3dh missing rk');
    }

    const conversationContext = await deriveConversationContextFromSecret(initiatorState.rk, { deviceId: resolvedOwnerDeviceId });
    const conversationId = conversationContext?.conversationId || null;
    const conversationToken = conversationContext?.tokenB64 || null;
    if (!conversationId || !conversationToken) {
      throw new Error('replayDeliveryIntent: missing conversation context');
    }

    const drInitPayload = storedGuestBundle
      ? { guest_bundle: storedGuestBundle, role: 'initiator' }
      : null;
    const conversationPayload = {
      token_b64: conversationToken,
      conversation_id: conversationId,
      peerDeviceId: resolvedOwnerDeviceId,
      ...(drInitPayload ? { dr_init: drInitPayload } : null)
    };

    const conversationIndex = ensureConversationIndex();
    const prevConvEntry = conversationIndex.get(conversationId) || {};
    conversationIndex.set(conversationId, {
      ...prevConvEntry,
      token_b64: conversationToken,
      peerAccountDigest: resolvedOwnerDigest,
      peerDeviceId: resolvedOwnerDeviceId,
      dr_init: prevConvEntry.dr_init || drInitPayload || null
    });

    const drHolder = drState({ peerAccountDigest: resolvedOwnerDigest, peerDeviceId: resolvedOwnerDeviceId });
    if (drHolder && !(drHolder.rk instanceof Uint8Array)) {
      copyDrState(drHolder, initiatorState, { callsiteTag: 'delivery-intent-replay' });
    }
    if (drHolder) {
      drHolder.baseKey = drHolder.baseKey || {};
      if (!drHolder.baseKey.role) drHolder.baseKey.role = 'initiator';
      if (!drHolder.baseKey.conversationId) drHolder.baseKey.conversationId = conversationId;
      if (!drHolder.baseKey.peerAccountDigest) drHolder.baseKey.peerAccountDigest = resolvedOwnerDigest;
      if (!drHolder.baseKey.peerDeviceId) drHolder.baseKey.peerDeviceId = resolvedOwnerDeviceId;
    }

    storeContactSecretMapping({
      peerAccountDigest: resolvedOwnerDigest,
      peerDeviceId: resolvedOwnerDeviceId,
      sessionKey: conversationToken,
      conversation: conversationPayload,
      drState: drHolder,
      role: 'initiator'
    });

    uplinkContactToD1({
      peerAccountDigest: resolvedOwnerDigest,
      conversation: conversationPayload
    }).catch(err => console.warn('[share-controller] delivery-intent replay uplink failed', err));

    triggerContactSecretsBackup('delivery-intent-replay', { force: true, allowWithoutDrState: true })
      .catch(err => console.warn('[share-controller] delivery-intent replay backup failed', err));

    removeDeliveryIntent(inviteId);

    logCapped('deliveryIntentReplayed', {
      inviteId,
      conversationIdPrefix8: conversationId?.slice(0, 8) || null,
      ownerDigestSuffix4: resolvedOwnerDigest?.slice(-4) || null
    }, 5);

    return { inviteId, conversationId, peerDigest: resolvedOwnerDigest };
  }

  return {
    openShareModal,
    closeShareModal,
    showShareMode,
    handleInviteScan,
    consumeInviteDropbox,
    handleContactShareEvent,
    handleContactInitEvent,
    replayDeliveryIntent,
    broadcastContactUpdate,
    openPairingCodeModal,
    closePairingCodeModal,
    setWsSend(fn) {
      wsTransport = typeof fn === 'function' ? fn : null;
    }
  };

  profileInitPromise?.catch(() => { });
}
