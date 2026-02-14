import { log, logCapped } from '../../core/log.js';
import { invitesStatus } from '../../api/invites.js';
import { sessionStore, restorePendingInvites, listPendingInvites, persistPendingInvites } from './session-store.js';
import { normalizeNickname } from '../../features/profile.js';
import { escapeHtml } from './ui-utils.js';
import { deleteContactSecret, getContactSecret, restoreContactSecrets } from '../../core/contact-secrets.js';
import { hydrateConversationsFromSecrets } from './session-store.js';
import { bootstrapDrFromGuestBundle } from '../../features/dr-session.js';
import { getAccountDigest, ensureDeviceId, normalizePeerIdentity, clearDrState, normalizeAccountDigest, normalizeDeviceId } from '../../core/store.js';
import { resetSecureConversation } from '../../features/secure-conversation-manager.js';
import { markConversationTombstone } from '../../features/messages-support/conversation-tombstone-store.js';
import { DEBUG } from './debug-flags.js';
import {
  upsertContactCore,
  patchContactCore,
  listReadyContacts,
  clearContactCore,
  removeContactCore,
  contactCoreReadyCount,
  getContactCore
} from './contact-core-store.js';
const contactCoreVerbose = DEBUG.contactCoreVerbose === true;

export function initContactsView(options) {
  const {
    dom,
    loadContactsApi,
    saveContactApi,
    friendsDeleteContact,
    modal,
    swipe,
    presenceManager,
    updateStats
  } = options;

  const {
    contactsListEl,
    contactsScrollEl,
    contactsSearchEl,
    contactsRefreshEl,
    contactsRefreshLabel
  } = dom;

  if (!contactsListEl) throw new Error('contactsListEl missing');
  if (!modal || typeof modal.showConfirmModal !== 'function') throw new Error('modal helpers required');
  if (!swipe || typeof swipe.setupSwipe !== 'function') throw new Error('swipe helpers required');
  if (!presenceManager) throw new Error('presence manager required');
  if (contactsScrollEl) {
    contactsScrollEl.style.overflowY = 'auto';
    contactsScrollEl.style.webkitOverflowScrolling = 'touch';
  }
  const counterEl = dom.contactsCountEl || dom.contactsContainer?.querySelector?.('[data-contacts-count]') || null;
  const updateContactCount = () => {
    if (!counterEl) return;
    const count = Array.isArray(sessionStore.contactState) ? sessionStore.contactState.length : 0;
    counterEl.textContent = String(count);
  };

  // --- Contact search / filter ---
  const applyContactFilter = () => {
    if (!contactsListEl) return;
    const query = (contactsSearchEl?.value || '').trim().toLowerCase();
    contactsListEl.querySelectorAll('.contact-item').forEach((item) => {
      if (!query) { item.style.display = ''; return; }
      const name = (item.querySelector('.name')?.textContent || '').toLowerCase();
      item.style.display = name.includes(query) ? '' : 'none';
    });
  };
  if (contactsSearchEl) {
    contactsSearchEl.addEventListener('input', applyContactFilter);
  }

  if (!sessionStore.conversationIndex) sessionStore.conversationIndex = new Map();
  const conversationIndex = sessionStore.conversationIndex;
  restorePendingInvites();
  if (!sessionStore.deletedContacts) sessionStore.deletedContacts = new Set();
  const deletedContacts = sessionStore.deletedContacts;
  const isHex64 = (value) => typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value.trim());
  const summarizeDigest = (value) => {
    const raw = typeof value === 'string' ? value.trim() : '';
    return {
      len: raw.length,
      isHex64: isHex64(raw),
      prefix8: raw.slice(0, 8) || null,
      suffix8: raw.slice(-8) || null
    };
  };

  const PULL_THRESHOLD = 60;
  const PULL_MAX = 140;
  const RECENT_REMOVE_SUPPRESS_MS = 45_000;
  const recentlyRemovedPeers = new Map();
  let pullGuardActive = false;
  let pullTracking = false;
  let pullDecided = false;
  let pullInvalid = false;
  let pullStartY = 0;
  let pullStartX = 0;
  let pullDistance = 0;
  let contactsRefreshing = false;
  let pendingInviteStatusInFlight = false;

  const contactKey = (entry) => {
    if (entry?.peerKey) return entry.peerKey;
    // Fallback logic
    if (typeof entry === 'string' && entry.includes('::')) {
      const [digestPart, devicePart] = entry.split('::');
      const digest = normalizeAccountDigest(digestPart);
      const deviceId = normalizeDeviceId(devicePart);
      if (digest && deviceId) return `${digest}::${deviceId}`;
      if (digest) return digest;
      return null;
    }
    const identity = normalizePeerIdentity(entry?.peerAccountDigest ?? entry?.accountDigest ?? entry);
    return identity.key || identity.accountDigest || null;
  };
  function renderContacts() {
    contactsListEl.innerHTML = '';

    const contacts = listReadyContacts();
    const pendingInvites = Array.isArray(listPendingInvites())
      ? listPendingInvites().filter((entry) => entry?.inviteId)
      : [];
    sessionStore.contactState = contacts;
    if (contactCoreVerbose) {
      try { console.log('[contact-core] render:list ' + JSON.stringify({ readyCount: contacts.length })); } catch { }
    }

    if (!contacts.length && !pendingInvites.length) {
      presenceManager.clearPresenceState();
      const empty = document.createElement('li');
      empty.className = 'contact-empty';
      empty.textContent = '尚未新增好友';
      contactsListEl.appendChild(empty);
      updateStats?.();
      updateContactCount();
      try { document.dispatchEvent(new CustomEvent('contacts:rendered')); } catch { }
      return;
    }
    if (!contacts.length) {
      presenceManager.clearPresenceState();
    }

    if (pendingInvites.length) {
      const now = Date.now();
      pendingInvites.forEach((entry) => {
        const expiresAt = Number(entry?.expiresAt || 0);
        const isExpired = Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now / 1000;
        const titleText = isExpired ? '已過期' : '同步中，等待對方完成建立';
        const metaText = isExpired ? '已過期' : '同步中，等待對方完成建立';
        const li = document.createElement('li');
        li.className = 'contact-item pending-invite';
        li.dataset.inviteId = String(entry.inviteId);
        li.setAttribute('aria-disabled', 'true');
        li.innerHTML = `
          <div class="item-content">
            <div class="avatar">${escapeHtml('?')}</div>
            <div class="info">
              <div class="name">
                <span class="name-text">${escapeHtml(titleText)}</span>
              </div>
              <div class="meta">${escapeHtml(metaText)}</div>
            </div>
          </div>`;
        contactsListEl.appendChild(li);
      });
    }

    const selfDigest = (getAccountDigest() || '').toUpperCase();

    contacts.forEach((c) => {
      const key = contactKey(c);
      if (!key) return;
      if (selfDigest && key === selfDigest) return;
      const name = normalizeNickname(c.nickname || '') || c.nickname || `好友 ${key.slice(-4)}`;
      const avatarSrc = c.avatar?.thumbDataUrl || c.avatar?.previewDataUrl || '';
      const initials = name ? name.slice(0, 2) : key.slice(-2);
      const tsSeconds = Number(c.addedAt || 0) || Math.floor(Date.now() / 1000);
      const lastStr = new Date(tsSeconds * 1000).toLocaleString();
      const isOnline = sessionStore.onlineContacts.has(key);
      const corruptMap = sessionStore.corruptContacts instanceof Map ? sessionStore.corruptContacts : null;
      const pendingMap = sessionStore.pendingContacts instanceof Map ? sessionStore.pendingContacts : null;
      const digestOnly = key.includes('::') ? key.split('::')[0] : key;
      const corruptInfo = corruptMap ? (corruptMap.get(key) || corruptMap.get(digestOnly)) : null;
      const pendingInfo = pendingMap ? (pendingMap.get(key) || pendingMap.get(digestOnly)) : null;
      const metaText = pendingInfo
        ? '同步中，請稍候'
        : (corruptInfo ? '狀態損壞，需要重新同步/重新邀請' : `最近同步：${lastStr}`);

      const li = document.createElement('li');
      li.className = 'contact-item';
      li.dataset.peerAccountDigest = key;
      if (c.msgId) li.dataset.msgId = String(c.msgId);
      li.innerHTML = `
        <div class="item-content">
          <div class="avatar">${avatarSrc ? `<img src="${escapeHtml(avatarSrc)}" alt="avatar" />` : escapeHtml(initials)}</div>
          <div class="info">
            <div class="name">
              <span class="presence-dot${isOnline ? ' online' : ''}" aria-hidden="true"></span>
              <span class="name-text">${escapeHtml(name)}</span>
            </div>
            <div class="meta">${escapeHtml(metaText)}</div>
          </div>
        </div>
        <button type="button" class="item-delete" aria-label="刪除好友"><i class='bx bx-trash'></i></button>`;

      const deleteBtn = li.querySelector('.item-delete');
      deleteBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        confirmDeleteContact({ peerAccountDigest: key, element: li, name });
      });

      li.addEventListener('click', (e) => {
        if (li.classList.contains('show-delete')) {
          e.preventDefault();
          swipe.closeSwipe(li);
          return;
        }
        const conversationId = c?.conversationId || c?.conversation?.conversation_id || null;
        const conversationToken = c?.conversationToken || c?.conversation?.token_b64 || null;
        const peerDeviceId = c?.peerDeviceId || (key.includes('::') ? key.split('::')[1] : null);
        const conversation = conversationToken && conversationId
          ? {
            token_b64: conversationToken,
            conversation_id: conversationId
          }
          : null;
        const detail = {
          peerAccountDigest: key,
          peerDeviceId,
          nickname: name,
          avatar: c?.avatar || null,
          conversation
        };
        if (contactCoreVerbose) {
          try { console.log('[contact-core] open ' + JSON.stringify({ peerKey: key, conversationId, hasToken: !!conversationToken, peerDeviceId })); } catch { }
        }
        try { console.log('[contacts-view]', { contactOpen: detail }); } catch { }
        try {
          document.dispatchEvent(new CustomEvent('contacts:open-conversation', { detail }));
        } catch (err) {
          log({ contactOpenEventError: err?.message || err });
        }
      });

      swipe.setupSwipe(li);
      li.querySelector('.name')?.setAttribute('title', `${name} (${key})`);
      contactsListEl.appendChild(li);
    });
    updateStats?.();
    updateContactCount();
    applyContactFilter();
    try { document.dispatchEvent(new CustomEvent('contacts:rendered')); } catch { }
  }

  function markRecentlyRemoved(key) {
    if (!key) return;
    recentlyRemovedPeers.set(key, Date.now());
  }

  function isRecentlyRemoved(key) {
    if (!key) return false;
    const ts = recentlyRemovedPeers.get(key);
    if (!ts) return false;
    if (Date.now() - ts > RECENT_REMOVE_SUPPRESS_MS) {
      recentlyRemovedPeers.delete(key);
      return false;
    }
    return true;
  }

  function removeContactState(peerAccountDigest, { notifyPeer = true } = {}) {
    const key = contactKey(peerAccountDigest);
    if (!key) return false;
    const accountOnly = key.includes('::') ? key.split('::')[0] : key;
    let mutated = false;
    const idx = sessionStore.contactState.findIndex((c) => {
      return contactKey(c) === key;
    });
    if (idx >= 0) {
      sessionStore.contactState.splice(idx, 1);
      mutated = true;
    }
    const existingCore = getContactCore(key);
    if (existingCore) {
      removeContactCore(key, 'contacts-view:remove-contact');
      mutated = true;
    }
    if (mutated) {
      deleteContactSecret(key);
      try {
        resetSecureConversation(key, { reason: 'contact-removed', source: 'contacts-view' });
      } catch (err) {
        log({ resetSecureConversationError: err?.message || err, peerAccountDigest: key });
      }
      presenceManager.removePresenceForContact(key);
      renderContacts();
      updateStats?.();
      markRecentlyRemoved(key);
      if (accountOnly) deletedContacts.add(accountOnly);
    }
    if (mutated && notifyPeer) {
      try {
        document.dispatchEvent(new CustomEvent('contacts:removed', { detail: { peerAccountDigest: key, notifyPeer: true } }));
      } catch (err) {
        log({ contactRemovedEventError: err?.message || err });
      }
    }
    return mutated;
  }

  function removeContactLocal(peerAccountDigest) {
    removeContactState(peerAccountDigest, { notifyPeer: true });
  }

  function showDeleteForContact(peerAccountDigest) {
    const key = contactKey(peerAccountDigest);
    if (!key || !contactsListEl) return;
    contactsListEl.querySelectorAll('.contact-item').forEach((item) => {
      if (!item || !item.classList) return;
      if (item.dataset.peerAccountDigest === key) item.classList.add('show-delete');
      else item.classList.remove('show-delete');
    });
  }

  function confirmDeleteContact({ peerAccountDigest, element, name }) {
    const key = contactKey(peerAccountDigest);
    if (!key) return;
    modal.showConfirmModal({
      title: '刪除好友',
      message: `確定要刪除「${escapeHtml(name || key)}」？`,
      confirmLabel: '刪除',
      onConfirm: async () => {
        try {
          const contactEntry = getContactCore(key);
          const convId = contactEntry?.conversationId || contactEntry?.conversation?.conversation_id || contactEntry?.conversation?.id || null;
          const peerDeviceId = contactEntry?.peerDeviceId || contactEntry?.conversation?.peerDeviceId || null;
          const accountDigestOnly = key.includes('::') ? key.split('::')[0] : key;
          await friendsDeleteContact({ peerAccountDigest: accountDigestOnly });
          deletedContacts.add(accountDigestOnly);
          if (convId) markConversationTombstone(convId);
          clearDrState(
            { peerAccountDigest: key, peerDeviceId },
            { __drDebugTag: 'web/src/app/ui/mobile/contacts-view.js:258:confirm-delete-contact' }
          );
          deleteContactSecret(key, { deviceId: ensureDeviceId() });
          removeContactState(key, { notifyPeer: true });
          if (element) swipe.closeSwipe(element);
          updateStats?.();
          log({ contactDeleted: key });
        } catch (err) {
          log({ contactDeleteError: err?.message || err });
          alert('刪除失敗，請稍後再試。');
        }
      }
    });
  }

  function applyContactsPullTransition(enable) {
    const transition = enable ? 'transform 120ms ease-out' : 'none';
    if (contactsRefreshEl) {
      contactsRefreshEl.style.transition = enable ? 'transform 120ms ease-out, opacity 120ms ease-out' : 'none';
    }
    if (contactsScrollEl) {
      contactsScrollEl.style.transition = transition;
    }
  }

  function updateContactsPull(offset) {
    const clamped = Math.min(PULL_MAX, Math.max(0, offset));
    const progress = Math.min(1, clamped / PULL_THRESHOLD);
    if (contactsRefreshEl) {
      const fadeStart = 5;
      const fadeRange = 25;
      const alpha = Math.min(1, Math.max(0, (clamped - fadeStart) / fadeRange));
      contactsRefreshEl.style.opacity = String(alpha);
      contactsRefreshEl.style.transform = 'translateY(0)';
      const spinner = contactsRefreshEl.querySelector('.icon');
      const labelEl = contactsRefreshEl.querySelector('.label');
      if (spinner && labelEl) {
        if (contactsRefreshing) {
          spinner.classList.add('spin');
          labelEl.textContent = '刷新聯絡人清單中';
        } else {
          spinner.classList.remove('spin');
          labelEl.textContent = clamped >= 10 ? '放開重整聯絡人列表' : '下拉更新聯絡人';
        }
      }
    }
    if (contactsScrollEl) {
      contactsScrollEl.style.transform = `translateY(${clamped}px)`;
    }
    if (contactsRefreshLabel) contactsRefreshLabel.textContent = progress >= 1 ? '鬆開更新聯絡人' : '下拉更新聯絡人';
  }

  function resetContactsPull({ animate = true } = {}) {
    pullDistance = 0;
    applyContactsPullTransition(animate);
    updateContactsPull(0);
  }

  function handleTouchStart(e) {
    if (contactsScrollEl && contactsScrollEl.scrollTop > 0) {
      pullGuardActive = true;
      return;
    }
    pullGuardActive = false;
    if (e.touches.length !== 1) return;
    pullTracking = true;
    pullDecided = false;
    pullInvalid = false;
    pullStartY = e.touches[0].clientY;
    pullStartX = e.touches[0].clientX;
    pullDistance = 0;
    applyContactsPullTransition(false);
  }

  function handleTouchMove(e) {
    if (pullGuardActive || !pullTracking || contactsRefreshing || pullInvalid) return;
    if (e.touches.length !== 1) return;
    const dy = e.touches[0].clientY - pullStartY;
    const dx = Math.abs(e.touches[0].clientX - pullStartX);
    if (!pullDecided) {
      if (Math.abs(dy) < 8 && dx < 8) return;
      pullDecided = true;
      if (dy <= 0 || dy < Math.abs(dx)) {
        pullTracking = false;
        pullInvalid = true;
        resetContactsPull({ animate: true });
        return;
      }
    }
    pullDistance = dy;
    if (pullDistance > 0) {
      e.preventDefault();
      updateContactsPull(pullDistance);
    }
  }

  async function handleTouchEnd() {
    if (pullGuardActive || !pullTracking) return;
    pullTracking = false;
    if (contactsRefreshing) return;
    if (pullDistance >= PULL_THRESHOLD && !pullInvalid) {
      contactsRefreshing = true;
      updateContactsPull(PULL_THRESHOLD);
      if (contactsRefreshLabel) contactsRefreshLabel.textContent = '載入中…';
      try {
        await loadInitialContacts();
      } finally {
        contactsRefreshing = false;
        resetContactsPull({ animate: true });
      }
    } else {
      resetContactsPull({ animate: true });
    }
  }

  function setupPullToRefresh() {
    if (!contactsScrollEl || !contactsRefreshEl) return;
    updateContactsPull(0);
    contactsScrollEl.addEventListener('touchstart', handleTouchStart, { passive: true });
    contactsScrollEl.addEventListener('touchmove', handleTouchMove, { passive: false });
    contactsScrollEl.addEventListener('touchend', handleTouchEnd, { passive: true });
    contactsScrollEl.addEventListener('touchcancel', handleTouchEnd, { passive: true });
  }

  function normalizeGuestBundleStrict(bundle) {
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
      throw new Error('guest bundle missing');
    }
    const allowed = new Set(['ik_pub', 'spk_pub', 'spk_sig', 'opk_id', 'opk_pub', 'ek_pub']);
    for (const key of Object.keys(bundle)) {
      if (!allowed.has(key)) {
        throw new Error(`guest bundle unexpected field: ${key}`);
      }
    }
    const ikPubB64 = typeof bundle.ik_pub === 'string' ? bundle.ik_pub.trim() : '';
    const spkPubB64 = typeof bundle.spk_pub === 'string' ? bundle.spk_pub.trim() : '';
    const signatureB64 = typeof bundle.spk_sig === 'string' ? bundle.spk_sig.trim() : '';
    const ekPubB64 = typeof bundle.ek_pub === 'string' ? bundle.ek_pub.trim() : '';
    const opkIdRaw = bundle.opk_id;
    if (!ikPubB64 || !spkPubB64 || !signatureB64 || !ekPubB64) {
      throw new Error('guest bundle missing keys');
    }
    if (opkIdRaw === null || opkIdRaw === undefined || opkIdRaw === '') {
      throw new Error('guest bundle missing opk_id');
    }
    const opkId = Number(opkIdRaw);
    if (!Number.isFinite(opkId) || opkId < 0) {
      throw new Error('guest bundle invalid opk_id');
    }
    return {
      ik_pub: ikPubB64,
      spk_pub: spkPubB64,
      spk_sig: signatureB64,
      opk_id: opkId,
      ek_pub: ekPubB64
    };
  }

  function scheduleDrBootstrap(peerAccountDigest, conversation) {
    // v1 strict: do not hydrate/bootstrap DR state during replay/hydrate.
    return;
    const key = contactKey(peerAccountDigest);
    if (!key || !conversation) return;
    const bundle = conversation?.dr_init?.guest_bundle;
    const peerDeviceId = conversation?.peerDeviceId || null;
    if (!bundle) return;
    const selfDeviceId = ensureDeviceId();
    // 僅 owner 端（peerDeviceId 等於自己）才允許 responder bootstrap，guest 端禁止。
    if (!selfDeviceId || !peerDeviceId || selfDeviceId !== peerDeviceId) return;
    let normalized = null;
    try {
      normalized = normalizeGuestBundleStrict(bundle);
    } catch (err) {
      log({ drBootstrapLoadError: err?.message || err, reasonCode: 'GuestBundleInvalid', peerAccountDigest: key });
      return;
    }
    bootstrapDrFromGuestBundle({ peerAccountDigest: key, peerDeviceId, guestBundle: normalized }).catch((err) => {
      log({ drBootstrapLoadError: err?.message || err, reasonCode: 'BootstrapFailed', peerAccountDigest: key });
    });
  }

  async function loadInitialContacts() {
    // contacts-view refresh uses delta-commit: only add/update complete entries; never clear/remove to avoid downgrading ready contacts or losing messages.
    // File: web/src/app/ui/mobile/contacts-view.js (loadInitialContacts)
    const DEBUG_CONTACTS_CORE = false;
    const DEBUG_CONTACTS_A1 = DEBUG.contactsA1 === true;
    if (DEBUG_CONTACTS_CORE) console.log('[contacts-view]', { contactsReloadStart: true, phase: 'start' });
    const selfAcct = getAccountDigest() || null;
    const prevReady = listReadyContacts();
    const prevPeers = new Set(
      prevReady
        .map((entry) => contactKey(entry))
        .filter(Boolean)
    );
    const prevReadyCount = prevPeers.size;
    const builtByKey = new Map();
    const profileUpdates = new Map();
    const buildCounts = { total: 0, ready: 0, skipped: 0, profileOnly: 0 };
    const localCache = new Map();
    if (Array.isArray(sessionStore.contactState)) {
      sessionStore.contactState.forEach((entry) => {
        const k = contactKey(entry);
        if (k) localCache.set(k, entry);
      });
    }
    const localConversationCache = conversationIndex instanceof Map ? new Map(conversationIndex) : new Map();
    const conversationPeerLookup = new Map();
    for (const [convId, conv] of localConversationCache.entries()) {
      if (!convId) continue;
      const convPeerKey = contactKey(conv?.peerAccountDigest || conv?.peerKey || conv);
      const convPeerDeviceId = normalizeDeviceId(conv?.peerDeviceId || (convPeerKey?.includes('::') ? convPeerKey.split('::')[1] : null));
      const convPeerDigest = convPeerKey ? convPeerKey.split('::')[0] : null;
      if (convPeerDigest && convPeerDeviceId) {
        conversationPeerLookup.set(convId, { peerKey: `${convPeerDigest}::${convPeerDeviceId}`, peerDeviceId: convPeerDeviceId });
      }
    }
    if (DEBUG_CONTACTS_A1) {
      const sampleLookup = [];
      for (const [convId, info] of conversationPeerLookup.entries()) {
        sampleLookup.push({ conversationId: convId, peerDeviceId: info?.peerDeviceId || null });
        if (sampleLookup.length >= 3) break;
      }
      try {
        console.log('[contacts-view][A1]', {
          conversationLookupBuilt: true,
          localConversationCacheSize: localConversationCache.size,
          conversationPeerLookupSize: conversationPeerLookup.size,
          sampleConversationIds: sampleLookup.map((item) => item.conversationId),
          samplePeerDeviceIds: sampleLookup.map((item) => item.peerDeviceId)
        });
      } catch { }
    }
    let fetched = [];
    try {
      const entries = await loadContactsApi();
      fetched = Array.isArray(entries) ? [...entries] : [];
    } catch (err) {
      log({ contactsInitError: err?.message || err });
      fetched = [];
    }
    // 若伺服器資料缺對端裝置，先用 contactSecrets 作為補全來源。
    const secretMap = restoreContactSecrets();
    const secretByKey = new Map();
    const secretByDigest = new Map();
    if (secretMap instanceof Map) {
      for (const [peerKeyRaw, record] of secretMap.entries()) {
        const key = contactKey(peerKeyRaw);
        if (!key) continue;
        secretByKey.set(key, record);
        const digest = key.split('::')[0];
        if (!secretByDigest.has(digest)) secretByDigest.set(digest, []);
        secretByDigest.get(digest).push({ key, record });
      }
    }

    const processed = new Set();
    const stageEntry = (payload, sourceTag) => {
      if (!payload) return null;
      buildCounts.total += 1;
      const peerKey = payload.peerKey || contactKey(payload);
      const hasProfile = (payload.nickname !== null && payload.nickname !== undefined) || (payload.avatar !== null && payload.avatar !== undefined);
      const complete = !!(payload.peerAccountDigest && payload.peerDeviceId && payload.conversationId && payload.conversationToken);
      const hasPeerIdentity = !!(payload.peerAccountDigest && payload.peerDeviceId);
      if (complete && peerKey) {
        let staged = { ...payload, peerKey, sourceTag };
        const stagedProfile = profileUpdates.get(peerKey);
        if (stagedProfile) {
          if (stagedProfile.nickname !== undefined) staged.nickname = stagedProfile.nickname;
          if (stagedProfile.avatar !== undefined) staged.avatar = stagedProfile.avatar;
          profileUpdates.delete(peerKey);
        }
        if (!builtByKey.has(peerKey)) {
          buildCounts.ready += 1;
        }
        builtByKey.set(peerKey, staged);
        processed.add(peerKey);
        if (DEBUG_CONTACTS_CORE) {
          console.log('[contacts-view]', {
            contactsCoreStage: 'stage-complete',
            phase: 'build',
            acct: selfAcct,
            peerDigest: payload.peerAccountDigest || null,
            peerDeviceId: payload.peerDeviceId || null,
            conversationId: payload.conversationId || null,
            hasToken: !!payload.conversationToken,
            hasProfile,
            counts: { buildTotal: buildCounts.total, buildReady: buildCounts.ready, skipped: buildCounts.skipped, profileOnly: buildCounts.profileOnly },
            sourceTag
          });
        }
        return staged;
      }
      if (hasPeerIdentity && hasProfile && peerKey) {
        const existingProfile = profileUpdates.get(peerKey) || {};
        const stagedProfile = {
          peerAccountDigest: payload.peerAccountDigest,
          peerDeviceId: payload.peerDeviceId,
          peerKey,
          nickname: payload.nickname !== undefined ? payload.nickname : existingProfile.nickname,
          avatar: payload.avatar !== undefined ? payload.avatar : existingProfile.avatar,
          sourceTag: sourceTag || existingProfile.sourceTag || null
        };
        profileUpdates.set(peerKey, stagedProfile);
        buildCounts.profileOnly += 1;
        if (DEBUG_CONTACTS_CORE) {
          console.log('[contacts-view]', {
            contactsCoreStage: 'stage-profile-only',
            phase: 'build',
            acct: selfAcct,
            peerDigest: payload.peerAccountDigest || null,
            peerDeviceId: payload.peerDeviceId || null,
            hasProfile,
            counts: { buildTotal: buildCounts.total, buildReady: buildCounts.ready, skipped: buildCounts.skipped, profileOnly: buildCounts.profileOnly },
            sourceTag
          });
        }
        if (builtByKey.has(peerKey)) {
          const existingComplete = builtByKey.get(peerKey);
          const mergedComplete = { ...existingComplete };
          if (payload.nickname !== undefined && payload.nickname !== null) mergedComplete.nickname = payload.nickname;
          if (payload.avatar !== undefined && payload.avatar !== null) mergedComplete.avatar = payload.avatar;
          builtByKey.set(peerKey, mergedComplete);
        }
        return stagedProfile;
      }
      buildCounts.skipped += 1;
      if (DEBUG_CONTACTS_CORE) {
        console.log('[contacts-view]', {
          contactsCoreStage: 'skip-incomplete',
          phase: 'build',
          acct: selfAcct,
          peerDigest: payload.peerAccountDigest || null,
          peerDeviceId: payload.peerDeviceId || null,
          conversationId: payload.conversationId || null,
          hasToken: !!payload.conversationToken,
          hasProfile,
          reason: !peerKey || !hasPeerIdentity ? 'missing-peer' : 'missing-profile',
          counts: { buildTotal: buildCounts.total, buildReady: buildCounts.ready, skipped: buildCounts.skipped, profileOnly: buildCounts.profileOnly },
          sourceTag
        });
      }
      return null;
    };
    const resolveCorePayload = (entry, sourceTag) => {
      const digest = normalizeAccountDigest(entry?.peerAccountDigest ?? entry?.accountDigest ?? entry);
      if (!digest || !isHex64(digest)) return null;
      let peerDeviceId = normalizeDeviceId(entry?.peerDeviceId || null);
      const rawKey = contactKey(entry);
      if (!peerDeviceId && rawKey && rawKey.includes('::')) {
        peerDeviceId = normalizeDeviceId(rawKey.split('::')[1]);
      }
      let conversationId =
        entry?.conversationId
        || entry?.conversation?.conversation_id
        || entry?.conversation?.id
        || null;
      let conversationToken =
        entry?.conversationToken
        || entry?.conversation?.token_b64
        || entry?.conversation?.token
        || null;
      let drInit = entry?.conversation?.dr_init || entry?.conversation?.drInit || null;
      let peerKeyFromLookup = null;
      const keyCandidate = peerDeviceId ? `${digest}::${peerDeviceId}` : rawKey;
      const secretForKey = keyCandidate ? secretByKey.get(keyCandidate) : null;
      const secretForDigestList = secretByDigest.get(digest) || [];
      const secretRecord = secretForKey || (secretForDigestList.length === 1 ? secretForDigestList[0].record : null);
      if (!peerDeviceId && secretRecord) {
        peerDeviceId = normalizeDeviceId(secretRecord?.peerDeviceId || null);
      }
      let localKey = peerDeviceId ? `${digest}::${peerDeviceId}` : rawKey;
      let cacheEntry = localKey ? localCache.get(localKey) || null : null;
      if (!peerDeviceId && cacheEntry?.peerDeviceId) {
        peerDeviceId = normalizeDeviceId(cacheEntry.peerDeviceId);
      }
      if (!peerDeviceId && conversationId && localConversationCache.has(conversationId)) {
        const convCache = localConversationCache.get(conversationId);
        peerDeviceId = normalizeDeviceId(convCache?.peerDeviceId || null);
      }
      if (!peerDeviceId && conversationId && conversationPeerLookup.has(conversationId)) {
        const convPeer = conversationPeerLookup.get(conversationId);
        const lookupKey = typeof convPeer?.peerKey === 'string' ? convPeer.peerKey : null;
        const lookupDigest = lookupKey && lookupKey.includes('::') ? normalizeAccountDigest(lookupKey.split('::')[0]) : null;
        const lookupDeviceId = normalizeDeviceId(convPeer?.peerDeviceId || (lookupKey && lookupKey.includes('::') ? lookupKey.split('::')[1] : null));
        if (lookupDeviceId && (!lookupDigest || lookupDigest === digest)) {
          peerDeviceId = lookupDeviceId;
          peerKeyFromLookup = lookupKey || (digest ? `${digest}::${lookupDeviceId}` : null);
        }
      }
      if (peerDeviceId) {
        const refreshedKey = `${digest}::${peerDeviceId}`;
        cacheEntry = localCache.get(refreshedKey) || cacheEntry;
        localKey = refreshedKey;
      } else if (!cacheEntry && peerKeyFromLookup) {
        cacheEntry = localCache.get(peerKeyFromLookup) || null;
        localKey = peerKeyFromLookup;
      }
      if (!conversationId) {
        conversationId =
          cacheEntry?.conversation?.conversation_id
          || secretRecord?.conversationId
          || secretRecord?.conversation?.id
          || null;
      }
      if (!conversationToken) {
        conversationToken =
          cacheEntry?.conversation?.token_b64
          || secretRecord?.conversationToken
          || secretRecord?.conversation?.token
          || null;
      }
      if (!drInit) {
        drInit =
          cacheEntry?.conversation?.dr_init
          || secretRecord?.conversation?.dr_init
          || secretRecord?.conversationDrInit
          || null;
      }
      const entryTs = Number(entry?.profileUpdatedAt || 0);
      const cacheTs = Number(cacheEntry?.profileUpdatedAt || 0);
      // [Fix] Stale Read Protection: If Local Cache is newer or equal, prefer it over D1.
      // preventing "toggle revert" where a slow D1 uplink overwrites a fresh local update.
      const preferLocal = cacheTs > 0 && cacheTs >= entryTs;

      const nickname = preferLocal
        ? (cacheEntry?.nickname ?? entry?.nickname ?? null)
        : (entry?.nickname ?? cacheEntry?.nickname ?? null);

      const avatar = preferLocal
        ? (cacheEntry?.avatar ?? entry?.avatar ?? null)
        : (entry?.avatar ?? cacheEntry?.avatar ?? null);

      const contactSecretResolved = entry?.contactSecret
        || secretRecord?.conversationToken
        || secretRecord?.conversation?.token
        || null;
      if ((!digest || !peerDeviceId) && DEBUG_CONTACTS_A1) {
        const hasLookupHit = !!(conversationId && conversationPeerLookup.has(conversationId));
        const conversationTokenPresent = !!conversationToken;
        try {
          console.log('[contacts-view][A1]', {
            resolveCorePayloadMissingPeerDevice: true,
            sourceTag,
            digest,
            rawKey,
            conversationId: conversationId || null,
            conversationTokenPresent,
            peerDeviceId: peerDeviceId || null,
            hasLookupHit
          });
        } catch { }
      }
      if (!digest || !peerDeviceId) return null;
      const resolvedPeerKey = peerKeyFromLookup || (peerDeviceId ? `${digest}::${peerDeviceId}` : null);
      return {
        peerAccountDigest: digest,
        peerDeviceId,
        conversationId: conversationId || null,
        conversationToken: conversationToken || null,
        nickname,
        avatar,
        contactSecret: contactSecretResolved,
        conversation: drInit ? { dr_init: drInit } : null,
        peerKey: resolvedPeerKey,
        sourceTag
      };
    };

    for (const entry of fetched) {
      const digest = normalizeAccountDigest(entry?.peerAccountDigest ?? entry?.accountDigest ?? entry);
      if (digest && deletedContacts.has(digest)) {
        log({ contactSkipDeleted: digest });
        continue;
      }
      const payload = resolveCorePayload(entry, 'contacts-view:fetched');
      if (!payload) continue;
      if (payload.peerKey && isRecentlyRemoved(payload.peerKey)) {
        presenceManager.removePresenceForContact(payload.peerKey);
        continue;
      }
      const staged = stageEntry(payload, 'contacts-view:fetched');
      if (staged?.peerKey && payload?.conversation?.dr_init) {
        scheduleDrBootstrap(payload.peerKey, { dr_init: payload.conversation.dr_init, peerDeviceId: payload.peerDeviceId });
      }
    }
    // 保留本地已存在但伺服器未返回的聯絡人，避免刷新後消失
    for (const [key, entry] of localCache.entries()) {
      if (processed.has(key)) continue;
      const digest = normalizeAccountDigest(entry?.peerAccountDigest ?? entry?.accountDigest ?? entry);
      if (digest && deletedContacts.has(digest)) continue;
      const payload = resolveCorePayload(entry, 'contacts-view:local-cache');
      if (!payload) continue;
      stageEntry(payload, 'contacts-view:local-cache');
    }
    // contact-secrets 還原聯絡人（含 peerDeviceId/token）
    if (secretMap instanceof Map) {
      for (const [peerKey, record] of secretMap.entries()) {
        const payload = resolveCorePayload({ ...record, peerAccountDigest: peerKey }, 'contacts-view:secrets');
        if (!payload) continue;
        if (processed.has(payload.peerKey)) continue;
        stageEntry(payload, 'contacts-view:secrets');
      }
    }

    if (DEBUG_CONTACTS_CORE) {
      console.log('[contacts-view]', {
        contactsCoreStage: 'build',
        phase: 'build',
        acct: selfAcct,
        counts: { total: buildCounts.total, ready: buildCounts.ready, skipped: buildCounts.skipped, profileOnly: buildCounts.profileOnly },
        committed: builtByKey.size,
        sourceTag: 'contacts-view:refresh'
      });
    }
    for (const entry of builtByKey.values()) {
      const profilePatch = profileUpdates.get(entry.peerKey);
      const mergedEntry = profilePatch ? { ...entry } : entry;
      if (profilePatch) {
        if (profilePatch.nickname !== undefined) mergedEntry.nickname = profilePatch.nickname;
        if (profilePatch.avatar !== undefined) mergedEntry.avatar = profilePatch.avatar;
        profileUpdates.delete(entry.peerKey);
      }
      upsertContactCore(mergedEntry, 'contacts-view:commit');
    }
    for (const [peerKey, profilePayload] of profileUpdates.entries()) {
      if (builtByKey.has(peerKey)) continue;
      const existingCore = getContactCore(peerKey);
      if (!existingCore) {
        if (DEBUG_CONTACTS_CORE) {
          console.log('[contacts-view]', {
            contactsCoreStage: 'profile-only-skip',
            phase: 'commit',
            acct: selfAcct,
            peerDigest: profilePayload.peerAccountDigest || null,
            peerDeviceId: profilePayload.peerDeviceId || null,
            reason: 'missing-core',
            sourceTag: profilePayload.sourceTag || 'contacts-view:profile-only'
          });
        }
        continue;
      }
      const patch = {};
      if (profilePayload.nickname !== undefined) patch.nickname = profilePayload.nickname;
      if (profilePayload.avatar !== undefined) patch.avatar = profilePayload.avatar;
      const nextNickname = patch.nickname ?? existingCore.nickname ?? null;
      const nextAvatar = patch.avatar ?? existingCore.avatar ?? null;
      if (nextNickname === existingCore.nickname && nextAvatar === existingCore.avatar) {
        if (DEBUG_CONTACTS_CORE) {
          console.log('[contacts-view]', {
            contactsCoreStage: 'profile-only-skip',
            phase: 'commit',
            acct: selfAcct,
            peerDigest: profilePayload.peerAccountDigest || null,
            peerDeviceId: profilePayload.peerDeviceId || null,
            reason: 'no-profile-change',
            sourceTag: profilePayload.sourceTag || 'contacts-view:profile-only'
          });
        }
        continue;
      }
      patchContactCore(peerKey, patch, 'contacts-view:profile-only');
      if (DEBUG_CONTACTS_CORE) {
        console.log('[contacts-view]', {
          contactsCoreStage: 'profile-only-commit',
          phase: 'commit',
          acct: selfAcct,
          peerDigest: profilePayload.peerAccountDigest || null,
          peerDeviceId: profilePayload.peerDeviceId || null,
          hasProfile: (patch.nickname !== undefined) || (patch.avatar !== undefined),
          sourceTag: profilePayload.sourceTag || 'contacts-view:profile-only'
        });
      }
    }
    if (DEBUG_CONTACTS_CORE) {
      console.log('[contacts-view]', {
        contactsCoreStage: 'commit',
        phase: 'commit',
        acct: selfAcct,
        counts: { total: buildCounts.total, ready: buildCounts.ready, skipped: buildCounts.skipped, profileOnly: buildCounts.profileOnly },
        committed: builtByKey.size,
        sourceTag: 'contacts-view:commit'
      });
    }

    const currentPeers = new Set(listReadyContacts().map((entry) => contactKey(entry)).filter(Boolean));
    for (const peer of prevPeers) {
      if (peer && !currentPeers.has(peer)) {
        try {
          document.dispatchEvent(new CustomEvent('contacts:removed', { detail: { peerAccountDigest: peer, notifyPeer: false } }));
        } catch (err) {
          log({ contactRemovedEventError: err?.message || err, peer });
        }
      }
    }
    try { await hydrateConversationsFromSecrets(); } catch { }
    renderContacts();
    presenceManager.sendPresenceSubscribe();
    updateContactCount();
    console.log('[contacts-view]', { contactsReloadDone: contactCoreReadyCount() });
  }

  async function refreshPendingInviteStatus({ source = 'startup' } = {}) {
    if (pendingInviteStatusInFlight) return;
    const pending = Array.isArray(listPendingInvites())
      ? listPendingInvites().filter((entry) => entry?.inviteId)
      : [];
    if (!pending.length) return;
    pendingInviteStatusInFlight = true;
    const nowSec = Date.now();
    let changed = false;
    let shouldReload = false;
    const store = restorePendingInvites();
    try {
      for (const entry of pending) {
        const inviteId = typeof entry?.inviteId === 'string' ? entry.inviteId.trim() : '';
        if (!inviteId) continue;
        let snapshot = null;
        try {
          snapshot = await invitesStatus({ inviteId });
        } catch (err) {
          log({ pendingInviteStatusError: err?.message || err, inviteId, source });
          continue;
        }
        const status = typeof snapshot?.status === 'string' ? snapshot.status.toUpperCase() : '';
        if (status === 'EXPIRED') {
          const existing = store.get(inviteId);
          const nextExpiresAt = nowSec;
          if (existing && Number(existing.expiresAt || 0) !== nextExpiresAt) {
            store.set(inviteId, { ...existing, inviteId, expiresAt: nextExpiresAt });
            changed = true;
          }
          continue;
        }
        if (status === 'CONSUMED') {
          const existing = store.get(inviteId);
          const hasSessionMaterial = !!(existing?.conversationToken && existing?.conversationId);
          if (!hasSessionMaterial) {
            if (store.delete(inviteId)) {
              changed = true;
            }
            shouldReload = true;
          }
        }
      }
    } finally {
      pendingInviteStatusInFlight = false;
    }
    if (changed) {
      persistPendingInvites();
      try { document.dispatchEvent(new CustomEvent('contacts:pending-invites-updated')); } catch { }
    }
    if (shouldReload && !contactsRefreshing) {
      try {
        await loadInitialContacts();
        renderContacts();
      } catch (err) {
        log({ pendingInviteContactsReloadError: err?.message || err });
      }
    }
  }

  async function addContactEntry({
    peerAccountDigest,
    peerDeviceId,
    nickname,
    avatar,
    conversation,
    contactSecret,
    addedAt,
    updatedAt
  } = {}) {
    let digest = null;
    let peerDeviceIdFromKey = null;
    const conversationIdRaw = conversation?.conversation_id || conversation?.conversationId || null;
    const conversationTokenRaw = conversation?.token_b64 || conversation?.tokenB64 || null;
    const conversationPeerDeviceId = normalizeDeviceId(conversation?.peerDeviceId || null);
    if (typeof peerAccountDigest === 'string' && peerAccountDigest.includes('::')) {
      const [dPart, devPart] = peerAccountDigest.split('::');
      digest = normalizeAccountDigest(dPart);
      peerDeviceIdFromKey = normalizeDeviceId(devPart);
    }
    const identity = normalizePeerIdentity({
      peerAccountDigest,
      peerDeviceId
    });
    digest = digest || identity.accountDigest || null;
    peerDeviceIdFromKey = peerDeviceIdFromKey || identity.deviceId || null;
    const missingCoreFields = !digest || !isHex64(digest) || !peerDeviceIdFromKey || !conversationIdRaw || !conversationTokenRaw;
    if (missingCoreFields) {
      console.warn('[contacts-view]', {
        contactAddEarlyReturn: 'missing-core',
        peerAccountDigest: digest || peerAccountDigest || null,
        peerDeviceId: peerDeviceIdFromKey || peerDeviceId || conversationPeerDeviceId || null,
        hasConvId: !!conversationIdRaw,
        hasToken: !!conversationTokenRaw
      });
      return null;
    }
    console.log('[contacts-view]', {
      contactAddEntryStart: {
        peerAccountDigest: digest || peerAccountDigest || null,
        hasConversation: !!(conversationIdRaw && conversationTokenRaw),
        hasSecret: !!contactSecret
      }
    });
    const key = `${digest}::${peerDeviceIdFromKey}`;
    if (!key) {
      console.warn('[contacts-view]', { contactAddEarlyReturn: 'missing-key', peerAccountDigest });
      return;
    }
    const selfDigest = (getAccountDigest() || '').toUpperCase();
    if (selfDigest && key === selfDigest) {
      console.log('[contacts-view]', { contactSkipSelfEntry: key });
      return;
    }
    const bypassRemovalGuard =
      !!(conversation && conversation.token_b64 && conversation.conversation_id) ||
      (typeof contactSecret === 'string' && contactSecret.length > 0);
    if (isRecentlyRemoved(key) && !bypassRemovalGuard) {
      console.log('[contacts-view]', { contactSuppressedAfterAddition: key, reason: 'recently-removed' });
      return;
    }
    if (bypassRemovalGuard && isRecentlyRemoved(key)) {
      recentlyRemovedPeers.delete(key);
    }
    if (conversationPeerDeviceId && peerDeviceIdFromKey && conversationPeerDeviceId !== peerDeviceIdFromKey) {
      console.warn('[contacts-view]', {
        contactConversationPeerDeviceMismatch: true,
        fromKey: peerDeviceIdFromKey,
        fromConversation: conversationPeerDeviceId
      });
    }
    try {
      const debugPayload = {
        contactAddDebug: {
          key,
          peerDeviceIdFromKey,
          peerDeviceIdArg: peerDeviceId || null,
          conversationPeerDeviceId: conversation?.peerDeviceId || null,
          conversationHas: !!(conversation && conversation.conversation_id && conversation.token_b64)
        }
      };
      console.log('[contacts-view]', debugPayload);
      try {
        console.log('[contacts-view]', '[contactAddDebug]', JSON.stringify(debugPayload));
      } catch { }
    } catch { }
    const conversationPayload = {
      token_b64: conversationTokenRaw,
      conversation_id: conversationIdRaw,
      ...(conversation?.dr_init ? { dr_init: conversation.dr_init } : null),
      // peer 裝置優先用 key 上的 deviceId，不從 conversation.peerDeviceId 覆寫
      peerDeviceId: peerDeviceIdFromKey || null
    };

    const now = Date.now();
    const isPlaceholderNickname = (name) => typeof name === 'string' && name.startsWith('好友 ');
    const incomingAddedAt = Number.isFinite(addedAt) ? Number(addedAt) : now;
    const incomingUpdatedAt = Number.isFinite(updatedAt) ? Number(updatedAt) : incomingAddedAt;
    const existing = getContactCore(key);
    const existingHasProfile = !!normalizeNickname(existing?.nickname || '') && !isPlaceholderNickname(existing?.nickname);
    const prevUpdatedAt = Number.isFinite(existing?.profileUpdatedAt)
      ? Number(existing.profileUpdatedAt)
      : existingHasProfile && Number.isFinite(existing?.updatedAt)
        ? Number(existing.updatedAt)
        : existingHasProfile && Number.isFinite(existing?.addedAt)
          ? Number(existing.addedAt)
          : 0;
    const incomingHasProfile = !!normalizeNickname(nickname || '');
    const takeIncomingProfile =
      (incomingHasProfile && !existingHasProfile)
      || (!prevUpdatedAt || (incomingUpdatedAt && incomingUpdatedAt >= prevUpdatedAt));

    const normalizedIncomingNickname = normalizeNickname(nickname || '') || null;
    const nicknameToStore = takeIncomingProfile
      ? normalizedIncomingNickname
      : (existing?.nickname || normalizedIncomingNickname || null);
    const resolvedNickname = nicknameToStore || `好友 ${key.slice(-4)}`;

    const contact = {
      peerAccountDigest: key,
      accountDigest: digest || null,
      peerDeviceId: peerDeviceIdFromKey,
      nickname: resolvedNickname,
      avatar: takeIncomingProfile ? (avatar || null) : (existing?.avatar || avatar || null),
      addedAt: existing?.addedAt || incomingAddedAt || now,
      profileUpdatedAt: takeIncomingProfile ? incomingUpdatedAt : (prevUpdatedAt || incomingUpdatedAt || now),
      conversation: conversationPayload,
      contactSecret: typeof contactSecret === 'string' ? contactSecret : null
    };
    try {
      console.log('[contacts-view]', {
        contactResolved: {
          key,
          resolvedNickname,
          incomingNickname: nickname || null,
          takeIncomingProfile,
          incomingUpdatedAt,
          prevUpdatedAt
        }
      });
    } catch { }
    try {
      console.log('[contacts-view]', {
        contactAddPreSave: {
          peerAccountDigest: key,
          conversationId: conversationPayload?.conversation_id || null,
          hasDrInit: !!conversationPayload?.dr_init
        }
      });
      console.log('[contacts-view]', {
        contactAddAttempt: key,
        hasConversation: !!conversationPayload,
        hasSecret: !!contact.contactSecret
      });
      console.log('[contacts-view]', {
        contactSaveDispatch: {
          peerAccountDigest: key,
          conversationId: conversationPayload?.conversation_id || null,
          hasDrInit: !!conversationPayload?.dr_init
        }
      });
      const saved = await saveContactApi(contact);
      const entry = saved ? {
        ...contact,
        conversation: saved.conversation || contact.conversation,
        contactSecret: saved.contactSecret_b64 || contact.contactSecret || null,
        msgId: saved.msgId || saved.id || contact.msgId || null
      } : contact;
      console.log('[contacts-view]', {
        contactAddSaved: key,
        msgId: entry.msgId || null,
        hasConversation: !!entry?.conversation?.conversation_id,
        peerDeviceId: entry?.conversation?.peerDeviceId || null
      });
      logCapped('contactAddSavedProof', {
        peerKeySuffix4: typeof key === 'string' ? key.slice(-4) : null,
        hasConversation: !!entry?.conversation?.conversation_id,
        hasSecret: !!entry?.contactSecret
      }, 5);
      try {
        if (contactCoreVerbose) {
          console.log('[contact-core] pre-upsert', {
            sourceTag: 'contacts-view:add-contact',
            peerKey: key,
            peerAccountDigest: summarizeDigest(digest || peerAccountDigest || null),
            peerDeviceId: peerDeviceIdFromKey || null,
            conversationId: entry?.conversation?.conversation_id || null,
            hasToken: !!entry?.conversation?.token_b64
          });
        }
      } catch { }
      const upserted = upsertContactCore({
        peerAccountDigest: digest,
        peerDeviceId: peerDeviceIdFromKey,
        conversationId: entry?.conversation?.conversation_id,
        conversationToken: entry?.conversation?.token_b64,
        nickname: nicknameToStore,
        avatar: takeIncomingProfile ? (avatar || null) : (existing?.avatar || avatar || null),
        contactSecret: entry.contactSecret,
        conversation: entry.conversation,
        addedAt: contact.addedAt,
        profileUpdatedAt: contact.profileUpdatedAt,
        msgId: entry.msgId || null
      }, 'contacts-view:add-contact');
      if (!upserted) {
        throw new Error('contact-core upsert failed');
      }
      if (entry?.conversation?.dr_init) {
        scheduleDrBootstrap(key, entry.conversation);
      }
      renderContacts();
      presenceManager.sendPresenceSubscribe();
      updateStats?.();
      updateContactCount();
      emitContactEntryUpdated(upserted, { peerAccountDigest: key, isNew: !existing });
      console.log('[contacts-view]', {
        contactAddReturn: {
          peerAccountDigest: key,
          msgId: upserted.msgId || null,
          conversationId: upserted?.conversationId || upserted?.conversation?.conversation_id || null
        }
      });
      return upserted;
    } catch (err) {
      console.error('[contacts-view]', { contactAddError: err?.message || err, peerAccountDigest: key });
      throw err;
    }
  }

  function emitContactEntryUpdated(entry, { peerAccountDigest, isNew } = {}) {
    const key = contactKey(peerAccountDigest);
    if (!key) return;
    try {
      document.dispatchEvent(new CustomEvent('contacts:entry-updated', {
        detail: {
          peerAccountDigest: key,
          isNew: !!isNew,
          entry
        }
      }));
      updateContactCount();
    } catch (err) {
      log({ contactEntryUpdateEventError: err?.message || err, peerAccountDigest: key });
    }
  }

  async function refreshContactsAfterInviteConsume() {
    if (contactsRefreshing) return;
    contactsRefreshing = true;
    logCapped('contactsRefreshAfterInviteConsume', {
      stage: 'start',
      readyCount: contactCoreReadyCount()
    }, 5);
    let errorMessage = null;
    try {
      await loadInitialContacts();
      renderContacts();
    } catch (err) {
      errorMessage = err?.message || String(err);
    } finally {
      const donePayload = { stage: 'done', readyCount: contactCoreReadyCount() };
      if (errorMessage) donePayload.error = errorMessage;
      logCapped('contactsRefreshAfterInviteConsume', donePayload, 5);
      contactsRefreshing = false;
    }
  }

  setupPullToRefresh();
  refreshPendingInviteStatus({ source: 'startup' }).catch((err) => {
    log({ pendingInviteStatusRefreshError: err?.message || err });
  });

  document.addEventListener('contacts:refresh-after-consume', () => {
    refreshContactsAfterInviteConsume();
  });
  document.addEventListener('contacts:changed', (event) => {
    const detail = event?.detail || {};
    if (detail?.reason !== 'contact-share-commit') return;
    if (contactsRefreshing) return;
    contactsRefreshing = true;
    Promise.resolve()
      .then(() => loadInitialContacts())
      .then(() => renderContacts())
      .catch((err) => log({ contactsRefreshError: err?.message || err, source: 'contacts:changed' }))
      .finally(() => {
        contactsRefreshing = false;
      });
  });
  document.addEventListener('contacts:show-delete', (event) => {
    const detail = event?.detail || {};
    const targetPeer = contactKey(detail.peerAccountDigest || detail.peer || detail.peerDigest);
    showDeleteForContact(targetPeer);
  });

  document.addEventListener('contacts:removed', (event) => {
    const detail = event?.detail || {};
    if (!detail || detail.notifyPeer) return;
    const peer = contactKey(detail.peerAccountDigest || detail.peer || detail.peerDigest);
    if (!peer) return;
    removeContactState(peer, { notifyPeer: false });
  });
  document.addEventListener('contacts:pending-invites-updated', () => {
    try { renderContacts(); } catch (err) { log({ contactsRenderError: err?.message || err, source: 'pending-invites' }); }
  });

  return {
    loadInitialContacts,
    renderContacts,
    addContactEntry,
    removeContactLocal
  };
}
