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
  supportsInsertableStreams
} from './key-manager.js';
import { CALL_EVENT, subscribeCallEvent } from './events.js';
import { createFaceBlurPipeline, isFaceBlurSupported, BLUR_MODE } from './face-blur.js';
import { normalizeAccountDigest, normalizePeerDeviceId, ensureDeviceId, getAccountDigest } from '../../core/store.js';
import { getCallAudioConstraints } from '../../ui/mobile/browser-detection.js';
import { toU8Strict } from '/shared/utils/u8-strict.js';
import { buildCallPeerIdentity } from './identity.js';

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
    subscribeCallEvent(CALL_EVENT.STATE, ({ session }) => handleSessionState(session))
  ];
}

export function disposeCallMediaSession() {
  for (const off of unsubscribers.splice(0)) {
    try { off?.(); } catch { }
  }
  cleanupPeerConnection('dispose');
}

export async function startOutgoingCallMedia({ callId } = {}) {
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
  activeCallId = callId;
  const identity = requirePeerIdentitySnapshot();
  activePeerKey = identity.peerKey;
  direction = 'incoming';
  awaitingOfferAfterAccept = true;
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
      showToast?.('無法啟動攝影機', { variant: 'error' });
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
    showToast?.('無法切換攝影機', { variant: 'error' });
  }
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

  // NOTE: We intentionally do NOT set encodedInsertableStreams: true
  // here because the peer might not support E2EE (e.g. iOS Safari)
  // and we cannot reliably determine the peer's capability before
  // creating the connection (the callee never sends its capabilities
  // back to the caller).  Without the constructor flag, receiver
  // createEncodedStreams() would throw "Too late"; the guard in
  // setupInsertableStreamsForReceiver prevents the call entirely.
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
    attachRemoteStream(remoteStream);
    setupInsertableStreamsForReceiver(event.receiver, event.track);
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
      showToast?.('通話連線失敗', { variant: 'error' });
      completeCallSession({ reason: iceState, error: 'ice-connection-failed' });
      cleanupPeerConnection(iceState);
    } else if (iceState === 'disconnected') {
      log({ callIceDisconnected: true, callId: activeCallId });
      showToast?.('通話連線不穩定', { variant: 'warning' });
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
      showToast?.('通話連線中斷', { variant: 'error' });
      completeCallSession({ reason: state, error: 'peer-connection-failed' });
      cleanupPeerConnection(state);
    } else if (state === 'disconnected') {
      log({ callConnectionDisconnected: true, callId: activeCallId });
      showToast?.('通話連線不穩定', { variant: 'warning' });
    } else if (state === 'closed') {
      cleanupPeerConnection(state);
    }
  };
  await attachLocalMedia();
  return peerConnection;
}

async function attachLocalMedia() {
  if (localStream && localStream.getTracks().length) {
    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
    });
    return;
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
          showToast?.('無法存取攝影機，改為語音通話', { variant: 'warning' });
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
    showToast?.('無法存取麥克風：' + (err?.message || err), { variant: 'error' });
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
  if (audioPlayRetryTimer) {
    clearTimeout(audioPlayRetryTimer);
    audioPlayRetryTimer = null;
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
      const hasLiveVideo = stream.getVideoTracks().some((t) => t.readyState === 'live');
      if (hasLiveVideo || remoteVideoEl.srcObject !== stream) {
        remoteVideoEl.srcObject = stream;
        remoteVideoEl.muted = true;
      }
      // Always call play() as a secondary measure for browsers that do
      // pick up new tracks but need an explicit play() to start rendering.
      const maybePlay = remoteVideoEl.play();
      if (maybePlay && typeof maybePlay.catch === 'function') {
        maybePlay.catch((err) => log({ callMediaVideoPlayError: err?.message || err }));
      }
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
  if (!supportsInsertableStreams() || !sender || !track) return;
  if (!peerSupportsInsertableStreams()) return;
  // Never encrypt until we've confirmed receiver transforms work.
  // Without this gate the caller encrypts outgoing data in
  // attachLocalMedia (key context is already set by
  // prepareCallKeyEnvelope), but the receiver side fails with
  // "Too late to create encoded streams" — the peer then receives
  // encrypted frames it cannot decrypt, causing noise / no video.
  if (!e2eeReceiverConfirmed) return;
  const keyContext = getCallKeyContext();
  if (!keyContext) return;
  const keyName = track.kind === 'video' ? 'videoTx' : 'audioTx';
  const transform = createEncryptionTransform(keyName, 'encrypt');
  if (!transform) return;
  applyTransformStream(sender, transform);
}

function setupInsertableStreamsForReceiver(receiver, track) {
  // Receiver encoded streams require the encodedInsertableStreams
  // constructor flag.  Without it, createEncodedStreams() throws
  // "Too late" and may leave the receiver in a broken state.
  if (!peerConnectionEncodedStreams) return;
  if (!supportsInsertableStreams() || !receiver || !track) return;
  if (!peerSupportsInsertableStreams()) return;
  const keyContext = getCallKeyContext();
  if (!keyContext) return;
  const keyName = track.kind === 'video' ? 'videoRx' : 'audioRx';
  const transform = createEncryptionTransform(keyName, 'decrypt');
  if (!transform) return;
  if (applyTransformStream(receiver, transform)) {
    if (!e2eeReceiverConfirmed) {
      e2eeReceiverConfirmed = true;
      // Receiver confirmed — now apply sender transforms for existing tracks.
      applySenderTransformsDeferred();
    }
  }
}

function applySenderTransformsDeferred() {
  if (!peerConnection) return;
  for (const sender of peerConnection.getSenders()) {
    if (sender.track) {
      setupInsertableStreamsForSender(sender, sender.track);
    }
  }
}

function createEncryptionTransform(keyName, mode) {
  const context = getCallKeyContext();
  const keyEntry = context?.keys?.[keyName];
  if (!keyEntry?.key || !keyEntry?.nonce) return null;
  const baseNonce = new Uint8Array(keyEntry.nonce);
  let cryptoKey = null;
  const usages = mode === 'encrypt' ? ['encrypt'] : ['decrypt'];
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
  const transform = new TransformStream({
    async transform(encodedFrame, controller) {
      if (!cryptoKey) {
        await importPromise;
      }
      try {
        const counter = incrementFrameCounter(keyName);
        const iv = buildNonce(baseNonce, counter);
        const op = mode === 'encrypt' ? 'encrypt' : 'decrypt';
        const result = await crypto.subtle[op]({ name: 'AES-GCM', iv }, cryptoKey, encodedFrame.data);
        encodedFrame.data = result instanceof ArrayBuffer ? result : encodedFrame.data;
        controller.enqueue(encodedFrame);
      } catch (err) {
        log({ callMediaTransformError: err?.message || err, mode, keyName });
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
