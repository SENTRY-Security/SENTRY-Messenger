import { friendsCreateInvite, friendsAcceptInvite, friendsAttachInviteContact, parseFriendInvite, friendsShareContactUpdate } from '../../api/friends.js';
import { encodeFriendInvite } from '../../lib/invite.js';
import { generateQR } from '../../lib/qr.js';
import QrScanner from '../../lib/vendor/qr-scanner.min.js';
import { log } from '../../core/log.js';
import { devkeysFetch } from '../../api/devkeys.js';
import { unwrapDevicePrivWithMK } from '../../crypto/prekeys.js';
import { x3dhInitiate } from '../../crypto/dr.js';
import { b64 } from '../../crypto/nacl.js';
import { getUidHex, getMkRaw, getDevicePriv, setDevicePriv } from '../../core/store.js';
import { generateRandomNickname } from '../../features/profile.js';
import { deriveConversationContextFromSecret } from '../../features/conversation.js';
import { encryptContactPayload, decryptContactPayload } from '../../features/contact-share.js';
import { restoreContactSecrets, setContactSecret, deleteContactSecret, getContactSecret } from '../../core/contact-secrets.js';
import { sessionStore } from './session-store.js';
import { primeDrStateFromInitiator, bootstrapDrFromGuestBundle } from '../../features/dr-session.js';

const INVITE_SECRET_STORAGE_KEY = 'inviteSecrets-v1';

