import { normalizeAccountDigest, normalizePeerDeviceId, getMkRaw, normalizePeerIdentity } from '../../core/store.js';
import { sessionStore } from './session-store.js';
import { DEBUG } from './debug-flags.js';

const coreMap = new Map();

const toPeerKey = ({ peerAccountDigest, peerDeviceId, peerKey = null }) => {
  const digest = normalizeAccountDigest(peerAccountDigest || (peerKey && peerKey.split('::')[0]) || null);
  const dev = normalizePeerDeviceId(peerDeviceId || (peerKey && peerKey.split('::')[1]) || null);
  if (!digest || !dev) return null;
  return `${digest}::${dev}`;
};

const contactCoreLogEnabled = DEBUG.contactCoreVerbose === true;

const logJson = (tag, payload) => {
  if (!contactCoreLogEnabled) return;
  try {
    console.log(`[contact-core] ${tag} ${JSON.stringify(payload)}`);
  } catch {
    // ignore logging failures
  }
};

const HANDSHAKE_SOURCE_ALLOWLIST = new Set([
  'contacts-view:add-contact',
  'contacts-view:fetched',
  'contacts-view:local-cache',
  'contacts-view:secrets',
  'share-controller:contact-init-received',
  'share-controller:contact-share'
]);

const isHandshakeSource = (sourceTag) => {
  if (!sourceTag) return false;
  if (HANDSHAKE_SOURCE_ALLOWLIST.has(sourceTag)) return true;
  return false;
};

const ensureContactIndex = () => {
  if (!(sessionStore.contactIndex instanceof Map)) {
    const entries = sessionStore.contactIndex && typeof sessionStore.contactIndex.entries === 'function'
      ? Array.from(sessionStore.contactIndex.entries())
      : [];
    sessionStore.contactIndex = new Map(entries);
  }
  return sessionStore.contactIndex;
};

const ensureConversationIndex = () => {
  if (!(sessionStore.conversationIndex instanceof Map)) {
    const entries = sessionStore.conversationIndex && typeof sessionStore.conversationIndex.entries === 'function'
      ? Array.from(sessionStore.conversationIndex.entries())
      : [];
    sessionStore.conversationIndex = new Map(entries);
  }
  return sessionStore.conversationIndex;
};

const ensureConversationThreads = () => {
  if (!(sessionStore.conversationThreads instanceof Map)) {
    const entries = sessionStore.conversationThreads && typeof sessionStore.conversationThreads.entries === 'function'
      ? Array.from(sessionStore.conversationThreads.entries())
      : [];
    sessionStore.conversationThreads = new Map(entries);
  }
  return sessionStore.conversationThreads;
};

const cloneEntry = (entry) => {
  if (!entry) return null;
  try {
    return structuredClone(entry);
  } catch {
    return JSON.parse(JSON.stringify(entry));
  }
};

function normalizeCoreInput(fields = {}) {
  const sourceTag = fields.sourceTag || 'unknown';
  const digest = normalizeAccountDigest(
    fields.peerAccountDigest
    || fields.accountDigest
    || (typeof fields.peerKey === 'string' && fields.peerKey.includes('::') ? fields.peerKey.split('::')[0] : null)
  );
  const peerDeviceId = normalizePeerDeviceId(
    fields.peerDeviceId
    || (typeof fields.peerKey === 'string' && fields.peerKey.includes('::') ? fields.peerKey.split('::')[1] : null)
  );
  const conversation = fields.conversation || {};
  const conversationId = fields.conversationId
    || conversation.conversation_id
    || conversation.id
    || null;
  const conversationToken = fields.conversationToken
    || conversation.token_b64
    || conversation.token
    || null;
  const nickname = fields.nickname ?? conversation.nickname ?? null;
  const avatar = fields.avatar ?? conversation.avatar ?? null;
  const peerKey = toPeerKey({ peerAccountDigest: digest, peerDeviceId, peerKey: fields.peerKey || null });
  const drInit = conversation.dr_init || conversation.drInit || fields.drInit || null;
  const addedAt = Number.isFinite(fields.addedAt) ? Number(fields.addedAt) : null;
  const profileUpdatedAt = Number.isFinite(fields.profileUpdatedAt) ? Number(fields.profileUpdatedAt) : null;
  const msgId = fields.msgId || null;

  return {
    peerKey,
    peerAccountDigest: digest,
    peerDeviceId,
    conversationId: conversationId || null,
    conversationToken: conversationToken || null,
    nickname,
    avatar,
    drInit,
    addedAt,
    profileUpdatedAt,
    msgId,
    contactSecret: fields.contactSecret || null,
    sourceTag
  };
}

