// Share controller (Signal-style): QR only carries inviteId + secret + owner deviceId.
// Flow: generate invite -> scan -> accept -> X3DH -> derive conversation token -> DR init -> contact-share.

import { friendsCreateInvite, friendsAcceptInvite } from '../../api/friends.js';
import { prekeysPublish } from '../../api/prekeys.js';
import { devkeysStore } from '../../api/devkeys.js';
import { encodeFriendInvite, decodeFriendInvite } from '../../lib/invite.js';
import { generateQR } from '../../lib/qr.js';
import QrScanner from '../../lib/vendor/qr-scanner.min.js';
import { log } from '../../core/log.js';
import { x3dhInitiate } from '../../crypto/dr.js';
import { genX25519Keypair } from '../../crypto/nacl.js';
import { b64 } from '../../crypto/nacl.js';
import {
  setDevicePriv,
  getMkRaw,
  getAccountDigest,
  getDeviceId,
  ensureDeviceId,
  clearDrState,
  clearDrStatesByAccount,
  normalizePeerIdentity
} from '../../core/store.js';
import { generateRandomNickname, normalizeNickname } from '../../features/profile.js';
import { deriveConversationContextFromSecret } from '../../features/conversation.js';
import { encryptContactPayload, decryptContactPayload } from '../../features/contact-share.js';
import { restoreContactSecrets, setContactSecret, getContactSecret } from '../../core/contact-secrets.js';
import { sessionStore } from './session-store.js';
import { primeDrStateFromInitiator, bootstrapDrFromGuestBundle, restoreDrStateFromSnapshot, snapshotDrState, sendDrText } from '../../features/dr-session.js';
import { ensureDevicePrivAvailable } from '../../features/device-priv.js';
import { generateOpksFrom, wrapDevicePrivWithMK } from '../../crypto/prekeys.js';
import { bytesToB64Url, b64UrlToBytes } from '../../../shared/utils/base64.js';

const INVITE_INFO = new TextEncoder().encode('invite-token');
const CONTACT_UPDATE_REASONS = new Set(['update', 'nickname', 'avatar', 'profile', 'manual']);
// 手動標記目前 QR/聯絡人分享流程的版本，用來追蹤是否為最新部署
const QR_BUILD_VERSION = 'qr-20250212-01';
const AUTO_PROFILE_BROADCAST_DELAY_MS = 1200;

async function deriveInviteTokenB64Url(secretB64Url) {
  const secretBytes = b64UrlToBytes(secretB64Url);
  if (!secretBytes) throw new Error('invalid invite secret');
  const baseKey = await crypto.subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: INVITE_INFO }, baseKey, 256);
  return bytesToB64Url(new Uint8Array(bits));
}

