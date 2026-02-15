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
import { normalizeAccountDigest, normalizePeerDeviceId, ensureDeviceId, getAccountDigest } from '../../core/store.js';
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
    await peerConnection.addIceCandidate(candidate);
  } catch (err) {
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

export function setRemoteVideoElement(el) {
  remoteVideoEl = el || null;
  if (remoteVideoEl && remoteStream) {
    try {
      remoteVideoEl.srcObject = remoteStream;
      const maybePlay = remoteVideoEl.play();
      if (maybePlay && typeof maybePlay.catch === 'function') {
        maybePlay.catch(() => {});
      }
    } catch {}
  }
}

export function setLocalVideoElement(el) {
  localVideoEl = el || null;
  if (localVideoEl && localStream) {
    try {
      localVideoEl.srcObject = localStream;
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
      if (videoSender) {
        await videoSender.replaceTrack(newTrack);
      } else {
        const sender = peerConnection.addTrack(newTrack, localStream);
        setupInsertableStreamsForSender(sender, newTrack);
      }
      localStream.getVideoTracks().forEach((t) => {
        try { t.stop(); } catch {}
        localStream.removeTrack(t);
      });
      localStream.addTrack(newTrack);
      localVideoMuted = false;
      if (localVideoEl) {
        localVideoEl.srcObject = localStream;
        try { localVideoEl.play(); } catch {}
      }
      updateCallMedia({ controls: { videoEnabled: true, videoMuted: false } });
    } catch (err) {
      log({ callToggleVideoError: err?.message || err });
      showToast?.('無法啟動攝影機', { variant: 'error' });
    }
  } else {
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
    const videoSender = peerConnection.getSenders().find((s) => s.track?.kind === 'video');
    if (videoSender) {
      await videoSender.replaceTrack(newTrack);
      setupInsertableStreamsForSender(videoSender, newTrack);
    }
    localStream.getVideoTracks().forEach((t) => {
      try { t.stop(); } catch {}
      localStream.removeTrack(t);
    });
    localStream.addTrack(newTrack);
    cameraFacing = nextFacing;
    if (localVideoEl) {
      localVideoEl.srcObject = localStream;
      try { localVideoEl.play(); } catch {}
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
  peerConnection = new RTCPeerConnection(rtcConfig);
  peerConnection.onicecandidate = (event) => {
    try {
      if (!event.candidate || !sendSignal || !activeCallId) return;
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
  peerConnection.ontrack = (event) => {
    remoteStream = event.streams[0] || new MediaStream([event.track]);
    attachRemoteStream(remoteStream);
    setupInsertableStreamsForReceiver(event.receiver, event.track);
    promoteSessionToInCall('remote-track');
  };
  peerConnection.oniceconnectionstatechange = () => {
    const iceState = peerConnection.iceConnectionState;
    if (iceState === 'connected' || iceState === 'completed') {
      promoteSessionToInCall('ice-state');
    } else if (iceState === 'failed') {
      showToast?.('通話連線失敗', { variant: 'error' });
      completeCallSession({ reason: iceState });
      cleanupPeerConnection(iceState);
    }
  };
  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    if (state === 'connected' || state === 'completed') {
      promoteSessionToInCall('connection-state');
      return;
    }
    if (state === 'failed' || state === 'disconnected') {
      showToast?.('通話連線中斷', { variant: 'warning' });
      completeCallSession({ reason: state });
      cleanupPeerConnection(state);
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
    const cached = getCachedMicrophoneStream();
    if (cached) {
      const tracks = cloneLiveAudioTracks(cached);
      if (tracks.length) {
        localStream = new MediaStream(tracks);
      }
    }
    if (!localStream) {
      const wantVideo = isVideoCall();
      const videoConstraints = wantVideo
        ? { facingMode: cameraFacing, width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 30 } }
        : false;
      let freshStream;
      try {
        freshStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: videoConstraints });
      } catch (mediaErr) {
        if (wantVideo) {
          log({ callMediaCameraFallback: mediaErr?.message || mediaErr });
          showToast?.('無法存取攝影機，改為語音通話', { variant: 'warning' });
          freshStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
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
    localStream.getTracks().forEach((track) => {
      const sender = peerConnection.addTrack(track, localStream);
      setupInsertableStreamsForSender(sender, track);
    });
    applyLocalAudioMuteState();
    if (localVideoEl && localStream.getVideoTracks().length) {
      try {
        localVideoEl.srcObject = localStream;
        localVideoEl.muted = true;
        const maybePlay = localVideoEl.play();
        if (maybePlay && typeof maybePlay.catch === 'function') {
          maybePlay.catch(() => {});
        }
      } catch {}
    }
    const hasVideo = localStream.getVideoTracks().length > 0;
    updateCallMedia({ controls: { videoEnabled: hasVideo } });
    hydrateCallCapability({ video: hasVideo });
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
  } catch (err) {
    log({ callTurnCredentialError: err?.message || err });
    // Continue with STUN-only — TURN is preferred but not mandatory
  }
  if (!credentialServers.length) {
    log({ callTurnCredentialWarning: 'no TURN servers available, using STUN-only' });
  }
  const iceServers = [...baseServers, ...credentialServers];
  if (!iceServers.length) {
    failCall('ice-servers-missing');
  }
  return { iceServers };
}

async function createAndSendOffer() {
  if (!peerConnection) return;
  try {
    const wantVideo = isVideoCall();
    const offer = await peerConnection.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: wantVideo });
    await peerConnection.setLocalDescription(offer);
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
      description: { sdp: offer.sdp, type: offer.type }
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
    await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.description));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
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
      description: { sdp: answer.sdp, type: answer.type }
    });
    if (!sent) {
      throw new Error('call-answer send failed');
    }
    promoteSessionToInCall('answer-sent');
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
    await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.description));
    await flushPendingRemoteCandidates();
    promoteSessionToInCall('answer-received');
  } catch (err) {
    if (err?.__callFail) return;
    failCall('remote-answer-failed', err);
  }
}

