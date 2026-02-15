import {
  DEFAULT_CALL_MEDIA_CAPABILITY,
  CALL_MEDIA_STATE_STATUS,
  applyCallKeyEnvelopeToState,
  cloneCallMediaState,
  createCallMediaState,
  normalizeCallMediaCapability,
  setCallMediaStatus as setMediaStatus,
  touchCallMediaState
} from '../../../shared/calls/schemas.js';
import { createCallInvite } from '../../api/calls.js';
import { CALL_EVENT, emitCallEvent } from './events.js';
import { sessionStore } from '../../ui/mobile/session-store.js';
import { log } from '../../core/log.js';
import {
  getAccountDigest,
  getDeviceId,
  normalizeAccountDigest,
  normalizePeerDeviceId,
  normalizePeerIdentity
} from '../../core/store.js';
import { buildCallPeerIdentity, logCallIdentitySet } from './identity.js';

export const CALL_SESSION_STATUS = Object.freeze({
  IDLE: 'idle',
  OUTGOING: 'dialing',
  INCOMING: 'incoming',
  CONNECTING: 'connecting',
  IN_CALL: 'in_call',
  ENDED: 'ended',
  FAILED: 'failed'
});

export const CALL_SESSION_DIRECTION = Object.freeze({
  OUTGOING: 'outgoing',
  INCOMING: 'incoming'
});

export const CALL_REQUEST_KIND = Object.freeze({
  VOICE: 'voice',
  VIDEO: 'video'
});

const SERVER_STATUS_MAP = Object.freeze({
  dialing: CALL_SESSION_STATUS.OUTGOING,
  ringing: CALL_SESSION_STATUS.OUTGOING,
  connecting: CALL_SESSION_STATUS.CONNECTING,
  connected: CALL_SESSION_STATUS.CONNECTING,
  in_call: CALL_SESSION_STATUS.IN_CALL,
  ended: CALL_SESSION_STATUS.ENDED,
  failed: CALL_SESSION_STATUS.FAILED,
  cancelled: CALL_SESSION_STATUS.ENDED,
  timeout: CALL_SESSION_STATUS.FAILED
});

let activeSession = createEmptySession();

function resolveSelfProfileSummary() {
  const profile = sessionStore?.profileState || null;
  const nicknameRaw = typeof profile?.nickname === 'string' ? profile.nickname.trim() : '';
  const displayName = nicknameRaw || null;
  const candidateUrls = [
    profile?.avatar?.shareUrl,
    profile?.avatar?.publicUrl,
    profile?.avatar?.url,
    profile?.avatar?.httpsUrl,
    profile?.avatar?.cdnUrl
  ];
  let avatarUrl = null;
  for (const url of candidateUrls) {
    if (typeof url === 'string' && /^https?:/i.test(url)) {
      avatarUrl = url;
      break;
    }
  }
  return { displayName, avatarUrl };
}

function ensureContactIndexMap() {
  if (!(sessionStore.contactIndex instanceof Map)) {
    const entries = sessionStore.contactIndex && typeof sessionStore.contactIndex.entries === 'function'
      ? Array.from(sessionStore.contactIndex.entries())
      : [];
    sessionStore.contactIndex = new Map(entries);
  }
  return sessionStore.contactIndex;
}

function ensureConversationThreadsMap() {
  if (!(sessionStore.conversationThreads instanceof Map)) {
    const entries = sessionStore.conversationThreads && typeof sessionStore.conversationThreads.entries === 'function'
      ? Array.from(sessionStore.conversationThreads.entries())
      : [];
    sessionStore.conversationThreads = new Map(entries);
  }
  return sessionStore.conversationThreads;
}

function pickAvatarFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const candidates = [
    entry.avatar?.thumbDataUrl,
    entry.avatar?.previewDataUrl,
    entry.avatar?.url
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length) return c;
  }
  return null;
}

function pickNicknameFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const nickname = entry.nickname || entry.profile?.nickname || null;
  return typeof nickname === 'string' && nickname.trim().length ? nickname.trim() : null;
}

