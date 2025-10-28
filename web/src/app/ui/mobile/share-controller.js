import { friendsCreateInvite, friendsAcceptInvite, friendsAttachInviteContact, parseFriendInvite, friendsShareContactUpdate } from '../../api/friends.js';
import { encodeFriendInvite } from '../../lib/invite.js';
import { generateQR } from '../../lib/qr.js';
import QrScanner from '../../lib/vendor/qr-scanner.min.js';
import { log } from '../../core/log.js';
import { x3dhInitiate } from '../../crypto/dr.js';
import { b64 } from '../../crypto/nacl.js';
import { getUidHex } from '../../core/store.js';
import { generateRandomNickname, normalizeNickname } from '../../features/profile.js';
import { deriveConversationContextFromSecret } from '../../features/conversation.js';
import { encryptContactPayload, decryptContactPayload } from '../../features/contact-share.js';
import { restoreContactSecrets, setContactSecret, deleteContactSecret, getContactSecret } from '../../core/contact-secrets.js';
import { sessionStore } from './session-store.js';
import { primeDrStateFromInitiator, bootstrapDrFromGuestBundle, restoreDrStateFromSnapshot, snapshotDrState } from '../../features/dr-session.js';
import { ensureDevicePrivAvailable } from '../../features/device-priv.js';

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
    showToast: showToastOption,
    wsSend
  } = options;

  const notifyToast = typeof showToastOption === 'function' ? showToastOption : null;
  let wsTransport = typeof wsSend === 'function' ? wsSend : null;
  const recentlyDeletedPeers = new Map();
  const CONTACT_READD_COOLDOWN_MS = 30_000;

  if (!dom) throw new Error('share controller requires dom references');
  const contactSecretMap = restoreContactSecrets();
  primeStoredDrSnapshots(contactSecretMap);

  function primeStoredDrSnapshots(map) {
    if (!(map instanceof Map)) return;
    for (const [peerUid, info] of map.entries()) {
      if (!info?.drState) continue;
      try {
        restoreDrStateFromSnapshot({ peerUidHex: peerUid, snapshot: info.drState });
      } catch (err) {
        log({ drSnapshotRestoreError: err?.message || err, peerUid });
      }
    }
  }

  function storeContactSecretMapping({ peerUid, inviteId, secret, role, conversation, drState }) {
    if (!peerUid || !inviteId || !secret) return;
    let conversationToken = null;
    let conversationId = null;
    let conversationDrInit = null;
    if (conversation) {
      conversationToken = conversation.tokenB64 || conversation.token_b64 || null;
      conversationId = conversation.conversationId || conversation.conversation_id || null;
      conversationDrInit = conversation.dr_init || conversation.drInit || null;
    }
    const existing = getContactSecret(peerUid) || {};
    const payload = {
      inviteId,
      secret,
      role: typeof existing.role === 'string' && existing.role.length ? existing.role : (role || null),
      conversationToken: conversationToken || existing.conversationToken || null,
      conversationId: conversationId || existing.conversationId || null,
      conversationDrInit: conversationDrInit || existing.conversationDrInit || null
    };
    if (drState) {
      const snapshot = snapshotDrState(drState);
      if (snapshot) {
        payload.drState = snapshot;
      }
    }
    setContactSecret(peerUid, payload);
  }

  function markPeerRecentlyDeleted(peerUid) {
    const key = String(peerUid || '').toUpperCase();
    if (!key) return;
    recentlyDeletedPeers.set(key, Date.now());
    log({ contactRecentlyDeletedMarked: key });
  }

  function wasPeerRecentlyDeleted(peerUid) {
    const key = String(peerUid || '').toUpperCase();
    if (!key) return false;
    const ts = recentlyDeletedPeers.get(key);
    if (!ts) return false;
    if (Date.now() - ts > CONTACT_READD_COOLDOWN_MS) {
      recentlyDeletedPeers.delete(key);
      return false;
    }
    log({ contactRecentlyDeletedCheck: key });
    return true;
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
  shareState.inviteBlockedDueToKeys = !!shareState.inviteBlockedDueToKeys;
  shareState.lastInviteError = shareState.lastInviteError || null;

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
          conversationId: record.conversationId || null,
          conversationDrInit: record.conversationDrInit || null
        };
      }
    }
    return freshest;
  }

  async function ensureActiveInvite({ force = false } = {}) {
    if (!shareModal) return;
    if (shareState.inviteBlockedDueToKeys && !force) {
      setInviteStatus('缺少交友金鑰，請重新登入完成初始化。', true);
      return;
    }
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

  document.addEventListener('contacts:removed', (event) => {
    const detail = event?.detail || {};
    const peer = detail.peerUid || detail.peer_uid || detail.peer || detail.uid;
    markPeerRecentlyDeleted(peer);
    if (detail?.notifyPeer !== false && wsTransport && peer) {
      try {
        wsTransport({
          type: 'contact-removed',
          targetUid: String(peer).toUpperCase()
        });
      } catch (err) {
        log({ contactRemovedNotifyError: err?.message || err, peer });
      }
    }
  });

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
    getCurrentInvite: () => shareState.currentInvite,
    setWsSend(fn) {
      wsTransport = typeof fn === 'function' ? fn : null;
    }
  };

  function handleEscapeKey(e) {
    if (e.key === 'Escape' && shareState.open) closeShareModal();
  }

  async function onGenerateInvite({ auto = false, attempt = 0 } = {}) {
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
        conversationId: conversation.conversationId,
        conversationDrInit: conversation.drInit || conversation.dr_init || null
      };
      inviteSecrets.set(shareState.currentInvite.inviteId, {
        secret: shareState.currentInvite.secret,
        role: 'owner',
        ownerUid: shareState.currentInvite.ownerUid,
        prekeyBundle: shareState.currentInvite.prekeyBundle || null,
        expiresAt: shareState.currentInvite.expiresAt,
        conversationToken: shareState.currentInvite.conversationToken,
        conversationId: shareState.currentInvite.conversationId,
        conversationDrInit: shareState.currentInvite.conversationDrInit || null
      });
      persistInviteSecrets();
      shareState.inviteBlockedDueToKeys = false;
      shareState.lastInviteError = null;

      await attachInviteOwnerContact(shareState.currentInvite);
      renderInviteQr(shareState.currentInvite);
      startInviteCountdown(shareState.currentInvite.expiresAt);
    } catch (err) {
      const msg = err?.message || String(err);
      log({ inviteError: msg, attempt });
      shareState.currentInvite = null;
      shareState.lastInviteError = msg;
      if (isPrekeyRecoveryError(msg)) {
        shareState.inviteBlockedDueToKeys = true;
        setInviteStatus('生成失敗：缺少交友金鑰，請重新登入完成初始化', true);
      } else {
        shareState.inviteBlockedDueToKeys = false;
        setInviteStatus(`生成失敗：${msg}`, true);
      }
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
        if (shareState.inviteBlockedDueToKeys) {
          setInviteStatus('交友邀請已過期，請重新登入完成初始化。', true);
        } else {
          setInviteStatus('交友邀請已過期，正在重新生成…');
          setTimeout(() => onGenerateInvite({ auto: true }), 220);
        }
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
        conversationId: conversation.conversationId,
        conversationDrInit: conversation.drInit || conversation.dr_init || null
      };
      inviteSecrets.set(parsed.inviteId, entry);
      persistInviteSecrets();
      sessionStore.conversationIndex?.set?.(conversation.conversationId, {
        token_b64: conversation.tokenB64,
        peerUid: parsed.ownerUid || null,
        secretRole: 'guest'
      });

      const devicePriv = await ensureDevicePrivLoaded();
      if (!devicePriv) throw new Error('找不到裝置金鑰，請重新登入後再試');
      const x3dhState = await x3dhInitiate(devicePriv, ownerBundle);
      const guestBundle = buildGuestBundle(devicePriv, ownerBundle, x3dhState);
      const drInitPayload = { guest_bundle: guestBundle, role: 'initiator' };
      entry.guestBundle = guestBundle;
      entry.conversationDrInit = drInitPayload;
      inviteSecrets.set(parsed.inviteId, entry);
      persistInviteSecrets();
      const conversationContext = {
        token_b64: conversation.tokenB64,
        conversation_id: conversation.conversationId,
        dr_init: drInitPayload
      };
      sessionStore.conversationIndex?.set?.(conversation.conversationId, {
        token_b64: conversation.tokenB64,
        peerUid: parsed.ownerUid || null,
        dr_init: drInitPayload,
        secretRole: 'guest'
      });
      let contactEnvelope = null;
      try {
        const payload = await buildLocalContactPayload({
          conversation: conversationContext,
          drInit: drInitPayload
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
        let conversationInfo = ownerContact?.conversation && ownerContact.conversation.token_b64 && ownerContact.conversation.conversation_id
          ? {
              token_b64: ownerContact.conversation.token_b64,
              conversation_id: ownerContact.conversation.conversation_id,
              ...(ownerContact.conversation.dr_init ? { dr_init: ownerContact.conversation.dr_init } : null)
            }
          : conversationContext;
        if (!conversationInfo?.dr_init && conversationContext?.dr_init) {
          conversationInfo = {
            ...(conversationInfo || {}),
            dr_init: conversationContext.dr_init
          };
        }
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
          conversation: conversationInfo,
          drState: x3dhState
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
    const existingContact = sessionStore.contactIndex?.get?.(fromUid) || null;
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
      const reason = payload?.reason || null;
      if (reason === 'conversation-delete' && wasPeerRecentlyDeleted(fromUid)) {
        log({ contactShareIgnoredForDeleted: fromUid, reason });
        recentlyDeletedPeers.delete(fromUid);
        return;
      }
      let conversation = null;
      if (payload?.conversation && payload.conversation.token_b64 && payload.conversation.conversation_id) {
        conversation = payload.conversation;
      } else if (record?.conversationToken && record?.conversationId) {
        conversation = { token_b64: record.conversationToken, conversation_id: record.conversationId };
      } else if (stored?.conversationToken && stored?.conversationId) {
        conversation = {
          token_b64: stored.conversationToken,
          conversation_id: stored.conversationId,
          dr_init: stored.conversationDrInit || null
        };
      } else if (existingContact?.conversation?.token_b64 && existingContact?.conversation?.conversation_id) {
        conversation = {
          token_b64: existingContact.conversation.token_b64,
          conversation_id: existingContact.conversation.conversation_id,
          dr_init: existingContact.conversation.dr_init || null
        };
      }
      if (conversation && !conversation.dr_init) {
        conversation.dr_init = existingContact?.conversation?.dr_init || stored?.conversationDrInit || record?.conversationDrInit || null;
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
          dr_init: conversation.dr_init || null,
          secretRole: record?.role || stored?.role || null
        });
      }
      storeContactSecretMapping({
        peerUid: fromUid,
        inviteId,
        secret,
        role: record?.role || stored?.role || null,
        conversation
      });
      const drInit = conversation?.dr_init || conversation?.drInit || null;
      const bundle = drInit?.guest_bundle || drInit?.guestBundle || null;
      const candidateRole = [
        existingContact?.secretRole,
        record?.role,
        stored?.role
      ].find((value) => typeof value === 'string' && value.length);
      const selfRole = candidateRole ? candidateRole.toLowerCase() : null;
      if (bundle && selfRole !== 'guest') {
        try {
          await bootstrapDrFromGuestBundle({ peerUidHex: fromUid, guestBundle: bundle });
        } catch (err) {
          log({ drBootstrapError: err?.message || err });
        }
      }
      inviteSecrets.delete(inviteId);
      persistInviteSecrets();
      shareState.currentInvite = null;
      if (!shareState.inviteBlockedDueToKeys) {
        try {
          await onGenerateInvite({ auto: true });
        } catch (err) {
          log({ autoInviteRefreshError: err?.message || err });
        }
      } else if (shareState.open) {
        setInviteStatus('缺少交友金鑰，請重新登入完成初始化。', true);
      }
      if (shareState.open) {
        closeShareModal();
      }
      if (notifyToast) notifyToast('已成功加入好友');
      const tab = typeof getCurrentTab === 'function' ? getCurrentTab() : null;
      if (typeof switchTab === 'function' && tab !== 'contacts') {
        switchTab('contacts');
      }
      recentlyDeletedPeers.delete(fromUid);
    } catch (err) {
      log({ contactShareDecryptError: err?.message || err });
    }
  }

  async function broadcastContactUpdate({ reason, targetPeers, overrides } = {}) {
    const secretMap = restoreContactSecrets();
    const targetSet = Array.isArray(targetPeers)
      ? new Set(
          targetPeers
            .map((value) => (typeof value === 'string' ? value.trim().toUpperCase() : null))
            .filter(Boolean)
        )
      : null;
    const entries = Array.from(secretMap.entries());
    if (!entries.length) return { total: 0, success: 0, errors: [] };

    let success = 0;
    const errors = [];

    for (const [peerUid, info] of entries) {
      if (targetSet && !targetSet.has(String(peerUid || '').toUpperCase())) continue;
      log({ contactBroadcastCandidate: {
        peerUid,
        hasInviteId: !!info?.inviteId,
        hasSecret: !!info?.secret,
        hasConversation: !!(info?.conversationToken && info?.conversationId),
        role: info?.role || null
      } });
      const inviteId = info?.inviteId;
      const secret = info?.secret;
      if (!inviteId || !secret) continue;
      const contactEntry = sessionStore.contactIndex?.get?.(peerUid) || null;
      let conversation = contactEntry?.conversation && contactEntry.conversation.token_b64 && contactEntry.conversation.conversation_id
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
      const conversationId = conversation?.conversationId || conversation?.conversation_id || null;
      if (conversationId && (!conversation?.dr_init || !conversation.dr_init?.guest_bundle)) {
        const storedConv = sessionStore.conversationIndex?.get?.(conversationId);
        if (storedConv?.dr_init) {
          conversation = {
            ...(conversation || {}),
            tokenB64: conversation?.tokenB64 || storedConv.token_b64,
            conversationId,
            dr_init: storedConv.dr_init
          };
        }
      }
      const drInit = conversation?.dr_init || conversation?.drInit || info?.conversationDrInit || null;
      let payload = null;
      let envelope = null;
      try {
        payload = await buildLocalContactPayload({ conversation, drInit, overrides });
        payload.reason = reason || 'update';
        log({ contactBroadcastPayload: { peerUid, hasConversation: !!payload?.conversation, drInit: payload?.conversation?.dr_init ? 'yes' : 'no' } });
        envelope = await encryptContactPayload(secret, payload);
        await friendsShareContactUpdate({ inviteId, secret, peerUid, envelope });
        storeContactSecretMapping({
          peerUid,
          inviteId,
          secret,
          role: info?.role || null,
          conversation
        });
        success += 1;
        if (wsTransport) {
          try {
            wsTransport({
              type: 'contacts-reload',
              targetUid: peerUid
            });
          } catch (err) {
            log({ contactsReloadNotifyError: err?.message || err, peerUid });
          }
        }
      } catch (err) {
        const message = err?.message || '';
        if (message.includes('NotFound')) {
          log({ contactBroadcastFallback: message, peerUid, reason: reason || null });
          try {
            if (!envelope && secret && payload) {
              envelope = await encryptContactPayload(secret, payload);
            }
            if (wsTransport && envelope) {
              wsTransport({
                type: 'contact-share',
                targetUid: peerUid,
                inviteId,
                envelope
              });
              success += 1;
              continue;
            }
          } catch (notifyErr) {
            log({ contactShareFallbackError: notifyErr?.message || notifyErr, peerUid });
          }
          if (wsTransport) {
            try {
              wsTransport({
                type: 'contacts-reload',
                targetUid: peerUid
              });
              success += 1;
              continue;
            } catch (notifyErr) {
              log({ contactsReloadNotifyError: notifyErr?.message || notifyErr, peerUid });
            }
          }
        }
        errors.push({ peerUid, error: err });
        log({ contactBroadcastError: message || err, peerUid, reason: reason || null });
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
        if (info.conversationDrInit || info.conversation_dr_init) {
          record.conversationDrInit = info.conversationDrInit || info.conversation_dr_init;
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
        log({ profileInitAwaitError: err?.message || err });
      }
      const loadedProfile = typeof getProfileState === 'function' ? getProfileState() : null;
      profileState = pickPreferredProfile(initialProfile, loadedProfile);
      if (profileState && sessionStore.profileState !== profileState) {
        sessionStore.profileState = profileState;
      }
    }

    const nickname = profileState?.nickname || '';
    let avatar = null;
    const baseAvatar = profileState?.avatar || initialProfile?.avatar || null;
    if (baseAvatar) {
      let ensuredAvatar = null;
      if (ensureAvatarThumbnail) {
        try {
          ensuredAvatar = await ensureAvatarThumbnail();
        } catch (err) {
          log({ ensureAvatarThumbError: err?.message || err });
        }
      }
      const effectiveAvatar = ensuredAvatar || baseAvatar;
      const thumb = effectiveAvatar?.thumbDataUrl || effectiveAvatar?.previewDataUrl || null;
      if (thumb) {
        avatar = {
          ...effectiveAvatar,
          thumbDataUrl: thumb
        };
        if (!avatar.previewDataUrl && effectiveAvatar?.previewDataUrl) {
          avatar.previewDataUrl = effectiveAvatar.previewDataUrl;
        }
        if (!profileState?.avatar?.thumbDataUrl && thumb) {
          sessionStore.profileState = {
            ...(sessionStore.profileState || {}),
            avatar: { ...(sessionStore.profileState?.avatar || effectiveAvatar), thumbDataUrl: thumb }
          };
          profileState = sessionStore.profileState;
        }
      }
    }

    let conversationInfo = null;
    if (conversation) {
      const convToken = conversation.tokenB64 || conversation.token_b64 || null;
      const convId = conversation.conversationId || conversation.conversation_id || null;
      if (convToken && convId) {
        conversationInfo = {
          token_b64: convToken,
          conversation_id: convId
        };
        const drInitPayload = normalizeDrInit(drInit) || normalizeDrInit(conversation.dr_init || conversation.drInit);
        if (drInitPayload) conversationInfo.dr_init = drInitPayload;
      }
    }
    const overrideNickname = overrides?.nickname ? normalizeNickname(overrides.nickname) : null;
    const effectiveNickname = overrideNickname || nickname || generateRandomNickname();
    const payload = {
      nickname: effectiveNickname,
      avatar,
      addedAt: Math.floor(Date.now() / 1000)
    };
    if (conversationInfo) payload.conversation = conversationInfo;
    return payload;
  }
  async function ensureDevicePrivLoaded() {
    try {
      return await ensureDevicePrivAvailable();
    } catch (err) {
      const msg = err?.message || '找不到裝置金鑰，請重新登入完成初始化';
      throw new Error(msg);
    }
  }

  function isPrekeyRecoveryError(message) {
    if (!message) return false;
    const lower = String(message).toLowerCase();
    return lower.includes('prekey') || lower.includes('bundle');
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