function applyDerivedOutputs(entry) {
  if (!entry?.isReady || !entry.conversationId || !entry.conversationToken) return;
  const contactIndex = ensureContactIndex();
  const conversationIndex = ensureConversationIndex();
  const threads = ensureConversationThreads();
  const peerKey = entry.peerKey;
  const prevContact = contactIndex.get(peerKey) || {};
  const nickname = entry.nickname ?? prevContact.nickname ?? null;
  const avatar = entry.avatar ?? prevContact.avatar ?? null;
  const conversation = {
    conversation_id: entry.conversationId,
    token_b64: entry.conversationToken,
    peerDeviceId: entry.peerDeviceId,
    ...(entry.drInit ? { dr_init: entry.drInit } : null)
  };

  contactIndex.set(peerKey, {
    ...prevContact,
    peerKey, // Ensure peerKey is stored
    peerAccountDigest: entry.peerAccountDigest, // Use the actual digest
    accountDigest: entry.peerAccountDigest,
    peerDeviceId: entry.peerDeviceId,
    nickname,
    avatar,
    addedAt: entry.addedAt ?? prevContact.addedAt ?? null,
    profileUpdatedAt: entry.profileUpdatedAt ?? prevContact.profileUpdatedAt ?? null,
    msgId: entry.msgId ?? prevContact.msgId ?? null,
    conversation
  });

  const prevConvIndex = conversationIndex.get(entry.conversationId) || {};
  conversationIndex.set(entry.conversationId, {
    ...prevConvIndex,
    token_b64: entry.conversationToken,
    peerAccountDigest: entry.peerAccountDigest,
    peerDeviceId: entry.peerDeviceId,
    dr_init: prevConvIndex.dr_init || entry.drInit || null
  });

  const prevThread = threads.get(entry.conversationId) || {};
  threads.set(entry.conversationId, {
    ...prevThread,
    peerKey,
    peerAccountDigest: entry.peerAccountDigest,
    peerDeviceId: entry.peerDeviceId,
    conversationId: entry.conversationId,
    conversationToken: entry.conversationToken,
    nickname: nickname ?? prevThread.nickname ?? null,
    avatar: avatar ?? prevThread.avatar ?? null
  });

  // Keep contactState aligned with ready entries while preserving unreadCount if present.
  const state = Array.isArray(sessionStore.contactState) ? sessionStore.contactState : [];
  // Lookup by peerKey (Primary Key)
  const existingIdx = state.findIndex((c) => (c?.peerKey || c?.peerAccountDigest || c?.accountDigest || c) === peerKey);
  const stateEntry = {
    ...(existingIdx >= 0 ? state[existingIdx] : {}),
    peerKey, // Explicitly store the Unique ID
    peerAccountDigest: entry.peerAccountDigest, // Strictly the Digest
    accountDigest: entry.peerAccountDigest, // Redundant alias
    peerDeviceId: entry.peerDeviceId,
    nickname,
    avatar,
    addedAt: entry.addedAt ?? (existingIdx >= 0 ? state[existingIdx]?.addedAt : null) ?? null,
    profileUpdatedAt: entry.profileUpdatedAt ?? (existingIdx >= 0 ? state[existingIdx]?.profileUpdatedAt : null) ?? null,
    msgId: entry.msgId ?? (existingIdx >= 0 ? state[existingIdx]?.msgId : null) ?? null,
    conversation,
    isReady: true
  };
  if (existingIdx >= 0) {
    state[existingIdx] = stateEntry;
  } else {
    state.unshift(stateEntry);
  }
  sessionStore.contactState = state;
}

const summarizeDigest = (value) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  const len = raw.length;
  const isHex64 = /^[0-9a-fA-F]{64}$/.test(raw);
  return {
    len,
    isHex64,
    prefix8: raw.slice(0, 8) || null,
    suffix8: raw.slice(-8) || null
  };
};

const summarizeToken = (value) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  return {
    len: raw.length,
    prefix6: raw.slice(0, 6) || null,
    suffix6: raw.slice(-6) || null
  };
};