function findContactEntry(peerKey, peerDigest) {
  const index = ensureContactIndexMap();
  const digest = normalizeAccountDigest(peerDigest || null);
  const key = typeof peerKey === 'string' && peerKey.trim().length ? peerKey : null;
  if (key && index?.get?.(key)) return index.get(key);
  if (digest && index?.get?.(digest)) return index.get(digest);
  if (index && typeof index.entries === 'function' && digest) {
    for (const [storedKey, entry] of index.entries()) {
      const identity = normalizePeerIdentity(entry?.peerAccountDigest || entry?.accountDigest || storedKey);
      if (identity.accountDigest && identity.accountDigest === digest) {
        return entry;
      }
    }
  }
  return null;
}

function findThreadEntry(peerKey, peerDigest, peerDeviceId) {
  const threads = ensureConversationThreadsMap();
  const digest = normalizeAccountDigest(peerDigest || null);
  const deviceId = normalizePeerDeviceId(peerDeviceId || null);
  for (const entry of threads.values()) {
    const identity = normalizePeerIdentity(entry?.peerAccountDigest || entry?.peerKey || entry);
    const entryDigest = identity.accountDigest || null;
    const entryDeviceId = identity.deviceId || normalizePeerDeviceId(entry?.peerDeviceId || null) || null;
    if (peerKey && identity.key && peerKey === identity.key) return entry;
    if (digest && entryDigest && digest === entryDigest) {
      if (deviceId && entryDeviceId && deviceId !== entryDeviceId) continue;
      return entry;
    }
  }
  return null;
}

export function resolveCallPeerProfile({
  peerAccountDigest,
  peerDeviceId = null,
  peerKey = null,
  displayNameFallback = null
} = {}) {
  let digest = normalizeAccountDigest(peerAccountDigest || null);
  let deviceId = normalizePeerDeviceId(peerDeviceId || null);
  let identity = normalizePeerIdentity(peerKey || { peerAccountDigest: digest, peerDeviceId: deviceId });
  if (!identity.accountDigest && digest) identity.accountDigest = digest;
  if (!identity.deviceId && deviceId) identity.deviceId = deviceId;
  if (!identity.key && identity.accountDigest && identity.deviceId) {
    try {
      identity = buildCallPeerIdentity({ peerAccountDigest: identity.accountDigest, peerDeviceId: identity.deviceId });
    } catch {
      /* ignore */
    }
  }
  digest = identity.accountDigest || normalizeAccountDigest(identity.key?.split('::')?.[0] || null) || digest;
  deviceId = identity.deviceId || deviceId;
  const key = identity.peerKey || identity.key || (digest && deviceId ? `${digest}::${deviceId}` : null);
  const threadEntry = findThreadEntry(key, digest, deviceId);
  const contactEntry = findContactEntry(key, digest);
  const nickname = pickNicknameFromEntry(threadEntry) || pickNicknameFromEntry(contactEntry);
  const avatarUrl = pickAvatarFromEntry(threadEntry) || pickAvatarFromEntry(contactEntry) || null;
  const conversationId = threadEntry?.conversationId
    || contactEntry?.conversation?.conversation_id
    || null;
  const fallbackName = digest ? `好友 ${digest.slice(-4)}` : '好友';
  const placeholderName = displayNameFallback || fallbackName;
  const source = (nickname || avatarUrl) ? 'snapshot' : 'fallback';
  return {
    peerAccountDigest: digest || null,
    peerDeviceId: deviceId || null,
    peerKey: key || null,
    nickname: nickname || null,
    avatarUrl,
    conversationId,
    fallbackName,
    placeholderName,
    source
  };
}

