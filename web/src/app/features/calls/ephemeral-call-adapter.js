// ephemeral-call-adapter.js
// Bridges ephemeral-call-* WebSocket messages ↔ standard call-* system.
// Allows the full call pipeline (state, media-session, call-overlay, call-audio)
// to be reused for ephemeral conversations without modification.

import { log } from '../../core/log.js';
import { normalizeAccountDigest, normalizePeerDeviceId, ensureDeviceId } from '../../core/store.js';
import {
  CALL_REQUEST_KIND,
  canStartCall,
  requestOutgoingCall,
  completeCallSession
} from './state.js';
import {
  handleCallSignalMessage,
  handleCallAuxMessage,
  setCallSignalSender,
  sendCallInviteSignal
} from './signaling.js';
import { startOutgoingCallMedia } from './media-session.js';

// ── Ephemeral context ──
let _ephCtx = null;
let _prevSignalSender = null; // stashed regular signal sender to restore on deactivation

/**
 * Activate ephemeral call mode.
 * Installs a signal sender that translates call-* → ephemeral-call-* via WS relay.
 * @param {Object} ctx.restoreSignalSender - optional function to restore as signal sender on deactivation
 */
export function activateEphemeralCallMode(ctx) {
  if (!ctx?.wsSend || !ctx?.conversationId || !ctx?.peerDigest) {
    log({ ephCallAdapterActivateSkipped: true, reason: 'missing-context' });
    return;
  }
  _prevSignalSender = ctx.restoreSignalSender || null;
  _ephCtx = {
    conversationId: ctx.conversationId,
    sessionId: ctx.sessionId || null,
    peerDigest: normalizeAccountDigest(ctx.peerDigest),
    peerDeviceId: normalizePeerDeviceId(ctx.peerDeviceId) || ctx.peerDeviceId || 'ephemeral-device',
    selfDeviceId: ctx.selfDeviceId || ensureDeviceId() || 'ephemeral-self',
    wsSend: ctx.wsSend,
    side: ctx.side || 'guest',
    peerDisplayName: ctx.peerDisplayName || null
  };

  setCallSignalSender(_ephemeralSignalSender);
  log({ ephCallAdapterActivated: true, side: _ephCtx.side });
}

/** Deactivate ephemeral call mode and restore the previous signal sender. */
export function deactivateEphemeralCallMode() {
  if (!_ephCtx) return;
  _ephCtx = null;
  // Restore previous signal sender so regular calls continue working
  if (_prevSignalSender) {
    setCallSignalSender(_prevSignalSender);
    _prevSignalSender = null;
  }
  log({ ephCallAdapterDeactivated: true });
}

/** Update context fields (e.g. when session info changes). */
export function updateEphemeralCallContext(updates) {
  if (!_ephCtx) return;
  if (updates.conversationId) _ephCtx.conversationId = updates.conversationId;
  if (updates.sessionId) _ephCtx.sessionId = updates.sessionId;
  if (updates.peerDigest) _ephCtx.peerDigest = normalizeAccountDigest(updates.peerDigest);
  if (updates.peerDeviceId) _ephCtx.peerDeviceId = normalizePeerDeviceId(updates.peerDeviceId) || updates.peerDeviceId;
  if (updates.peerDisplayName !== undefined) _ephCtx.peerDisplayName = updates.peerDisplayName;
}

export function isEphemeralCallMode() {
  return _ephCtx != null;
}

export function getEphemeralCallContext() {
  return _ephCtx ? { ..._ephCtx } : null;
}

// ── Signal sender: call-* → ephemeral-call-* ──
function _ephemeralSignalSender(payload) {
  if (!_ephCtx?.wsSend || !payload?.type) return;

  const msg = {
    ...payload,
    type: 'ephemeral-' + payload.type,
    conversationId: _ephCtx.conversationId,
    sessionId: _ephCtx.sessionId,
    targetAccountDigest: _ephCtx.peerDigest,
    senderDeviceId: _ephCtx.selfDeviceId
  };

  // Strip fields the ephemeral relay doesn't use
  delete msg.envelope;
  delete msg.capabilities;
  delete msg.traceId;

  try {
    _ephCtx.wsSend(msg);
  } catch (err) {
    log({ ephCallSignalSendError: err?.message, type: msg.type });
  }
}

