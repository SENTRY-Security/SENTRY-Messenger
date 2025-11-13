import { issueTurnCredentials } from '../../api/calls.js';
import { log } from '../../core/log.js';
import { getUidHex } from '../../core/store.js';
import { loadCallNetworkConfig } from './network-config.js';
import {
  getCallNetworkConfig,
  getCallMediaState,
  updateCallMedia,
  completeCallSession,
  getCallSessionSnapshot,
  updateCallSessionStatus
} from './state.js';
import {
  getCallKeyContext,
  supportsInsertableStreams
} from './key-manager.js';
import { CALL_EVENT, subscribeCallEvent } from './events.js';
import { CALL_SESSION_STATUS } from './state.js';

let sendSignal = null;
let showToast = () => {};
let remoteAudioEl = null;
let peerConnection = null;
let localStream = null;
let remoteStream = null;
let pendingOffer = null;
let awaitingAnswer = false;
let activeCallId = null;
let activePeerUid = null;
let direction = 'outgoing';
let unsubscribers = [];
let awaitingOfferAfterAccept = false;
let localAudioMuted = false;
let remoteAudioMuted = false;

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
  showToast = typeof showToastFn === 'function' ? showToastFn : () => {};
  ensureRemoteAudioElement();
  if (unsubscribers.length) return;
  unsubscribers = [
    subscribeCallEvent(CALL_EVENT.SIGNAL, ({ signal }) => handleSignal(signal)),
    subscribeCallEvent(CALL_EVENT.STATE, ({ session }) => handleSessionState(session))
  ];
}

export function disposeCallMediaSession() {
  for (const off of unsubscribers.splice(0)) {
    try { off?.(); } catch {}
  }
  cleanupPeerConnection('dispose');
}

export async function startOutgoingCallMedia({ callId, peerUid }) {
  activeCallId = callId;
  activePeerUid = peerUid;
  direction = 'outgoing';
  awaitingAnswer = true;
  await ensurePeerConnection();
  await createAndSendOffer();
}

export async function acceptIncomingCallMedia({ callId, peerUid }) {
  activeCallId = callId;
  activePeerUid = peerUid;
  direction = 'incoming';
  awaitingOfferAfterAccept = true;
  await ensurePeerConnection();
  if (pendingOffer && pendingOffer.callId === callId) {
    await applyRemoteOfferAndAnswer(pendingOffer);
    pendingOffer = null;
    awaitingOfferAfterAccept = false;
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

function ensureRemoteAudioElement() {
  if (typeof document === 'undefined') return null;
  remoteAudioEl = document.getElementById('callRemoteAudio');
  if (!remoteAudioEl) {
    remoteAudioEl = document.createElement('audio');
    remoteAudioEl.id = 'callRemoteAudio';
    remoteAudioEl.autoplay = true;
    remoteAudioEl.playsInline = true;
    remoteAudioEl.style.display = 'none';
    document.body.appendChild(remoteAudioEl);
  }
  remoteAudioEl.muted = !!remoteAudioMuted;
  return remoteAudioEl;
}

async function ensurePeerConnection() {
  if (peerConnection) return peerConnection;
  const rtcConfig = await buildRtcConfiguration();
  peerConnection = new RTCPeerConnection(rtcConfig);
  peerConnection.onicecandidate = (event) => {
    if (!event.candidate || !sendSignal || !activeCallId) return;
    sendSignal('call-ice-candidate', {
      callId: activeCallId,
      targetUid: activePeerUid,
      candidate: event.candidate
    });
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
      showToast?.('通話連線失敗', true);
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
      showToast?.('通話連線中斷', true);
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
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    localStream.getTracks().forEach((track) => {
      const sender = peerConnection.addTrack(track, localStream);
      setupInsertableStreamsForSender(sender, track);
    });
    applyLocalAudioMuteState();
  } catch (err) {
    showToast?.('無法存取麥克風：' + (err?.message || err), true);
    log({ callMediaMicError: err?.message || err });
  }
}

async function buildRtcConfiguration() {
  let config = getCallNetworkConfig();
  if (!config) {
    try { config = await loadCallNetworkConfig(); } catch {}
  }
  let iceServers = config?.ice?.servers || null;
  if (!iceServers || !iceServers.length) {
    try {
      const creds = await issueTurnCredentials({ ttlSeconds: config?.turnTtlSeconds || 300 });
      iceServers = creds?.iceServers || [];
    } catch (err) {
      log({ callTurnCredentialError: err?.message || err });
      showToast?.('無法取得 TURN 認證', true);
    }
  }
  return { iceServers: iceServers?.length ? iceServers : undefined };
}

async function createAndSendOffer() {
  if (!peerConnection) return;
  const offer = await peerConnection.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
  await peerConnection.setLocalDescription(offer);
  awaitingAnswer = true;
  if (sendSignal) {
    sendSignal('call-offer', {
      callId: activeCallId,
      targetUid: activePeerUid,
      description: { sdp: offer.sdp, type: offer.type }
    });
  }
}

async function applyRemoteOfferAndAnswer(msg) {
  if (!peerConnection || !msg?.description) return;
  await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.description));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  if (sendSignal) {
    sendSignal('call-answer', {
      callId: activeCallId,
      targetUid: activePeerUid,
      description: { sdp: answer.sdp, type: answer.type }
    });
  }
  promoteSessionToInCall('answer-sent');
}

