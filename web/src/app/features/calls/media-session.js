import { issueTurnCredentials } from '../../api/calls.js';
import { log } from '../../core/log.js';
import { loadCallNetworkConfig } from './network-config.js';
import { sessionStore } from '../../ui/mobile/session-store.js';
import {
  getCallNetworkConfig,
  getCallMediaState,
  updateCallMedia,
  completeCallSession,
  getCallSessionSnapshot,
  updateCallSessionStatus,
  failCallSession,
  setCallPeerDeviceId,
  CALL_SESSION_STATUS,
  CALL_REQUEST_KIND,
  hydrateCallCapability
} from './state.js';
import {
  getCallKeyContext,
  supportsInsertableStreams,
  usesScriptTransform,
  onKeyContextUpdate,
  releaseCallKeyContextOnCleanup,
  retryDeriveKeys
} from './key-manager.js';
import { CALL_EVENT, subscribeCallEvent } from './events.js';
import { createFaceBlurPipeline, isFaceBlurSupported, BLUR_MODE } from './face-blur.js';
import { normalizeAccountDigest, normalizePeerDeviceId, ensureDeviceId, getAccountDigest } from '../../core/store.js';
import { getCallAudioConstraints } from '../../ui/mobile/browser-detection.js';
import { toU8Strict } from '/shared/utils/u8-strict.js';
import { buildCallPeerIdentity } from './identity.js';
import { t } from '/locales/index.js';

// Flag set by ephemeral-call-adapter when ephemeral mode is active.
// Avoids circular import (media-session ↔ ephemeral-call-adapter).
let _ephemeralModeActive = false;

/** Called by ephemeral-call-adapter to toggle ephemeral mode awareness. */
export function setMediaSessionEphemeralMode(active) {
  _ephemeralModeActive = !!active;
}

let sendSignal = null;
let showToast = () => { };
let remoteAudioEl = null;
let peerConnection = null;
let localStream = null;
let remoteStream = null;
let pendingOffer = null;
let awaitingAnswer = false;
let activeCallId = null;
let activePeerKey = null;
let direction = 'outgoing';
let unsubscribers = [];
let awaitingOfferAfterAccept = false;
let localAudioMuted = false;
let remoteAudioMuted = false;
let localVideoMuted = false;
let remoteVideoEl = null;
let localVideoEl = null;
let cameraFacing = 'user';
let pendingRemoteCandidates = [];
let faceBlurPipeline = null;
let faceBlurMode = BLUR_MODE.FACE;
let e2eeReceiverConfirmed = false;
let peerConnectionEncodedStreams = false;
/** Map<RTCRtpSender|RTCRtpReceiver, Worker> for RTCRtpScriptTransform workers */
let scriptTransformWorkers = new Map();
let remoteCandidateStats = { host: 0, srflx: 0, relay: 0, prflx: 0, total: 0 };
let iceFailureCollecting = false; // guards against connectionstatechange racing with getStats()

function isVideoCall() {
  const session = getCallSessionSnapshot();
  return session?.kind === CALL_REQUEST_KIND.VIDEO;
}

function requireLocalDeviceId() {
  const id = ensureDeviceId();
  if (!id) {
    throw new Error('deviceId missing for call media');
  }
  return id;
}

function requirePeerIdentitySnapshot() {
  const snapshot = getCallSessionSnapshot();
  const digest = normalizeAccountDigest(snapshot?.peerAccountDigest || null);
  const deviceId = normalizePeerDeviceId(snapshot?.peerDeviceId || null);
  if (!digest) {
    throw new Error('peer account digest missing for call media');
  }
  if (!deviceId) {
    throw new Error('peer deviceId missing for call media');
  }
  const identity = buildCallPeerIdentity({ peerAccountDigest: digest, peerDeviceId: deviceId });
  if (!snapshot?.peerKey) {
    try {
      setCallPeerDeviceId(identity.deviceId, { callId: snapshot?.callId || null });
    } catch { }
  }
  return identity;
}

function setPeerDeviceId(deviceId) {
  const normalized = normalizePeerDeviceId(deviceId);
  if (!normalized) {
    throw new Error('peer deviceId missing for call media');
  }
  return setCallPeerDeviceId(normalized, { callId: activeCallId || undefined });
}

function requirePeerDeviceId() {
  return requirePeerIdentitySnapshot().deviceId;
}

function failCall(reason, err = null) {
  const message = err?.message || err || reason || 'call-media-failed';
  const session = getCallSessionSnapshot();
  const snapshot = session || {};
  let selfAccountDigest = null;
  let selfDeviceId = null;
  try {
    selfAccountDigest = getAccountDigest ? getAccountDigest() : null;
  } catch { }
  try {
    selfDeviceId = ensureDeviceId();
  } catch { }
  log(`callFail|callId=${snapshot.callId || null}|traceId=${snapshot.traceId || null}|selfAccountDigest=${selfAccountDigest || null}|selfDeviceId=${selfDeviceId || null}|peerAccountDigest=${snapshot.peerAccountDigest || null}|peerDeviceId=${snapshot.peerDeviceId || null}|peerKey=${snapshot.peerKey || activePeerKey || null}|reason=${message}`);
  failCallSession(message, {
    reason,
    callId: snapshot.callId || null,
    traceId: snapshot.traceId || null,
    peerDeviceId: snapshot.peerDeviceId || null,
    peerAccountDigest: snapshot.peerAccountDigest || null,
    peerKey: snapshot.peerKey || activePeerKey || null,
    selfAccountDigest,
    selfDeviceId
  });
  cleanupPeerConnection(reason || message);
  const error = err instanceof Error ? err : new Error(message);
  // mark to avoid double-fail handling
  error.__callFail = true;
  throw error;
}

function isLiveMicrophoneStream(stream) {
  if (!stream?.getAudioTracks) return false;
  return stream.getAudioTracks().some((track) => track?.readyState === 'live');
}

function cloneLiveAudioTracks(stream) {
  if (!stream?.getAudioTracks) return [];
  return stream.getAudioTracks()
    .filter((track) => track?.readyState === 'live')
    .map((track) => (typeof track.clone === 'function' ? track.clone() : track));
}

function getCachedMicrophoneStream() {
  const cached = sessionStore?.cachedMicrophoneStream || null;
  if (isLiveMicrophoneStream(cached)) return cached;
  try { sessionStore.cachedMicrophoneStream = null; } catch { }
  return null;
}

function setCachedMicrophoneStream(stream) {
  if (!isLiveMicrophoneStream(stream)) return null;
  try { sessionStore.cachedMicrophoneStream = stream; } catch { }
  return stream;
}

/**
 * Ensure the peer connection has transceivers for receiving media.
 * addTrack() creates 'sendrecv' transceivers for local tracks, but when a
 * media kind is absent (e.g. video in a voice-only call that still wants to
 * receive video), we add a 'recvonly' transceiver so the SDP includes the
 * correct m-line.
 *
 * This replaces the deprecated offerToReceiveAudio / offerToReceiveVideo
 * options in createOffer(), which iOS Safari 26.3+ no longer supports.
 */
function ensureReceiveTransceivers(wantVideo) {
  if (!peerConnection) return;
  const transceivers = peerConnection.getTransceivers();
  const hasAudio = transceivers.some((t) => {
    const kind = t.sender?.track?.kind || t.receiver?.track?.kind;
    return kind === 'audio';
  });
  const hasVideo = transceivers.some((t) => {
    const kind = t.sender?.track?.kind || t.receiver?.track?.kind;
    return kind === 'video';
  });
  if (!hasAudio) {
    peerConnection.addTransceiver('audio', { direction: 'recvonly' });
  }
  if (wantVideo && !hasVideo) {
    peerConnection.addTransceiver('video', { direction: 'recvonly' });
  }
}

function normalizeCallSignal(signal) {
  if (!signal || typeof signal !== 'object') return signal;
  const payload = signal.payload;
  const enriched = { ...signal };
  if (!enriched.description && payload && typeof payload === 'object' && payload.description) {
    enriched.description = payload.description;
  }
  if (enriched.candidate) {
    enriched.candidate = normalizeCandidate(enriched.candidate);
  } else if (payload && typeof payload === 'object' && payload.candidate) {
    enriched.candidate = normalizeCandidate(payload.candidate);
  }
  return enriched;
}

function normalizeCandidate(candidate) {
  if (!candidate) return null;
  if (typeof candidate === 'string') {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { }
    if (candidate.startsWith('candidate:')) {
      return { candidate };
    }
    return null;
  }
  return candidate;
}

async function addRemoteCandidate(candidate) {
  if (!peerConnection || !candidate) return;
  try {
    // iOS 26.3 WebKit silently drops candidates whose usernameFragment
    // is null/undefined — they never appear in the ICE agent (0 candidate
    // pairs, 0 remote candidates in getStats) despite addIceCandidate
    // resolving without error.
    //
    // Older Safari versions do NOT include usernameFragment in
    // RTCIceCandidate.toJSON(), so candidates from older peers arrive
    // without it.  Per the W3C spec, candidates without usernameFragment
    // should be associated with the latest remote description, but iOS
    // 26.3 appears to require it explicitly.
    //
    // Fix: inject usernameFragment from the remote SDP's a=ice-ufrag
    // when it is missing from the candidate init object.
    let init = candidate;
    if (typeof candidate === 'object' && !candidate.usernameFragment) {
      const sdp = peerConnection.remoteDescription?.sdp;
      if (sdp) {
        const ufrag = sdp.match(/a=ice-ufrag:([^\r\n]+)/)?.[1]?.trim();
        if (ufrag) {
          init = { ...candidate, usernameFragment: ufrag };
          log({ callCandidateUfragInjected: ufrag, sdpMid: init.sdpMid, callId: activeCallId });
        }
      }
    }
    await peerConnection.addIceCandidate(init);
  } catch (err) {
    log({ callAddIceCandidateError: err?.message || String(err), callId: activeCallId });
    failCall('add-ice-candidate-failed', err);
  }
}

async function flushPendingRemoteCandidates() {
  if (!pendingRemoteCandidates.length) return;
  const queue = pendingRemoteCandidates.splice(0);
  for (const candidate of queue) {
    await addRemoteCandidate(candidate);
  }
}

function promoteSessionToInCall(source = 'media') {
  const session = getCallSessionSnapshot();
  if (!session?.callId) return;
  if (session.status === CALL_SESSION_STATUS.IN_CALL) return;
  const promotableStatuses = [
    CALL_SESSION_STATUS.CONNECTING,
    CALL_SESSION_STATUS.OUTGOING,
    CALL_SESSION_STATUS.INCOMING
  ];
  if (!promotableStatuses.includes(session.status)) return;
  updateCallSessionStatus(CALL_SESSION_STATUS.IN_CALL, { callId: session.callId });
  log({ callSessionPromoted: source, callId: session.callId, prevStatus: session.status });
}

