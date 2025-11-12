import { log } from '../../core/log.js';
import { emitCallEvent, CALL_EVENT } from './events.js';
import {
  CALL_SESSION_STATUS,
  markIncomingCall,
  getCallSessionSnapshot,
  getCallCapability,
  updateCallSessionStatus,
  completeCallSession
} from './state.js';

let wsSend = null;

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
  peerUidHex,
  mode = 'voice',
  metadata = {},
  traceId = null
} = {}) {
  if (!callId || !peerUidHex) {
    log({ callSignalSendSkipped: 'call-invite', reason: 'missing-call-or-peer' });
    return false;
  }
  const capabilities = getCallCapability() || null;
  return emitSignal({
    type: 'call-invite',
    callId,
    targetUid: String(peerUidHex).trim().toUpperCase(),
    mode: mode === 'video' ? 'video' : 'voice',
    metadata,
    capabilities,
    traceId
  });
}

export function sendCallSignal(type, payload = {}) {
  if (!type) return false;
  return emitSignal({ type, ...payload });
}

function handleIncomingInvite(msg) {
  const payload = msg?.payload || {};
  const metadata = payload.metadata || payload.meta || {};
  const envelope = payload.envelope || null;
  const result = markIncomingCall({
    callId: msg.callId,
    peerUidHex: msg.fromUid,
    peerDisplayName: metadata.displayName || metadata.peerDisplayName || metadata.name || null,
    peerAvatarUrl: metadata.avatarUrl || metadata.peerAvatarUrl || metadata.avatar || null,
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

export function handleCallSignalMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  const type = String(msg.type || '');
  if (type === 'call-error' || type === 'call-event-ack') return false;
  if (!type.startsWith('call-')) return false;
  if (type === 'call-invite') {
    handleIncomingInvite(msg);
  }
  applySignalToState(msg);
  emitCallEvent(CALL_EVENT.SIGNAL, { signal: msg, session: getCallSessionSnapshot() });
  return true;
}

export function handleCallAuxMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type === 'call-error') {
    emitCallEvent(CALL_EVENT.ERROR, { error: msg, session: getCallSessionSnapshot() });
    log({ callSignalError: msg.code || 'unknown', callId: msg.callId || null, peerUid: msg.peerUid || null });
    return true;
  }
  if (msg.type === 'call-event-ack') {
    emitCallEvent(CALL_EVENT.SIGNAL, { ack: msg, session: getCallSessionSnapshot() });
    return true;
  }
  return false;
}
