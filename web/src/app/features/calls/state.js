import {
  DEFAULT_CALL_MEDIA_CAPABILITY,
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

export function getSelfProfileSummary() {
  return resolveSelfProfileSummary();
}

function createEmptySession() {
  return {
    traceId: null,
    sessionId: null,
    callId: null,
    direction: null,
    status: CALL_SESSION_STATUS.IDLE,
    peerUidHex: null,
    peerDisplayName: null,
    peerAvatarUrl: null,
    peerAccountDigest: null,
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
    localCapability: cloneCapability(session.localCapability),
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

function normalizePeerUid(value) {
  const str = String(value || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  return str || null;
}

function normalizeAccountDigest(value) {
  if (!value) return null;
  const str = String(value).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  return str.length === 64 ? str : null;
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
  peerUidHex,
  peerDisplayName,
  peerAvatarUrl,
  peerAccountDigest,
  kind = CALL_REQUEST_KIND.VOICE,
  traceId = null
} = {}) {
  const peerKey = normalizePeerUid(peerUidHex);
  if (!peerKey) {
    return { ok: false, error: 'MISSING_PEER' };
  }
  if (!canStartCall()) {
    return { ok: false, error: 'CALL_ALREADY_IN_PROGRESS' };
  }
  const peerDigest = normalizeAccountDigest(peerAccountDigest);
  activeSession = createEmptySession();
  activeSession.traceId = traceId || createTraceId();
  activeSession.sessionId = activeSession.traceId;
  activeSession.direction = CALL_SESSION_DIRECTION.OUTGOING;
  activeSession.status = CALL_SESSION_STATUS.OUTGOING;
  activeSession.peerUidHex = peerKey;
  activeSession.peerDisplayName = peerDisplayName || null;
  activeSession.peerAvatarUrl = peerAvatarUrl || null;
  activeSession.peerAccountDigest = peerDigest || null;
  activeSession.remoteDisplayName = peerDisplayName || null;
  activeSession.remoteAvatarUrl = peerAvatarUrl || null;
  activeSession.kind = normalizeKind(kind);
  activeSession.requestedAt = Date.now();
  resetMediaState();
  emitState('outgoing-request');
  emitCallEvent(CALL_EVENT.REQUEST, {
    direction: CALL_SESSION_DIRECTION.OUTGOING,
    kind: activeSession.kind,
    peerUidHex: activeSession.peerUidHex,
    traceId: activeSession.traceId
  });
  try {
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
    const response = await createCallInvite({
      peerUid: peerKey,
      peerAccountDigest: peerDigest,
      mode: activeSession.kind === CALL_REQUEST_KIND.VIDEO ? 'video' : 'voice',
      capabilities: activeSession.localCapability,
      metadata,
      traceId: activeSession.traceId
    });
    if (response?.callId) {
      activeSession.callId = response.callId;
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
  } catch (err) {
    const message = err?.message || 'call invite failed';
    activeSession.status = CALL_SESSION_STATUS.FAILED;
    activeSession.lastError = message;
    activeSession.endedAt = Date.now();
    emitState('outgoing-request-failed', { error: message });
    return { ok: false, error: message };
  }
}

export function markIncomingCall({
  callId,
  peerUidHex,
  peerDisplayName,
  peerAvatarUrl,
  envelope,
  traceId
} = {}) {
  const peerKey = normalizePeerUid(peerUidHex);
  if (!peerKey) return { ok: false, error: 'MISSING_PEER' };
  if (!canStartCall()) return { ok: false, error: 'CALL_ALREADY_IN_PROGRESS' };
  activeSession = createEmptySession();
  activeSession.direction = CALL_SESSION_DIRECTION.INCOMING;
  activeSession.status = CALL_SESSION_STATUS.INCOMING;
  activeSession.peerUidHex = peerKey;
  activeSession.peerDisplayName = peerDisplayName || null;
  activeSession.peerAvatarUrl = peerAvatarUrl || null;
  activeSession.remoteDisplayName = peerDisplayName || null;
  activeSession.remoteAvatarUrl = peerAvatarUrl || null;
  activeSession.callId = callId || null;
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

export function updateCallSessionStatus(nextStatus, { error = null, callId = null } = {}) {
  if (!Object.values(CALL_SESSION_STATUS).includes(nextStatus)) {
    throw new Error(`未知的 call session 狀態：${nextStatus}`);
  }
  activeSession.status = nextStatus;
  if (callId) activeSession.callId = callId;
  if (error) activeSession.lastError = error;
  if (nextStatus === CALL_SESSION_STATUS.CONNECTING) {
    if (!activeSession.connectedAt) activeSession.connectedAt = Date.now();
  }
  if ([CALL_SESSION_STATUS.ENDED, CALL_SESSION_STATUS.FAILED].includes(nextStatus)) {
    activeSession.endedAt = Date.now();
  }
  emitState('status-change');
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
    peerUidHex: activeSession.peerUidHex,
    requestedAt: activeSession.requestedAt,
    connectedAt: activeSession.connectedAt,
    endedAt: activeSession.endedAt,
    lastError: activeSession.lastError,
    traceId: activeSession.traceId
  };
}