export function resolvePeerForCallEvent(event = {}, selfDeviceId = null) {
  const selfDevice = normalizePeerDeviceId(selfDeviceId || getDeviceId() || null);
  const fromDeviceId = normalizePeerDeviceId(
    event.fromDeviceId
    || event.from_device_id
    || event.senderDeviceId
    || event.sender_device_id
    || null
  );
  const toDeviceId = normalizePeerDeviceId(
    event.toDeviceId
    || event.to_device_id
    || event.targetDeviceId
    || event.target_device_id
    || event.receiverDeviceId
    || event.receiver_device_id
    || null
  );
  const callId = event.callId || event.call_id || null;
  const logBase = {
    callId: callId || null,
    selfDeviceId: selfDevice || null,
    fromDeviceId: fromDeviceId || null,
    toDeviceId: toDeviceId || null
  };
  if (!selfDevice || (!fromDeviceId && !toDeviceId)) {
    log({ callPeerResolveError: 'missing-device', ...logBase });
    return null;
  }
  if (toDeviceId && selfDevice === toDeviceId) {
    const peerAccountDigest = normalizeAccountDigest(
      event.fromAccountDigest
      || event.from_account_digest
      || event.callerAccountDigest
      || event.caller_account_digest
      || null
    );
    if (!peerAccountDigest || !fromDeviceId) {
      log({ callPeerResolveError: 'missing-from-identity', ...logBase });
      return null;
    }
    try {
      return buildCallPeerIdentity({ peerAccountDigest, peerDeviceId: fromDeviceId });
    } catch (err) {
      log({ callPeerResolveError: err?.message || err, ...logBase });
      return null;
    }
  }
  if (fromDeviceId && selfDevice === fromDeviceId) {
    const peerAccountDigest = normalizeAccountDigest(
      event.toAccountDigest
      || event.to_account_digest
      || event.targetAccountDigest
      || event.target_account_digest
      || null
    );
    if (!peerAccountDigest || !toDeviceId) {
      log({ callPeerResolveError: 'missing-to-identity', ...logBase });
      return null;
    }
    try {
      return buildCallPeerIdentity({ peerAccountDigest, peerDeviceId: toDeviceId });
    } catch (err) {
      log({ callPeerResolveError: err?.message || err, ...logBase });
      return null;
    }
  }
  log({ callPeerResolveError: 'device-mismatch', ...logBase });
  return null;
}

export function getSelfProfileSummary() {
  return resolveSelfProfileSummary();
}

function createEmptySession() {
  return {
    traceId: null,
    sessionId: null,
    callId: null,
    initiatorAccountDigest: null,
    direction: null,
    status: CALL_SESSION_STATUS.IDLE,
    peerKey: null,
    peerAccountDigest: null,
    peerDisplayName: null,
    peerAvatarUrl: null,
    peerDeviceId: null,
    kind: CALL_REQUEST_KIND.VOICE,
    requestedAt: null,
    connectedAt: null,
    endedAt: null,
    lastError: null,
  localCapability: normalizeCallMediaCapability(DEFAULT_CALL_MEDIA_CAPABILITY),
  mediaState: createCallMediaState(),
  network: {
    config: null,
    lastLoadedAt: null
    },
    serverSession: null,
    remoteDisplayName: null,
    remoteAvatarUrl: null
  };
}

function setSessionPeerIdentity({ peerAccountDigest, peerDeviceId, callId = null } = {}) {
  const digest = normalizeAccountDigest(peerAccountDigest);
  if (!digest) {
    throw new Error('peerAccountDigest required for call identity');
  }
  const deviceId = normalizePeerDeviceId(peerDeviceId);
  if (!deviceId) {
    throw new Error('peerDeviceId required for call identity');
  }
  if (callId && activeSession.callId && callId !== activeSession.callId) {
    throw new Error('callId mismatch when setting peer identity');
  }
  if (activeSession.peerDeviceId && activeSession.peerDeviceId !== deviceId) {
    throw new Error('peer-device-id-mismatch');
  }
  if (!activeSession.peerAccountDigest) {
    activeSession.peerAccountDigest = digest;
  }
  const identity = buildCallPeerIdentity({ peerAccountDigest: digest, peerDeviceId: deviceId });
  if (activeSession.peerKey !== identity.peerKey) {
    activeSession.peerAccountDigest = digest;
    activeSession.peerDeviceId = deviceId;
    activeSession.peerKey = identity.peerKey;
    if (callId && !activeSession.callId) {
      activeSession.callId = callId;
    }
    logCallIdentitySet({
      callId: activeSession.callId || callId || null,
      peerAccountDigest: identity.digest,
      peerDeviceId: identity.deviceId,
      peerKey: identity.peerKey
    });
  }
  return identity;
}

function cloneCapability(capability) {
  if (!capability) return null;
  return {
    ...capability,
    features: Array.isArray(capability.features) ? [...capability.features] : []
  };
}

function cloneSession(session = activeSession) {
  if (!session) return null;
  return {
    ...session,
    peerKey: session.peerKey || null,
    localCapability: cloneCapability(session.localCapability),
    peerDeviceId: session.peerDeviceId || null,
    mediaState: cloneCallMediaState(session.mediaState),
    network: {
      config: session.network?.config ? { ...session.network.config } : null,
      lastLoadedAt: session.network?.lastLoadedAt || null
    }
  };
}