export function initCallMediaSession({ sendSignalFn, showToastFn }) {
  sendSignal = typeof sendSignalFn === 'function' ? sendSignalFn : null;
  showToast = typeof showToastFn === 'function' ? showToastFn : () => { };
  ensureRemoteAudioElement();
  // Advertise accurate insertableStreams capability early so the call-invite
  // signal (sent before attachLocalMedia) reflects actual browser support.
  hydrateCallCapability({ insertableStreams: supportsInsertableStreams() });
  if (unsubscribers.length) return;
  unsubscribers = [
    subscribeCallEvent(CALL_EVENT.SIGNAL, ({ signal }) => handleSignal(signal)),
    subscribeCallEvent(CALL_EVENT.STATE, ({ session }) => handleSessionState(session)),
    // Rekey ScriptTransform workers when call key context changes (key rotation)
    // Also retroactively apply transforms for receivers/senders that were skipped
    // because keyContext wasn't ready at ontrack time (race condition fix).
    onKeyContextUpdate((ctx) => {
      rekeyScriptTransformWorkers();
      if (ctx) applyDeferredTransforms();
    })
  ];
}

export function disposeCallMediaSession() {
  for (const off of unsubscribers.splice(0)) {
    try { off?.(); } catch { }
  }
  cleanupPeerConnection('dispose');
}

export async function startOutgoingCallMedia({ callId } = {}) {
  if (!supportsInsertableStreams() && !_ephemeralModeActive) {
    failCall('e2ee-not-supported', new Error(t('callKeys.e2eeNotSupported')));
    return;
  }
  // [2nd-call-debug] DELETE WHEN DONE — capture stale keyContext before starting outgoing call
  console.log('[2nd-call-debug] startOutgoingCallMedia', JSON.stringify({
    callId,
    staleKeyContextSalt: getCallKeyContext()?.envelope?.cmkSalt || null
  }));
  activeCallId = callId;
  const identity = requirePeerIdentitySnapshot();
  activePeerKey = identity.peerKey;
  direction = 'outgoing';
  awaitingAnswer = true;
  try {
    await ensurePeerConnection();
    await createAndSendOffer();
  } catch (err) {
    if (!err?.__callFail) {
      failCall('outgoing-media-setup-failed', err);
    }
  }
}

export async function acceptIncomingCallMedia({ callId } = {}) {
  if (!supportsInsertableStreams() && !_ephemeralModeActive) {
    failCall('e2ee-not-supported', new Error(t('callKeys.e2eeNotSupported')));
    return;
  }
  // [2nd-call-debug] DELETE WHEN DONE — capture stale keyContext before accepting incoming
  console.log('[2nd-call-debug] acceptIncomingCallMedia', JSON.stringify({
    callId,
    staleKeyContextSalt: getCallKeyContext()?.envelope?.cmkSalt || null
  }));
  activeCallId = callId;
  const identity = requirePeerIdentitySnapshot();
  activePeerKey = identity.peerKey;
  direction = 'incoming';
  awaitingOfferAfterAccept = true;
  // Defensive: kick off a derive attempt if keyContext isn't set yet.
  // In normal flow this is a no-op — call-overlay disables the accept button
  // while isKeyDerivationPending() is true, so by the time the user can click
  // accept the keyContext is already derived.  But if a render race lets the
  // user through before the disable propagates, this synchronous gate ensures
  // sender/receiver transforms downstream see a non-null keyContext, instead
  // of relying on setupInsertableStreamsForSender's 500ms setTimeout retry
  // (which races with the SDP exchange).
  // retryDeriveKeys() returns immediately if keyContext is already set.
  try { await retryDeriveKeys(); } catch { /* logged inside */ }
  try {
    await ensurePeerConnection();
    if (pendingOffer && pendingOffer.callId === callId) {
      await applyRemoteOfferAndAnswer(pendingOffer);
      pendingOffer = null;
      awaitingOfferAfterAccept = false;
    }
  } catch (err) {
    if (!err?.__callFail) {
      failCall('incoming-media-setup-failed', err);
    }
  }
}

export function endCallMediaSession(reason = 'hangup') {
  cleanupPeerConnection(reason);
}

/**
 * Called when the page returns to the foreground during an active call.
 * Re-attempts audio/video playback (browsers may suspend playback when
 * backgrounded) and triggers an ICE restart if the connection dropped.
 */
export function recoverCallMediaOnResume() {
  if (!peerConnection) return;
  const iceState = peerConnection.iceConnectionState;
  log({ callMediaResume: true, iceState, callId: activeCallId });

  // Re-attempt audio/video playback — browsers suspend media elements
  // when the tab is hidden and play() may have been rejected.
  if (remoteAudioEl?.srcObject) attemptRemoteAudioPlayback();
  if (remoteVideoEl?.srcObject) attemptRemoteVideoPlayback();

  // ICE restart if the connection degraded while backgrounded
  if (iceState === 'disconnected' || iceState === 'failed') {
    log({ callIceRestart: true, iceState, callId: activeCallId });
    peerConnection.createOffer({ iceRestart: true })
      .then((offer) => peerConnection.setLocalDescription(offer))
      .then(() => {
        if (!peerConnection || !sendSignal) return;
        const identity = requirePeerIdentitySnapshot();
        sendSignal('call-offer', {
          callId: activeCallId,
          targetAccountDigest: identity.digest,
          senderDeviceId: requireLocalDeviceId(),
          targetDeviceId: identity.deviceId,
          description: peerConnection.localDescription
        });
      })
      .catch((err) => {
        log({ callIceRestartError: err?.message || err, callId: activeCallId });
      });
  }
}

export function isLocalAudioMuted() {
  return localAudioMuted;
}

export function setLocalAudioMuted(muted = false) {
  localAudioMuted = !!muted;
  applyLocalAudioMuteState();
}

export function isRemoteAudioMuted() {
  return remoteAudioMuted;
}

export function setRemoteAudioMuted(muted = false) {
  remoteAudioMuted = !!muted;
  applyRemoteAudioMuteState();
}

export function isLocalVideoMuted() {
  return localVideoMuted;
}

export function setLocalVideoMuted(muted = false) {
  localVideoMuted = !!muted;
  applyLocalVideoMuteState();
}

export function getLocalStream() {
  return localStream;
}

/**
 * Return the local stream suitable for self-preview display.
 * When the face blur pipeline is active and enabled, this returns a stream
 * containing the blurred video track (+ original audio), so the user sees
 * exactly what the remote peer receives.  Falls back to the raw localStream.
 */
export function getLocalDisplayStream() {
  if (faceBlurPipeline && faceBlurMode !== BLUR_MODE.OFF && localStream) {
    const blurTrack = faceBlurPipeline.track;
    if (blurTrack && blurTrack.readyState === 'live') {
      return new MediaStream([blurTrack, ...localStream.getAudioTracks()]);
    }
  }
  return localStream;
}

export function getRemoteStream() {
  return remoteStream;
}

export function setRemoteVideoElement(el) {
  remoteVideoEl = el || null;
  if (remoteVideoEl) {
    remoteVideoEl.muted = true;
    if (remoteStream) {
      try {
        remoteVideoEl.srcObject = remoteStream;
        const maybePlay = remoteVideoEl.play();
        if (maybePlay && typeof maybePlay.catch === 'function') {
          maybePlay.catch(() => {});
        }
      } catch {}
    }
  }
}

export function setLocalVideoElement(el) {
  localVideoEl = el || null;
  if (localVideoEl && localStream) {
    try {
      localVideoEl.srcObject = faceBlurPipeline ? new MediaStream([faceBlurPipeline.track]) : localStream;
      localVideoEl.muted = true;
      const maybePlay = localVideoEl.play();
      if (maybePlay && typeof maybePlay.catch === 'function') {
        maybePlay.catch(() => {});
      }
    } catch {}
  }
}

export async function toggleLocalVideo(enabled) {
  if (!peerConnection || !localStream) return;
  const videoSender = peerConnection.getSenders().find((s) => s.track?.kind === 'video' || (!s.track && s._wasVideo));
  if (enabled) {
    try {
      const constraints = { facingMode: cameraFacing, width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 30 } };
      const camStream = await navigator.mediaDevices.getUserMedia({ video: constraints });
      const newTrack = camStream.getVideoTracks()[0];
      if (!newTrack) return;
      // Update or create face blur pipeline
      if (faceBlurPipeline) {
        faceBlurPipeline.updateSource(newTrack);
      } else if (isFaceBlurSupported()) {
        try {
          faceBlurPipeline = createFaceBlurPipeline(newTrack);
          if (faceBlurPipeline) faceBlurPipeline.setMode(faceBlurMode);
        } catch (err) {
          log({ faceBlurPipelineError: err?.message || err });
          faceBlurPipeline = null;
        }
      }
      const sendTrack = faceBlurPipeline ? faceBlurPipeline.track : newTrack;
      if (videoSender) {
        await videoSender.replaceTrack(sendTrack);
      } else {
        const sender = peerConnection.addTrack(sendTrack, localStream);
        setupInsertableStreamsForSender(sender, sendTrack);
      }
      localStream.getVideoTracks().forEach((t) => {
        try { t.stop(); } catch {}
        localStream.removeTrack(t);
      });
      localStream.addTrack(newTrack);
      localVideoMuted = false;
      if (localVideoEl) {
        localVideoEl.srcObject = faceBlurPipeline ? new MediaStream([faceBlurPipeline.track]) : localStream;
        localVideoEl.play().catch(() => {});
      }
      updateCallMedia({ controls: { videoEnabled: true, videoMuted: false } });
    } catch (err) {
      log({ callToggleVideoError: err?.message || err });
      showToast?.(t('callMedia.cannotStartCamera'), { variant: 'error' });
    }
  } else {
    // Destroy face blur pipeline when video is turned off
    if (faceBlurPipeline) {
      try { faceBlurPipeline.destroy(); } catch {}
      faceBlurPipeline = null;
    }
    localStream.getVideoTracks().forEach((track) => {
      track.stop();
      localStream.removeTrack(track);
    });
    if (videoSender) {
      try {
        await videoSender.replaceTrack(null);
        videoSender._wasVideo = true;
      } catch {}
    }
    localVideoMuted = true;
    updateCallMedia({ controls: { videoEnabled: false, videoMuted: true } });
  }
}

