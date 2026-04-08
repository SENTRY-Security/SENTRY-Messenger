// ephemeral-call-adapter.js
// Bridges ephemeral-call-* WebSocket messages ↔ standard call-* system.
// Allows the full call pipeline (state, media-session, call-overlay, call-audio)
// to be reused for ephemeral conversations without modification.

import { log } from '../../core/log.js';
import { normalizeAccountDigest, normalizePeerDeviceId, ensureDeviceId } from '../../core/store.js';
import {
  CALL_REQUEST_KIND,
  CALL_SESSION_DIRECTION,
  canStartCall,
  requestOutgoingCall,
  completeCallSession,
  updateCallMedia,
  getCallCapability,
  setStateEphemeralMode
} from './state.js';
import { setNetworkConfigEphemeralMode } from './network-config.js';
import {
  handleCallSignalMessage,
  handleCallAuxMessage,
  setCallSignalSender,
  sendCallInviteSignal
} from './signaling.js';
import { startOutgoingCallMedia, setMediaSessionEphemeralMode } from './media-session.js';
import { prepareCallKeyEnvelope } from './key-manager.js';

// ── Ephemeral context ──
let _ephCtx = null;
let _prevSignalSender = null; // stashed regular signal sender to restore on deactivation
let _callTokenGate = null;    // promise that resolves when call token is stored
let _gateQueue = [];          // messages queued while gate is pending
const GATE_TIMEOUT_MS = 5000; // max wait for token derivation before processing anyway

/**
 * Set a promise that must resolve before incoming call signals are processed.
 * This prevents handling call-invite before the call token is stored,
 * which would cause key derivation failure → encrypted audio played raw → noise.
 */
export function setCallTokenGate(promise) {
  if (!promise) { _callTokenGate = null; return; }

  _callTokenGate = promise;

  // Safety timeout — don't block calls forever if derivation hangs
  const timeout = new Promise(resolve => setTimeout(resolve, GATE_TIMEOUT_MS));
  const gateWithTimeout = Promise.race([promise, timeout]);

  gateWithTimeout.then(() => {
    _drainGateQueue();
  }).catch(err => {
    log({ callTokenGateError: err?.message || 'unknown' });
    _drainGateQueue();
  });
}

function _drainGateQueue() {
  _callTokenGate = null;
  const queued = _gateQueue.splice(0);
  if (queued.length > 0) {
    log({ callTokenGateDrained: queued.length });
  }
  for (const msg of queued) {
    if (_ephCtx) {
      _processEphemeralCallMessage(msg);
    } else {
      log({ callTokenGateDropped: msg?.type, reason: 'adapter-deactivated' });
    }
  }
}

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
  setMediaSessionEphemeralMode(true);
  setStateEphemeralMode(true);
  setNetworkConfigEphemeralMode(true);
  log({ ephCallAdapterActivated: true, side: _ephCtx.side });
}

/** Deactivate ephemeral call mode and restore the previous signal sender. */
export function deactivateEphemeralCallMode() {
  if (!_ephCtx) return;
  _ephCtx = null;
  _callTokenGate = null;
  _gateQueue.length = 0;
  setMediaSessionEphemeralMode(false);
  setStateEphemeralMode(false);
  setNetworkConfigEphemeralMode(false);
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

  // Strip fields the ephemeral relay doesn't use.
  // CRITICAL: targetDeviceId must be removed — the dummy device IDs used by the
  // ephemeral adapter (e.g. 'owner-device', 'ephemeral-guest') don't match any
  // real WebSocket deviceId on the target's Durable Object. If targetDeviceId is
  // present, _handleNotify filters out ALL sockets and the message is never delivered.
  delete msg.targetDeviceId;
  // Keep msg.envelope AND msg.capabilities so E2EE negotiation works correctly.
  // Previously capabilities was deleted, causing the peer to default to local
  // capability (insertableStreams: true) even when no E2EE key exchange occurred.
  // This mismatch led to one side encrypting audio while the other couldn't
  // decrypt — resulting in noise or silent audio.
  delete msg.traceId;

  // Always inject local capabilities into outgoing signals so the peer knows
  // our E2EE status.  Standard call signals (accept, offer, answer) don't
  // carry capabilities, but ephemeral calls need both sides to agree.
  //
  // IMPORTANT: read from getCallCapability() (the device's true LOCAL
  // capability), NOT from mediaState.capabilities — applyCallKeyEnvelopeToState
  // overwrites mediaState.capabilities with the PEER's caps as soon as we
  // receive their envelope.  Echoing that back would silently advertise the
  // peer's caps as our own, breaking E2EE feature negotiation when the two
  // sides differ (e.g. one side missing insertableStreams).
  if (!msg.capabilities) {
    const localCaps = getCallCapability();
    if (localCaps) {
      msg.capabilities = localCaps;
    }
  }

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

  // If a call token gate is pending, queue the message — it will be
  // processed once the token is derived (or the safety timeout fires).
  // Without this, call-invite arrives before token is stored → key
  // derivation fails → encrypted audio played as raw noise.
  if (_callTokenGate) {
    log({ callTokenGateQueued: msg.type });
    _gateQueue.push(msg);
    return true;
  }

  return _processEphemeralCallMessage(msg);
}