function emitState(reason, extra = {}) {
  emitCallEvent(CALL_EVENT.STATE, {
    reason,
    session: cloneSession(),
    ...extra
  });
}

function createTraceId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `trace-${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

function normalizeKind(kind) {
  return kind === CALL_REQUEST_KIND.VIDEO ? CALL_REQUEST_KIND.VIDEO : CALL_REQUEST_KIND.VOICE;
}

function resetMediaState() {
  activeSession.mediaState = createCallMediaState({
    capabilities: activeSession.localCapability
  });
}

function applyServerStatus(status) {
  if (!status) return;
  const normalized = String(status).toLowerCase();
  const next = SERVER_STATUS_MAP[normalized];
  if (!next || activeSession.status === next) return;
  activeSession.status = next;
  if (next === CALL_SESSION_STATUS.ENDED || next === CALL_SESSION_STATUS.FAILED) {
    activeSession.endedAt = Date.now();
  }
}

export function getCallSessionSnapshot() {
  return cloneSession();
}

export function canStartCall() {
  return [CALL_SESSION_STATUS.IDLE, CALL_SESSION_STATUS.ENDED, CALL_SESSION_STATUS.FAILED]
    .includes(activeSession.status);
}

export function resetCallSession(reason = 'reset') {
  activeSession = createEmptySession();
  emitState(reason);
}

export async function requestOutgoingCall({
  peerAccountDigest,
  peerDisplayName,
  peerAvatarUrl,
  peerDeviceId = null,
  kind = CALL_REQUEST_KIND.VOICE,
  traceId = null
} = {}) {
  const peerDigest = normalizeAccountDigest(peerAccountDigest || null);
  if (!peerDigest) return { ok: false, error: 'MISSING_PEER' };
  if (!canStartCall()) {
    return { ok: false, error: 'CALL_ALREADY_IN_PROGRESS' };
  }
  const normalizedPeerDeviceId = normalizePeerDeviceId(peerDeviceId);
  activeSession = createEmptySession();
  activeSession.traceId = traceId || createTraceId();
  activeSession.sessionId = activeSession.traceId;
  activeSession.initiatorAccountDigest = getAccountDigest ? getAccountDigest() : null;
  activeSession.direction = CALL_SESSION_DIRECTION.OUTGOING;
  activeSession.status = CALL_SESSION_STATUS.OUTGOING;
  activeSession.peerAccountDigest = peerDigest;
  activeSession.peerDisplayName = peerDisplayName || null;
  activeSession.peerAvatarUrl = peerAvatarUrl || null;
  activeSession.peerDeviceId = normalizedPeerDeviceId || null;
  activeSession.remoteDisplayName = peerDisplayName || null;
  activeSession.remoteAvatarUrl = peerAvatarUrl || null;
  activeSession.kind = normalizeKind(kind);
  activeSession.requestedAt = Date.now();
  if (normalizedPeerDeviceId) {
    try {
      setSessionPeerIdentity({ peerAccountDigest: peerDigest, peerDeviceId: normalizedPeerDeviceId });
    } catch (err) {
      activeSession.lastError = err?.message || 'peer identity invalid';
      return { ok: false, error: activeSession.lastError };
    }
  }
  resetMediaState();
  emitState('outgoing-request');
  emitCallEvent(CALL_EVENT.REQUEST, {
    direction: CALL_SESSION_DIRECTION.OUTGOING,
    kind: activeSession.kind,
    peerAccountDigest: activeSession.peerAccountDigest,
    traceId: activeSession.traceId
  });
  const metadata = {};
  if (peerDisplayName) metadata.peerDisplayName = peerDisplayName;
  if (peerAvatarUrl) metadata.peerAvatarUrl = peerAvatarUrl;
  const selfProfile = resolveSelfProfileSummary();
  if (selfProfile.displayName) {
    metadata.displayName = selfProfile.displayName;
    metadata.callerDisplayName = selfProfile.displayName;
  }
  if (selfProfile.avatarUrl) {
    metadata.avatarUrl = selfProfile.avatarUrl;
    metadata.callerAvatarUrl = selfProfile.avatarUrl;
  }
  let response = null;
  try {
    response = await createCallInvite({
      peerAccountDigest: peerDigest,
      mode: activeSession.kind === CALL_REQUEST_KIND.VIDEO ? 'video' : 'voice',
      capabilities: activeSession.localCapability,
      metadata,
      traceId: activeSession.traceId,
      preferredDeviceId: normalizedPeerDeviceId || null
    });
  } catch (err) {
    log({ callInviteApiFailed: err?.message || err, peerAccountDigest: peerDigest });
  }
  if (response?.callId) {
    activeSession.callId = response.callId;
  }
  // Fallback: generate a local callId if the server didn't provide one
  if (!activeSession.callId) {
    activeSession.callId = crypto.randomUUID();
  }
  if (response?.targetDeviceId) {
    setCallPeerDeviceId(response.targetDeviceId, { callId: activeSession.callId });
  } else if (normalizedPeerDeviceId) {
    // Use the locally-known peer device ID when the server is unavailable
    setCallPeerDeviceId(normalizedPeerDeviceId, { callId: activeSession.callId });
  } else {
    activeSession.status = CALL_SESSION_STATUS.FAILED;
    activeSession.lastError = 'invite-target-device-missing';
    activeSession.endedAt = Date.now();
    emitState('outgoing-request-failed', { error: 'invite-target-device-missing' });
    return { ok: false, error: 'invite-target-device-missing' };
  }
  if (response?.session) {
    activeSession.serverSession = { ...response.session };
    applyServerStatus(response.session.status);
  }
  emitState('outgoing-request-confirmed', {
    callId: activeSession.callId,
    serverSession: activeSession.serverSession || null
  });
  return { ok: true, callId: activeSession.callId, session: response?.session || null };
}

export function markIncomingCall({
  callId,
  peerAccountDigest = null,
  peerDisplayName,
  peerAvatarUrl,
  peerDeviceId = null,
  envelope,
  traceId,
  kind = CALL_REQUEST_KIND.VOICE
} = {}) {
  const digest = normalizeAccountDigest(peerAccountDigest);
  const deviceId = normalizePeerDeviceId(peerDeviceId);
  if (!digest) return { ok: false, error: 'MISSING_PEER' };
  if (!deviceId) return { ok: false, error: 'MISSING_PEER_DEVICE' };
  if (!canStartCall()) return { ok: false, error: 'CALL_ALREADY_IN_PROGRESS' };
  const profile = resolveCallPeerProfile({
    peerAccountDigest: digest,
    peerDeviceId: deviceId,
    displayNameFallback: peerDisplayName || null
  });
  const resolvedName = profile.nickname || profile.placeholderName || null;
  const resolvedAvatar = profile.avatarUrl || null;
  activeSession = createEmptySession();
  activeSession.initiatorAccountDigest = null;
  activeSession.direction = CALL_SESSION_DIRECTION.INCOMING;
  activeSession.status = CALL_SESSION_STATUS.INCOMING;
  activeSession.callId = callId || null;
  activeSession.peerAccountDigest = digest || null;
  activeSession.peerDisplayName = resolvedName;
  activeSession.peerAvatarUrl = resolvedAvatar;
  activeSession.peerDeviceId = deviceId;
  setSessionPeerIdentity({ peerAccountDigest: digest, peerDeviceId: deviceId, callId: activeSession.callId || callId || null });
  activeSession.remoteDisplayName = profile.placeholderName || resolvedName;
  activeSession.remoteAvatarUrl = resolvedAvatar;
  activeSession.kind = normalizeKind(kind);
  activeSession.traceId = traceId || createTraceId();
  activeSession.requestedAt = Date.now();
  resetMediaState();
  if (envelope) {
    try {
      applyCallKeyEnvelopeToState(activeSession.mediaState, envelope);
    } catch (err) {
      activeSession.lastError = err?.message || 'call envelope invalid';
      activeSession.status = CALL_SESSION_STATUS.FAILED;
    }
  }
  emitState('incoming-call');
  return { ok: true };
}

export function setCallPeerDeviceId(peerDeviceId, { callId = null } = {}) {
  const normalized = normalizePeerDeviceId(peerDeviceId);
  if (!normalized) throw new Error('peerDeviceId required');
  if (!activeSession.peerAccountDigest) {
    throw new Error('peerAccountDigest required before setting peerDeviceId');
  }
  const identity = setSessionPeerIdentity({
    peerAccountDigest: activeSession.peerAccountDigest,
    peerDeviceId: normalized,
    callId: callId || activeSession.callId || null
  });
  return identity.deviceId;
}

export function updateCallSessionStatus(nextStatus, { error = null, callId = null } = {}) {
  if (!Object.values(CALL_SESSION_STATUS).includes(nextStatus)) {
    throw new Error(`未知的 call session 狀態：${nextStatus}`);
  }
  activeSession.status = nextStatus;
  if (callId) activeSession.callId = callId;
  if (error) activeSession.lastError = error;
  const shouldPromoteAfterEmit = (
    nextStatus === CALL_SESSION_STATUS.CONNECTING
    && activeSession.mediaState?.status === CALL_MEDIA_STATE_STATUS.READY
    && activeSession.callId
  );
  if (nextStatus === CALL_SESSION_STATUS.CONNECTING) {
    if (!activeSession.connectedAt) activeSession.connectedAt = Date.now();
  }
  if ([CALL_SESSION_STATUS.ENDED, CALL_SESSION_STATUS.FAILED].includes(nextStatus)) {
    activeSession.endedAt = Date.now();
  }
  emitState('status-change');
  if (shouldPromoteAfterEmit) {
    updateCallSessionStatus(CALL_SESSION_STATUS.IN_CALL, { callId: activeSession.callId });
  }
  return cloneSession();
}

export function completeCallSession({ reason = 'hangup', error = null } = {}) {
  const status = error ? CALL_SESSION_STATUS.FAILED : CALL_SESSION_STATUS.ENDED;
  activeSession.status = status;
  activeSession.lastError = error;
  activeSession.endedAt = Date.now();
  emitState('session-complete', { reason });
  return cloneSession();
}

export function failCallSession(error, extra = {}) {
  activeSession.status = CALL_SESSION_STATUS.FAILED;
  activeSession.lastError = error ? String(error) : 'unknown error';
  activeSession.endedAt = Date.now();
  emitCallEvent(CALL_EVENT.ERROR, {
    error: activeSession.lastError,
    session: cloneSession(),
    extra
  });
  emitState('session-failed');
  return cloneSession();
}

export function applyCallEnvelope(envelope) {
  applyCallKeyEnvelopeToState(activeSession.mediaState, envelope);
  emitState('media-envelope');
  return cloneCallMediaState(activeSession.mediaState);
}

export function setCallMediaStatus(status, error = null) {
  setMediaStatus(activeSession.mediaState, status, error);
  emitState('media-status');
  if (
    status === CALL_MEDIA_STATE_STATUS.READY
    && activeSession.callId
    && activeSession.status === CALL_SESSION_STATUS.CONNECTING
  ) {
    updateCallSessionStatus(CALL_SESSION_STATUS.IN_CALL, { callId: activeSession.callId });
  }
  return cloneCallMediaState(activeSession.mediaState);
}

export function updateCallMedia(fields = {}) {
  touchCallMediaState(activeSession.mediaState, fields);
  emitState('media-update');
  return cloneCallMediaState(activeSession.mediaState);
}

export function getCallMediaState() {
  return activeSession.mediaState;
}

export function setCallNetworkConfig(config) {
  activeSession.network.config = config ? { ...config } : null;
  activeSession.network.lastLoadedAt = config ? Date.now() : null;
  emitState('network-config');
}

export function getCallNetworkConfig() {
  return activeSession.network.config ? { ...activeSession.network.config } : null;
}

export function hydrateCallCapability(capability) {
  activeSession.localCapability = normalizeCallMediaCapability({
    ...activeSession.localCapability,
    ...capability
  });
  emitState('capability-update');
  return cloneCapability(activeSession.localCapability);
}

export function getCallCapability() {
  return cloneCapability(activeSession.localCapability);
}

export function isCallActive() {
  return [
    CALL_SESSION_STATUS.OUTGOING,
    CALL_SESSION_STATUS.INCOMING,
    CALL_SESSION_STATUS.CONNECTING,
    CALL_SESSION_STATUS.IN_CALL
  ].includes(activeSession.status);
}

export function getCallSummary() {
  return {
    status: activeSession.status,
    direction: activeSession.direction,
    kind: activeSession.kind,
    peerAccountDigest: activeSession.peerAccountDigest,
    requestedAt: activeSession.requestedAt,
    connectedAt: activeSession.connectedAt,
    endedAt: activeSession.endedAt,
    lastError: activeSession.lastError,
    traceId: activeSession.traceId
  };
}