export async function switchCamera() {
  if (!peerConnection || !localStream) return;
  const nextFacing = cameraFacing === 'user' ? 'environment' : 'user';
  try {
    const constraints = { facingMode: nextFacing, width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 30 } };
    const camStream = await navigator.mediaDevices.getUserMedia({ video: constraints });
    const newTrack = camStream.getVideoTracks()[0];
    if (!newTrack) return;
    // Update face blur pipeline source to the new camera
    if (faceBlurPipeline) {
      faceBlurPipeline.updateSource(newTrack);
    }
    const videoSender = peerConnection.getSenders().find((s) => s.track?.kind === 'video');
    if (videoSender) {
      // If pipeline is active, sender already has pipeline.track — no replaceTrack needed
      if (!faceBlurPipeline) {
        await videoSender.replaceTrack(newTrack);
      }
      setupInsertableStreamsForSender(videoSender, faceBlurPipeline ? faceBlurPipeline.track : newTrack);
    }
    localStream.getVideoTracks().forEach((t) => {
      try { t.stop(); } catch {}
      localStream.removeTrack(t);
    });
    localStream.addTrack(newTrack);
    cameraFacing = nextFacing;
    if (localVideoEl) {
      localVideoEl.srcObject = faceBlurPipeline ? new MediaStream([faceBlurPipeline.track]) : localStream;
      localVideoEl.play().catch(() => {});
    }
  } catch (err) {
    log({ callSwitchCameraError: err?.message || err });
    showToast?.(t('callMedia.cannotSwitchCamera'), { variant: 'error' });
  }
}

export function getCameraFacing() {
  return cameraFacing;
}

function ensureRemoteAudioElement() {
  if (typeof document === 'undefined') return null;
  remoteAudioEl = document.getElementById('callRemoteAudio');
  if (!remoteAudioEl) {
    remoteAudioEl = document.createElement('audio');
    remoteAudioEl.id = 'callRemoteAudio';
    remoteAudioEl.autoplay = true;
    remoteAudioEl.playsInline = true;
    remoteAudioEl.preload = 'auto';
    remoteAudioEl.setAttribute('aria-hidden', 'true');
    applyRemoteAudioElementStyles(remoteAudioEl);
    document.body.appendChild(remoteAudioEl);
  } else {
    applyRemoteAudioElementStyles(remoteAudioEl);
  }
  remoteAudioEl.muted = !!remoteAudioMuted;
  if (remoteAudioMuted) {
    remoteAudioEl.setAttribute('muted', 'true');
  } else {
    remoteAudioEl.removeAttribute('muted');
  }
  return remoteAudioEl;
}

function applyRemoteAudioElementStyles(el) {
  if (!el) return;
  Object.assign(el.style, {
    position: 'absolute',
    width: '1px',
    height: '1px',
    opacity: '0',
    pointerEvents: 'none',
    bottom: '0',
    left: '0'
  });
}

async function ensurePeerConnection() {
  if (peerConnection) return peerConnection;
  const rtcConfig = await buildRtcConfiguration();

  // Generate an explicit ECDSA P-256 certificate for DTLS.
  // iOS 26.3 may default to a different curve or algorithm (e.g. P-384
  // or Ed25519) that older Safari versions cannot negotiate during the
  // DTLS handshake.  Since ICE "checking → failed" occurs even with
  // relay candidates on both sides, the failure likely happens at the
  // DTLS layer (browsers report DTLS failure as ICE failure).
  // ECDSA P-256 is universally supported across all Safari versions.
  try {
    const cert = await RTCPeerConnection.generateCertificate({
      name: 'ECDSA',
      namedCurve: 'P-256'
    });
    rtcConfig.certificates = [cert];
    log({ callCertGenerated: 'ECDSA-P256', callId: activeCallId });
  } catch (certErr) {
    log({ callCertError: certErr?.message || String(certErr), callId: activeCallId });
    // Continue without explicit certificate — browser picks its default
  }

  // Enable encodedInsertableStreams ONLY for the legacy createEncodedStreams()
  // path (Chrome).  On Safari (RTCRtpScriptTransform), setting this flag
  // puts the RTCPeerConnection into an encoded-streams mode that conflicts
  // with ScriptTransform — video frames get queued waiting for
  // createEncodedStreams() and never reach the ScriptTransform worker.
  if (supportsInsertableStreams() && !usesScriptTransform()) {
    rtcConfig.encodedInsertableStreams = true;
    peerConnectionEncodedStreams = true;
  }
  peerConnection = new RTCPeerConnection(rtcConfig);
  // Track gathered ICE candidate types for diagnostics
  const candidateStats = { host: 0, srflx: 0, relay: 0, prflx: 0, total: 0 };

  peerConnection.onicecandidate = (event) => {
    try {
      if (!event.candidate) {
        // Gathering complete (null candidate)
        log({
          callIceGatheringDone: true,
          callId: activeCallId,
          candidates: { ...candidateStats }
        });
        return;
      }
      if (!sendSignal || !activeCallId) return;
      // Track candidate types for diagnostics
      const candStr = event.candidate.candidate || '';
      if (candStr.includes(' host ')) candidateStats.host++;
      else if (candStr.includes(' srflx ')) candidateStats.srflx++;
      else if (candStr.includes(' relay ')) candidateStats.relay++;
      else if (candStr.includes(' prflx ')) candidateStats.prflx++;
      candidateStats.total++;

      const candidateInit = typeof event.candidate.toJSON === 'function'
        ? event.candidate.toJSON()
        : event.candidate;
      const targetIdentity = requirePeerIdentitySnapshot();
      activePeerKey = targetIdentity.peerKey;
      const targetDeviceId = targetIdentity.deviceId;
      sendSignal('call-ice-candidate', {
        callId: activeCallId,
        targetAccountDigest: targetIdentity.digest,
        senderDeviceId: requireLocalDeviceId(),
        targetDeviceId,
        candidate: candidateInit
      });
    } catch (err) {
      failCall('ice-candidate-send-failed', err);
    }
  };
  peerConnection.onicegatheringstatechange = () => {
    const gatherState = peerConnection.iceGatheringState;
    log({ callIceGatheringState: gatherState, callId: activeCallId, candidates: { ...candidateStats } });
  };
  peerConnection.ontrack = (event) => {
    remoteStream = event.streams[0] || new MediaStream([event.track]);
    log({ callRemoteTrack: event.track?.kind, readyState: event.track?.readyState, callId: activeCallId });
    // Set up receiver E2EE transform BEFORE attaching the stream to DOM
    // elements.  This ensures encrypted frames are decrypted before the
    // codec/decoder sees them — avoids decoder errors that abort play().
    setupInsertableStreamsForReceiver(event.receiver, event.track);
    attachRemoteStream(remoteStream);
    promoteSessionToInCall('remote-track');
  };
  // Log DTLS transport state changes — DTLS failure is often
  // reported as ICE failure by WebKit.  This helps distinguish
  // ICE-level vs DTLS-level failures.
  try {
    const dtlsCheck = setInterval(() => {
      if (!peerConnection) { clearInterval(dtlsCheck); return; }
      try {
        const senders = peerConnection.getSenders();
        const transport = senders[0]?.transport;
        if (transport && transport.state) {
          log({ callDtlsState: transport.state, iceTransportState: transport.iceTransport?.state, callId: activeCallId });
          if (transport.state === 'connected' || transport.state === 'failed' || transport.state === 'closed') {
            clearInterval(dtlsCheck);
          }
        }
      } catch { clearInterval(dtlsCheck); }
    }, 500);
    // Cleanup after 30s regardless
    setTimeout(() => clearInterval(dtlsCheck), 30000);
  } catch { }

  peerConnection.oniceconnectionstatechange = async () => {
    if (!peerConnection) return;
    const iceState = peerConnection.iceConnectionState;
    log({
      callIceConnectionState: iceState,
      callId: activeCallId,
      signalingState: peerConnection.signalingState,
      localDesc: peerConnection.localDescription?.type || 'none',
      remoteDesc: peerConnection.remoteDescription?.type || 'none',
      candidates: { ...candidateStats }
    });
    if (iceState === 'connected' || iceState === 'completed') {
      promoteSessionToInCall('ice-state');
    } else if (iceState === 'failed') {
      // CRITICAL: collect getStats() BEFORE cleanup.
      // Set a flag so onconnectionstatechange (which fires
      // synchronously during our await) does NOT race and close
      // the peer connection before we finish collecting stats.
      iceFailureCollecting = true;
      const savedCallId = activeCallId;
      try {
        const stats = await Promise.race([
          peerConnection.getStats(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('stats-timeout')), 3000))
        ]);
        const pairs = [];
        const transports = [];
        const localCands = {};
        const remoteCands = {};
        let totalReports = 0;
        stats.forEach((report) => {
          totalReports++;
          if (report.type === 'candidate-pair') {
            pairs.push({
              st: report.state,
              nom: report.nominated,
              lid: report.localCandidateId,
              rid: report.remoteCandidateId,
              bSent: report.bytesSent,
              bRecv: report.bytesReceived,
              reqS: report.requestsSent,
              resR: report.responsesReceived,
              reqR: report.requestsReceived,
              resS: report.responsesSent,
              curRtt: report.currentRoundTripTime
            });
          }
          if (report.type === 'transport') {
            transports.push({
              dtlsState: report.dtlsState,
              iceState: report.iceState,
              selectedPairId: report.selectedCandidatePairId,
              tlsVersion: report.tlsVersion,
              dtlsCipher: report.dtlsCipher,
              srtpCipher: report.srtpCipher
            });
          }
          if (report.type === 'local-candidate') {
            localCands[report.id] = {
              typ: report.candidateType,
              proto: report.protocol,
              addr: report.address,
              port: report.port,
              relProto: report.relayProtocol
            };
          }
          if (report.type === 'remote-candidate') {
            remoteCands[report.id] = {
              typ: report.candidateType,
              proto: report.protocol,
              addr: report.address,
              port: report.port
            };
          }
        });
        log({
          callIceFailedStats: true,
          callId: savedCallId,
          totalReports,
          candidatePairs: pairs.length,
          pairsDetail: JSON.stringify(pairs.slice(0, 12)),
          transports: JSON.stringify(transports),
          localCands: JSON.stringify(Object.values(localCands).slice(0, 8)),
          remoteCands: JSON.stringify(Object.values(remoteCands).slice(0, 8))
        });
      } catch (statsErr) {
        log({ callIceStatsError: statsErr?.message, callId: savedCallId });
      }
      iceFailureCollecting = false;
      // Guard: peer connection may have been cleaned up during await
      if (!peerConnection) return;
      log({
        callIceFailed: true,
        callId: activeCallId,
        direction,
        candidates: { ...candidateStats },
        remoteCandidates: { ...remoteCandidateStats },
        hasLocalDesc: !!peerConnection.localDescription,
        hasRemoteDesc: !!peerConnection.remoteDescription,
        signalingState: peerConnection.signalingState
      });
      showToast?.(t('callMedia.connectionFailed'), { variant: 'error' });
      completeCallSession({ reason: iceState, error: 'ice-connection-failed' });
      cleanupPeerConnection(iceState);
    } else if (iceState === 'disconnected') {
      log({ callIceDisconnected: true, callId: activeCallId });
      showToast?.(t('callMedia.connectionUnstable'), { variant: 'warning' });
    }
  };
  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    log({ callConnectionState: state, callId: activeCallId });
    if (state === 'connected' || state === 'completed') {
      promoteSessionToInCall('connection-state');
      return;
    }
    if (state === 'failed') {
      // If the ICE failure handler is currently collecting getStats(),
      // skip cleanup here — the ICE handler owns the lifecycle and
      // will cleanup after stats are collected.
      if (iceFailureCollecting) return;
      showToast?.(t('callMedia.connectionLost'), { variant: 'error' });
      completeCallSession({ reason: state, error: 'peer-connection-failed' });
      cleanupPeerConnection(state);
    } else if (state === 'disconnected') {
      log({ callConnectionDisconnected: true, callId: activeCallId });
      showToast?.(t('callMedia.connectionUnstable'), { variant: 'warning' });
    } else if (state === 'closed') {
      cleanupPeerConnection(state);
    }
  };
  await attachLocalMedia();
  return peerConnection;
}

