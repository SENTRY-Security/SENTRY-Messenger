import { log } from '../../core/log.js';
import { sessionStore } from '../../ui/mobile/session-store.js';
import { normalizeAccountDigest, normalizePeerDeviceId, ensureDeviceId } from '../../core/store.js';
import { emitCallEvent, CALL_EVENT } from './events.js';
import {
  CALL_SESSION_STATUS,
  markIncomingCall,
  getCallSessionSnapshot,
  setCallPeerDeviceId,
  getCallCapability,
  updateCallSessionStatus,
  completeCallSession,
  applyCallEnvelope
} from './state.js';
import { buildCallPeerIdentity } from './identity.js';

let wsSend = null;

function resolveContactSnapshot(peer) {
  const digest = normalizeAccountDigest(
    peer && typeof peer === 'object'
      ? (peer.peerAccountDigest ?? peer.accountDigest ?? peer)
      : peer
  );
  const deviceId = normalizePeerDeviceId(
    peer && typeof peer === 'object'
      ? (peer.peerDeviceId ?? peer.deviceId ?? null)
      : null
  );
  let key = null;
  if (digest && deviceId) {
    try {
      key = buildCallPeerIdentity({ peerAccountDigest: digest, peerDeviceId: deviceId }).peerKey;
    } catch {}
  }
  if (!key || !(sessionStore?.contactIndex instanceof Map)) {
    return { key: key || null, nickname: null, avatarUrl: null, accountDigest: digest || null };
  }
  const entry = sessionStore.contactIndex.get(key);
  if (!entry) return { key, nickname: null, avatarUrl: null, accountDigest: digest || null };
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
  return { key, nickname, avatarUrl, accountDigest: digest || entry.peerAccountDigest || null };
}

export function setCallSignalSender(fn) {
  wsSend = typeof fn === 'function' ? fn : null;
}

function applyPeerIdentityFromSignal(msg) {
  if (!msg || typeof msg !== 'object') return;
  const digest = normalizeAccountDigest(
    msg.fromAccountDigest
    || msg.from_account_digest
    || msg.peerAccountDigest
    || msg.targetAccountDigest
    || msg.target_account_digest
    || null
  );
  const deviceId = normalizePeerDeviceId(
    msg.fromDeviceId
    || msg.from_device_id
    || msg.senderDeviceId
    || msg.peerDeviceId
    || msg.targetDeviceId
    || msg.target_device_id
    || null
  );
  if (!digest || !deviceId) return;
  const session = getCallSessionSnapshot();
  if (!session?.peerAccountDigest) return;
  if (session?.callId && msg?.callId && session.callId !== msg.callId) return;
  const sessionDigest = normalizeAccountDigest(session?.peerAccountDigest || null);
  if (sessionDigest && digest && sessionDigest !== digest) {
    log({ callSignalPeerIdentityMismatch: true, sessionDigest, signalDigest: digest, callId: session?.callId || msg?.callId || null });
    return;
  }
  try {
    setCallPeerDeviceId(deviceId, { callId: msg?.callId || session?.callId || null });
  } catch (err) {
    log({ callSignalPeerIdentityError: err?.message || err, callId: msg?.callId || null });
  }
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
  const targetAccountDigest = normalizeAccountDigest(peerAccountDigest || getCallSessionSnapshot()?.peerAccountDigest || null);
  if (!callId || !targetAccountDigest) {
    log({ callSignalSendSkipped: 'call-invite', reason: 'missing-call-or-peer-digest' });
    return false;
  }
  const senderDeviceId = ensureDeviceId();
  const targetDeviceId = normalizePeerDeviceId(getCallSessionSnapshot()?.peerDeviceId || null);
  if (!targetDeviceId) {
    log({ callSignalSendSkipped: 'call-invite', reason: 'missing-peer-device' });
    return false;
  }
  const normalizedCapabilities = capabilities || getCallCapability() || null;
  return emitSignal({
    type: 'call-invite',
    callId,
    targetAccountDigest,
    senderDeviceId,
    targetDeviceId,
    mode: mode === 'video' ? 'video' : 'voice',
    metadata,
    capabilities: normalizedCapabilities,
    envelope,
    traceId
  });
}

export function sendCallSignal(type, payload = {}) {
  if (!type) return false;
  const session = getCallSessionSnapshot();
  const targetAccountDigest = normalizeAccountDigest(
    payload?.targetAccountDigest
    || payload?.target_account_digest
    || session?.peerAccountDigest
    || null
  );
  if (!targetAccountDigest) {
    log({ callSignalSendSkipped: type, reason: 'missing-peer-digest' });
    return false;
  }
  const senderDeviceId = ensureDeviceId();
  const targetDeviceId = normalizePeerDeviceId(payload.targetDeviceId || session?.peerDeviceId || null);
  if (!targetDeviceId) {
    log({ callSignalSendSkipped: type, reason: 'missing-peer-device' });
    return false;
  }
  const normalizedPayload = {
    ...payload,
    targetAccountDigest,
    senderDeviceId,
    targetDeviceId
  };
  delete normalizedPayload.target_account_digest;
  delete normalizedPayload.targetUid;
  delete normalizedPayload.target_uid;
  delete normalizedPayload.peerKey;
  delete normalizedPayload.targetPeerKey;
  return emitSignal({ type, ...normalizedPayload });
}

function handleIncomingInvite(msg) {
  const payload = msg?.payload || {};
  const metadata = payload.metadata || payload.meta || {};
  const envelope = payload.envelope || null;
  const contactSnapshot = resolveContactSnapshot({
    peerAccountDigest: msg?.fromAccountDigest || msg?.from_account_digest || null
  });
  const fromAccountDigest = normalizeAccountDigest(
    contactSnapshot.accountDigest
    || msg.fromAccountDigest
    || msg.from_account_digest
    || null
  );
  const fromDeviceId = normalizePeerDeviceId(
    msg.fromDeviceId
    || msg.from_device_id
    || msg.senderDeviceId
    || null
  );
  const fallbackName = contactSnapshot.nickname
    || (contactSnapshot.key ? `好友 ${contactSnapshot.key.slice(-4)}` : null);
  const fallbackAvatar = contactSnapshot.avatarUrl || null;
  const result = markIncomingCall({
    callId: msg.callId,
    peerAccountDigest: fromAccountDigest,
    peerDeviceId: fromDeviceId,
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
  applyPeerIdentityFromSignal(msg);
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