/**
 * Handle an incoming ephemeral-call-* WS message.
 * Translates to call-* format and feeds into the standard call signal handler.
 * @returns {boolean} true if handled
 */
export function handleEphemeralCallMessage(msg) {
  if (!msg?.type || !msg.type.startsWith('ephemeral-call-')) return false;
  if (!_ephCtx) {
    log({ ephCallMessageIgnored: msg.type, reason: 'adapter-not-active' });
    return false;
  }

  const callType = msg.type.replace('ephemeral-', '');

  const translated = {
    ...msg,
    type: callType,
    fromAccountDigest: _ephCtx.peerDigest,
    fromDeviceId: _ephCtx.peerDeviceId,
    senderDeviceId: msg.senderDeviceId || _ephCtx.peerDeviceId
  };

  // Incoming invite: inject peer profile
  if (callType === 'call-invite') {
    translated.payload = translated.payload || {};
    translated.payload.metadata = translated.payload.metadata || translated.metadata || {};
    if (_ephCtx.peerDisplayName) {
      translated.payload.metadata.displayName = translated.payload.metadata.displayName || _ephCtx.peerDisplayName;
    }
    translated.mode = translated.mode || msg.mode || 'voice';
  }

  // Offer/answer: ensure description at top level (media-session.js reads it there)
  if ((callType === 'call-offer' || callType === 'call-answer') && msg.description) {
    translated.description = msg.description;
  }

  // ICE candidate
  if (callType === 'call-ice-candidate' && msg.candidate) {
    translated.candidate = msg.candidate;
  }

  log({ ephCallMessageTranslated: callType, callId: msg.callId });

  const handled = handleCallSignalMessage(translated);
  if (!handled) {
    handleCallAuxMessage(translated);
  }
  return true;
}

/**
 * Initiate an outgoing ephemeral call.
 * Uses requestOutgoingCall (API failure is gracefully handled),
 * then sends invite signal via ephemeral adapter and starts WebRTC.
 */
export async function initiateEphemeralCall({ mode = 'voice' } = {}) {
  if (!_ephCtx) {
    log({ ephCallInitiateSkipped: true, reason: 'adapter-not-active' });
    return null;
  }
  if (!canStartCall()) {
    log({ ephCallInitiateSkipped: true, reason: 'call-already-active' });
    return null;
  }

  const kind = mode === 'video' ? CALL_REQUEST_KIND.VIDEO : CALL_REQUEST_KIND.VOICE;

  // requestOutgoingCall calls createCallInvite API which will fail for ephemeral,
  // but the failure is caught — it falls back to a locally-generated callId
  // and uses the provided peerDeviceId.
  const result = await requestOutgoingCall({
    peerAccountDigest: _ephCtx.peerDigest,
    peerDeviceId: _ephCtx.peerDeviceId,
    peerDisplayName: _ephCtx.peerDisplayName,
    kind
  });

  if (!result?.ok) {
    log({ ephCallInitiateFailed: result?.error || 'unknown' });
    return null;
  }

  const callId = result.callId;

  // Send invite signal → adapter translates to ephemeral-call-invite
  sendCallInviteSignal({
    callId,
    peerAccountDigest: _ephCtx.peerDigest,
    mode,
    metadata: {
      displayName: _ephCtx.peerDisplayName || 'Ephemeral User'
    }
  });

  // Start WebRTC media pipeline (creates offer, etc.)
  try {
    await startOutgoingCallMedia({ callId });
  } catch (err) {
    log({ ephCallMediaStartError: err?.message || err });
    completeCallSession({ reason: 'media-start-failed', error: err?.message });
    return null;
  }

  return { callId, mode };
}

function _generateCallId() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}