async function attachLocalMedia() {
  // Defensive: attachLocalMedia is called exactly once per peer connection
  // lifetime (from ensurePeerConnection, which early-returns if peerConnection
  // already exists; cleanupPeerConnection resets localStream alongside
  // peerConnection so they stay in sync).  We removed the previous "reuse
  // existing localStream" early-return because:
  //   1. It would addTrack() without calling setupInsertableStreamsForSender,
  //      potentially sending unencrypted / wrong-key audio if the deferred
  //      sender-transform pass for any reason did not run (e.g. ontrack
  //      delivered video before audio).
  //   2. It only ever fired in race conditions that don't occur in the
  //      normal cleanup → next-call sequence.
  // If somehow we DO find a stale localStream here, stop its tracks and
  // reacquire to avoid leaking the mic and to keep the encrypted-frame
  // pipeline consistent (every track must go through the standard
  // setup-sender path below).
  if (localStream && localStream.getTracks().length) {
    log({
      attachLocalMediaUnexpectedReuse: true,
      callId: activeCallId,
      trackCount: localStream.getTracks().length
    });
    try { localStream.getTracks().forEach((t) => { try { t.stop(); } catch {} }); } catch {}
    localStream = null;
  }
  try {
    const wantVideo = isVideoCall();
    const cached = getCachedMicrophoneStream();
    if (cached) {
      if (wantVideo && cached.getVideoTracks().some((t) => t.readyState === 'live')) {
        // Video call with pre-acquired video+audio stream: clone all live tracks
        const liveTracks = cached.getTracks()
          .filter((t) => t.readyState === 'live')
          .map((t) => (typeof t.clone === 'function' ? t.clone() : t));
        if (liveTracks.length) {
          localStream = new MediaStream(liveTracks);
        }
      } else if (!wantVideo) {
        // Voice call: only need audio tracks from the cached stream.
        const tracks = cloneLiveAudioTracks(cached);
        if (tracks.length) {
          localStream = new MediaStream(tracks);
        }
      }
      // Video call but cached stream lacks live video tracks: fall through
      // to the fresh getUserMedia() path below so we request camera access
      // rather than silently downgrading to a voice-only call.
    }
    if (!localStream) {
      const videoConstraints = wantVideo
        ? { facingMode: cameraFacing, width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 30 } }
        : false;
      const audioConstraints = getCallAudioConstraints();
      let freshStream;
      try {
        freshStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: videoConstraints });
      } catch (mediaErr) {
        if (wantVideo) {
          log({ callMediaCameraFallback: mediaErr?.message || mediaErr });
          showToast?.(t('callMedia.cameraFallbackToVoice'), { variant: 'warning' });
          freshStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
        } else {
          throw mediaErr;
        }
      }
      setCachedMicrophoneStream(freshStream);
      if (wantVideo) {
        localStream = freshStream;
      } else {
        const tracks = cloneLiveAudioTracks(freshStream);
        localStream = tracks.length ? new MediaStream(tracks) : freshStream;
      }
    }
    // Set up face blur pipeline for video tracks before adding to peer connection
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack && isFaceBlurSupported()) {
      try {
        faceBlurPipeline = createFaceBlurPipeline(videoTrack);
        if (faceBlurPipeline) {
          faceBlurPipeline.setMode(faceBlurMode);
          log({ faceBlurPipelineCreated: true, mode: faceBlurMode });
        } else {
          log({ faceBlur: 'pipeline returned null (captureStream unavailable)' });
        }
      } catch (err) {
        log({ faceBlurPipelineError: err?.message || err });
        faceBlurPipeline = null;
      }
    }
    localStream.getTracks().forEach((track) => {
      // If face blur pipeline is active, send processed video track to peer
      const sendTrack = (track.kind === 'video' && faceBlurPipeline) ? faceBlurPipeline.track : track;
      const sender = peerConnection.addTrack(sendTrack, localStream);
      setupInsertableStreamsForSender(sender, sendTrack);
    });
    applyLocalAudioMuteState();
    if (localVideoEl && localStream.getVideoTracks().length) {
      try {
        // Show processed (blurred) video in local preview so user sees what peer sees
        if (faceBlurPipeline) {
          localVideoEl.srcObject = new MediaStream([faceBlurPipeline.track]);
        } else {
          localVideoEl.srcObject = localStream;
        }
        localVideoEl.muted = true;
        const maybePlay = localVideoEl.play();
        if (maybePlay && typeof maybePlay.catch === 'function') {
          maybePlay.catch(() => {});
        }
      } catch {}
    }
    const hasVideo = localStream.getVideoTracks().length > 0;
    updateCallMedia({ controls: { videoEnabled: hasVideo } });
    hydrateCallCapability({ video: hasVideo, insertableStreams: supportsInsertableStreams() });
  } catch (err) {
    showToast?.(t('callMedia.cannotAccessMic') + (err?.message || err), { variant: 'error' });
    log({ callMediaMicError: err?.message || err });
    failCall('microphone-access-failed', err);
  }
}

async function buildRtcConfiguration() {
  let config = getCallNetworkConfig();
  if (!config) {
    config = await loadCallNetworkConfig();
  }
  if (!config) {
    failCall('call-network-config-missing');
  }
  const baseServers = Array.isArray(config?.ice?.servers)
    ? config.ice.servers
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
        const normalizedUrls = urls
          .map((url) => (typeof url === 'string' ? url.trim() : ''))
          .filter((url) => url.length);
        if (!normalizedUrls.length) return null;
        const server = { urls: normalizedUrls };
        if (entry.username) server.username = entry.username;
        if (entry.credential) server.credential = entry.credential;
        return server;
      })
      .filter(Boolean)
    : [];
  let credentialServers = [];
  try {
    const creds = await issueTurnCredentials({ ttlSeconds: config?.turnTtlSeconds || 300 });
    credentialServers = Array.isArray(creds?.iceServers) ? creds.iceServers : [];
    log({
      callTurnCredentials: 'ok',
      turnServerCount: credentialServers.length,
      turnUrls: credentialServers.map((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).join(',')).join(';'),
      callId: activeCallId
    });
  } catch (err) {
    log({ callTurnCredentialError: err?.message || err, callId: activeCallId });
    // Continue with STUN-only — TURN is preferred but not mandatory
  }
  if (!credentialServers.length) {
    log({ callTurnCredentialWarning: 'no TURN servers available, using STUN-only', callId: activeCallId });
  }
  const iceServers = [...baseServers, ...credentialServers];
  if (!iceServers.length) {
    failCall('ice-servers-missing');
  }
  // Explicitly set standard RTCConfiguration properties.  iOS Safari 26.3+
  // may default to different values if these are omitted.
  //
  // Use 'max-bundle' so all media types (audio + video) share a single
  // ICE transport.  'balanced' can cause video to fail independently when
  // the separate video transport cannot traverse a NAT / firewall that
  // the audio transport successfully negotiated.
  const iceTransportPolicy = config?.ice?.iceTransportPolicy || 'all';
  const bundlePolicy = config?.ice?.bundlePolicy || 'max-bundle';
  return { iceServers, iceTransportPolicy, bundlePolicy, rtcpMuxPolicy: 'require' };
}

/**
 * Log SDP characteristics for debugging call negotiation issues.
 */
function logSdpInfo(label, sdp) {
  if (typeof sdp !== 'string') return;
  try {
    const codecs = [];
    const extmapMixed = /a=extmap-allow-mixed/.test(sdp);
    const rtpmapRegex = /^a=rtpmap:\d+\s+([^\s/]+)/gm;
    let m;
    while ((m = rtpmapRegex.exec(sdp)) !== null) {
      if (!codecs.includes(m[1])) codecs.push(m[1]);
    }
    const setupMatches = sdp.match(/a=setup:(\w+)/g) || [];
    const dtlsSetup = setupMatches.map((s) => s.replace('a=setup:', '')).join(',');
    const fpMatch = sdp.match(/a=fingerprint:(\S+)/);
    const fpAlgo = fpMatch ? fpMatch[1] : 'none';
    const ufragMatch = sdp.match(/a=ice-ufrag:([^\r\n]+)/);
    const iceUfrag = ufragMatch ? ufragMatch[1].trim() : 'none';
    const iceOptions = sdp.match(/a=ice-options:([^\r\n]+)/);
    const rtcpMux = /a=rtcp-mux/.test(sdp);
    const mLines = (sdp.match(/^m=/gm) || []).length;
    const bundleGroup = sdp.match(/a=group:BUNDLE\s+([^\r\n]+)/);
    const midMatches = sdp.match(/a=mid:([^\r\n]+)/g) || [];
    const mids = midMatches.map((m) => m.replace('a=mid:', '')).join(',');
    log({
      sdpDiag: label,
      codecs: codecs.join(','),
      extmapMixed,
      dtlsSetup: dtlsSetup || 'none',
      fpAlgo,
      iceUfrag,
      iceOptions: iceOptions ? iceOptions[1].trim() : 'none',
      rtcpMux,
      mids,
      mLines,
      bundle: bundleGroup ? bundleGroup[1].trim() : 'none',
      sdpLen: sdp.length,
      callId: activeCallId
    });
  } catch { }
}