const summarizeCoreInputs = (fields = {}) => {
  const digestRaw = fields.peerAccountDigest
    || fields.accountDigest
    || (typeof fields.peerKey === 'string' && fields.peerKey.includes('::') ? fields.peerKey.split('::')[0] : null)
    || null;
  const deviceRaw = fields.peerDeviceId
    || (typeof fields.peerKey === 'string' && fields.peerKey.includes('::') ? fields.peerKey.split('::')[1] : null)
    || null;
  const conversationIdRaw = fields.conversationId
    || fields.conversation?.conversation_id
    || fields.conversation?.id
    || null;
  const conversationTokenRaw = fields.conversationToken
    || fields.conversation?.token_b64
    || fields.conversation?.token
    || null;
  const digestSummary = summarizeDigest(digestRaw || null);
  const tokenSummary = summarizeToken(conversationTokenRaw || null);
  const deviceLen = typeof deviceRaw === 'string' ? deviceRaw.trim().length : 0;
  const convIdLen = typeof conversationIdRaw === 'string' ? conversationIdRaw.trim().length : 0;
  return {
    peerAccountDigest: { len: digestSummary.len, isHex64: digestSummary.isHex64 },
    peerDeviceId: { len: deviceLen, exists: deviceLen > 0 },
    conversationId: { len: convIdLen, exists: convIdLen > 0 },
    conversationToken: { len: tokenSummary.len, exists: tokenSummary.len > 0 }
  };
};

export function clearContactCore() {
  coreMap.clear();
  try { logJson('clear', {}); } catch { }
  ensureContactIndex().clear();
  ensureConversationIndex().clear();
  ensureConversationThreads().clear();
  sessionStore.contactState = [];
}

