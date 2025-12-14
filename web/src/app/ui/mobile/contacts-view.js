import { log } from '../../core/log.js';
import { sessionStore } from './session-store.js';
import { normalizeNickname } from '../../features/profile.js';
import { escapeHtml } from './ui-utils.js';
import { deleteContactSecret, getContactSecret, restoreContactSecrets } from '../../core/contact-secrets.js';
import { hydrateConversationsFromSecrets } from './session-store.js';
import { bootstrapDrFromGuestBundle } from '../../features/dr-session.js';
import { getAccountDigest, ensureDeviceId, normalizePeerIdentity, clearDrState, normalizeAccountDigest, normalizeDeviceId } from '../../core/store.js';
import { resetSecureConversation } from '../../features/secure-conversation-manager.js';
import { markConversationTombstone } from '../../features/messages.js';

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

  const contactState = sessionStore.contactState;
  const contactIndex = sessionStore.contactIndex;
  if (!sessionStore.conversationIndex) sessionStore.conversationIndex = new Map();
  const conversationIndex = sessionStore.conversationIndex;
  if (!sessionStore.deletedContacts) sessionStore.deletedContacts = new Set();
  const deletedContacts = sessionStore.deletedContacts;

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

  const contactKey = (entry) => {
    // entry 可能是 digest、digest::deviceId 或物件
    if (typeof entry === 'string' && entry.includes('::')) {
      const [digestPart, devicePart] = entry.split('::');
      const digest = normalizeAccountDigest(digestPart);
      const deviceId = normalizeDeviceId(devicePart);
      if (digest && deviceId) return `${digest}::${deviceId}`;
      if (digest) return digest;
      return null;
    }
    const identity = normalizePeerIdentity(entry?.peerAccountDigest ?? entry?.accountDigest ?? entry);
    // 優先使用 digest+deviceId，若裝置 ID 缺失則退回僅 digest，避免整條流程直接早退
    return identity.key || identity.accountDigest || null;
  };
  function renderContacts() {
    contactsListEl.innerHTML = '';

    if (!sessionStore.contactState.length) {
      presenceManager.clearPresenceState();
      const empty = document.createElement('li');
      empty.className = 'contact-empty';
      empty.textContent = '尚未新增好友';
      contactsListEl.appendChild(empty);
      updateStats?.();
      updateContactCount();
      try { document.dispatchEvent(new CustomEvent('contacts:rendered')); } catch {}
      return;
    }

    const selfDigest = (getAccountDigest() || '').toUpperCase();

    sessionStore.contactState.forEach((c) => {
      const key = contactKey(c);
      if (!key) return;
      if (selfDigest && key === selfDigest) return;
      const name = normalizeNickname(c.nickname || '') || c.nickname || `好友 ${key.slice(-4)}`;
      const avatarSrc = c.avatar?.thumbDataUrl || c.avatar?.previewDataUrl || '';
      const initials = name ? name.slice(0, 2) : key.slice(-2);
      const tsSeconds = Number(c.addedAt || 0) || Math.floor(Date.now() / 1000);
      const lastStr = new Date(tsSeconds * 1000).toLocaleString();
      const isOnline = sessionStore.onlineContacts.has(key);

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
            <div class="meta">最近同步：${escapeHtml(lastStr)}</div>
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
        const conversation = c?.conversation && c.conversation.token_b64 && c.conversation.conversation_id
          ? {
              token_b64: c.conversation.token_b64,
              conversation_id: c.conversation.conversation_id
            }
          : null;
        const detail = {
          peerAccountDigest: key,
          peerDeviceId: (key.includes('::') ? key.split('::')[1] : null),
          nickname: name,
          avatar: c?.avatar || null,
          conversation
        };
        try { console.log('[contacts-view]', { contactOpen: detail }); } catch {}
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
    try { document.dispatchEvent(new CustomEvent('contacts:rendered')); } catch {}
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
    if (contactIndex.delete(key)) mutated = true;
    if (conversationIndex) {
      for (const [convId, info] of conversationIndex.entries()) {
        const peerMatch = contactKey(info);
        if (peerMatch === key) {
          conversationIndex.delete(convId);
          mutated = true;
        }
      }
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
          const contactEntry = sessionStore.contactIndex?.get?.(key) || null;
          const convId = contactEntry?.conversation?.conversation_id || contactEntry?.conversation?.id || null;
          const peerDeviceId = contactEntry?.conversation?.peerDeviceId || null;
          const accountDigestOnly = key.includes('::') ? key.split('::')[0] : key;
          await friendsDeleteContact({ peerAccountDigest: accountDigestOnly });
          deletedContacts.add(accountDigestOnly);
          if (convId) markConversationTombstone(convId);
          clearDrState({ peerAccountDigest: key, peerDeviceId });
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

  function scheduleDrBootstrap(peerAccountDigest, conversation) {
    const key = contactKey(peerAccountDigest);
    if (!key || !conversation) return;
    const bundle = conversation?.dr_init?.guest_bundle || conversation?.drInit?.guestBundle;
    const peerDeviceId = conversation?.peerDeviceId || null;
    if (!bundle) return;
    const selfDeviceId = ensureDeviceId();
    // 僅 owner 端（peerDeviceId 等於自己）才允許 responder bootstrap，guest 端禁止。
    if (!selfDeviceId || !peerDeviceId || selfDeviceId !== peerDeviceId) return;
    bootstrapDrFromGuestBundle({ peerAccountDigest: key, peerDeviceId, guestBundle: bundle }).catch((err) => {
      log({ drBootstrapLoadError: err?.message || err });
    });
  }

  async function loadInitialContacts() {
    console.log('[contacts-view]', { contactsReloadStart: true });
    const prevPeers = new Set(
      Array.isArray(sessionStore.contactState)
        ? sessionStore.contactState.map((entry) => contactKey(entry)).filter(Boolean)
        : []
    );
    const localCache = new Map();
    if (Array.isArray(sessionStore.contactState)) {
      sessionStore.contactState.forEach((entry) => {
        const k = contactKey(entry);
        if (k) localCache.set(k, entry);
      });
    }
    const localConversationCache = conversationIndex instanceof Map ? new Map(conversationIndex) : new Map();
    let fetched = [];
    try {
      const entries = await loadContactsApi();
      fetched = Array.isArray(entries) ? [...entries] : [];
    } catch (err) {
      log({ contactsInitError: err?.message || err });
      fetched = [];
    }
    contactIndex.clear();
    if (conversationIndex) conversationIndex.clear();
    // 若伺服器資料缺對端裝置，先用 contactSecrets 補齊 conversationIndex，避免後續解密缺 peerDeviceId。
    try { hydrateConversationsFromSecrets(); } catch {}
    let missingConv = 0;
    let missingConvToken = 0;
    let missingConvDevice = 0;
    const sanitized = [];
    for (const entry of fetched) {
      const digest = normalizeAccountDigest(entry?.peerAccountDigest ?? entry?.accountDigest ?? entry);
      const peerDeviceIdFromEntry = normalizeDeviceId(entry?.peerDeviceId || null);
      const conv = entry?.conversation;
      const key = digest && peerDeviceIdFromEntry
        ? `${digest}::${peerDeviceIdFromEntry}`
        : contactKey(entry);
      if (!key) continue;
      if (digest && deletedContacts.has(digest)) {
        log({ contactSkipDeleted: digest });
        continue;
      }
      if (isRecentlyRemoved(key)) {
        presenceManager.removePresenceForContact(key);
        continue;
      }
      const normalizedEntry = {
        ...entry,
        peerAccountDigest: key,
        accountDigest: digest || normalizeAccountDigest(entry?.peerAccountDigest ?? null) || null,
        peerDeviceId: peerDeviceIdFromEntry || null
      };
      contactIndex.set(key, normalizedEntry);
      if (!conv) {
        missingConv += 1;
      }
      if (conv?.conversation_id && conv?.token_b64 && conversationIndex) {
        const peerDeviceId = peerDeviceIdFromEntry || null;
        if (peerDeviceId) {
          conversationIndex.set(conv.conversation_id, {
            token_b64: conv.token_b64,
            peerAccountDigest: key,
            peerDeviceId,
            dr_init: conv.dr_init || null
          });
          const isHidden = entry?.hidden === true || entry?.isSelfContact === true;
          if (!isHidden) {
            scheduleDrBootstrap(key, conv);
          }
        } else {
          missingConvDevice += 1;
          log({ contactMissingPeerDevice: key });
        }
      } else if (conv?.conversation_id || conv?.token_b64) {
        missingConvToken += 1;
        console.warn('[contacts-view]', {
          contactMissingConversationToken: key,
          hasConversationId: !!conv?.conversation_id,
          hasToken: !!conv?.token_b64
        });
      }
      if (entry?.hidden === true || entry?.isSelfContact === true) {
        continue;
      }
      sanitized.push(normalizedEntry);
    }
    // 保留本地已存在但伺服器未返回的聯絡人，避免刷新後消失
    for (const [key, entry] of localCache.entries()) {
      if (contactIndex.has(key)) {
        // 補回伺服器缺的 peerDeviceId，避免覆蓋掉本地正確裝置
        const existing = contactIndex.get(key);
        const mergedPeerDeviceId = existing?.peerDeviceId || entry?.peerDeviceId || null;
        if (!entry.peerDeviceId && mergedPeerDeviceId) entry.peerDeviceId = mergedPeerDeviceId;
        // conversation.peerDeviceId 僅用於顯示，不用來覆蓋 peer 裝置。
        const merged = { ...existing, ...entry };
        contactIndex.set(key, merged);
        sanitized.push(merged);
      } else {
        contactIndex.set(key, entry);
        sanitized.push(entry);
      }
      const conv = entry?.conversation;
      if (conv?.conversation_id && conv?.token_b64 && conversationIndex) {
        const peerDeviceId = entry?.peerDeviceId || null;
        if (peerDeviceId) {
          conversationIndex.set(conv.conversation_id, {
            token_b64: conv.token_b64,
            peerAccountDigest: key,
            peerDeviceId,
            dr_init: conv.dr_init || null
          });
        }
      } else if (conv?.conversation_id && localConversationCache.has(conv.conversation_id)) {
        conversationIndex.set(conv.conversation_id, localConversationCache.get(conv.conversation_id));
      }
    }
    // 若伺服器/本地快取都沒有資料，嘗試從 contact-secrets 還原聯絡人（含 peerDeviceId/token）
    if (!sanitized.length) {
      const secretMap = restoreContactSecrets();
      const restored = [];
      if (secretMap instanceof Map) {
        for (const [peerKey, record] of secretMap.entries()) {
          const [dPart, devPart] = typeof peerKey === 'string' && peerKey.includes('::') ? peerKey.split('::') : [peerKey, null];
          const digest = normalizeAccountDigest(dPart);
          const peerDeviceId = normalizeDeviceId(record?.peerDeviceId || devPart || null);
          const token = record?.conversationToken || record?.conversation?.token || null;
          const convId = record?.conversationId || record?.conversation?.id || null;
          const drInit = record?.conversationDrInit || record?.conversation?.drInit || null;
          if (!digest || !peerDeviceId || !token || !convId) continue;
          const key = `${digest}::${peerDeviceId}`;
          if (contactIndex.has(key)) continue;
          const entry = {
            peerAccountDigest: key,
            accountDigest: digest,
            peerDeviceId,
            nickname: '',
            avatar: null,
            conversation: {
              conversation_id: convId,
              token_b64: token,
              peerDeviceId,
              ...(drInit ? { dr_init: drInit } : null)
            },
            contactSecret: token
          };
          contactIndex.set(key, entry);
          restored.push(entry);
          if (conversationIndex) {
            conversationIndex.set(convId, {
              token_b64: token,
              peerAccountDigest: key,
              peerDeviceId,
              dr_init: drInit || null
            });
          }
        }
      }
      if (restored.length) {
        console.log('[contacts-view]', { contactsRestoreFromSecrets: restored.length });
        sanitized.push(...restored);
      }
    }

    console.log('[contacts-view]', {
      contactsReloadFetched: sanitized.length,
      missingConversation: missingConv,
      missingConversationToken: missingConvToken,
      missingConversationDevice: missingConvDevice
    });
    // 過濾已標記刪除的帳號，並同步清除 index
    const filtered = [];
    for (const entry of sanitized) {
      const k = contactKey(entry);
      const acct = typeof k === 'string' && k.includes('::') ? k.split('::')[0] : k;
      if (acct && deletedContacts.has(acct)) {
        contactIndex.delete(k);
        if (entry?.conversation?.conversation_id) conversationIndex?.delete?.(entry.conversation.conversation_id);
        continue;
      }
      filtered.push(entry);
    }
    sessionStore.contactState = filtered;
    const currentPeers = new Set(sanitized.map((entry) => contactKey(entry)).filter(Boolean));
    for (const peer of prevPeers) {
      if (peer && !currentPeers.has(peer)) {
        try {
          document.dispatchEvent(new CustomEvent('contacts:removed', { detail: { peerAccountDigest: peer, notifyPeer: false } }));
        } catch (err) {
          log({ contactRemovedEventError: err?.message || err, peer });
        }
      }
    }
    try { hydrateConversationsFromSecrets(); } catch {}
    renderContacts();
    presenceManager.sendPresenceSubscribe();
    updateContactCount();
    console.log('[contacts-view]', { contactsReloadDone: sanitized.length });
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
    if (!digest || !peerDeviceIdFromKey) {
      console.warn('[contacts-view]', { contactAddEarlyReturn: 'missing-peer-device', peerAccountDigest });
      throw new Error('peerDeviceId required for contact');
    }
    console.log('[contacts-view]', {
      contactAddEntryStart: {
        peerAccountDigest: digest || peerAccountDigest || null,
        hasConversation: !!(conversation?.conversation_id && conversation?.token_b64),
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
    const conversationPeerDeviceId = normalizeDeviceId(conversation?.peerDeviceId || null);
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
      } catch {}
    } catch {}
    const conversationPayload = conversation && conversation.conversation_id && conversation.token_b64 ? {
      token_b64: conversation.token_b64,
      conversation_id: conversation.conversation_id,
      ...(conversation.dr_init ? { dr_init: conversation.dr_init } : null),
      // peer 裝置優先用 key 上的 deviceId，不從 conversation.peerDeviceId 覆寫
      peerDeviceId: peerDeviceIdFromKey || null
    } : null;
    if (conversation && !conversationPayload?.peerDeviceId) {
      console.warn('[contacts-view]', {
        contactAddConversationMissingPeerDevice: true,
        peerAccountDigest,
        digest,
        peerDeviceIdFromKey,
        conversationPeerDeviceId
      });
      throw new Error('peerDeviceId required for conversation');
    }

    const now = Math.floor(Date.now() / 1000);
    const isPlaceholderNickname = (name) => typeof name === 'string' && name.startsWith('好友 ');
    const incomingAddedAt = Number.isFinite(addedAt) ? Number(addedAt) : now;
    const incomingUpdatedAt = Number.isFinite(updatedAt) ? Number(updatedAt) : incomingAddedAt;
    const existing = sessionStore.contactIndex?.get?.(key) || null;
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

    let resolvedNickname = takeIncomingProfile
      ? (nickname || '')
      : (existing?.nickname || nickname || '');
    resolvedNickname = normalizeNickname(resolvedNickname || '') || resolvedNickname || '';
    if (!resolvedNickname) {
      resolvedNickname = `好友 ${key.slice(-4)}`;
    }

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
    } catch {}
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
      contactIndex.set(key, entry);
      if (entry?.conversation?.conversation_id && entry?.conversation?.token_b64 && conversationIndex) {
        // 固定使用 key 上的對端裝置；conversation.peerDeviceId 不覆寫 peer 裝置。
        const peerDeviceId = peerDeviceIdFromKey || null;
        if (peerDeviceId) {
          conversationIndex.set(entry.conversation.conversation_id, {
            token_b64: entry.conversation.token_b64,
            peerAccountDigest: key,
            peerDeviceId,
            dr_init: entry.conversation.dr_init || null
          });
          scheduleDrBootstrap(key, entry.conversation);
        } else {
          console.warn('[contacts-view]', { contactMissingPeerDevice: key });
        }
      }
      const existingIndex = sessionStore.contactState.findIndex((c) => {
        return contactKey(c) === key;
      });
      if (existingIndex >= 0) {
        sessionStore.contactState[existingIndex] = entry;
      } else {
        sessionStore.contactState.unshift(entry);
      }
      renderContacts();
      presenceManager.sendPresenceSubscribe();
      updateStats?.();
      updateContactCount();
      emitContactEntryUpdated(entry, { peerAccountDigest: key, isNew: existingIndex < 0 });
      console.log('[contacts-view]', {
        contactAddReturn: {
          peerAccountDigest: key,
          msgId: entry.msgId || null,
          conversationId: entry?.conversation?.conversation_id || null
        }
      });
      return entry;
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

  setupPullToRefresh();

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

  return {
    loadInitialContacts,
    renderContacts,
    addContactEntry,
    removeContactLocal
  };
}