function _processEphemeralCallMessage(msg) {
  const callType = msg.type.replace('ephemeral-', '');

  const translated = {
    ...msg,
    type: callType,
    fromAccountDigest: _ephCtx.peerDigest,
    fromDeviceId: _ephCtx.peerDeviceId,
    senderDeviceId: msg.senderDeviceId || _ephCtx.peerDeviceId
  };

  // Incoming invite: inject peer profile and forward envelope
  if (callType === 'call-invite') {
    translated.payload = translated.payload || {};
    translated.payload.metadata = translated.payload.metadata || translated.metadata || {};
    if (_ephCtx.peerDisplayName) {
      translated.payload.metadata.displayName = translated.payload.metadata.displayName || _ephCtx.peerDisplayName;
    }
    // Forward E2EE key envelope into payload so handleIncomingInvite can read it
    if (msg.envelope && !translated.payload.envelope) {
      translated.payload.envelope = msg.envelope;
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

  // Apply peer capabilities from the signal to the media state.
  // In regular calls, capabilities arrive inside the envelope which gets
  // applied via applyCallKeyEnvelopeToState.  Ephemeral calls may not have
  // an envelope (E2EE key exchange can fail), so the top-level capabilities
  // field is the only source.  Without this, mediaState.capabilities stays
  // at local default (insertableStreams: true), causing one side to encrypt
  // audio while the other can't decrypt — resulting in noise or no audio.
  //
  // Apply on ALL signal types (invite, accept, offer, answer) — both sides
  // need to know the peer's E2EE capability as early as possible.
  if (msg.capabilities && !msg.envelope) {
    try {
      updateCallMedia({ capabilities: msg.capabilities });
      log({ ephCallCapabilitiesApplied: true, callType, caps: msg.capabilities });
    } catch (err) {
      log({ ephCallCapabilitiesError: err?.message });
    }
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

  // Prepare E2EE key envelope (best-effort — if no conversation token, skip)
  let envelope = null;
  let e2eeReady = false;
  try {
    envelope = await prepareCallKeyEnvelope({
      callId,
      peerAccountDigest: _ephCtx.peerDigest,
      peerDeviceId: _ephCtx.peerDeviceId,
      direction: CALL_SESSION_DIRECTION.OUTGOING
    });
    e2eeReady = true;
    log({ ephCallE2EE: 'envelope-prepared', callId });
  } catch (err) {
    log({ ephCallE2EESkipped: err?.message || err, callId });
  }

  // When E2EE key exchange failed, explicitly advertise insertableStreams: false
  // so the peer knows NOT to encrypt. Without this, the peer defaults to local
  // capability (insertableStreams: true) and may encrypt audio that we cannot
  // decrypt — causing severe noise or silent audio on one side.
  const callCapabilities = e2eeReady ? undefined : { insertableStreams: false };

  // Send invite signal → adapter translates to ephemeral-call-invite
  sendCallInviteSignal({
    callId,
    peerAccountDigest: _ephCtx.peerDigest,
    mode,
    metadata: {
      displayName: _ephCtx.peerDisplayName || 'Ephemeral User'
    },
    envelope,
    capabilities: callCapabilities
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

/**
 * Derive a call conversation token from the DR root key.
 * Both sides (guest & owner) share the same rk after X3DH, so they derive
 * the same token — enabling the standard call E2EE key derivation pipeline.
 * @param {Uint8Array} rk - DR root key (32 bytes)
 * @returns {Promise<Uint8Array>} 32-byte token
 */
export async function deriveCallTokenFromDR(rk) {
  if (!rk || rk.length < 32) throw new Error('DR root key required');
  const enc = new TextEncoder();
  const hkdfKey = await crypto.subtle.importKey('raw', rk, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'HKDF', hash: 'SHA-256',
    salt: enc.encode('ephemeral-call-token-salt'),
    info: enc.encode('ephemeral-call-token')
  }, hkdfKey, 256);
  return new Uint8Array(bits);
}

function _generateCallId() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}