async function handleIncomingOffer(msg) {
  if (msg.fromUid === getUidHex()) return;
  if (!activeCallId) {
    activeCallId = msg.callId;
    activePeerUid = msg.fromUid;
    direction = 'incoming';
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
  if (!peerConnection || msg.fromUid === getUidHex()) return;
  if (!awaitingAnswer) return;
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.description));
    promoteSessionToInCall('answer-received');
  } catch (err) {
    log({ callMediaAnswerError: err?.message || err });
  } finally {
    awaitingAnswer = false;
  }
}

async function handleIncomingCandidate(msg) {
  if (!peerConnection || msg.fromUid === getUidHex()) return;
  const candidate = msg.candidate;
  if (!candidate) return;
  try {
    await peerConnection.addIceCandidate(candidate);
  } catch (err) {
    log({ callMediaCandidateError: err?.message || err });
  }
}

function handleSignal(msg) {
  if (!msg || msg.callId && activeCallId && msg.callId !== activeCallId) return;
  const type = msg?.type;
  switch (type) {
    case 'call-offer':
      handleIncomingOffer(msg);
      break;
    case 'call-answer':
      handleIncomingAnswer(msg);
      break;
    case 'call-ice-candidate':
      handleIncomingCandidate(msg);
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
    try { peerConnection.onicecandidate = null; } catch {}
    try { peerConnection.ontrack = null; } catch {}
    try { peerConnection.close(); } catch {}
  }
  if (localStream) {
    try { localStream.getTracks().forEach((track) => track.stop()); } catch {}
  }
  peerConnection = null;
  localStream = null;
  remoteStream = null;
  pendingOffer = null;
  awaitingAnswer = false;
  awaitingOfferAfterAccept = false;
  activeCallId = null;
  activePeerUid = null;
  if (remoteAudioEl) {
    try {
      remoteAudioEl.srcObject = null;
      remoteAudioEl.style.display = 'none';
    } catch {}
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
  const importPromise = crypto.subtle.importKey('raw', keyEntry.key, { name: 'AES-GCM' }, false, usages)
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
    } catch {}
  }
  updateCallMedia({
    controls: {
      audioMuted: localAudioMuted
    }
  });
}

function applyRemoteAudioMuteState() {
  if (remoteAudioEl) {
    try {
      remoteAudioEl.muted = !!remoteAudioMuted;
    } catch {}
    if (!remoteAudioMuted) {
      attemptRemoteAudioPlayback();
    }
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
  localAudioMuted = false;
  remoteAudioMuted = false;
  if (hadLocalMute) {
    applyLocalAudioMuteState();
  }
  if (hadRemoteMute) {
    applyRemoteAudioMuteState();
  }
}