export function upsertContactCore(fields, sourceTag = 'unknown') {
  const inputSummary = summarizeCoreInputs(fields);
  const payload = normalizeCoreInput({ ...fields, sourceTag });
  const { peerKey, peerAccountDigest, peerDeviceId } = payload;
  const conversationIdIncoming = payload.conversationId || null;
  const conversationTokenIncoming = payload.conversationToken || null;
  const missingFields = [];
  if (!peerKey) missingFields.push('peerKey');
  if (!peerAccountDigest) missingFields.push('peerAccountDigest');
  if (!peerDeviceId) missingFields.push('peerDeviceId');
  if (!conversationIdIncoming) missingFields.push('conversationId');
  if (!conversationTokenIncoming) missingFields.push('conversationToken');
  const hasConversation = !!(conversationIdIncoming && conversationTokenIncoming);
  const allowPending = isHandshakeSource(sourceTag);
  if (!peerKey || !peerAccountDigest || !peerDeviceId || (!hasConversation && !allowPending)) {
    const digestSummary = summarizeDigest(peerAccountDigest || null);
    logJson('reject', {
      peerKey: peerKey || null,
      sourceTag,
      reason: 'missing-core',
      missingFields,
      digestLen: digestSummary.len,
      isHex64: digestSummary.isHex64,
      inputSummary
    });
    return null;
  }
  const existing = coreMap.get(peerKey) || null;
  const mismatch = (
    (existing?.peerAccountDigest && existing.peerAccountDigest !== peerAccountDigest)
  ) || (
      (existing?.peerDeviceId && existing.peerDeviceId !== peerDeviceId)
    ) || (
      existing?.conversationId && conversationIdIncoming && existing.conversationId !== conversationIdIncoming
    ) || (
      existing?.conversationToken && conversationTokenIncoming && existing.conversationToken !== conversationTokenIncoming
    );
  if (mismatch) {
    logJson('reject', {
      peerKey,
      reason: 'core-mismatch',
      sourceTag,
      inputSummary,
      existing: {
        peerDeviceId: existing.peerDeviceId || null,
        conversationId: existing.conversationId || null,
        conversationToken: summarizeToken(existing.conversationToken || null)
      },
      incoming: {
        peerDeviceId: peerDeviceId || null,
        conversationId: conversationIdIncoming || null,
        conversationToken: summarizeToken(conversationTokenIncoming || null)
      }
    });
    throw new Error(`contact-core mismatch peerKey=${peerKey} source=${sourceTag}`);
  }
  const nextConversationId = conversationIdIncoming || existing?.conversationId || null;
  const nextConversationToken = conversationTokenIncoming || existing?.conversationToken || null;
  const nextIsReady = !!(existing?.isReady || (nextConversationId && nextConversationToken));
  const nextEntry = {
    ...existing,
    peerKey,
    peerAccountDigest,
    peerDeviceId,
    conversationId: nextConversationId,
    conversationToken: nextConversationToken,
    nickname: payload.nickname ?? existing?.nickname ?? null,
    avatar: payload.avatar ?? existing?.avatar ?? null,
    addedAt: payload.addedAt ?? existing?.addedAt ?? null,
    profileUpdatedAt: payload.profileUpdatedAt ?? existing?.profileUpdatedAt ?? null,
    msgId: payload.msgId ?? existing?.msgId ?? null,
    contactSecret: payload.contactSecret ?? existing?.contactSecret ?? null,
    drInit: payload.drInit ?? existing?.drInit ?? null,
    sourceTag: payload.sourceTag || existing?.sourceTag || sourceTag || 'unknown',
    conversation: (nextIsReady && nextConversationId && nextConversationToken) ? {
      conversation_id: nextConversationId,
      token_b64: nextConversationToken,
      peerDeviceId,
      ...(payload.drInit ? { dr_init: payload.drInit } : (existing?.drInit ? { dr_init: existing.drInit } : null))
    } : (existing?.isReady ? existing?.conversation || null : null),
    isReady: nextIsReady
  };
  if (existing?.isReady && !nextEntry.isReady) {
    nextEntry.isReady = true; // prevent ready -> pending downgrade
  }
  coreMap.set(peerKey, nextEntry);
  const changedFields = {};
  if (!existing || existing.isReady !== nextEntry.isReady) changedFields.isReady = nextEntry.isReady;
  if (nextEntry.conversationId && nextEntry.conversationId !== existing?.conversationId) {
    changedFields.conversationId = nextEntry.conversationId;
  }
  if (nextEntry.conversationToken && nextEntry.conversationToken !== existing?.conversationToken) {
    changedFields.conversationToken = summarizeToken(nextEntry.conversationToken);
  }
  ['nickname', 'avatar', 'contactSecret', 'drInit', 'addedAt', 'profileUpdatedAt', 'msgId'].forEach((key) => {
    if (nextEntry[key] !== existing?.[key]) changedFields[key] = nextEntry[key];
  });
  if (!existing?.isReady && nextEntry.isReady) {
    logJson('upgrade', { peerKey, from: 'pending', to: 'ready' });
  }
  if (Object.keys(changedFields).length > 0) {
    logJson('upsert', { peerKey, sourceTag, isReady: nextEntry.isReady, changedFields });
  }
  if (nextEntry.isReady) applyDerivedOutputs(nextEntry);
  return cloneEntry(nextEntry);
}

export function patchContactCore(peerKey, patch = {}, sourceTag = 'unknown') {
  const key = toPeerKey({ peerKey, peerAccountDigest: patch.peerAccountDigest, peerDeviceId: patch.peerDeviceId }) || peerKey;
  const existing = key ? coreMap.get(key) : null;
  const inputSummary = summarizeCoreInputs({ ...patch, peerKey: key || peerKey || null });
  if (!existing) {
    logJson('reject', { peerKey: key || peerKey || null, reason: 'not-found', sourceTag, inputSummary });
    return null;
  }
  // Guard against attempts to mutate core fields.
  ['peerAccountDigest', 'peerDeviceId', 'conversationId', 'conversationToken'].forEach((coreField) => {
    if (patch[coreField] && patch[coreField] !== existing[coreField]) {
      logJson('reject', { peerKey: key, reason: `core-field-immutable:${coreField}`, sourceTag, inputSummary });
      throw new Error('contact-core immutable field change');
    }
  });
  const nextEntry = {
    ...existing,
    nickname: patch.nickname ?? existing.nickname,
    avatar: patch.avatar ?? existing.avatar,
    contactSecret: patch.contactSecret ?? existing.contactSecret,
    drInit: patch.drInit ?? existing.drInit
  };
  coreMap.set(key, nextEntry);
  const changedFields = {};
  ['nickname', 'avatar', 'contactSecret', 'drInit'].forEach((field) => {
    if (nextEntry[field] !== existing[field]) changedFields[field] = nextEntry[field];
  });
  if (Object.keys(changedFields).length > 0) {
    logJson('upsert', { peerKey: key, sourceTag, isReady: nextEntry.isReady, changedFields });
  }
  if (nextEntry.isReady) applyDerivedOutputs(nextEntry);
  return cloneEntry(nextEntry);
}