async function createAndSendOffer() {
  if (!peerConnection) return;
  try {
    const wantVideo = isVideoCall();
    // Use transceiver API instead of deprecated offerToReceiveAudio/Video
    // options which iOS Safari 26.3+ no longer supports.
    ensureReceiveTransceivers(wantVideo);
    const offer = await peerConnection.createOffer();
    logSdpInfo('offer-raw', offer.sdp);
    // setLocalDescription MUST use the ORIGINAL unmodified SDP.
    // Any SDP munging (even removing a=extmap-allow-mixed) breaks
    // iOS Safari 26.3's ICE engine.  Standard SDP offer/answer
    // negotiation handles cross-version compatibility naturally —
    // if the remote peer doesn't support an attribute, it omits it
    // from its answer, and the local browser adapts.
    await peerConnection.setLocalDescription(offer);

    // Wait for ICE gathering to complete so the offer SDP contains
    // ALL candidates.  This avoids reliance on addIceCandidate() which
    // is broken on iOS 26.3 WebKit (silently drops trickled candidates).
    const pc = peerConnection; // capture ref
    await new Promise((resolve) => {
      if (!pc || pc.iceGatheringState === 'complete') { resolve(); return; }
      const onGatheringDone = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', onGatheringDone);
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', onGatheringDone);
      setTimeout(() => {
        pc.removeEventListener('icegatheringstatechange', onGatheringDone);
        resolve();
      }, 6000);
    });

    // Use localDescription (not the raw offer) — it contains all
    // gathered ICE candidates embedded in the SDP.
    const fullOffer = peerConnection.localDescription;
    logSdpInfo('offer-local', fullOffer.sdp);
    awaitingAnswer = true;
    if (!sendSignal) {
      throw new Error('call signal sender missing');
    }
    const targetIdentity = requirePeerIdentitySnapshot();
    activePeerKey = targetIdentity.peerKey;
    const sent = sendSignal('call-offer', {
      callId: activeCallId,
      targetAccountDigest: targetIdentity.digest,
      senderDeviceId: requireLocalDeviceId(),
      targetDeviceId: targetIdentity.deviceId,
      description: fullOffer
    });
    if (!sent) {
      throw new Error('call-offer send failed');
    }
  } catch (err) {
    failCall('create-offer-failed', err);
  }
}

async function applyRemoteOfferAndAnswer(msg) {
  if (!peerConnection || !msg?.description) return;
  try {
    logSdpInfo('remote-offer', msg.description.sdp);
    await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.description));
    await flushPendingRemoteCandidates();
    const answer = await peerConnection.createAnswer();
    logSdpInfo('answer-raw', answer.sdp);
    await peerConnection.setLocalDescription(answer);

    // CRITICAL: Wait for ICE gathering to complete so the answer SDP
    // contains ALL candidates.  iOS 26.3 WebKit has a bug where
    // addIceCandidate() silently drops trickled candidates (they never
    // register in the ICE agent — 0 candidate pairs, 0 remote candidates
    // in getStats()).  By embedding candidates directly in the answer SDP,
    // setRemoteDescription() on the caller side processes them from the
    // SDP parser, completely bypassing addIceCandidate().
    const pc = peerConnection; // capture ref
    await new Promise((resolve) => {
      if (!pc || pc.iceGatheringState === 'complete') { resolve(); return; }
      const onGatheringDone = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', onGatheringDone);
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', onGatheringDone);
      // Safety timeout — don't block forever
      setTimeout(() => {
        pc.removeEventListener('icegatheringstatechange', onGatheringDone);
        resolve();
      }, 6000);
    });

    // Use localDescription (not the original answer variable) because
    // localDescription now contains all gathered ICE candidates in the SDP.
    const fullAnswer = peerConnection.localDescription;
    logSdpInfo('answer-full', fullAnswer.sdp);

    if (!sendSignal) {
      throw new Error('call signal sender missing');
    }
    const targetIdentity = requirePeerIdentitySnapshot();
    activePeerKey = targetIdentity.peerKey;
    const sent = sendSignal('call-answer', {
      callId: activeCallId,
      targetAccountDigest: targetIdentity.digest,
      senderDeviceId: requireLocalDeviceId(),
      targetDeviceId: targetIdentity.deviceId,
      description: fullAnswer
    });
    if (!sent) {
      throw new Error('call-answer send failed');
    }
    // Do NOT promote here — the SDP answer being sent does not mean media
    // is flowing.  Wait for ICE/connection state 'connected' or ontrack
    // events to promote, so the UI accurately reflects actual connectivity.
  } catch (err) {
    failCall('answer-failed', err);
  }
}

async function handleIncomingOffer(msg) {
  if (!activeCallId) {
    activeCallId = msg.callId;
    direction = 'incoming';
  }
  const fromDigest = normalizeAccountDigest(msg.fromAccountDigest || msg.from_account_digest || null);
  const fromDeviceId = normalizePeerDeviceId(msg.fromDeviceId || msg.from_device_id || msg.senderDeviceId || null);
  if (fromDigest && fromDeviceId) {
    try {
      const identity = buildCallPeerIdentity({ peerAccountDigest: fromDigest, peerDeviceId: fromDeviceId });
      activePeerKey = identity.peerKey;
      setCallPeerDeviceId(identity.deviceId, { callId: activeCallId || msg.callId || undefined });
    } catch (err) {
      failCall('peer-device-id-missing', err);
      return;
    }
  } else if (fromDeviceId) {
    try {
      setPeerDeviceId(fromDeviceId);
    } catch (err) {
      failCall('peer-device-id-missing', err);
      return;
    }
  }
  if (awaitingOfferAfterAccept) {
    pendingOffer = msg;
    await applyRemoteOfferAndAnswer(msg);
    awaitingOfferAfterAccept = false;
  } else {
    pendingOffer = msg;
  }
}

async function handleIncomingAnswer(msg) {
  if (!peerConnection) return;
  if (!awaitingAnswer) return;
  if (!msg?.description) return;
  awaitingAnswer = false;
  const fromDigest = normalizeAccountDigest(msg.fromAccountDigest || msg.from_account_digest || null);
  const fromDeviceId = normalizePeerDeviceId(msg.fromDeviceId || msg.from_device_id || msg.senderDeviceId || null);
  if (fromDigest && fromDeviceId) {
    try {
      const identity = buildCallPeerIdentity({ peerAccountDigest: fromDigest, peerDeviceId: fromDeviceId });
      activePeerKey = identity.peerKey;
      setCallPeerDeviceId(identity.deviceId, { callId: activeCallId || msg.callId || undefined });
    } catch (err) {
      failCall('peer-device-id-missing', err);
      return;
    }
  } else if (fromDeviceId) {
    try {
      setPeerDeviceId(fromDeviceId);
    } catch (err) {
      failCall('peer-device-id-missing', err);
      return;
    }
  }
  try {
    logSdpInfo('remote-answer', msg.description.sdp);
    // Do NOT sanitize the incoming answer — setRemoteDescription must
    // receive the answer exactly as the remote peer generated it.
    // Modifying it can break DTLS/SRTP negotiation or ICE.
    await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.description));
    await flushPendingRemoteCandidates();
    // Do NOT promote here — receiving the SDP answer does not mean media
    // is flowing.  Wait for ICE/connection state 'connected' or ontrack
    // events to promote, so the UI accurately reflects actual connectivity.
  } catch (err) {
    if (err?.__callFail) return;
    failCall('remote-answer-failed', err);
  }
}

async function handleIncomingCandidate(msg) {
  if (!peerConnection) return;
  const candidate = msg.candidate;
  if (!candidate) return;
  // Log incoming remote candidate for diagnostics
  const candStr = typeof candidate === 'object' ? (candidate.candidate || '') : String(candidate);
  let remoteType = 'unknown';
  if (candStr.includes(' host ')) remoteType = 'host';
  else if (candStr.includes(' srflx ')) remoteType = 'srflx';
  else if (candStr.includes(' relay ')) remoteType = 'relay';
  else if (candStr.includes(' prflx ')) remoteType = 'prflx';
  if (remoteType === 'host') remoteCandidateStats.host++;
  else if (remoteType === 'srflx') remoteCandidateStats.srflx++;
  else if (remoteType === 'relay') remoteCandidateStats.relay++;
  else if (remoteType === 'prflx') remoteCandidateStats.prflx++;
  remoteCandidateStats.total++;
  // Log candidate details — the first 3 candidates include the full
  // candidate string so we can inspect address family (IPv4/IPv6),
  // ufrag, sdpMid, and relay addresses.
  const candDetail = {
    callRemoteCandidate: remoteType,
    callId: activeCallId,
    queued: !peerConnection.remoteDescription?.type
  };
  if (remoteCandidateStats.total <= 3 && typeof candidate === 'object') {
    candDetail.sdpMid = candidate.sdpMid ?? candidate.sdpMLineIndex;
    candDetail.ufrag = candidate.usernameFragment || undefined;
    candDetail.cand = (candidate.candidate || '').slice(0, 160);
  }
  log(candDetail);
  const fromDigest = normalizeAccountDigest(msg.fromAccountDigest || msg.from_account_digest || null);
  const fromDeviceId = normalizePeerDeviceId(msg.fromDeviceId || msg.from_device_id || msg.senderDeviceId || null);
  if (fromDigest && fromDeviceId) {
    try {
      const identity = buildCallPeerIdentity({ peerAccountDigest: fromDigest, peerDeviceId: fromDeviceId });
      activePeerKey = identity.peerKey;
      setCallPeerDeviceId(identity.deviceId, { callId: activeCallId || msg.callId || undefined });
    } catch (err) {
      failCall('peer-device-id-missing', err);
      return;
    }
  } else if (fromDeviceId) {
    try {
      setPeerDeviceId(fromDeviceId);
    } catch (err) {
      failCall('peer-device-id-missing', err);
      return;
    }
  }
  if (!peerConnection.remoteDescription || !peerConnection.remoteDescription.type) {
    pendingRemoteCandidates.push(candidate);
    return;
  }
  try {
    await addRemoteCandidate(candidate);
  } catch (err) {
    if (err?.__callFail) return;
    failCall('remote-candidate-failed', err);
  }
}

function handleSignal(msg) {
  const signal = normalizeCallSignal(msg);
  if (!signal || signal.callId && activeCallId && signal.callId !== activeCallId) return;
  const type = signal?.type;
  switch (type) {
    case 'call-offer':
      handleIncomingOffer(signal);
      break;
    case 'call-answer':
      handleIncomingAnswer(signal);
      break;
    case 'call-ice-candidate':
      handleIncomingCandidate(signal);
      break;
    default:
      break;
  }
}

function handleSessionState(session) {
  if (!session) return;
  if ([CALL_SESSION_STATUS.ENDED, CALL_SESSION_STATUS.FAILED, CALL_SESSION_STATUS.IDLE].includes(session.status)) {
    cleanupPeerConnection(session.status);
  }
}

