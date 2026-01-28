import { sessionStore } from './session-store.js';
import { normalizePeerIdentity } from '../../core/store.js';

export function createPresenceManager(options) {
  const {
    contactsListEl,
    wsSend
  } = options;

  if (typeof wsSend !== 'function') throw new Error('presence manager requires wsSend');

  const onlineContacts = sessionStore.onlineContacts;

  function sendPresenceSubscribe() {
    const digests = new Set();
    for (const c of sessionStore.contactState || []) {
      const identity = normalizePeerIdentity(c?.peerAccountDigest || c?.accountDigest || null);
      if (identity.accountDigest) digests.add(identity.accountDigest);
    }
    wsSend({
      type: 'presence-subscribe',
      accountDigests: Array.from(digests)
    });
  }

  function applyPresenceSnapshot(list) {
    const entries = Array.isArray(list) ? list : [];
    const normalized = new Set();
    for (const entry of entries) {
      const identity = normalizePeerIdentity(entry);
      if (identity.key) normalized.add(identity.key);
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

  function setContactPresence(peerAccountDigest, online) {
    const identity = normalizePeerIdentity(peerAccountDigest);
    const key = identity.key;
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

  function updateContactPresenceDom(peerAccountDigest, online) {
    if (!contactsListEl) return;
    const item = contactsListEl.querySelector(`.contact-item[data-peer-account-digest="${peerAccountDigest}"]`);
    if (!item) return;
    const dot = item.querySelector('.presence-dot');
    if (dot) dot.classList.toggle('online', !!online);
  }

  function removePresenceForContact(peerAccountDigest) {
    const identity = normalizePeerIdentity(peerAccountDigest);
    const key = identity.key;
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