export function removeContactCore(peerKey, reason = 'remove') {
  const key = toPeerKey({ peerKey }) || peerKey || null;
  if (!key) return;
  const existing = coreMap.get(key) || null;
  coreMap.delete(key);
  ensureContactIndex().delete(key);
  if (existing?.conversationId) {
    ensureConversationIndex().delete(existing.conversationId);
    ensureConversationThreads().delete(existing.conversationId);
  }
  sessionStore.contactState = (sessionStore.contactState || []).filter((c) => (c?.peerAccountDigest || c?.accountDigest || c) !== key);
  logJson('remove', { peerKey: key, reason });
}

export function getContactCore(peerKey) {
  const key = toPeerKey({ peerKey }) || peerKey || null;
  if (!key) return null;
  return cloneEntry(coreMap.get(key) || null);
}

export function findContactCoreByAccountDigest(peerAccountDigest) {
  const digest = normalizeAccountDigest(peerAccountDigest);
  if (!digest) return [];
  const matches = [];
  for (const [peerKey, entry] of coreMap.entries()) {
    const entryDigest = entry?.peerAccountDigest
      || (typeof peerKey === 'string' && peerKey.includes('::') ? peerKey.split('::')[0] : null);
    if (entryDigest === digest) {
      matches.push({ peerKey, entry: cloneEntry(entry) });
    }
  }
  return matches;
}

export function migrateContactCorePeerDevice({ peerAccountDigest, fromPeerDeviceId, toPeerDeviceId, sourceTag = 'unknown' } = {}) {
  const fromKey = toPeerKey({ peerAccountDigest, peerDeviceId: fromPeerDeviceId });
  const toKey = toPeerKey({ peerAccountDigest, peerDeviceId: toPeerDeviceId });
  if (!fromKey || !toKey || fromKey === toKey) return null;
  const existing = coreMap.get(fromKey) || null;
  if (!existing) {
    logJson('reject', { peerKey: fromKey, reason: 'migrate-missing', sourceTag });
    return null;
  }
  if (coreMap.has(toKey)) {
    logJson('reject', { peerKey: toKey, reason: 'migrate-target-exists', sourceTag });
    return null;
  }
  const nextEntry = {
    ...existing,
    peerKey: toKey,
    peerDeviceId: toPeerDeviceId
  };
  coreMap.set(toKey, nextEntry);
  coreMap.delete(fromKey);
  const contactIndex = ensureContactIndex();
  if (contactIndex.has(fromKey)) {
    const prevContact = contactIndex.get(fromKey) || {};
    contactIndex.delete(fromKey);
    contactIndex.set(toKey, {
      ...prevContact,
      peerAccountDigest: toKey,
      accountDigest: existing.peerAccountDigest || prevContact.accountDigest || null,
      peerDeviceId: toPeerDeviceId
    });
  }
  if (existing?.conversationId) {
    const convId = existing.conversationId;
    const conversationIndex = ensureConversationIndex();
    const prevConv = conversationIndex.get(convId);
    if (prevConv) {
      conversationIndex.set(convId, {
        ...prevConv,
        peerAccountDigest: toKey,
        peerDeviceId: toPeerDeviceId
      });
    }
    const threads = ensureConversationThreads();
    const prevThread = threads.get(convId);
    if (prevThread) {
      threads.set(convId, {
        ...prevThread,
        peerAccountDigest: toKey,
        peerDeviceId: toPeerDeviceId
      });
    }
  }
  const state = Array.isArray(sessionStore.contactState) ? sessionStore.contactState : [];
  const idx = state.findIndex((c) => (c?.peerAccountDigest || c?.accountDigest || c) === fromKey);
  if (idx >= 0) {
    state[idx] = {
      ...state[idx],
      peerAccountDigest: toKey,
      accountDigest: existing.peerAccountDigest || state[idx]?.accountDigest || null,
      peerDeviceId: toPeerDeviceId
    };
    sessionStore.contactState = state;
  }
  logJson('migrate', { fromPeerKey: fromKey, toPeerKey: toKey, sourceTag });
  return cloneEntry(nextEntry);
}