function cleanupPeerConnection(reason) {
  // [2nd-call-debug] DELETE WHEN DONE — see whether keyContext is still set when cleanup runs
  console.log('[2nd-call-debug] cleanupPeerConnection', JSON.stringify({
    reason,
    callId: activeCallId,
    keyContextSaltAtCleanup: getCallKeyContext()?.envelope?.cmkSalt || null,
    hadPeerConnection: !!peerConnection
  }));
  if (audioPlayRetryTimer) {
    clearTimeout(audioPlayRetryTimer);
    audioPlayRetryTimer = null;
  }
  if (videoPlayRetryTimer) {
    clearTimeout(videoPlayRetryTimer);
    videoPlayRetryTimer = null;
  }
  if (peerConnection) {
    try { peerConnection.onicecandidate = null; } catch { }
    try { peerConnection.ontrack = null; } catch { }
    try { peerConnection.oniceconnectionstatechange = null; } catch { }
    try { peerConnection.onconnectionstatechange = null; } catch { }
    try { peerConnection.close(); } catch { }
  }
  if (faceBlurPipeline) {
    try { faceBlurPipeline.destroy(); } catch { }
    faceBlurPipeline = null;
  }
  if (localStream) {
    try { localStream.getTracks().forEach((track) => track.stop()); } catch { }
  }
  // Release cached microphone stream to avoid holding the mic open after call ends
  try {
    const cached = sessionStore?.cachedMicrophoneStream;
    if (cached && typeof cached.getTracks === 'function') {
      cached.getTracks().forEach((track) => { try { track.stop(); } catch { } });
    }
    if (sessionStore) sessionStore.cachedMicrophoneStream = null;
  } catch { }
  cleanupScriptTransformWorkers();
  peerConnection = null;
  localStream = null;
  remoteStream = null;
  pendingOffer = null;
  awaitingAnswer = false;
  awaitingOfferAfterAccept = false;
  pendingRemoteCandidates = [];
  activeCallId = null;
  activePeerKey = null;
  remoteCandidateStats = { host: 0, srflx: 0, relay: 0, prflx: 0, total: 0 };
  iceFailureCollecting = false;
  if (remoteAudioEl) {
    try {
      remoteAudioEl.srcObject = null;
      applyRemoteAudioElementStyles(remoteAudioEl);
    } catch { }
  }
  if (remoteVideoEl) {
    try { remoteVideoEl.srcObject = null; } catch { }
  }
  if (localVideoEl) {
    try { localVideoEl.srcObject = null; } catch { }
  }
  e2eeReceiverConfirmed = false;
  peerConnectionEncodedStreams = false;
  // Release the module-level keyContext so the next call (especially on the
  // guest side of ephemeral calls, which does not run initCallKeyManager())
  // starts with a clean slate.  Without this, the next call's
  // setupInsertableStreamsForReceiver/Sender would silently keep using the
  // previous call's cmkSalt-derived keys → AES-GCM decrypt fails →
  // passthrough activates → audible noise.
  //
  // IMPORTANT: this only clears the in-memory call derivation context.  It
  // does NOT touch the conversation token or DR state — that was the
  // PR #23 trap.  See releaseCallKeyContextOnCleanup's doc for context.
  try { releaseCallKeyContextOnCleanup(reason || 'media-cleanup'); } catch { }
  resetControlStates();
  if (reason) {
    log({ callMediaCleanup: reason });
  }
}

function attachRemoteStream(stream) {
  if (!remoteAudioEl) return;
  try {
    // iOS Safari garbles audio when the same MediaStream is shared between
    // an <audio> and a <video> element.  Give the audio element a dedicated
    // stream that contains only audio tracks to avoid the conflict.
    // Skip reassignment when the tracks haven't changed so a pending play()
    // is not interrupted by a redundant load (fixes "play() interrupted by a
    // new load request" on back-to-back ontrack events).
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length) {
      const curSrc = remoteAudioEl.srcObject;
      const curIds = curSrc ? curSrc.getAudioTracks().map((t) => t.id) : [];
      const newIds = audioTracks.map((t) => t.id);
      const changed = curIds.length !== newIds.length
        || newIds.some((id, i) => id !== curIds[i]);
      if (changed) {
        remoteAudioEl.srcObject = new MediaStream(audioTracks);
        remoteAudioEl.style.display = 'block';
        applyRemoteAudioMuteState();
        attemptRemoteAudioPlayback();
      }
    }
  } catch (err) {
    log({ callMediaAttachError: err?.message || err });
  }
  if (remoteVideoEl && stream) {
    try {
      // iOS Safari 26.3 does not automatically activate a video track that
      // was added to an already-attached MediaStream.  Even calling play()
      // on the element is not enough — the video decoder is never started
      // unless srcObject is reassigned.
      //
      // Unlike the <audio> element (where a redundant srcObject assignment
      // interrupts playback and causes audible glitches), reassigning
      // srcObject on a <video> element only causes an invisible re-load,
      // so it is safe to do unconditionally.
      const videoTracks = stream.getVideoTracks();
      const hasLiveVideo = videoTracks.some((t) => t.readyState === 'live');
      if (hasLiveVideo) {
        // Give the video element a video-only stream.  iOS Safari can
        // garble / double-process audio when the same audio track appears
        // in both the <audio> and <video> element's MediaStream (even when
        // the <video> element is muted).  Stripping audio tracks here
        // prevents the conflict entirely — the <audio> element already
        // carries a dedicated audio-only stream.
        const videoOnlyStream = new MediaStream(videoTracks);
        remoteVideoEl.srcObject = videoOnlyStream;
        remoteVideoEl.muted = true;
      } else if (remoteVideoEl.srcObject) {
        // No live video → clear video element
        remoteVideoEl.srcObject = null;
      }
      // Use the same retry mechanism as audio to avoid rapid play() calls
      // aborting each other ("The operation was aborted." on iOS Safari).
      if (hasLiveVideo) attemptRemoteVideoPlayback();
    } catch (err) {
      log({ callMediaVideoAttachError: err?.message || err });
    }
  }
}

let audioPlayRetryTimer = null;

function attemptRemoteAudioPlayback(retryCount = 0) {
  if (audioPlayRetryTimer) {
    clearTimeout(audioPlayRetryTimer);
    audioPlayRetryTimer = null;
  }
  if (!remoteAudioEl || typeof remoteAudioEl.play !== 'function') return;
  try {
    const maybePromise = remoteAudioEl.play();
    if (maybePromise && typeof maybePromise.catch === 'function') {
      maybePromise.catch((err) => {
        log({ callMediaPlayError: err?.message || err, retryCount });
        // iOS Safari may reject play() outside user gesture context.
        // Retry with exponential backoff (200ms, 400ms, 800ms, 1600ms)
        // up to 4 times — media may become playable after ICE connects
        // or the audio context unlocks.
        const MAX_RETRIES = 4;
        if (retryCount < MAX_RETRIES && remoteAudioEl && peerConnection) {
          const delay = 200 * Math.pow(2, retryCount);
          audioPlayRetryTimer = setTimeout(() => {
            audioPlayRetryTimer = null;
            attemptRemoteAudioPlayback(retryCount + 1);
          }, delay);
        }
      });
    }
  } catch (err) {
    log({ callMediaPlayError: err?.message || err });
  }
}

let videoPlayRetryTimer = null;

function attemptRemoteVideoPlayback(retryCount = 0) {
  if (videoPlayRetryTimer) {
    clearTimeout(videoPlayRetryTimer);
    videoPlayRetryTimer = null;
  }
  if (!remoteVideoEl || typeof remoteVideoEl.play !== 'function') return;
  try {
    const maybePromise = remoteVideoEl.play();
    if (maybePromise && typeof maybePromise.catch === 'function') {
      maybePromise.catch((err) => {
        log({ callMediaVideoPlayError: err?.message || err, retryCount });
        // iOS Safari aborts play() when srcObject changes rapidly or the
        // decoder hasn't received data yet.  Retry with exponential backoff
        // (300ms, 600ms, 1200ms, 2400ms) up to 4 times.
        const MAX_RETRIES = 4;
        if (retryCount < MAX_RETRIES && remoteVideoEl && peerConnection) {
          const delay = 300 * Math.pow(2, retryCount);
          videoPlayRetryTimer = setTimeout(() => {
            videoPlayRetryTimer = null;
            attemptRemoteVideoPlayback(retryCount + 1);
          }, delay);
        }
      });
    }
  } catch (err) {
    log({ callMediaVideoPlayError: err?.message || err });
  }
}

function peerSupportsInsertableStreams() {
  // After receiving the peer's key envelope, mediaState.capabilities
  // reflects the peer's advertised capability.  If the peer does not
  // support insertable streams we must not encrypt (they cannot decrypt)
  // and need not decrypt (they did not encrypt).
  //
  // IMPORTANT: require explicit `true` — mediaState.capabilities is
  // initialised from localCapability (resetMediaState) before the
  // peer's envelope overrides it.  Defaulting to `true` when the field
  // is missing or the caps are null would incorrectly assume the peer
  // supports E2EE.
  const caps = getCallMediaState()?.capabilities;
  return caps?.insertableStreams === true;
}

function setupInsertableStreamsForSender(sender, track) {
  if (!supportsInsertableStreams() || !sender || !track) {
    log({ e2eeSenderSkip: 'no-support', kind: track?.kind, callId: activeCallId });
    return;
  }
  // Safari's RTCRtpScriptTransform silently blocks video receiver frames
  // (zero frames reach the worker even though onrtctransform fires).
  // Skip video E2EE on ALL browsers to avoid a mismatch where one side
  // encrypts video that the other side cannot decrypt.  Audio E2EE is
  // unaffected and continues to work normally.
  if (track.kind === 'video') {
    log({ e2eeSenderSkip: 'video-e2ee-disabled', callId: activeCallId });
    return;
  }
  if (!peerSupportsInsertableStreams()) {
    // Peer advertised insertableStreams: false (e.g. ephemeral call where
    // E2EE key exchange failed).  Skip encryption — do NOT fail the call.
    // Unencrypted audio/video will flow normally.
    log({ e2eeSenderSkip: 'peer-not-supported', kind: track?.kind, callId: activeCallId });
    return;
  }
  if (!e2eeReceiverConfirmed) {
    log({ e2eeSenderSkip: 'receiver-not-confirmed', kind: track?.kind, callId: activeCallId });
    return;
  }
  const keyContext = getCallKeyContext();
  if (!keyContext) {
    log({ e2eeSenderSkip: 'no-key-context', kind: track?.kind, callId: activeCallId });
    // Retry shortly — key derivation may complete between ontrack events
    const cid = activeCallId;
    setTimeout(() => {
      if (activeCallId !== cid || !peerConnection) return;
      if (scriptTransformWorkers.has(sender)) return;
      if (getCallKeyContext()) {
        log({ e2eeSenderRetry: true, kind: track?.kind, callId: cid });
        setupInsertableStreamsForSender(sender, track);
      }
    }, 500);
    return;
  }
  const keyName = track.kind === 'video' ? 'videoTx' : 'audioTx';
  // [2nd-call-debug] DELETE WHEN DONE — capture which salt the sender transform is using
  console.log('[2nd-call-debug] setupSender about to apply', JSON.stringify({
    kind: track.kind,
    callId: activeCallId,
    keyContextSalt: keyContext?.envelope?.cmkSalt || null,
    keyContextCallId: keyContext?.callId || null,
    direction: keyContext?.direction || null
  }));
  if (usesScriptTransform()) {
    const ok = applyScriptTransform(sender, keyName, 'encrypt');
    log({ e2eeSenderApplied: ok, keyName, scriptTransform: true, callId: activeCallId });
    return;
  }
  const transform = createEncryptionTransform(keyName, 'encrypt');
  if (!transform) return;
  const ok = applyTransformStream(sender, transform);
  log({ e2eeSenderApplied: ok, keyName, scriptTransform: false, callId: activeCallId });
}

