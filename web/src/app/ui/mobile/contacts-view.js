import { log } from '../../core/log.js';
import { sessionStore } from './session-store.js';
import { normalizeNickname } from '../../features/profile.js';
import { escapeHtml } from './ui-utils.js';
import { deleteContactSecret, getContactSecret } from '../../core/contact-secrets.js';
import { bootstrapDrFromGuestBundle } from '../../features/dr-session.js';
import { getUidHex, getAccountDigest } from '../../core/store.js';

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

  const contactState = sessionStore.contactState;
  const contactIndex = sessionStore.contactIndex;
  if (!sessionStore.conversationIndex) sessionStore.conversationIndex = new Map();
  const conversationIndex = sessionStore.conversationIndex;

  const PULL_THRESHOLD = 88;
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

  function renderContacts() {
    contactsListEl.innerHTML = '';

    if (!sessionStore.contactState.length) {
      presenceManager.clearPresenceState();
      const empty = document.createElement('li');
      empty.className = 'contact-empty';
      empty.textContent = '尚未新增好友';
      contactsListEl.appendChild(empty);
      updateStats?.();
      try { document.dispatchEvent(new CustomEvent('contacts:rendered')); } catch {}
      return;
    }

    const selfUid = (getUidHex() || '').toUpperCase();
    const selfDigest = (getAccountDigest() || '').toUpperCase();

    sessionStore.contactState.forEach((c) => {
      const key = String(c?.peerUid || '').toUpperCase();
      if (!key) return;
      if ((selfUid && key === selfUid) || (selfDigest && key === selfDigest)) return;
      const name = normalizeNickname(c.nickname || '') || c.nickname || `好友 ${key.slice(-4)}`;
      const avatarSrc = c.avatar?.thumbDataUrl || c.avatar?.previewDataUrl || '';
      const initials = name ? name.slice(0, 2) : key.slice(-2);
      const tsSeconds = Number(c.addedAt || 0) || Math.floor(Date.now() / 1000);
      const lastStr = new Date(tsSeconds * 1000).toLocaleString();
      const isOnline = sessionStore.onlineContacts.has(key);

      const li = document.createElement('li');
      li.className = 'contact-item';
      li.dataset.peerUid = key;
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
        confirmDeleteContact({ peerUid: key, element: li, name });
      });

      li.addEventListener('click', (e) => {
        if (li.classList.contains('show-delete')) {
          e.preventDefault();
          swipe.closeSwipe(li);
          return;
        }
        const detail = {
          peerUid: key,
          nickname: name,
          avatar: c?.avatar || null,
          conversation: c?.conversation && c.conversation.token_b64 && c.conversation.conversation_id
            ? {
                token_b64: c.conversation.token_b64,
                conversation_id: c.conversation.conversation_id
              }
            : null
        };
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

  function removeContactState(peerUid, { notifyPeer = true } = {}) {
    const key = String(peerUid || '').toUpperCase();
    if (!key) return false;
    let mutated = false;
    const idx = sessionStore.contactState.findIndex((c) => String(c?.peerUid || '').toUpperCase() === key);
    if (idx >= 0) {
      sessionStore.contactState.splice(idx, 1);
      mutated = true;
    }
    if (contactIndex.delete(key)) mutated = true;
    if (conversationIndex) {
      for (const [convId, info] of conversationIndex.entries()) {
        if (info?.peerUid === key) {
          conversationIndex.delete(convId);
          mutated = true;
        }
      }
    }
    if (mutated) {
      deleteContactSecret(key);
      presenceManager.removePresenceForContact(key);
      renderContacts();
      updateStats?.();
      markRecentlyRemoved(key);
    }
    if (mutated && notifyPeer) {
      try {
        document.dispatchEvent(new CustomEvent('contacts:removed', { detail: { peerUid: key, notifyPeer: true } }));
      } catch (err) {
        log({ contactRemovedEventError: err?.message || err });
      }
    }
    return mutated;
  }

  function removeContactLocal(peerUid) {
    removeContactState(peerUid, { notifyPeer: true });
  }

  function showDeleteForContact(peerUid) {
    const key = String(peerUid || '').toUpperCase();
    if (!key || !contactsListEl) return;
    contactsListEl.querySelectorAll('.contact-item').forEach((item) => {
      if (!item || !item.classList) return;
      if (item.dataset.peerUid === key) item.classList.add('show-delete');
      else item.classList.remove('show-delete');
    });
  }

  function confirmDeleteContact({ peerUid, element, name }) {
    const key = String(peerUid || '').toUpperCase();
    if (!key) return;
    modal.showConfirmModal({
      title: '刪除好友',
      message: `確定要刪除「${escapeHtml(name || key)}」？`,
      confirmLabel: '刪除',
      onConfirm: async () => {
        try {
          await friendsDeleteContact({ peerUid: key });
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
    if (!contactsRefreshEl) return;
    contactsRefreshEl.style.transition = enable ? 'transform 120ms ease-out, opacity 120ms ease-out' : 'none';
  }

  function updateContactsPull(offset) {
    if (!contactsRefreshEl) return;
    const clamped = Math.min(PULL_MAX, Math.max(0, offset));
    const progress = Math.min(1, clamped / PULL_THRESHOLD);
    contactsRefreshEl.style.opacity = String(Math.min(1, progress * 1.2));
    contactsRefreshEl.style.transform = `translateY(${clamped}px)`;
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
      if (contactsRefreshLabel) contactsRefreshLabel.textContent = '更新中…';
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

  function scheduleDrBootstrap(peerUid, conversation) {
    if (!peerUid || !conversation) return;
    const entry = sessionStore.contactIndex?.get?.(peerUid) || null;
    const entryRole = typeof entry?.secretRole === 'string' ? entry.secretRole.toLowerCase() : null;
    const secretInfo = getContactSecret(peerUid);
    const secretRole = typeof secretInfo?.role === 'string' ? secretInfo.role.toLowerCase() : null;
    const selfRole = entryRole || secretRole;
    if (selfRole === 'guest') return;
    const bundle = conversation?.dr_init?.guest_bundle || conversation?.drInit?.guestBundle;
    if (!bundle) return;
    bootstrapDrFromGuestBundle({ peerUidHex: peerUid, guestBundle: bundle }).catch((err) => {
      log({ drBootstrapLoadError: err?.message || err });
    });
  }

  async function loadInitialContacts() {
    const prevPeers = new Set(
      Array.isArray(sessionStore.contactState)
        ? sessionStore.contactState
            .map((entry) => String(entry?.peerUid || '').toUpperCase())
            .filter(Boolean)
        : []
    );
    let fetched = [];
    try {
      const entries = await loadContactsApi();
      fetched = Array.isArray(entries) ? [...entries] : [];
    } catch (err) {
      log({ contactsInitError: err?.message || err });
      fetched = [];
    }
    contactIndex.clear();
    conversationIndex?.clear();
    const sanitized = [];
    for (const entry of fetched) {
      const key = String(entry?.peerUid || '').toUpperCase();
      if (!key) continue;
      if (isRecentlyRemoved(key)) {
        presenceManager.removePresenceForContact(key);
        continue;
      }
      sanitized.push(entry);
      contactIndex.set(key, entry);
      const conv = entry?.conversation;
      if (conv?.conversation_id && conv?.token_b64 && conversationIndex) {
        conversationIndex.set(conv.conversation_id, {
          token_b64: conv.token_b64,
          peerUid: key,
          dr_init: conv.dr_init || null,
          secretRole: entry?.secretRole || entry?.secret_role || null
        });
        scheduleDrBootstrap(key, conv);
      }
    }
    sessionStore.contactState = sanitized;
    const currentPeers = new Set(
      sanitized.map((entry) => String(entry?.peerUid || '').toUpperCase()).filter(Boolean)
    );
    for (const peer of prevPeers) {
      if (peer && !currentPeers.has(peer)) {
        try {
          document.dispatchEvent(new CustomEvent('contacts:removed', { detail: { peerUid: peer, notifyPeer: false } }));
        } catch (err) {
          log({ contactRemovedEventError: err?.message || err, peer });
        }
      }
    }
    renderContacts();
    presenceManager.sendPresenceSubscribe();
  }

  async function addContactEntry({ peerUid, nickname, avatar, conversation, contactSecret, inviteId, secretRole }) {
    const key = String(peerUid || '').toUpperCase();
    if (!key) return;
    const selfUid = (getUidHex() || '').toUpperCase();
    const selfDigest = (getAccountDigest() || '').toUpperCase();
    if ((selfUid && key === selfUid) || (selfDigest && key === selfDigest)) {
      log({ contactSkipSelfEntry: key });
      return;
    }
    if (isRecentlyRemoved(key)) {
      log({ contactSuppressedAfterAddition: key });
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const conversationPayload = conversation && conversation.conversation_id && conversation.token_b64 ? {
      token_b64: conversation.token_b64,
      conversation_id: conversation.conversation_id,
      ...(conversation.dr_init ? { dr_init: conversation.dr_init } : null)
    } : null;

    const contact = {
      peerUid: key,
      nickname: nickname || `好友 ${key.slice(-4)}`,
      avatar: avatar || null,
      addedAt: now,
      conversation: conversationPayload,
      contactSecret: typeof contactSecret === 'string' ? contactSecret : null,
      inviteId: typeof inviteId === 'string' ? inviteId : null,
      secretRole: typeof secretRole === 'string' ? secretRole : null
    };
    try {
      const saved = await saveContactApi(contact);
      const entry = saved ? {
        ...contact,
        conversation: saved.conversation || contact.conversation,
        contactSecret: saved.contactSecret_b64 || contact.contactSecret || null,
        inviteId: saved.inviteId || contact.inviteId || null,
        secretRole: saved.contactSecret_role || contact.secretRole || null,
        msgId: saved.msgId || saved.id || contact.msgId || null
      } : contact;
      contactIndex.set(key, entry);
      if (entry?.conversation?.conversation_id && entry?.conversation?.token_b64 && conversationIndex) {
        conversationIndex.set(entry.conversation.conversation_id, {
          token_b64: entry.conversation.token_b64,
          peerUid: key,
          dr_init: entry.conversation.dr_init || null,
          secretRole: entry.secretRole || entry.secret_role || null
        });
        scheduleDrBootstrap(key, entry.conversation);
      }
      const existingIndex = sessionStore.contactState.findIndex((c) => c.peerUid === key);
      if (existingIndex >= 0) {
        sessionStore.contactState[existingIndex] = entry;
      } else {
        sessionStore.contactState.unshift(entry);
      }
      renderContacts();
      presenceManager.sendPresenceSubscribe();
      updateStats?.();
    } catch (err) {
      log({ contactAddError: err?.message || err });
    }
  }

  setupPullToRefresh();

  document.addEventListener('contacts:show-delete', (event) => {
    const detail = event?.detail || {};
    const targetPeer = detail.peerUid || detail.peer_uid || detail.peer || detail.uid;
    showDeleteForContact(targetPeer);
  });

  document.addEventListener('contacts:removed', (event) => {
    const detail = event?.detail || {};
    if (!detail || detail.notifyPeer) return;
    const peer = detail.peerUid || detail.peer_uid || detail.peer || detail.uid;
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
