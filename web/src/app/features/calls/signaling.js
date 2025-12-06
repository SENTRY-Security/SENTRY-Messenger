import { log } from '../../core/log.js';
import { sessionStore } from '../../ui/mobile/session-store.js';
import { normalizePeerIdentity } from '../../core/store.js';
import { emitCallEvent, CALL_EVENT } from './events.js';
import {
  CALL_SESSION_STATUS,
  markIncomingCall,
  getCallSessionSnapshot,
  getCallCapability,
  updateCallSessionStatus,
  completeCallSession,
  applyCallEnvelope
} from './state.js';

let wsSend = null;

function resolveContactSnapshot(peer) {
  const identity = normalizePeerIdentity(peer);
  const key = identity.key;
  if (!key || !(sessionStore?.contactIndex instanceof Map)) return { key: null, nickname: null, avatarUrl: null, accountDigest: identity.accountDigest || null };
  const entry = sessionStore.contactIndex.get(key);
  if (!entry) return { key, nickname: null, avatarUrl: null };
  const nickname =
    entry.nickname
    || entry.profile?.nickname
    || entry.profile?.displayName
    || entry.profile?.name
    || entry.contactProfile?.nickname
    || entry.contactProfile?.displayName
    || null;
  const avatarCandidates = [
    entry.avatarUrl,
    entry.avatar?.thumbDataUrl,
    entry.avatar?.previewDataUrl,
    entry.avatar?.url,
    entry.profile?.avatarUrl,
    entry.profile?.avatar?.thumbUrl
  ];
  let avatarUrl = null;
  for (const candidate of avatarCandidates) {
    if (typeof candidate === 'string' && candidate.length) {
      avatarUrl = candidate;
      break;
    }
  }
  return { key, nickname, avatarUrl, accountDigest: identity.accountDigest || entry.peerAccountDigest || null };
}

export function setCallSignalSender(fn) {
  wsSend = typeof fn === 'function' ? fn : null;
}

function emitSignal(payload) {
  if (!payload || typeof payload !== 'object' || !payload.type) return false;
  if (!wsSend) {
    log({ callSignalSendSkipped: payload.type, reason: 'ws-not-ready' });
    return false;
  }
  try {
    wsSend(payload);
    return true;
  } catch (err) {
    log({ callSignalSendError: err?.message || err, payloadType: payload.type });
    return false;
  }
}

export function sendCallInviteSignal({
  callId,
  peerAccountDigest,
  mode = 'voice',
  metadata = {},
  traceId = null,
  capabilities = null,
  envelope = null
} = {}) {
  if (!callId || !peerAccountDigest) {
    log({ callSignalSendSkipped: 'call-invite', reason: 'missing-call-or-peer-digest' });
    return false;
  }
  const normalizedCapabilities = capabilities || getCallCapability() || null;
  return emitSignal({
    type: 'call-invite',
    callId,
    targetAccountDigest: peerAccountDigest || null,
    mode: mode === 'video' ? 'video' : 'voice',
    metadata,
    capabilities: normalizedCapabilities,
    envelope,
    traceId
  });
}

export function sendCallSignal(type, payload = {}) {
  if (!type) return false;
  let normalizedPayload = payload;
  if (payload?.targetAccountDigest || payload?.targetUid) {
    const identity = normalizePeerIdentity({
      peerAccountDigest: payload.targetAccountDigest || payload.target_account_digest || null,
      peerUid: payload.targetUid || payload.target_uid || null
    });
    normalizedPayload = {
      ...payload,
      targetAccountDigest: identity.accountDigest || payload.targetAccountDigest || payload.target_account_digest || null
    };
    delete normalizedPayload.targetUid;
    delete normalizedPayload.target_uid;
  }
  return emitSignal({ type, ...normalizedPayload });
}

function handleIncomingInvite(msg) {
  const payload = msg?.payload || {};
  const metadata = payload.metadata || payload.meta || {};
  const envelope = payload.envelope || null;
  const contactSnapshot = resolveContactSnapshot({
    peerAccountDigest: msg?.fromAccountDigest || msg?.from_account_digest || null
  });
  const fallbackName = contactSnapshot.nickname
    || (contactSnapshot.key ? `好友 ${contactSnapshot.key.slice(-4)}` : null);
  const fallbackAvatar = contactSnapshot.avatarUrl || null;
  const result = markIncomingCall({
    callId: msg.callId,
    peerAccountDigest: contactSnapshot.accountDigest || msg.fromAccountDigest || msg.from_account_digest || null,
    peerDisplayName: metadata.displayName
      || metadata.callerDisplayName
      || metadata.name
      || fallbackName
      || null,
    peerAvatarUrl: metadata.avatarUrl
      || metadata.callerAvatarUrl
      || metadata.avatar
      || fallbackAvatar
      || null,
    envelope,
    traceId: msg.traceId
  });
  if (!result?.ok) {
    log({ callIncomingInviteIgnored: true, reason: result?.error || 'state-conflict' });
  }
}

function applySignalToState(msg) {
  if (!msg?.callId) return;
  const session = getCallSessionSnapshot();
  if (!session?.callId || session.callId !== msg.callId) return;
  const reason = msg.payload?.reason || msg.reason || msg.error || msg.type;
  switch (msg.type) {
    case 'call-accept':
      updateCallSessionStatus(CALL_SESSION_STATUS.CONNECTING, { callId: msg.callId });
      break;
    case 'call-end':
      completeCallSession({ reason: reason || 'peer_end' });
      break;
    case 'call-reject':
    case 'call-busy':
      completeCallSession({ reason: reason || msg.type });
      break;
    case 'call-cancel':
      completeCallSession({ reason: reason || 'peer_cancelled' });
      break;
    default:
      break;
  }
}

function maybeApplyEnvelopeFromSignal(msg) {
  const envelope = msg?.payload?.envelope;
  if (!envelope || !msg?.callId) return;
  const session = getCallSessionSnapshot();
  if (!session?.callId || session.callId !== msg.callId) return;
  try {
    applyCallEnvelope(envelope);
  } catch (err) {
    log({ callSignalEnvelopeError: err?.message || err, callId: msg.callId });
  }
}

export function handleCallSignalMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  const type = String(msg.type || '');
  if (type === 'call-error' || type === 'call-event-ack') return false;
  if (!type.startsWith('call-')) return false;
  if (type === 'call-invite') {
    handleIncomingInvite(msg);
  } else {
    maybeApplyEnvelopeFromSignal(msg);
  }
  applySignalToState(msg);
  emitCallEvent(CALL_EVENT.SIGNAL, { signal: msg, session: getCallSessionSnapshot() });
  return true;
}

export function handleCallAuxMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type === 'call-error') {
    emitCallEvent(CALL_EVENT.ERROR, { error: msg, session: getCallSessionSnapshot() });
    log({ callSignalError: msg.code || 'unknown', callId: msg.callId || null, peerAccountDigest: msg.targetAccountDigest || msg.toAccountDigest || msg.peerAccountDigest || null });
    return true;
  }
  if (msg.type === 'call-event-ack') {
    emitCallEvent(CALL_EVENT.SIGNAL, { ack: msg, session: getCallSessionSnapshot() });
    return true;
  }
  return false;
}