export function listReadyContacts() {
  return Array.from(coreMap.values())
    .filter((entry) => entry?.isReady)
    .map((entry) => cloneEntry(entry));
}

export function contactCoreReadyCount() {
  let count = 0;
  for (const entry of coreMap.values()) {
    if (entry?.isReady) count += 1;
  }
  return count;
}

export function contactCoreCounts() {
  let ready = 0;
  let pending = 0;
  for (const entry of coreMap.values()) {
    if (entry?.isReady) {
      ready += 1;
    } else {
      pending += 1;
    }
  }
  return { ready, pending };
}

export function listContactCoreEntries({ limit = 50 } = {}) {
  const out = [];
  let count = 0;
  for (const entry of coreMap.values()) {
    out.push(cloneEntry(entry));
    count += 1;
    if (count >= limit) break;
  }
  return out;
}

export function normalizeDigestString(value) {
  const identity = normalizePeerIdentity(value);
  return identity.key || null;
}

export function normalizePeerKey(value) {
  return normalizeDigestString(value?.peerAccountDigest ?? value);
}

export function splitPeerKey(value) {
  const key = typeof value === 'string' ? value : normalizePeerKey(value);
  if (!key || typeof key !== 'string' || !key.includes('::')) {
    return { digest: normalizeAccountDigest(key || null), deviceId: null };
  }
  const [digestPart, devicePart] = key.split('::');
  return {
    digest: normalizeAccountDigest(digestPart),
    deviceId: normalizePeerDeviceId(devicePart)
  };
}

export function resolveContactCoreEntry(peerKeyValue, peerDeviceId) {
  const normalizedKey = normalizePeerKey(peerKeyValue);
  if (normalizedKey) {
    return { peerKey: normalizedKey, entry: getContactCore(normalizedKey) };
  }
  const { digest } = splitPeerKey(peerKeyValue);
  const normalizedDeviceId = normalizePeerDeviceId(peerDeviceId || null);
  if (digest && normalizedDeviceId) {
    const derivedKey = normalizePeerKey({ peerAccountDigest: digest, peerDeviceId: normalizedDeviceId });
    if (derivedKey) {
      return { peerKey: derivedKey, entry: getContactCore(derivedKey) };
    }
  }
  if (!digest) return { peerKey: null, entry: null };
  const matches = findContactCoreByAccountDigest(digest);
  if (matches.length === 1) {
    return { peerKey: matches[0].peerKey || null, entry: matches[0].entry || null };
  }
  return { peerKey: null, entry: null };
}

export function resolveReadyContactCoreEntry(peerKeyValue, peerDeviceId, conversationId) {
  const resolved = resolveContactCoreEntry(peerKeyValue, peerDeviceId);
  const baseEntry = resolved.entry;
  const baseReady = !!(baseEntry?.isReady && baseEntry.conversationId && baseEntry.conversationToken);
  if (baseReady) {
    return { peerKey: resolved.peerKey, entry: baseEntry };
  }
  const convKey = conversationId ? String(conversationId) : null;
  if (convKey) {
    const readyList = Array.isArray(listReadyContacts()) ? listReadyContacts() : [];
    for (const entry of readyList) {
      const entryConvId = entry?.conversationId || entry?.conversation?.conversation_id || null;
      const entryToken = entry?.conversationToken || entry?.conversation?.token_b64 || null;
      if (!entry?.isReady || !entryConvId || !entryToken) continue;
      if (String(entryConvId) === convKey) {
        return { peerKey: entry.peerKey || resolved.peerKey, entry };
      }
    }
  }
  return { peerKey: resolved.peerKey, entry: baseEntry };
}

export function isCoreVaultReady(peerKeyValue, peerDeviceId, conversationId) {
  if (!getMkRaw()) return false;
  const info = resolveReadyContactCoreEntry(peerKeyValue, peerDeviceId, conversationId);
  const entry = info.entry;
  return !!(entry?.isReady && entry.conversationId && entry.conversationToken);
}

export function resolveContactAvatarUrl(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const candidates = [
    entry.avatarUrl,
    entry.avatar?.thumbDataUrl,
    entry.avatar?.previewDataUrl,
    entry.avatar?.url,
    entry.avatar?.httpsUrl,
    entry.profile?.avatarUrl,
    entry.profile?.avatar?.thumbUrl
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return null;
}