function setupInsertableStreamsForReceiver(receiver, track) {
  // Receiver encoded streams require the encodedInsertableStreams
  // constructor flag.  Without it, createEncodedStreams() throws
  // "Too late" and may leave the receiver in a broken state.
  // (Not required for RTCRtpScriptTransform path.)
  if (!usesScriptTransform() && !peerConnectionEncodedStreams) {
    log({ e2eeReceiverSkip: 'no-script-transform-no-encoded-streams', kind: track?.kind, callId: activeCallId });
    return;
  }
  if (!supportsInsertableStreams() || !receiver || !track) {
    log({ e2eeReceiverSkip: 'no-support', kind: track?.kind, callId: activeCallId });
    return;
  }
  // Safari's RTCRtpScriptTransform silently blocks video receiver frames
  // (zero frames reach the worker).  Skip video E2EE on ALL browsers so
  // neither side encrypts/decrypts video — avoids mismatches.  Audio E2EE
  // continues to function correctly.
  if (track.kind === 'video') {
    log({ e2eeReceiverSkip: 'video-e2ee-disabled', kind: 'video', callId: activeCallId });
    // Still confirm receiver so audio sender transforms can proceed.
    if (!e2eeReceiverConfirmed) {
      e2eeReceiverConfirmed = true;
      log({ e2eeReceiverConfirmed: true, triggeredBy: 'video-skip', callId: activeCallId });
      applySenderTransformsDeferred();
    }
    return;
  }
  if (!peerSupportsInsertableStreams()) {
    // Peer advertised insertableStreams: false (e.g. ephemeral call where
    // E2EE key exchange failed).  Skip decryption — do NOT fail the call.
    // Unencrypted audio/video will flow normally.
    log({ e2eeReceiverSkip: 'peer-not-supported', kind: track?.kind, callId: activeCallId });
    // Still confirm receiver so sender transforms aren't blocked.
    if (!e2eeReceiverConfirmed) {
      e2eeReceiverConfirmed = true;
      log({ e2eeReceiverConfirmed: true, triggeredBy: 'peer-not-supported', callId: activeCallId });
      applySenderTransformsDeferred();
    }
    return;
  }
  const keyContext = getCallKeyContext();
  if (!keyContext) {
    log({ e2eeReceiverSkip: 'no-key-context', kind: track?.kind, callId: activeCallId });
    // Schedule a retry — keyContext may arrive shortly after ontrack.
    // The onKeyContextUpdate callback is the primary fallback, but if it
    // fired between the video and audio ontrack events, this receiver
    // would be missed.  A brief delay covers that gap.
    const cid = activeCallId;
    setTimeout(() => {
      if (activeCallId !== cid || !peerConnection) return;
      if (scriptTransformWorkers.has(receiver)) return;
      if (getCallKeyContext()) {
        log({ e2eeReceiverRetry: true, kind: track?.kind, callId: cid });
        setupInsertableStreamsForReceiver(receiver, track);
      }
    }, 500);
    return;
  }
  const keyName = track.kind === 'video' ? 'videoRx' : 'audioRx';
  // [2nd-call-debug] DELETE WHEN DONE — capture which salt the receiver transform is using
  console.log('[2nd-call-debug] setupReceiver about to apply', JSON.stringify({
    kind: track.kind,
    callId: activeCallId,
    keyContextSalt: keyContext?.envelope?.cmkSalt || null,
    keyContextCallId: keyContext?.callId || null,
    direction: keyContext?.direction || null
  }));
  let applied = false;
  if (usesScriptTransform()) {
    applied = applyScriptTransform(receiver, keyName, 'decrypt');
    log({ e2eeReceiverApplied: applied, keyName, scriptTransform: true, callId: activeCallId });
  } else {
    const transform = createEncryptionTransform(keyName, 'decrypt');
    if (!transform) return;
    applied = applyTransformStream(receiver, transform);
    log({ e2eeReceiverApplied: applied, keyName, scriptTransform: false, callId: activeCallId });
  }
  if (applied && !e2eeReceiverConfirmed) {
    e2eeReceiverConfirmed = true;
    log({ e2eeReceiverConfirmed: true, triggeredBy: keyName, callId: activeCallId });
  }
  // Always retry sender transforms after a receiver is applied — in video
  // calls the first applySenderTransformsDeferred (triggered by video ontrack)
  // may have skipped audio because keyContext wasn't ready yet.  When the
  // audio receiver is applied later, we must retry so the audio sender
  // encrypt transform is applied.
  if (applied) {
    applySenderTransformsDeferred();
  }
  // After setting up a video receiver transform, request a keyframe from the
  // peer.  The initial keyframe may have arrived before the transform was
  // ready, leaving the video decoder unable to start rendering.  A brief
  // delay gives the transform pipeline time to initialise before the
  // keyframe request triggers a new I-frame from the sender.
  if (applied && track.kind === 'video') {
    requestKeyFrameFromPeer();
  }
}

function applySenderTransformsDeferred() {
  if (!peerConnection) return;
  for (const sender of peerConnection.getSenders()) {
    if (!sender.track) continue;
    // Skip senders that already have a ScriptTransform worker —
    // re-applying would create a duplicate worker + reset the frame
    // counter, risking a brief burst of noise.
    if (scriptTransformWorkers.has(sender)) continue;
    setupInsertableStreamsForSender(sender, sender.track);
  }
}

/**
 * Retroactively apply receiver + sender transforms when keyContext arrives
 * after ontrack already fired.  Without this, the receiver transform is
 * never set up (ontrack checked keyContext → null → skipped), and later
 * when keys are derived, only rekeyScriptTransformWorkers runs but there
 * are no workers to update.  This causes one side to encrypt audio while
 * the other can't decrypt — resulting in noise or silence.
 */
function applyDeferredTransforms() {
  if (!peerConnection || !peerSupportsInsertableStreams()) return;
  const ctx = getCallKeyContext();
  if (!ctx) return;
  // Apply receiver transforms for tracks that were skipped
  for (const receiver of peerConnection.getReceivers()) {
    if (!receiver.track) continue;
    // Skip if this receiver already has a worker (transform already applied)
    if (scriptTransformWorkers.has(receiver)) continue;
    setupInsertableStreamsForReceiver(receiver, receiver.track);
  }
  // Sender transforms may also need applying if receiver was just confirmed
  applySenderTransformsDeferred();
}

/**
 * Request a keyframe after the video receiver transform is set up.
 * Uses RTCRtpSender.generateKeyFrame() on the local VIDEO sender so the
 * remote peer's receiver gets a clean I-frame.  Also triggers a deferred
 * video play() retry via attemptRemoteVideoPlayback so the local decoder
 * picks up the first decrypted keyframe.
 */
function requestKeyFrameFromPeer() {
  if (!peerConnection) return;
  // Generate a local keyframe so the remote peer gets a clean I-frame.
  try {
    for (const sender of peerConnection.getSenders()) {
      if (sender.track?.kind === 'video' && typeof sender.generateKeyFrame === 'function') {
        sender.generateKeyFrame().catch(() => {});
      }
    }
  } catch { }
  // Retry video play after a delay — the decoder may now have valid data.
  setTimeout(() => {
    if (!peerConnection) return;
    attemptRemoteVideoPlayback();
    // Second keyframe request in case the first was too early.
    try {
      for (const sender of peerConnection.getSenders()) {
        if (sender.track?.kind === 'video' && typeof sender.generateKeyFrame === 'function') {
          sender.generateKeyFrame().catch(() => {});
        }
      }
    } catch { }
  }, 500);
}

function createEncryptionTransform(keyName, mode) {
  const context = getCallKeyContext();
  const keyEntry = context?.keys?.[keyName];
  if (!keyEntry?.key || !keyEntry?.nonce) return null;
  const usages = mode === 'encrypt' ? ['encrypt'] : ['decrypt'];
  // Track current epoch so we re-import when keys rotate
  let currentEpoch = context?.epoch ?? 0;
  let cryptoKey = null;
  let baseNonce = new Uint8Array(keyEntry.nonce);
  const importPromise = crypto.subtle.importKey(
    'raw',
    toU8Strict(keyEntry.key, 'web/src/app/features/calls/media-session.js:519:createEncryptionTransform'),
    { name: 'AES-GCM' },
    false,
    usages
  )
    .then((key) => {
      cryptoKey = key;
      return key;
    });
  let rekeyPromise = null;
  let _frameCount = 0;
  let _failCount = 0;
  let _passthrough = false; // fallback: stop decrypting after too many failures
  const transform = new TransformStream({
    async transform(encodedFrame, controller) {
      if (!cryptoKey) {
        try { await importPromise; } catch { controller.enqueue(encodedFrame); return; }
      }
      // Check if epoch has changed (key rotation occurred)
      const latestCtx = getCallKeyContext();
      const latestEpoch = latestCtx?.epoch ?? 0;
      if (latestEpoch !== currentEpoch && latestCtx?.keys?.[keyName]?.key) {
        if (!rekeyPromise) {
          rekeyPromise = crypto.subtle.importKey(
            'raw',
            toU8Strict(latestCtx.keys[keyName].key, 'media-session:rekey'),
            { name: 'AES-GCM' },
            false,
            usages
          ).then((key) => {
            cryptoKey = key;
            baseNonce = new Uint8Array(latestCtx.keys[keyName].nonce);
            currentEpoch = latestEpoch;
            rekeyPromise = null;
            _failCount = 0;
            _passthrough = false;
          });
        }
        try { await rekeyPromise; } catch { /* ignore */ }
      }
      _frameCount++;
      // Diagnostic: log first frame + every 200th frame
      if (_frameCount === 1 || _frameCount % 200 === 0) {
        logCapped({ e2eeFrame: { mode, keyName, frame: _frameCount, fails: _failCount, passthrough: _passthrough, hasKey: !!cryptoKey, byteLen: encodedFrame.data?.byteLength } });
      }
      // Passthrough mode: too many consecutive decrypt failures → peer likely
      // not encrypting.  Stop corrupting frames by attempting invalid decryption.
      if (_passthrough) {
        controller.enqueue(encodedFrame);
        return;
      }
      try {
        if (mode === 'encrypt') {
          const counter = incrementFrameCounter(keyName);
          const iv = buildNonce(baseNonce, counter);
          const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encodedFrame.data);
          const counterBytes = new Uint8Array(4);
          new DataView(counterBytes.buffer).setUint32(0, counter, false);
          const combined = new Uint8Array(4 + encrypted.byteLength);
          combined.set(counterBytes, 0);
          combined.set(new Uint8Array(encrypted), 4);
          encodedFrame.data = combined.buffer;
        } else {
          const data = new Uint8Array(encodedFrame.data);
          if (data.byteLength < 5) { controller.enqueue(encodedFrame); return; }
          const counter = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, false);
          const iv = buildNonce(baseNonce, counter);
          const ciphertext = data.slice(4);
          const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext);
          encodedFrame.data = decrypted;
          _failCount = 0; // reset on success
        }
        controller.enqueue(encodedFrame);
      } catch (err) {
        _failCount++;
        if (_failCount <= 3 || _failCount % 100 === 0) {
          log({ callMediaTransformError: err?.message || err, mode, keyName, frame: _frameCount, consecutiveFails: _failCount });
        }
        // After 50 consecutive decrypt failures, assume E2EE mismatch —
        // switch to passthrough so audio is at least audible (unencrypted).
        if (mode === 'decrypt' && _failCount >= 50) {
          _passthrough = true;
          log({ e2eePassthroughActivated: true, keyName, frame: _frameCount, reason: 'consecutive-decrypt-failures' });
        }
        controller.enqueue(encodedFrame);
      }
    }
  });
  return transform;
}

