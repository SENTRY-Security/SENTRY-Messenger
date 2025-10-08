import { sessionStore } from './session-store.js';

export function createPresenceManager(options) {
  const {
    contactsListEl,
    wsSend
  } = options;

  if (typeof wsSend !== 'function') throw new Error('presence manager requires wsSend');

  const onlineContacts = sessionStore.onlineContacts;
  const contactIndex = sessionStore.contactIndex;

  function sendPresenceSubscribe() {
    const peers = Array.from(new Set(sessionStore.contactState
      .map((c) => String(c?.peerUid || '').toUpperCase())
      .filter(Boolean)));
    wsSend({ type: 'presence-subscribe', uids: peers });
  }

  function applyPresenceSnapshot(list) {
    const normalized = new Set();
    for (const uid of list) {
      const key = String(uid || '').trim().toUpperCase();
      if (key) normalized.add(key);
    }
    const previous = new Set(onlineContacts);
    for (const key of normalized) {
      if (!onlineContacts.has(key)) {
        updateContactPresenceDom(key, true);
      }
      onlineContacts.add(key);
    }
    for (const key of previous) {
      if (!normalized.has(key)) {
        onlineContacts.delete(key);
        updateContactPresenceDom(key, false);
      }
    }
  }

  function setContactPresence(uid, online) {
    const key = String(uid || '').toUpperCase();
    if (!key) return;
    if (online) {
      if (!onlineContacts.has(key)) {
        onlineContacts.add(key);
        updateContactPresenceDom(key, true);
      }
    } else if (onlineContacts.has(key)) {
      onlineContacts.delete(key);
      updateContactPresenceDom(key, false);
    }
  }

  function clearPresenceState() {
    if (!onlineContacts.size) return;
    for (const key of Array.from(onlineContacts)) {
      updateContactPresenceDom(key, false);
    }
    onlineContacts.clear();
  }

  function updateContactPresenceDom(uid, online) {
    if (!contactsListEl) return;
    const item = contactsListEl.querySelector(`.contact-item[data-peer-uid="${uid}"]`);
    if (!item) return;
    const dot = item.querySelector('.presence-dot');
    if (dot) dot.classList.toggle('online', !!online);
  }

  function removePresenceForContact(uid) {
    const key = String(uid || '').toUpperCase();
    if (!key) return;
    if (onlineContacts.has(key)) {
      onlineContacts.delete(key);
      updateContactPresenceDom(key, false);
    }
  }

  return {
    sendPresenceSubscribe,
    applyPresenceSnapshot,
    setContactPresence,
    clearPresenceState,
    removePresenceForContact
  };
}