async function hashInviteTokenHex(inviteTokenB64Url) {
  const tokenBytes = b64UrlToBytes(inviteTokenB64Url);
  if (!tokenBytes) throw new Error('invalid invite token');
  const digest = await crypto.subtle.digest('SHA-256', tokenBytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
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
  let autoProfileBroadcasted = false;

  const contactSecretMap = restoreContactSecrets();
  primeStoredDrSnapshots(contactSecretMap);

  const {
    inviteBtn,
    inviteCountdownEl,
    inviteQrBox,
    inviteRefreshBtn,
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

  if (shareModal) shareModal.setAttribute('data-share-mode', shareState.mode);

  const shareModalCloseButtons = shareModal
    ? Array.from(shareModal.querySelectorAll('[data-share-close-btn]'))
    : [];
  const shareBackdrop = shareModalBackdrop || (shareModal ? shareModal.querySelector('.modal-backdrop') : null);

  if (btnShareModal) btnShareModal.addEventListener('click', () => openShareModal('qr'));
  shareBackdrop?.addEventListener('click', closeShareModal);
  btnShareSwitchQr?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); showShareMode('qr'); });
  btnShareSwitchScan?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); showShareMode('scan'); });
  shareModalCloseButtons.forEach((btn) => btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); closeShareModal(); }));
  document.addEventListener('keydown', handleEscapeKey);
  ensureQrPlaceholder();

  inviteRefreshBtn?.addEventListener('click', () => {
    if (inviteRefreshBtn.disabled) return;
    inviteRefreshBtn.disabled = true;
    onGenerateInvite().finally(() => {
      inviteRefreshBtn.disabled = false;
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
      peerAccountDigest: value?.peerAccountDigest ?? value?.accountDigest ?? value,
      peerDeviceId
    });
    if (!identity.key || !identity.deviceId) return null;
    return identity.key;
  }

  function primeStoredDrSnapshots(map) {
    const deviceId = getDeviceId() || 'default';
    if (!(map instanceof Map)) return;
    for (const [peerKey, info] of map.entries()) {
      const digest = normalizePeerKey(peerKey);
      if (!digest) continue;
      const merged = getContactSecret(digest, { deviceId });
      if (!merged?.drState) continue;
      try {
        restoreDrStateFromSnapshot({ peerAccountDigest: digest, snapshot: merged.drState });
      } catch (err) {
        console.error('[share-controller]', { drSnapshotRestoreError: err?.message || err, peerAccountDigest: digest });
      }
    }
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
    const conversationPeerDeviceId = conversation?.peerDeviceId || null;
    const peerDeviceResolved = peerDeviceId || conversationPeerDeviceId || null;
    const key = normalizePeerKey(peerAccountDigest, { peerDeviceId: peerDeviceResolved });
    const selfDeviceId = ensureDeviceId();
    if (!key || !sessionKey || !peerDeviceResolved || !selfDeviceId) {
      console.warn('[share-controller]', { contactSecretStoreSkipped: true, reason: 'missing-key-or-device', peerAccountDigest, peerDeviceId: peerDeviceResolved, selfDeviceId });
      throw new Error('contact secret requires peer device id, self device id, and session key');
    }
    const existing = getContactSecret(key, { deviceId: selfDeviceId }) || {};
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
    const derivedRole = (() => {
      if (role) return String(role).toLowerCase();
      if (existing?.role) return existing.role;
      if (selfDeviceId && peerDeviceResolved) {
        // 這裡 peerDeviceResolved 是對端裝置，self ≠ peer 表示本端為 guest；等於 self 則視為 owner。
        return selfDeviceId === peerDeviceResolved ? 'owner' : 'guest';
      }
      return null;
    })();
    const update = {
      conversation: {
        token: conversation?.token_b64 || sessionKey || existing.conversationToken || null,
        id: finalConvId,
        drInit: conversation?.dr_init || existing.conversationDrInit || null,
        peerDeviceId: conversationPeerDeviceId || peerDeviceResolved
      },
      meta: { source: 'share-controller:storeContactSecret' }
    };
    if (derivedRole) update.role = derivedRole;
    if (drState) {
      const snapshot = snapshotDrState(drState);
      if (snapshot) {
        update.dr = { state: snapshot };
      }
    }
    setContactSecret(key, { ...update, deviceId: selfDeviceId });
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
      ik: devicePriv.ik_pub_b64,
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

  function renderInviteQr(invite) {
    if (!inviteQrBox) return;
    const payload = encodeFriendInvite(invite);
    inviteQrBox.innerHTML = '';
    try {
      const canvas = generateQR(payload, 220);
      if (canvas) {
        removeQrPlaceholder();
        inviteQrBox.appendChild(canvas);
        inviteQrBox.setAttribute('data-qr-build-version', QR_BUILD_VERSION);
        console.log('[share-controller]', { qrBuildVersion: QR_BUILD_VERSION, inviteId: invite?.inviteId || null });
        log({ qrBuildVersion: QR_BUILD_VERSION, inviteId: invite?.inviteId || null });
      } else {
        inviteQrBox.textContent = '無法產生 QR，請稍後再試。';
      }
    } catch (err) {
      const msg = err?.message || String(err);
      console.error('[share-controller]', { qrRenderError: msg });
      inviteQrBox.textContent = '生成 QR 時發生錯誤';
    }
  }

  async function onGenerateInvite() {
    const ownerAccountDigest = currentOwnerDigest();
    const ownerDeviceId = ensureDeviceId();
    if (!ownerAccountDigest || !ownerDeviceId) {
      setInviteStatus('尚未登入，無法生成交友邀請，請重新登入後再試。', { isError: true });
      return;
    }
    setInviteStatus('檢查交友金鑰配置…', { loading: true });
    await ensureOwnerPrekeys({ force: false, reason: 'invite' });
    setInviteStatus('交友金鑰已就緒，正在建立邀請…', { loading: true });
    const secretBytes = crypto.getRandomValues(new Uint8Array(32));
    const secretB64Url = bytesToB64Url(secretBytes);
    const inviteToken = await deriveInviteTokenB64Url(secretB64Url);
    const tokenHash = await hashInviteTokenHex(inviteToken);
    const invite = await friendsCreateInvite({ deviceId: ownerDeviceId, inviteToken });
    if (!invite || !invite.inviteId || !invite.expiresAt) {
      throw new Error('伺服器回傳內容不完整');
    }
    shareState.currentInvite = {
      inviteId: String(invite.inviteId),
      secret: String(secretB64Url),
      expiresAt: Number(invite.expiresAt),
      ownerAccountDigest,
      ownerDeviceId,
      version: 2,
      // 將伺服端回傳的 prekey bundle (含 opk) 一併塞進 QR，避免掃描端使用不一致的 opk。
      prekeyBundle: invite.prekeyBundle || null
    };
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
    setInviteStatus('安全邀請通道已生成，建立 QR 中…', { loading: true });
    renderInviteQr(shareState.currentInvite);
    setInviteStatus('安全邀請通道已生成，請好友掃描 QR', { loading: false });
  }

  function openShareModal(defaultMode = 'qr') {
    if (!shareModal) return;
    shareState.open = true;
    shareModal.style.display = 'flex';
    shareModal.setAttribute('aria-hidden', 'false');
    lockBodyScroll();
    const target = defaultMode === 'scan' ? 'scan' : 'qr';
    showShareMode(target);
    onGenerateInvite().catch((err) => console.error('[share-controller]', { inviteEnsureError: err?.message || err }));
  }

  function closeShareModal() {
    if (!shareModal) return;
    shareState.open = false;
    shareModal.style.display = 'none';
    shareModal.setAttribute('aria-hidden', 'true');
    shareFlip?.classList.remove('flipped');
    stopInviteScanner();
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
      onGenerateInvite().catch((err) => console.error('[share-controller]', { inviteEnsureError: err?.message || err }));
    }
  }

  function handleEscapeKey(e) {
    if (e.key === 'Escape' && shareState.open) closeShareModal();
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
      returnDetailedScanResult: true
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
    try {
      const parsed = decodeFriendInvite(raw);
      console.log('[share-controller]', { inviteScanParsed: parsed });
      if (!parsed) throw new Error('無法解析好友邀請內容');
      const version = Number.isFinite(parsed.version) ? Number(parsed.version) : 1;
      if (version !== 2) {
        throw new Error('邀請版本不符，請請好友重新生成 (需要 v2)');
      }
      const ownerIdentity = normalizePeerIdentity({
        peerAccountDigest: parsed.ownerAccountDigest || null,
        peerDeviceId: parsed.ownerDeviceId || null
      });
      const ownerAccountDigest = ownerIdentity.accountDigest || null;
      const ownerDeviceId = ownerIdentity.deviceId || parsed.ownerDeviceId || null;
      if (!ownerDeviceId) throw new Error('invite 缺少 ownerDeviceId');

      // 掃碼前先清除舊的 DR state / contact secret，確保以全新 initiator 狀態建立。
      try {
        if (ownerAccountDigest) {
          clearDrStatesByAccount(ownerAccountDigest);
        }
        clearDrState({ peerAccountDigest: ownerAccountDigest, peerDeviceId: ownerDeviceId });
        const normPeerKey = normalizePeerKey(ownerAccountDigest, { peerDeviceId: ownerDeviceId });
        if (normPeerKey) {
          setContactSecret(normPeerKey, { dr: null, conversation: null, meta: { source: 'invite-scan-reset' } });
        }
      } catch (err) {
        console.warn('[share-controller]', { inviteScanResetError: err?.message || err });
      }

      const devicePriv = await ensureDevicePrivLoaded();
      if (!devicePriv) throw new Error('找不到裝置金鑰，請重新登入後再試');
      const inviteToken = await deriveInviteTokenB64Url(parsed.secret);
      const ekPair = await genX25519Keypair();
      const guestBundle = buildGuestBundleForAccept(devicePriv, ekPair);
      const res = await friendsAcceptInvite({ inviteId: parsed.inviteId, inviteToken, guestBundle });
      console.log('[share-controller]', { inviteScanAccepted: res });

      const ownerBundleFromInvite = normalizeInviteOwnerBundle(parsed?.prekeyBundle || null);
      const ownerBundleFromServer = normalizeInviteOwnerBundle(res?.ownerPrekeyBundle || res?.owner_prekey_bundle);
      const ownerBundle = ownerBundleFromInvite || ownerBundleFromServer;
      if (!ownerBundle) throw new Error('owner prekey bundle 缺少，請重新掃描 QR');
      if (ownerBundleFromInvite && ownerBundleFromServer) {
        const sameIk = ownerBundleFromInvite.ik_pub === ownerBundleFromServer.ik_pub;
        const sameSpk = ownerBundleFromInvite.spk_pub === ownerBundleFromServer.spk_pub;
        const sameSig = ownerBundleFromInvite.spk_sig === ownerBundleFromServer.spk_sig;
        const inviteOpk = ownerBundleFromInvite.opk?.pub || null;
        const serverOpk = ownerBundleFromServer.opk?.pub || null;
        const inviteOpkId = ownerBundleFromInvite.opk?.id ?? null;
        const serverOpkId = ownerBundleFromServer.opk?.id ?? null;
        const opkMatch = inviteOpk && serverOpk && inviteOpk === serverOpk && inviteOpkId === serverOpkId;
        if (!sameIk || !sameSpk || !sameSig || !opkMatch) {
          console.error('[share-controller]', {
            ownerBundleMismatch: true,
            inviteOpkId,
            serverOpkId,
            inviteOpk,
            serverOpk
          });
          throw new Error('邀請金鑰與伺服端金鑰不一致，請重新生成並掃描 QR');
        }
      }
      const resolvedOwnerDigest = ownerAccountDigest || ownerBundle?.account_digest || null;
      const resolvedOwnerDeviceId = ownerDeviceId || ownerBundle?.device_id || null;
      if (!resolvedOwnerDigest) throw new Error('owner digest 不完整，請重試');
      const x3dhState = await x3dhInitiate(devicePriv, ownerBundle, ekPair);
      const conversation = await deriveConversationContextFromSecret(x3dhState.rk, { deviceId: resolvedOwnerDeviceId });

      const drInitPayload = { guest_bundle: buildGuestBundle(devicePriv, ownerBundle, x3dhState), role: 'initiator' };
      const conversationContext = {
        token_b64: conversation.tokenB64,
        conversation_id: conversation.conversationId,
        peerDeviceId: resolvedOwnerDeviceId,
        dr_init: drInitPayload
      };
      if (!x3dhState.baseKey) x3dhState.baseKey = {};
      x3dhState.baseKey.role = 'initiator';
      x3dhState.baseKey.conversationId = conversationContext.conversation_id;

      const contactInitPayload = {
        type: 'contact-init',
        guestAccountDigest: (getAccountDigest() || '').toUpperCase(),
        guestDeviceId: ensureDeviceId(),
        guestBundle: drInitPayload.guest_bundle,
        conversation: conversationContext
      };
      sendContactInit(resolvedOwnerDigest, resolvedOwnerDeviceId, contactInitPayload);
      console.log('[share-controller]', { contactInitSent: { targetDigest: resolvedOwnerDigest, targetDeviceId: resolvedOwnerDeviceId, conversationId: conversationContext.conversation_id } });

      await addContactEntry({
        peerAccountDigest: resolvedOwnerDigest,
        peerDeviceId: resolvedOwnerDeviceId,
        nickname: '',
        avatar: null,
        addedAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
        conversation: conversationContext,
        contactSecret: conversation.tokenB64
      });
      const alreadyLive = hasLiveDrState(resolvedOwnerDigest);
      if (!alreadyLive) {
        clearDrState(resolvedOwnerDigest);
        primeDrStateFromInitiator({
          peerAccountDigest: resolvedOwnerDigest,
          peerDeviceId: resolvedOwnerDeviceId,
          state: x3dhState,
          conversationId: conversationContext.conversation_id
        });
      }
      storeContactSecretMapping({
        peerAccountDigest: resolvedOwnerDigest,
        peerDeviceId: resolvedOwnerDeviceId,
        sessionKey: conversation.tokenB64,
        conversation: conversationContext,
        drState: x3dhState,
        role: 'guest'
      });
      sessionStore.conversationIndex?.set?.(conversation.conversationId, {
        token_b64: conversation.tokenB64,
        peerAccountDigest: resolvedOwnerDigest,
        peerDeviceId: resolvedOwnerDeviceId,
        dr_init: drInitPayload
      });

      await sendContactShare({
        peerAccountDigest: resolvedOwnerDigest,
        conversation: conversationContext,
        sessionKey: conversation.tokenB64,
        peerDeviceId: resolvedOwnerDeviceId,
        drInit: drInitPayload
      });

      if (inviteScanStatus) inviteScanStatus.textContent = '成功加入好友！';
      switchTab('contacts');
      setTimeout(() => {
        if (shareState.open) closeShareModal();
      }, 700);
    } catch (err) {
      const msg = err?.message || String(err);
      const friendly = msg.toLowerCase().includes('expired')
        ? '邀請已過期，請請好友重新生成 QR。'
        : msg;
      console.error('[share-controller]', { inviteScanError: msg });
      if (inviteScanStatus) inviteScanStatus.textContent = friendly || '無法解析邀請內容';
      setTimeout(() => {
        if (shareState.open && shareState.mode === 'scan') {
          restartInviteScannerWithMessage('請再試一次，將 QR 置中掃描');
        }
      }, 1600);
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
    const resolvedPeerDeviceId = peerDeviceId || null; // 嚴格要求顯式指定對方裝置
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
    const payload = await buildLocalContactPayload({ conversation, drInit, overrides });
    if (reason) {
      payload.reason = reason;
    }
    payload.reason = payload.reason || 'invite-accept';
    const contactPayload = { ...payload };
    const envelope = await encryptContactPayload(sessionKey || conversationToken, contactPayload);
    const metaOverrides = {
      msg_type: 'contact-share',
      targetDeviceId: resolvedPeerDeviceId || null,
      receiverDeviceId: resolvedPeerDeviceId || null,
      peerDeviceId: resolvedPeerDeviceId || null
    };
    await sendDrText({
      peerAccountDigest: targetDigest,
      conversation,
      convId: conversationId,
      peerDeviceId: resolvedPeerDeviceId,
      text: JSON.stringify({ type: 'contact-share', envelope }),
      metaOverrides
    });
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
      const peerDeviceId =
        conversation.peerDeviceId ||
        conversation.peerDeviceId ||
        ensureDeviceId() ||
        null;
      if (convToken && convId) {
        conversationInfo = {
          token_b64: convToken,
          conversation_id: convId
        };
        if (peerDeviceId) {
          conversationInfo.peerDeviceId = peerDeviceId;
        }
        const drInitPayload = drInit || conversation.dr_init || conversation.drInit || null;
        if (drInitPayload) conversationInfo.dr_init = drInitPayload;
      }
    }
    const overrideNickname = overrides?.nickname;
    const effectiveNickname = overrideNickname || nickname || generateRandomNickname();
    const payload = {
      nickname: effectiveNickname,
      avatar,
      addedAt: Math.floor(Date.now() / 1000),
      updatedAt: profileUpdatedAt
    };
    if (conversationInfo) payload.conversation = conversationInfo;
    return payload;
  }

  async function handleContactShareEvent(msg) {
    const identity = normalizePeerIdentity({
      peerAccountDigest: msg?.fromAccountDigest || msg?.peerAccountDigest || null,
      peerDeviceId: msg?.senderDeviceId || msg?.peerDeviceId || null
    });
    const peerKey = identity.key;
    const peerDeviceId = identity.deviceId || null;
    console.log('[share-controller]', {
      contactShareHandleStart: {
        peerAccountDigest: peerKey || null,
        peerDeviceId: peerDeviceId || null,
        hasEnvelope: !!msg?.envelope
      }
    });
    if (!peerKey || !peerDeviceId) {
      console.warn('[share-controller]', { contactShareMissingPeerDevice: true, peerAccountDigest: peerKey || null, peerDeviceId });
      if (notifyToast) {
        notifyToast('收到未知裝置的聯絡更新，請請好友重新掃碼', { variant: 'warning' });
      }
      return;
    }
    const selfDeviceId = ensureDeviceId();
    const stored = getContactSecret(peerKey, { deviceId: selfDeviceId });
    if (stored?.peerDeviceId && peerDeviceId && stored.peerDeviceId !== peerDeviceId) {
      console.warn('[share-controller]', {
        contactSharePeerDeviceConflict: true,
        peerAccountDigest: peerKey,
        storedPeerDeviceId: stored.peerDeviceId,
        incomingPeerDeviceId: peerDeviceId
      });
      // 將 peerDeviceId 置換為最新，避免卡在舊裝置紀錄。
      try {
        setContactSecret(peerKey, { peerDeviceId, meta: { source: 'contact-share-peer-device-update' } });
      } catch (err) {
        console.warn('[share-controller]', { contactSharePeerDeviceUpdateError: err?.message || err, peerAccountDigest: peerKey });
      }
    }
    const sessionKey = stored?.conversationToken || null;
    if (!sessionKey) {
      console.warn('[share-controller]', { contactShareMissingSession: peerKey, peerDeviceId, selfDeviceId });
      return;
    }
    const envelope = msg?.envelope;
    if (!envelope?.iv || !envelope?.ct) {
      console.warn('[share-controller]', { contactShareMissingEnvelope: true, peerAccountDigest: peerKey, peerDeviceId });
      return;
    }
    try {
      const payload = await decryptContactPayload(sessionKey, envelope);
      const normalizedNickname = normalizeNickname(payload?.nickname || '') || payload?.nickname || generateRandomNickname();
      payload.nickname = normalizedNickname;
      try {
        console.log('[share-controller]', {
          contactSharePayload: {
            peerAccountDigest: peerKey,
            peerDeviceId,
            hasAvatar: !!payload.avatar,
            nickname: payload.nickname || null,
            conversationId: conversation?.conversation_id || null
          }
        });
      } catch {}
      const reasonRaw = typeof payload?.reason === 'string' ? payload.reason.trim() : '';
      const reasonKey = reasonRaw ? reasonRaw.toLowerCase() : null;
      const conversationRaw = payload?.conversation || null;
      const conversationTokenB64 = conversationRaw?.token_b64 || conversationRaw?.tokenB64 || null;
      const conversationIdFromPayload = conversationRaw?.conversation_id || conversationRaw?.conversationId || null;
      if (!conversationRaw || !conversationTokenB64 || !conversationIdFromPayload) {
        console.warn('[share-controller]', { contactShareMissingConversation: peerKey });
        return;
      }
      const conversation = {
        token_b64: conversationTokenB64,
        conversation_id: conversationIdFromPayload,
        dr_init: conversationRaw?.dr_init || conversationRaw?.drInit || null,
        // 對端裝置必須存在，強制用 senderDeviceId 作為 peerDeviceId
        peerDeviceId
      };
      if (conversation.peerDeviceId && peerDeviceId && conversation.peerDeviceId !== peerDeviceId) {
        console.warn('[share-controller]', {
          contactSharePeerDeviceMismatch: true,
          peerAccountDigest: peerKey,
          fromEvent: peerDeviceId,
          fromPayload: conversation.peerDeviceId
        });
        if (notifyToast) {
          notifyToast('對方裝置資訊不符，請請好友重新掃描 QR', { variant: 'warning' });
        }
        return;
      }

      await addContactEntry({
        peerAccountDigest: peerKey,
        nickname: payload.nickname,
        avatar: payload.avatar || null,
        addedAt: payload.addedAt || null,
        updatedAt: payload.updatedAt || null,
        conversation,
        contactSecret: conversation.token_b64
      });
      sessionStore.conversationIndex?.set?.(conversation.conversation_id, {
        token_b64: conversation.token_b64,
        peerAccountDigest: peerKey,
        peerDeviceId: peerDeviceId || null,
        dr_init: conversation.dr_init || null
      });
      const selfDeviceId = ensureDeviceId();
      const selfRole = selfDeviceId && conversation.peerDeviceId
        ? (selfDeviceId === conversation.peerDeviceId ? 'guest' : 'owner')
        : (getAccountDigest() ? 'guest' : 'guest');
      console.log('[share-controller]', {
        contactShareDecryptSuccess: {
          peerAccountDigest: peerKey,
          peerDeviceId,
          hasAvatar: !!payload.avatar,
          nickname: payload.nickname || null,
          conversationId: conversation.conversation_id
        }
      });
      storeContactSecretMapping({
        peerAccountDigest: peerKey,
        sessionKey: conversation.token_b64,
        conversation,
        // 保留既有角色標記（owner/guest），不在 contact-share 時覆寫。
      });
      const drInitRaw = conversation.dr_init || null;
      const normalizedBundle = drInitRaw?.guest_bundle ? normalizeGuestBundle(drInitRaw.guest_bundle) : null;
      // 只有當對方裝置等於本機（owner/responder 端）才允許 responder bootstrap；guest 端禁止。
      const allowResponderBootstrap = !!(selfDeviceId && peerDeviceId && selfDeviceId === peerDeviceId);
      if (normalizedBundle && allowResponderBootstrap) {
        const alreadyLive = hasLiveDrState(peerKey);
        if (!alreadyLive) {
          try {
            await bootstrapDrFromGuestBundle({
              peerAccountDigest: peerKey,
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
    if (!bundle || typeof bundle !== 'object') return null;
    const clean = (value) => (typeof value === 'string' ? value.trim() : '');
    const ek = clean(bundle.ek_pub || bundle.ek || bundle.ephemeral_pub || '');
    const sig = clean(bundle.spk_sig || bundle.spkSig || bundle.signature || '');
    if (!ek || !sig) return null;
    const normalized = { ek_pub: ek, spk_sig: sig };
    const ik = clean(bundle.ik_pub || bundle.ik || bundle.identity_pub || '');
    if (ik) normalized.ik_pub = ik;
    const spk = clean(bundle.spk_pub || bundle.spk || '');
    if (spk) normalized.spk_pub = spk;
    const opkIdRaw = bundle.opk_id ?? bundle.opkId ?? bundle.opk?.id;
    if (opkIdRaw !== undefined && opkIdRaw !== null && opkIdRaw !== '') {
      const parsed = Number(opkIdRaw);
      if (Number.isFinite(parsed)) normalized.opk_id = parsed;
    }
    return normalized;
  }

  function sendContactInit(ownerDigest, ownerDeviceId, payload) {
    if (!wsTransport || typeof wsTransport !== 'function') {
      throw new Error('無法建立安全通道（WS 未連線），請稍後重試');
    }
    if (!ownerDigest || !ownerDeviceId) {
      throw new Error('缺少目標帳號或裝置資訊，無法送出安全邀請');
    }
    if (!payload?.guestBundle || !payload?.conversation?.conversation_id || !payload?.conversation?.token_b64) {
      throw new Error('安全邀請內容不完整');
    }
    const guestAccountDigest = (getAccountDigest() || '').toUpperCase();
    if (!guestAccountDigest) {
      throw new Error('缺少 guestAccountDigest，請重新登入後再試');
    }
    wsTransport({
      type: 'contact-init',
      targetAccountDigest: ownerDigest,
      targetDeviceId: ownerDeviceId,
      senderAccountDigest: guestAccountDigest,
      guestAccountDigest,
      senderDeviceId: ensureDeviceId(),
      conversation: payload.conversation,
      guestBundle: payload.guestBundle
    });
  }

  async function handleContactInitEvent(msg = {}) {
    const guestIdentity = normalizePeerIdentity(msg.guestAccountDigest || msg.senderAccountDigest || msg.peerAccountDigest || null);
    const peerDigest = guestIdentity.accountDigest || null;
    const peerDeviceId = msg.senderDeviceId || msg.guestDeviceId || msg.peerDeviceId || guestIdentity.deviceId || null;
    const conversation = msg.conversation ? { ...msg.conversation } : {};
    const guestBundle = msg.guestBundle || null;
    if (!peerDigest || !peerDeviceId) {
      console.warn('[share-controller]', { contactInitMissingFields: true, reason: 'missing-guest-digest-or-device', peerDigest, peerDeviceId });
      return;
    }
    if (!conversation?.conversation_id || !conversation?.token_b64 || !guestBundle) {
      console.warn('[share-controller]', { contactInitMissingFields: true, reason: 'conversation-or-bundle', peerDigest, peerDeviceId, hasConv: !!conversation?.conversation_id });
      return;
    }
    // 協定要求對端裝置唯一：若 payload 內的 conversation.peerDeviceId 與 senderDeviceId 不一致，視為錯誤並拒收。
    if (conversation.peerDeviceId && conversation.peerDeviceId !== peerDeviceId) {
      console.warn('[share-controller]', {
        contactInitPeerDeviceMismatch: true,
        peerAccountDigest: peerDigest,
        fromEvent: peerDeviceId,
        fromPayload: conversation.peerDeviceId
      });
      return;
    }
    // 強制使用 senderDeviceId 作為對端裝置。
    conversation.peerDeviceId = peerDeviceId;
    console.log('[share-controller]', { contactInitReceived: { peerDigest, peerDeviceId, conversationId: conversation.conversation_id } });
    sessionStore.conversationIndex?.set?.(conversation.conversation_id, {
      token_b64: conversation.token_b64,
      peerAccountDigest: peerDigest,
      peerDeviceId: peerDeviceId || null,
      dr_init: conversation.dr_init || null
    });
    storeContactSecretMapping({
      peerAccountDigest: peerDigest,
      peerDeviceId, // 這裡代表對端（guest）的裝置
      sessionKey: conversation.token_b64,
      conversation,
      drState: null,
      role: 'owner'
    });
    try {
      clearDrState({ peerAccountDigest: peerDigest, peerDeviceId });
      const selfDeviceId = ensureDeviceId();
      // 只有 owner/responder 端（對端裝置等於本機）才允許 responder bootstrap。
      if (selfDeviceId && peerDeviceId && selfDeviceId === peerDeviceId) {
        await bootstrapDrFromGuestBundle({
          peerAccountDigest: peerDigest,
          peerDeviceId,
          guestBundle,
          force: true,
          conversationId: conversation.conversation_id
        });
      }
    } catch (err) {
      console.error('[share-controller]', { contactInitBootstrapError: err?.message || err, peerAccountDigest: peerDigest });
    }
    try {
      await sendContactShare({
        peerAccountDigest: peerDigest,
        conversation,
        sessionKey: conversation.token_b64,
        peerDeviceId, // 對端裝置
        drInit: conversation.dr_init || null
      });
      console.log('[share-controller]', { contactInitContactShareSent: { peerDigest, peerDeviceId, conversationId: conversation.conversation_id } });
      // 被掃描端完成回傳後，自動關閉 QR modal。
      if (shareState.open) {
        setTimeout(() => {
          if (shareState.open) closeShareModal();
        }, 500);
      }
    } catch (err) {
      console.error('[share-controller]', { contactInitContactShareError: err?.message || err, peerDigest, peerDeviceId });
    }
  }

  function normalizeInviteOwnerBundle(bundle) {
    if (!bundle) return null;
    let obj = bundle;
    if (typeof bundle === 'string') {
      let rawStr = bundle;
      const tryParse = (str) => {
        try { return JSON.parse(str); } catch { return null; }
      };
      obj = tryParse(rawStr);
      if (!obj) {
        try {
          const norm = rawStr.replace(/-/g, '+').replace(/_/g, '/');
          const padded = norm.padEnd(norm.length + ((4 - (norm.length % 4)) % 4), '=');
          const decoded = atob(padded);
          obj = tryParse(decoded);
        } catch {
          obj = null;
        }
      }
    }
    if (!obj || typeof obj !== 'object') return null;
    const ik = String(obj.ik_pub || obj.ik || '').trim();
    const spk = String(obj.spk_pub || obj.spk || '').trim();
    const sig = String(obj.spk_sig || '').trim();
    if (!ik || !spk || !sig) return null;
    let opk = null;
    if (obj.opk && typeof obj.opk === 'object') {
      const pub = String(obj.opk.pub || obj.opk.opk_pub || '').trim();
      const rawId = obj.opk.id ?? obj.opk.opk_id;
      const id = Number(rawId);
      if (pub) opk = { id: Number.isFinite(id) ? id : null, pub };
    }
    return { ik_pub: ik, spk_pub: spk, spk_sig: sig, opk };
  }

  function buildGuestBundleForAccept(devicePriv, ekPair) {
    const bundle = {
      ik_pub: devicePriv.ik_pub_b64,
      ek_pub: b64(ekPair?.publicKey || new Uint8Array())
    };
    if (devicePriv.spk_pub_b64) bundle.spk_pub = devicePriv.spk_pub_b64;
    if (devicePriv.spk_sig_b64) bundle.spk_sig = devicePriv.spk_sig_b64;
    return bundle;
  }

  function buildGuestBundle(devicePriv, ownerBundle, x3dhState) {
    const ekPub = x3dhState?.myRatchetPub instanceof Uint8Array ? x3dhState.myRatchetPub : new Uint8Array();
    const bundle = {
      ik_pub: devicePriv.ik_pub_b64,
      ek_pub: b64(ekPub)
    };
    if (devicePriv.spk_pub_b64) bundle.spk_pub = devicePriv.spk_pub_b64;
    if (devicePriv.spk_sig_b64) bundle.spk_sig = devicePriv.spk_sig_b64;
    if (ownerBundle?.opk && ownerBundle.opk.id != null) bundle.opk_id = ownerBundle.opk.id;
    return bundle;
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

  async function broadcastContactUpdate({ reason = 'manual', targetPeers = null, overrides = null } = {}) {
    const reasonKey = typeof reason === 'string' ? reason.toLowerCase() : 'manual';
    const map = contactSecretMap instanceof Map ? contactSecretMap : restoreContactSecrets();
    if (!(map instanceof Map)) return;
    const targetSet = Array.isArray(targetPeers) && targetPeers.length
      ? new Set(
        targetPeers
          .map((p) => normalizePeerIdentity(p).key)
          .filter(Boolean)
      )
      : null;
    const deviceId = ensureDeviceId();
    for (const peerKey of map.keys()) {
      const identity = normalizePeerIdentity(peerKey);
      const digest = identity.key;
      if (!digest) continue;
      if (targetSet && !targetSet.has(digest)) continue;
      const record = getContactSecret(digest, { deviceId });
      if (!record) continue;
      const token = record.conversationToken || record.conversation?.token || null;
      const convId = record.conversationId || record.conversation?.id || null;
      const peerDeviceId = record.peerDeviceId || record.conversation?.peerDeviceId || identity.deviceId || null;
      if (!token || !convId || !peerDeviceId) continue;
      const drInit = record.conversationDrInit || record.conversation?.drInit || null;
      const conversation = {
        token_b64: token,
        conversation_id: convId,
        dr_init: drInit,
        peerDeviceId
      };
      try {
        await sendContactShare({
          peerAccountDigest: digest,
          conversation,
          sessionKey: token,
          peerDeviceId,
          drInit,
          overrides,
          reason: reasonKey
        });
      } catch (err) {
        console.error('[share-controller]', {
          contactBroadcastError: err?.message || err,
          peerAccountDigest: digest,
          peerDeviceId,
          reason: reasonKey,
          attempt: 'initial'
        });
        try {
          await sendContactShare({
            peerAccountDigest: digest,
            conversation,
            sessionKey: token,
            peerDeviceId,
            drInit,
            overrides,
            reason: reasonKey
          });
        } catch (err2) {
          console.error('[share-controller]', {
            contactBroadcastRetryError: err2?.message || err2,
            peerAccountDigest: digest,
            peerDeviceId,
            reason: reasonKey
          });
        }
      }
    }
  }

  return {
    openShareModal,
    closeShareModal,
    showShareMode,
    handleInviteScan,
    handleContactShareEvent,
    handleContactInitEvent,
    broadcastContactUpdate,
    setWsSend(fn) {
      wsTransport = typeof fn === 'function' ? fn : null;
    }
  };

  profileInitPromise
    ?.then(() => {
      if (autoProfileBroadcasted) return;
      autoProfileBroadcasted = true;
      setTimeout(() => {
        if (!contactSecretMap || !(contactSecretMap instanceof Map) || contactSecretMap.size === 0) return;
        broadcastContactUpdate({ reason: 'profile' })
          .catch((err) => console.warn('[share-controller]', { autoProfileBroadcastError: err?.message || err }));
      }, AUTO_PROFILE_BROADCAST_DELAY_MS);
    })
    .catch(() => {});
}