function applyTransformStream(target, transformStream) {
  try {
    if (typeof target.createEncodedStreams === 'function') {
      const { readable, writable } = target.createEncodedStreams();
      readable.pipeThrough(transformStream).pipeTo(writable).catch((err) => {
        log({ callMediaPipeError: err?.message || err });
      });
      return true;
    } else if (typeof target.createEncodedVideoStreams === 'function') {
      const { readable, writable } = target.createEncodedVideoStreams();
      readable.pipeThrough(transformStream).pipeTo(writable).catch((err) => {
        log({ callMediaPipeError: err?.message || err });
      });
      return true;
    } else if (typeof target.createEncodedAudioStreams === 'function') {
      const { readable, writable } = target.createEncodedAudioStreams();
      readable.pipeThrough(transformStream).pipeTo(writable).catch((err) => {
        log({ callMediaPipeError: err?.message || err });
      });
      return true;
    }
  } catch (err) {
    log({ callMediaTransformUnsupported: err?.message || err });
  }
  return false;
}

// --- RTCRtpScriptTransform support (Safari 15.4+, Chrome 118+) ---

const SCRIPT_TRANSFORM_WORKER_CODE = `
let cryptoKey = null;
let baseNonce = null;
let frameCounter = 0;
let mode = 'encrypt';
let importPromise = null;
let _fc = 0;
let _fails = 0;
let _passthrough = false;

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type === 'key') {
    mode = msg.mode || mode;
    const usages = mode === 'encrypt' ? ['encrypt'] : ['decrypt'];
    baseNonce = new Uint8Array(msg.nonce);
    if (msg.resetCounter) frameCounter = 0;
    _fails = 0;
    _passthrough = false;
    try {
      importPromise = crypto.subtle.importKey(
        'raw', new Uint8Array(msg.key), { name: 'AES-GCM' }, false, usages
      ).then(k => { cryptoKey = k; });
      await importPromise;
    } catch (err) {
      console.error('[e2ee-worker] key import failed', err?.message || err);
    }
  }
};

self.onrtctransform = (event) => {
  const { readable, writable } = event.transformer;
  const ts = new TransformStream({
    async transform(frame, controller) {
      if (!cryptoKey) {
        if (importPromise) { try { await importPromise; } catch {} }
        if (!cryptoKey) { controller.enqueue(frame); return; }
      }
      _fc++;
      if (_passthrough) { controller.enqueue(frame); return; }
      try {
        if (mode === 'encrypt') {
          frameCounter++;
          const iv = new Uint8Array(baseNonce);
          new DataView(iv.buffer).setUint32(iv.length - 4, frameCounter, false);
          const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, frame.data);
          const counterBytes = new Uint8Array(4);
          new DataView(counterBytes.buffer).setUint32(0, frameCounter, false);
          const combined = new Uint8Array(4 + encrypted.byteLength);
          combined.set(counterBytes, 0);
          combined.set(new Uint8Array(encrypted), 4);
          frame.data = combined.buffer;
        } else {
          const data = new Uint8Array(frame.data);
          if (data.byteLength < 5) { controller.enqueue(frame); return; }
          const counter = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, false);
          const iv = new Uint8Array(baseNonce);
          new DataView(iv.buffer).setUint32(iv.length - 4, counter, false);
          const ciphertext = data.slice(4);
          const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext);
          frame.data = decrypted;
          _fails = 0;
        }
        controller.enqueue(frame);
      } catch (err) {
        _fails++;
        if (_fails <= 3) console.warn('[e2ee-worker]', mode, 'fail #' + _fails, err?.message);
        if (mode === 'decrypt' && _fails >= 50) {
          _passthrough = true;
          console.warn('[e2ee-worker] passthrough activated after', _fails, 'consecutive decrypt failures');
        }
        controller.enqueue(frame);
      }
    }
  });
  readable.pipeThrough(ts).pipeTo(writable).catch(() => {});
};
`;

let scriptTransformWorkerUrl = null;

function getScriptTransformWorkerUrl() {
  if (!scriptTransformWorkerUrl) {
    const blob = new Blob([SCRIPT_TRANSFORM_WORKER_CODE], { type: 'text/javascript' });
    scriptTransformWorkerUrl = URL.createObjectURL(blob);
  }
  return scriptTransformWorkerUrl;
}

function applyScriptTransform(target, keyName, mode) {
  try {
    const context = getCallKeyContext();
    const keyEntry = context?.keys?.[keyName];
    if (!keyEntry?.key || !keyEntry?.nonce) return false;
    const worker = new Worker(getScriptTransformWorkerUrl());
    // Send initial key material
    const keyBuf = toU8Strict(keyEntry.key, 'media-session:scriptTransform:key');
    const nonceBuf = new Uint8Array(keyEntry.nonce);
    worker.postMessage({
      type: 'key',
      mode,
      keyName,
      key: keyBuf.buffer,
      nonce: nonceBuf.buffer,
      resetCounter: true
    }, [keyBuf.buffer.slice(0), nonceBuf.buffer.slice(0)]);
    target.transform = new RTCRtpScriptTransform(worker, { operation: mode, keyName });
    scriptTransformWorkers.set(target, worker);
    return true;
  } catch (err) {
    log({ callScriptTransformError: err?.message || err, keyName, mode });
    return false;
  }
}

/** Send updated keys to all active ScriptTransform workers (key rotation). */
function rekeyScriptTransformWorkers() {
  const context = getCallKeyContext();
  if (!context) return;
  for (const [target, worker] of scriptTransformWorkers) {
    // Determine keyName from the transform options set during creation
    const isReceiver = target instanceof RTCRtpReceiver;
    const track = target.track;
    const kind = track?.kind || 'audio';
    const keyName = isReceiver
      ? (kind === 'video' ? 'videoRx' : 'audioRx')
      : (kind === 'video' ? 'videoTx' : 'audioTx');
    const entry = context.keys?.[keyName];
    if (!entry?.key || !entry?.nonce) continue;
    try {
      const keyBuf = toU8Strict(entry.key, 'media-session:scriptTransform:rekey');
      const nonceBuf = new Uint8Array(entry.nonce);
      worker.postMessage({
        type: 'key',
        key: keyBuf.buffer,
        nonce: nonceBuf.buffer,
        resetCounter: false
      }, [keyBuf.buffer.slice(0), nonceBuf.buffer.slice(0)]);
    } catch (err) {
      log({ callScriptTransformRekeyError: err?.message || err, keyName });
    }
  }
}

function cleanupScriptTransformWorkers() {
  for (const [, worker] of scriptTransformWorkers) {
    try { worker.terminate(); } catch {}
  }
  scriptTransformWorkers = new Map();
}

function incrementFrameCounter(keyName) {
  const mediaState = getCallMediaState();
  const current = mediaState?.frameCounters?.[keyName] ?? 0;
  const next = current + 1;
  updateCallMedia({
    frameCounters: {
      [keyName]: next
    }
  });
  return next;
}

function buildNonce(baseNonce, counter) {
  const nonce = new Uint8Array(baseNonce);
  const view = new DataView(nonce.buffer);
  view.setUint32(nonce.length - 4, counter, false);
  return nonce;
}

function applyLocalAudioMuteState() {
  if (localStream) {
    try {
      localStream.getAudioTracks().forEach((track) => {
        track.enabled = !localAudioMuted;
      });
    } catch { }
  }
  updateCallMedia({
    controls: {
      audioMuted: localAudioMuted
    }
  });
}

function applyLocalVideoMuteState() {
  if (localStream) {
    try {
      localStream.getVideoTracks().forEach((track) => {
        track.enabled = !localVideoMuted;
      });
    } catch {}
  }
  updateCallMedia({
    controls: {
      videoMuted: localVideoMuted
    }
  });
}

function applyRemoteAudioMuteState() {
  if (remoteAudioEl) {
    try {
      remoteAudioEl.muted = !!remoteAudioMuted;
      if (remoteAudioMuted) {
        remoteAudioEl.setAttribute('muted', 'true');
      } else {
        remoteAudioEl.removeAttribute('muted');
        attemptRemoteAudioPlayback();
      }
    } catch { }
  }
  updateCallMedia({
    controls: {
      remoteMuted: remoteAudioMuted
    }
  });
}

export function setFaceBlurMode(mode) {
  faceBlurMode = (mode === BLUR_MODE.BACKGROUND || mode === BLUR_MODE.OFF) ? mode : BLUR_MODE.FACE;
  if (faceBlurPipeline) {
    faceBlurPipeline.setMode(faceBlurMode);
  }
}

export function getFaceBlurMode() {
  return faceBlurMode;
}

/** @deprecated Use setFaceBlurMode() instead */
export function setFaceBlurEnabled(val) {
  setFaceBlurMode(val ? BLUR_MODE.FACE : BLUR_MODE.OFF);
}

export function isFaceBlurEnabled() {
  return faceBlurMode !== BLUR_MODE.OFF;
}

export function isFaceBlurActive() {
  return !!faceBlurPipeline;
}

function resetControlStates() {
  const hadLocalMute = localAudioMuted;
  const hadRemoteMute = remoteAudioMuted;
  const hadVideoMute = localVideoMuted;
  localAudioMuted = false;
  remoteAudioMuted = false;
  localVideoMuted = false;
  faceBlurMode = BLUR_MODE.FACE;
  cameraFacing = 'user';
  if (hadLocalMute) {
    applyLocalAudioMuteState();
  }
  if (hadRemoteMute) {
    applyRemoteAudioMuteState();
  }
  if (hadVideoMute) {
    applyLocalVideoMuteState();
  }
}