async function handleIncomingCandidate(msg) {
  if (!peerConnection) return;
  const candidate = msg.candidate;
  if (!candidate) return;
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
  if (peerConnection) {
    try { peerConnection.onicecandidate = null; } catch { }
    try { peerConnection.ontrack = null; } catch { }
    try { peerConnection.oniceconnectionstatechange = null; } catch { }
    try { peerConnection.onconnectionstatechange = null; } catch { }
    try { peerConnection.close(); } catch { }
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
  resetControlStates();
  if (reason) {
    log({ callMediaCleanup: reason });
  }
}

function attachRemoteStream(stream) {
  if (!remoteAudioEl) return;
  try {
    remoteAudioEl.srcObject = stream;
    remoteAudioEl.style.display = 'block';
    applyRemoteAudioMuteState();
    attemptRemoteAudioPlayback();
  } catch (err) {
    log({ callMediaAttachError: err?.message || err });
  }
  if (remoteVideoEl && stream) {
    try {
      remoteVideoEl.srcObject = stream;
      const maybePlay = remoteVideoEl.play();
      if (maybePlay && typeof maybePlay.catch === 'function') {
        maybePlay.catch((err) => log({ callMediaVideoPlayError: err?.message || err }));
      }
    } catch (err) {
      log({ callMediaVideoAttachError: err?.message || err });
    }
  }
}

function attemptRemoteAudioPlayback() {
  if (!remoteAudioEl || typeof remoteAudioEl.play !== 'function') return;
  try {
    const maybePromise = remoteAudioEl.play();
    if (maybePromise && typeof maybePromise.catch === 'function') {
      maybePromise.catch((err) => log({ callMediaPlayError: err?.message || err }));
    }
  } catch (err) {
    log({ callMediaPlayError: err?.message || err });
  }
}

function setupInsertableStreamsForSender(sender, track) {
  if (!supportsInsertableStreams() || !sender || !track) return;
  const keyContext = getCallKeyContext();
  if (!keyContext) return;
  const keyName = track.kind === 'video' ? 'videoTx' : 'audioTx';
  const transform = createEncryptionTransform(keyName, 'encrypt');
  if (!transform) return;
  applyTransformStream(sender, transform);
}

function setupInsertableStreamsForReceiver(receiver, track) {
  if (!supportsInsertableStreams() || !receiver || !track) return;
  const keyContext = getCallKeyContext();
  if (!keyContext) return;
  const keyName = track.kind === 'video' ? 'videoRx' : 'audioRx';
  const transform = createEncryptionTransform(keyName, 'decrypt');
  if (!transform) return;
  applyTransformStream(receiver, transform);
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
    } else if (typeof target.createEncodedVideoStreams === 'function') {
      const { readable, writable } = target.createEncodedVideoStreams();
      readable.pipeThrough(transformStream).pipeTo(writable).catch((err) => {
        log({ callMediaPipeError: err?.message || err });
      });
    } else if (typeof target.createEncodedAudioStreams === 'function') {
      const { readable, writable } = target.createEncodedAudioStreams();
      readable.pipeThrough(transformStream).pipeTo(writable).catch((err) => {
        log({ callMediaPipeError: err?.message || err });
      });
    }
  } catch (err) {
    log({ callMediaTransformUnsupported: err?.message || err });
  }
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

function resetControlStates() {
  const hadLocalMute = localAudioMuted;
  const hadRemoteMute = remoteAudioMuted;
  const hadVideoMute = localVideoMuted;
  localAudioMuted = false;
  remoteAudioMuted = false;
  localVideoMuted = false;
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