export function setupShareController(options) {
  const {
    dom,
    inviteSecrets,
    shareState,
    getProfileState,
    profileInitPromise,
    ensureAvatarThumbnail,
    addContactEntry,
    switchTab,
    updateProfileStats,
    getCurrentTab,
    showToast: showToastOption
  } = options;

  const notifyToast = typeof showToastOption === 'function' ? showToastOption : null;

  if (!dom) throw new Error('share controller requires dom references');
  restoreContactSecrets();

  function storeContactSecretMapping({ peerUid, inviteId, secret, role, conversation }) {
    if (!peerUid || !inviteId || !secret) return;
    let conversationToken = null;
    let conversationId = null;
    if (conversation) {
      conversationToken = conversation.tokenB64 || conversation.token_b64 || null;
      conversationId = conversation.conversationId || conversation.conversation_id || null;
    }
    setContactSecret(peerUid, { inviteId, secret, role, conversationToken, conversationId });
  }

  function getSecretForPeer(peerUid) {
    if (!peerUid) return null;
    return getContactSecret(peerUid);
  }
  const {
    inviteCountdownEl,
    inviteQrBox,
    btnShareModal,
    shareModal,
    shareModalBackdrop,
    btnShareSwitchScan,
    btnShareSwitchQr,
    shareFlip,
    inviteScanVideo,
    inviteScanStatus
  } = dom;

  shareState.mode = shareState.mode || 'qr';
  shareState.open = shareState.open || false;
  shareState.currentInvite = null;
  shareState.inviteTimerId = shareState.inviteTimerId || null;
  shareState.scanner = shareState.scanner || null;
  shareState.scannerActive = shareState.scannerActive || false;
  shareState.scannerOpen = shareState.scannerOpen || false;

  if (shareModal) shareModal.setAttribute('data-share-mode', shareState.mode);

  const shareModalCloseButtons = shareModal
    ? Array.from(shareModal.querySelectorAll('[data-share-close-btn]'))
    : [];

  const shareBackdrop = shareModalBackdrop || (shareModal ? shareModal.querySelector('.modal-backdrop') : null);

  if (btnShareModal) btnShareModal.addEventListener('click', () => openShareModal('qr'));
  shareBackdrop?.addEventListener('click', closeShareModal);
  btnShareSwitchQr?.addEventListener('click', () => showShareMode('qr'));
  btnShareSwitchScan?.addEventListener('click', () => showShareMode('scan'));
  shareModalCloseButtons.forEach((btn) => btn.addEventListener('click', closeShareModal));

  document.addEventListener('keydown', handleEscapeKey);
  ensureQrPlaceholder();

  const AUTO_REFRESH_BUFFER_MS = 5_000;

  function isInviteActive(invite) {
    if (!invite || !Number.isFinite(invite.expiresAt)) return false;
    return invite.expiresAt * 1000 - Date.now() > AUTO_REFRESH_BUFFER_MS;
  }

  function getStoredActiveInvite() {
    let freshest = null;
    for (const [inviteId, record] of inviteSecrets.entries()) {
      if (!record || record.role !== 'owner' || !record.secret) continue;
      const expiresAt = Number(record.expiresAt ?? record.expires_at ?? 0);
      if (!Number.isFinite(expiresAt) || expiresAt * 1000 <= Date.now()) continue;
      if (!freshest || expiresAt > freshest.expiresAt) {
        freshest = {
          inviteId: String(inviteId),
          secret: String(record.secret),
          expiresAt,
          ownerUid: record.ownerUid ? String(record.ownerUid).toUpperCase() : null,
          prekeyBundle: record.prekeyBundle || null,
          conversationToken: record.conversationToken || null,
          conversationId: record.conversationId || null
        };
      }
    }
    return freshest;
  }

  async function ensureActiveInvite({ force = false } = {}) {
    if (!shareModal) return;
    if (!shareState.currentInvite || force) {
      const stored = getStoredActiveInvite();
      if (stored) shareState.currentInvite = stored;
    }
    if (shareState.currentInvite && !force && isInviteActive(shareState.currentInvite)) {
      renderInviteQr(shareState.currentInvite);
      startInviteCountdown(shareState.currentInvite.expiresAt);
      return;
    }
    await onGenerateInvite({ auto: true });
  }

  return {
    persistInviteSecrets,
    restoreInviteSecrets,
    clearInviteSecrets,
    handleContactShareEvent,
    openShareModal,
    closeShareModal,
    showShareMode,
    handleInviteScan,
    broadcastContactUpdate,
    removeContactSecret: (peerUid) => deleteContactSecret(peerUid),
    getCurrentInvite: () => shareState.currentInvite
  };

  function handleEscapeKey(e) {
    if (e.key === 'Escape' && shareState.open) closeShareModal();
  }

  async function onGenerateInvite({ auto = false } = {}) {
    const uid = getUidHex();
    if (!uid) {
      setInviteStatus('尚未登入，無法生成 QR，請重新登入後再試。', true);
      return;
    }

    setInviteStatus(auto ? '更新交友邀請中…' : '建立交友邀請中…');
    clearInviteView();
    log('invite: begin create');

    try {
      const invite = await friendsCreateInvite({ uidHex: uid });
      log({ inviteCreateFetched: true });
      if (!invite || !invite.inviteId || !invite.secret || !invite.expiresAt) {
        throw new Error('伺服器回傳內容不完整');
      }
      log({ inviteCreateResponse: invite });

      const conversation = await deriveConversationContextFromSecret(invite.secret);

      shareState.currentInvite = {
        inviteId: String(invite.inviteId),
        secret: String(invite.secret),
        expiresAt: Number(invite.expiresAt),
        ownerUid: String(invite.ownerUid || uid).toUpperCase(),
        prekeyBundle: invite.prekeyBundle || null,
        conversationToken: conversation.tokenB64,
        conversationId: conversation.conversationId
      };
      inviteSecrets.set(shareState.currentInvite.inviteId, {
        secret: shareState.currentInvite.secret,
        role: 'owner',
        ownerUid: shareState.currentInvite.ownerUid,
        prekeyBundle: shareState.currentInvite.prekeyBundle || null,
        expiresAt: shareState.currentInvite.expiresAt,
        conversationToken: shareState.currentInvite.conversationToken,
        conversationId: shareState.currentInvite.conversationId
      });
      persistInviteSecrets();

      await attachInviteOwnerContact(shareState.currentInvite);
      renderInviteQr(shareState.currentInvite);
      startInviteCountdown(shareState.currentInvite.expiresAt);
    } catch (err) {
      const msg = err?.message || String(err);
      log({ inviteError: msg });
      setInviteStatus(`生成失敗：${msg}`, true);
      shareState.currentInvite = null;
    } finally {
      updateProfileStats?.();
    }
  }

  function renderInviteQr(invite) {
    if (!inviteQrBox) return;
    const payload = encodeFriendInvite(invite);
    clearInviteView();
    try {
      const canvas = generateQR(payload, 220);
      if (canvas) {
        removeQrPlaceholder();
        inviteQrBox.appendChild(canvas);
      } else {
        inviteQrBox.textContent = '無法產生 QR，請稍後再試。';
      }
    } catch (err) {
      const msg = err?.message || String(err);
      log({ qrRenderError: msg });
      inviteQrBox.textContent = '生成 QR 時發生錯誤';
    }
  }

  async function attachInviteOwnerContact(invite) {
    if (!invite?.inviteId || !invite?.secret) return;
    const conversation = invite.conversationToken && invite.conversationId
      ? { tokenB64: invite.conversationToken, conversationId: invite.conversationId }
      : null;
    const payload = await buildLocalContactPayload({ conversation });
    try {
      const envelope = await encryptContactPayload(invite.secret, payload);
      await friendsAttachInviteContact({ inviteId: invite.inviteId, secret: invite.secret, envelope });
      log({ inviteContactAttached: invite.inviteId });
    } catch (err) {
      log({ inviteContactAttachError: err?.message || err, inviteId: invite?.inviteId });
    }
  }

  function ensureQrPlaceholder() {
    if (!inviteQrBox) return;
    if (!inviteQrBox.querySelector('.qr-placeholder')) {
      const div = document.createElement('div');
      div.className = 'qr-placeholder';
      div.textContent = '生成交友邀請後會顯示 QR';
      inviteQrBox.appendChild(div);
    }
  }

  function removeQrPlaceholder() {
    if (!inviteQrBox) return;
    const placeholder = inviteQrBox.querySelector('.qr-placeholder');
    if (placeholder) placeholder.remove();
  }

  function setInviteStatus(message, isError = false) {
    if (!inviteCountdownEl) return;
    inviteCountdownEl.textContent = message || '';
    inviteCountdownEl.style.color = isError ? '#ef4444' : '#64748b';
  }

  function startInviteCountdown(expiresAt) {
    stopInviteCountdown();
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
      setInviteStatus('邀請資訊不完整，請重新生成。', true);
      return;
    }
    const tick = () => {
    const remainingMs = Math.floor(expiresAt * 1000 - Date.now());
    if (remainingMs <= 0) {
      stopInviteCountdown();
      shareState.currentInvite = null;
      clearInviteView();
      if (inviteBtn) inviteBtn.textContent = '生成交友邀請';
      if (shareState.open) {
        setInviteStatus('交友邀請已過期，正在重新生成…');
        setTimeout(() => onGenerateInvite({ auto: true }), 220);
      } else {
        setInviteStatus('交友邀請已過期，請重新生成。', true);
      }
      return;
    }
      const seconds = Math.ceil(remainingMs / 1000);
      const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
      const ss = String(seconds % 60).padStart(2, '0');
      setInviteStatus(`交友邀請將在 ${mm}:${ss} 後過期。`);
    };
    tick();
    shareState.inviteTimerId = setInterval(tick, 1000);
  }

  function stopInviteCountdown() {
    if (shareState.inviteTimerId) {
      clearInterval(shareState.inviteTimerId);
      shareState.inviteTimerId = null;
    }
  }

  function clearInviteView() {
    stopInviteCountdown();
    if (inviteQrBox) {
      inviteQrBox.innerHTML = '';
      ensureQrPlaceholder();
    }
  }

  async function ensureInviteScanner() {
    if (shareState.scanner) return shareState.scanner;
    if (!inviteScanVideo) throw new Error('scan video missing');
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
      returnDetailedScanResult: true
    });
    return shareState.scanner;
  }

  async function startInviteScanner() {
    if (!inviteScanStatus) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      inviteScanStatus.textContent = '此裝置不支援相機存取。';
      log('invite scanner not supported');
      shareState.scannerOpen = false;
      return;
    }
    inviteScanStatus.textContent = '請將好友的交友 QR 對準框線';
    try {
      const scanner = await ensureInviteScanner();
      await scanner.start();
      shareState.scannerActive = true;
      shareState.scannerOpen = true;
      log('invite scanner started');
    } catch (err) {
      const msg = err?.message || String(err);
      inviteScanStatus.textContent = `無法開啟相機：${msg}`;
      log({ inviteScannerError: msg });
      shareState.scannerOpen = false;
    }
  }

  async function stopInviteScanner() {
    if (shareState.scanner && shareState.scannerActive) {
      try { await shareState.scanner.stop(); } catch (err) { log({ inviteScannerStopError: err?.message || err }); }
    }
    shareState.scannerActive = false;
    shareState.scannerOpen = false;
    if (inviteScanStatus) inviteScanStatus.textContent = '';
  }

  async function restartInviteScannerWithMessage(message) {
    if (inviteScanStatus) inviteScanStatus.textContent = message;
    await startInviteScanner();
  }

  function openShareModal(defaultMode = 'qr') {
    if (!shareModal) return;
    shareState.open = true;
    shareModal.style.display = 'flex';
    shareModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    if (btnShareModal) {
      btnShareModal.dataset.hiddenByModal = '1';
      btnShareModal.style.visibility = 'hidden';
    }
    const target = defaultMode === 'scan' ? 'scan' : 'qr';
    showShareMode(target);
    ensureActiveInvite().catch((err) => log({ inviteEnsureError: err?.message || err }));
  }

  function closeShareModal() {
    if (!shareModal) return;
    shareState.open = false;
    shareModal.style.display = 'none';
    shareModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    shareModal.removeAttribute('data-share-mode');
    shareFlip?.classList.remove('flipped');
    stopInviteScanner();
    if (btnShareModal && btnShareModal.dataset.hiddenByModal === '1') {
      btnShareModal.style.visibility = '';
      delete btnShareModal.dataset.hiddenByModal;
    }
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
      ensureActiveInvite().catch((err) => log({ inviteEnsureError: err?.message || err }));
    }
  }

  async function handleInviteScan(raw) {
    if (!raw) return;
    log({ inviteScanRaw: raw });
    if (shareState.scanner && shareState.scannerActive) {
      try { await shareState.scanner.stop(); } catch (err) { log({ inviteScannerStopError: err?.message || err }); }
      shareState.scannerActive = false;
    }
    if (inviteScanStatus) inviteScanStatus.textContent = '解析中…';
    try {
      let parsed;
      try {
        parsed = parseFriendInvite(raw);
      } catch (err) {
        log({ inviteScanParseError: err?.message || String(err) });
        parsed = null;
      }
      log({ inviteScanParsed: parsed });
      if (!parsed) throw new Error('無法解析好友邀請內容');
      if (parsed.ownerUid) parsed.ownerUid = String(parsed.ownerUid).toUpperCase();
      const ownerBundle = normalizeInviteOwnerBundle(parsed.prekeyBundle);
      if (!ownerBundle) throw new Error('邀請缺少預共享金鑰資料，請請好友重新生成');

      const conversation = await deriveConversationContextFromSecret(parsed.secret);

      const entry = {
        secret: parsed.secret,
        role: 'guest',
        ownerUid: parsed.ownerUid || null,
        ownerBundle,
        conversationToken: conversation.tokenB64,
        conversationId: conversation.conversationId
      };
      inviteSecrets.set(parsed.inviteId, entry);
      persistInviteSecrets();
      sessionStore.conversationIndex?.set?.(conversation.conversationId, {
        token_b64: conversation.tokenB64,
        peerUid: parsed.ownerUid || null
      });

      const devicePriv = await ensureDevicePrivLoaded();
      if (!devicePriv) throw new Error('找不到裝置金鑰，請重新登入後再試');
      const x3dhState = await x3dhInitiate(devicePriv, ownerBundle);
      const guestBundle = buildGuestBundle(devicePriv, ownerBundle, x3dhState);
      entry.guestBundle = guestBundle;
      inviteSecrets.set(parsed.inviteId, entry);
      persistInviteSecrets();
      sessionStore.conversationIndex?.set?.(conversation.conversationId, {
        token_b64: conversation.tokenB64,
        peerUid: parsed.ownerUid || null,
        dr_init: { guest_bundle: guestBundle, role: 'initiator' }
      });
      let contactEnvelope = null;
      try {
        const payload = await buildLocalContactPayload({
          conversation,
          drInit: { guestBundle, role: 'initiator' }
        });
        contactEnvelope = await encryptContactPayload(parsed.secret, payload);
      } catch (err) {
        log({ contactEnvelopeEncryptError: err?.message || err });
        contactEnvelope = null;
      }
      const res = await friendsAcceptInvite({ inviteId: parsed.inviteId, secret: parsed.secret, contactEnvelope, guestBundle, ownerUid: parsed.ownerUid });
      log({ inviteScanAccepted: res });
      if (res?.owner_uid) {
        let ownerContact = null;
        if (res?.owner_contact?.iv && res?.owner_contact?.ct) {
          try {
            ownerContact = await decryptContactPayload(parsed.secret, res.owner_contact);
          } catch (err) {
            log({ ownerContactDecryptError: err?.message || err });
            ownerContact = null;
          }
        }
        const nickname = ownerContact?.nickname || '';
        const avatar = ownerContact?.avatar || null;
        const conversationInfo = ownerContact?.conversation || {
          token_b64: conversation.tokenB64,
          conversation_id: conversation.conversationId
        };
        await addContactEntry({
          peerUid: res.owner_uid,
          nickname,
          avatar,
          conversation: conversationInfo,
          contactSecret: parsed.secret,
          inviteId: parsed.inviteId,
          secretRole: 'guest'
        });
        try {
          primeDrStateFromInitiator({ peerUidHex: res.owner_uid, state: x3dhState });
        } catch (err) {
          log({ drPrimeError: err?.message || err });
        }
        storeContactSecretMapping({
          peerUid: res.owner_uid,
          inviteId: parsed.inviteId,
          secret: parsed.secret,
          role: 'guest',
          conversation: conversationInfo
        });
      }
      inviteSecrets.delete(parsed.inviteId);
      persistInviteSecrets();
      showShareMode('qr');
      if (inviteScanStatus) inviteScanStatus.textContent = '成功加入好友！';
      switchTab('contacts');
      setTimeout(() => {
        if (shareState.open) closeShareModal();
      }, 1400);
    } catch (err) {
      const msg = err?.message || String(err);
      log({ inviteScanError: msg });
      if (inviteScanStatus) inviteScanStatus.textContent = `無法解析：${msg}`;
      setTimeout(() => {
        if (shareState.open && shareState.mode === 'scan') {
          restartInviteScannerWithMessage('請再試一次，將 QR 置中掃描');
        }
      }, 1600);
    }
  }

  async function handleContactShareEvent(msg) {
    const inviteId = String(msg?.inviteId || '').trim();
    const fromUid = String(msg?.fromUid || '').toUpperCase();
    if (!inviteId || !fromUid) return;
    const record = inviteSecrets.get(inviteId);
    let secret = record?.secret;
    let stored = null;
    if (!secret) {
      stored = getSecretForPeer(fromUid);
      if (stored && stored.inviteId === inviteId && stored.secret) {
        secret = stored.secret;
      }
    }
    if (!secret) {
      log({ contactShareMissingSecret: inviteId, fromUid });
      return;
    }
    const envelope = msg?.envelope;
    if (!envelope?.iv || !envelope?.ct) return;
    try {
      const payload = await decryptContactPayload(secret, envelope);
      let conversation = null;
      if (payload?.conversation && payload.conversation.token_b64 && payload.conversation.conversation_id) {
        conversation = payload.conversation;
      } else if (record?.conversationToken && record?.conversationId) {
        conversation = { token_b64: record.conversationToken, conversation_id: record.conversationId };
      } else if (stored?.conversationToken && stored?.conversationId) {
        conversation = { token_b64: stored.conversationToken, conversation_id: stored.conversationId };
      }
      await addContactEntry({
        peerUid: fromUid,
        nickname: payload.nickname,
        avatar: payload.avatar || null,
        conversation,
        contactSecret: secret,
        inviteId,
        secretRole: record?.role || stored?.role || null
      });
      if (conversation?.conversation_id && conversation?.token_b64) {
        sessionStore.conversationIndex?.set?.(conversation.conversation_id, {
          token_b64: conversation.token_b64,
          peerUid: fromUid,
          dr_init: conversation.dr_init || null
        });
      }
      storeContactSecretMapping({
        peerUid: fromUid,
        inviteId,
        secret,
        role: record?.role || stored?.role || null,
        conversation
      });
      if (conversation?.dr_init?.guest_bundle || conversation?.drInit?.guestBundle) {
        const bundle = conversation.dr_init?.guest_bundle || conversation.drInit?.guestBundle;
        try {
          await bootstrapDrFromGuestBundle({ peerUidHex: fromUid, guestBundle: bundle });
        } catch (err) {
          log({ drBootstrapError: err?.message || err });
        }
      }
      inviteSecrets.delete(inviteId);
      persistInviteSecrets();
      shareState.currentInvite = null;
      try {
        await onGenerateInvite({ auto: true });
      } catch (err) {
        log({ autoInviteRefreshError: err?.message || err });
      }
      if (shareState.open) {
        closeShareModal();
      }
      if (notifyToast) notifyToast('已成功加入好友');
      const tab = typeof getCurrentTab === 'function' ? getCurrentTab() : null;
      if (typeof switchTab === 'function' && tab !== 'contacts') {
        switchTab('contacts');
      }
    } catch (err) {
      log({ contactShareDecryptError: err?.message || err });
    }
  }

  async function broadcastContactUpdate({ reason } = {}) {
    const secretMap = restoreContactSecrets();
    const entries = Array.from(secretMap.entries());
    if (!entries.length) return { total: 0, success: 0, errors: [] };

    let success = 0;
    const errors = [];

    for (const [peerUid, info] of entries) {
      const inviteId = info?.inviteId;
      const secret = info?.secret;
      if (!inviteId || !secret) continue;
      const contactEntry = sessionStore.contactIndex?.get?.(peerUid) || null;
      const conversation = contactEntry?.conversation && contactEntry.conversation.token_b64 && contactEntry.conversation.conversation_id
        ? {
            tokenB64: contactEntry.conversation.token_b64,
            conversationId: contactEntry.conversation.conversation_id,
            dr_init: contactEntry.conversation.dr_init || null
          }
        : (info?.conversationToken && info?.conversationId
            ? {
                tokenB64: info.conversationToken,
                conversationId: info.conversationId
              }
            : null);
      try {
        const payload = await buildLocalContactPayload({ conversation });
        const envelope = await encryptContactPayload(secret, payload);
        await friendsShareContactUpdate({ inviteId, secret, peerUid, envelope });
        storeContactSecretMapping({
          peerUid,
          inviteId,
          secret,
          role: info?.role || null,
          conversation
        });
        success += 1;
      } catch (err) {
        errors.push({ peerUid, error: err });
        log({ contactBroadcastError: err?.message || err, peerUid, reason: reason || null });
      }
    }

    if (success > 0 && notifyToast) {
      const message = reason === 'avatar' ? '好友頭像已更新' : '好友資料已更新';
      notifyToast(message);
    }

    return { total: entries.length, success, errors };
  }

  function persistInviteSecrets() {
    try {
      const payload = JSON.stringify(Array.from(inviteSecrets.entries()));
      sessionStorage.setItem(INVITE_SECRET_STORAGE_KEY, payload);
    } catch (err) {
      log({ inviteSecretPersistError: err?.message || err });
    }
    updateProfileStats?.();
  }

  function restoreInviteSecrets() {
    try {
      const raw = sessionStorage.getItem(INVITE_SECRET_STORAGE_KEY);
      if (!raw) return;
      const items = JSON.parse(raw);
      if (!Array.isArray(items)) return;
      inviteSecrets.clear();
      for (const [inviteId, info] of items) {
        if (!inviteId || !info?.secret) continue;
        const record = {
          secret: String(info.secret),
          role: info.role === 'owner' ? 'owner' : 'guest'
        };
        if (info.ownerUid || info.owner_uid) {
          record.ownerUid = String(info.ownerUid || info.owner_uid || '').trim();
        }
        if (info.prekeyBundle || info.ownerBundle || info.prekey_bundle) {
          record.prekeyBundle = info.prekeyBundle || info.ownerBundle || info.prekey_bundle;
        }
        if (info.guestBundle || info.guest_bundle) {
          record.guestBundle = info.guestBundle || info.guest_bundle;
        }
      if (info.expiresAt || info.expires_at) {
        const ts = Number(info.expiresAt ?? info.expires_at);
        if (Number.isFinite(ts)) record.expiresAt = ts;
      }
      if (info.conversationToken || info.conversation_token) {
        const token = String(info.conversationToken || info.conversation_token || '').trim();
        if (token) record.conversationToken = token;
      }
      if (info.conversationId || info.conversation_id) {
        const cid = String(info.conversationId || info.conversation_id || '').trim();
        if (cid) record.conversationId = cid;
      }
      inviteSecrets.set(String(inviteId), record);
    }
    } catch (err) {
      log({ inviteSecretRestoreError: err?.message || err });
    }
    const stored = getStoredActiveInvite();
    if (stored) shareState.currentInvite = stored;
    updateProfileStats?.();
  }

  function clearInviteSecrets() {
    inviteSecrets.clear();
    shareState.currentInvite = null;
    clearInviteView();
    try { sessionStorage.removeItem(INVITE_SECRET_STORAGE_KEY); } catch (err) { log({ inviteSecretClearError: err?.message || err }); }
    updateProfileStats?.();
  }

  function normalizeDrInit(info) {
    if (!info || typeof info !== 'object') return null;
    if (info.guest_bundle || info.guestBundle) {
      const bundle = info.guest_bundle || info.guestBundle;
      if (!bundle || typeof bundle !== 'object') return null;
      const out = { guest_bundle: bundle };
      if (info.role) out.role = info.role;
      return out;
    }
    return null;
  }

  async function buildLocalContactPayload({ conversation, drInit } = {}) {
    try {
      if (profileInitPromise) await profileInitPromise;
    } catch (err) {
      log({ profileInitAwaitError: err?.message || err });
    }
    const profileState = typeof getProfileState === 'function' ? getProfileState() : null;
    const nickname = profileState?.nickname || '';
    let avatar = null;
    if (profileState?.avatar) {
      avatar = await ensureAvatarThumbnail?.();
      if (avatar) avatar = { ...avatar };
    }
    let conversationInfo = null;
    if (conversation && conversation.tokenB64 && conversation.conversationId) {
      conversationInfo = {
        token_b64: conversation.tokenB64,
        conversation_id: conversation.conversationId
      };
      const drInitPayload = normalizeDrInit(drInit) || normalizeDrInit(conversation.dr_init || conversation.drInit);
      if (drInitPayload) conversationInfo.dr_init = drInitPayload;
    }
    const payload = {
      nickname: nickname || generateRandomNickname(),
      avatar,
      addedAt: Math.floor(Date.now() / 1000)
    };
    if (conversationInfo) payload.conversation = conversationInfo;
    return payload;
  }
  async function ensureDevicePrivLoaded() {
    let priv = getDevicePriv?.();
    if (priv) return priv;
    const uid = getUidHex();
    if (!uid) throw new Error('尚未登入，請重新登入後再試');
    const { r, data } = await devkeysFetch({ uidHex: uid });
    if (r.status === 404) throw new Error('找不到裝置金鑰備份，請重新登入完成初始化');
    if (!r.ok) {
      const msg = typeof data === 'string' ? data : data?.message || data?.error || '讀取裝置金鑰失敗';
      throw new Error(msg);
    }
    const mk = getMkRaw();
    if (!mk) throw new Error('尚未解鎖主金鑰，請重新登入');
    priv = await unwrapDevicePrivWithMK(data.wrapped_dev, mk);
    setDevicePriv?.(priv);
    return priv;
  }

  function normalizeInviteOwnerBundle(bundle) {
    if (!bundle || typeof bundle !== 'object') return null;
    const ik = String(bundle.ik_pub || bundle.ik || '').trim();
    const spk = String(bundle.spk_pub || bundle.spk || '').trim();
    const sig = String(bundle.spk_sig || '').trim();
    if (!ik || !spk || !sig) return null;
    let opk = null;
    if (bundle.opk && typeof bundle.opk === 'object') {
      const pub = String(bundle.opk.pub || bundle.opk.opk_pub || '').trim();
      const rawId = bundle.opk.id ?? bundle.opk.opk_id;
      const id = Number(rawId);
      if (pub) opk = { id: Number.isFinite(id) ? id : null, pub };
    }
    return { ik_pub: ik, spk_pub: spk, spk_sig: sig, opk };
  }

  function buildGuestBundle(devicePriv, ownerBundle, x3dhState) {
    const ekPub = x3dhState?.myRatchetPub instanceof Uint8Array ? x3dhState.myRatchetPub : new Uint8Array();
    const bundle = {
      ik_pub: devicePriv.ik_pub_b64,
      ek_pub: b64(ekPub)
    };
    if (devicePriv.spk_pub_b64) bundle.spk_pub = devicePriv.spk_pub_b64;
    if (ownerBundle?.opk && ownerBundle.opk.id != null) bundle.opk_id = ownerBundle.opk.id;
    return bundle;
  }

}
