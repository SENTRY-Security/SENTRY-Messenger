import { log } from '../../core/log.js';
import { getConversationTokenForCall } from '../../core/contact-secrets.js';
import { normalizeAccountDigest, normalizePeerDeviceId, ensureDeviceId } from '../../core/store.js';
import { bytesToB64, b64ToBytes, b64UrlToBytes } from '../../../shared/utils/base64.js';
import { toU8Strict } from '/shared/utils/u8-strict.js';
import {
  CALL_EVENT,
  subscribeCallEvent
} from './events.js';
import {
  CALL_SESSION_DIRECTION,
  CALL_SESSION_STATUS,
  applyCallEnvelope,
  getCallSessionSnapshot,
  getCallMediaState,
  getCallCapability,
  updateCallMedia,
  setCallMediaStatus
} from './state.js';
import { CALL_MEDIA_STATE_STATUS } from '../../../shared/calls/schemas.js';
import { buildCallPeerIdentity } from './identity.js';

const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const ZERO_SALT = new Uint8Array(32);

let subscriptions = [];
let deriveTask = null;
let suppressAutoDerive = false;
let keyContext = null;
let isResettingContext = false;

const ROLE_KEY_LABELS = {
  caller: {
    audioTxKey: 'call-audio-tx:caller',
    audioRxKey: 'call-audio-tx:callee',
    videoTxKey: 'call-video-tx:caller',
    videoRxKey: 'call-video-tx:callee',
    audioTxNonce: 'call-audio-nonce:caller',
    audioRxNonce: 'call-audio-nonce:callee',
    videoTxNonce: 'call-video-nonce:caller',
    videoRxNonce: 'call-video-nonce:callee'
  },
  callee: {
    audioTxKey: 'call-audio-tx:callee',
    audioRxKey: 'call-audio-tx:caller',
    videoTxKey: 'call-video-tx:callee',
    videoRxKey: 'call-video-tx:caller',
    audioTxNonce: 'call-audio-nonce:callee',
    audioRxNonce: 'call-audio-nonce:caller',
    videoTxNonce: 'call-video-nonce:callee',
    videoRxNonce: 'call-video-nonce:caller'
  }
};

function hasWebCrypto() {
  return typeof crypto !== 'undefined' && !!crypto.subtle && encoder;
}

function logCallKeyDerive({ callId = null, peerKey = null, hasSecret = false } = {}) {
  try {
    console.log('[call] key:derive', JSON.stringify({
      callId: callId || null,
      peerKey: peerKey || null,
      hasSecret: !!hasSecret
    }));
  } catch { }
}

function toRole(direction) {
  return direction === CALL_SESSION_DIRECTION.INCOMING ? 'callee' : 'caller';

}

export function initCallKeyManager() {
  if (!hasWebCrypto()) {
    log({ callKeyManagerInitSkipped: 'webcrypto-unavailable' });
    return () => { };
  }
  if (subscriptions.length) return () => { };
  const offState = subscribeCallEvent(CALL_EVENT.STATE, ({ session }) => handleCallStateEvent(session));
  const offSignal = subscribeCallEvent(CALL_EVENT.SIGNAL, () => maybeDeriveKeys('signal'));
  const offError = subscribeCallEvent(CALL_EVENT.ERROR, () => resetKeyContext('call-error'));
  subscriptions = [offState, offSignal, offError];
  maybeDeriveKeys('init').catch((err) => {
    log({ callKeyManagerInitError: err?.message || err });
  });
  return () => {
    for (const off of subscriptions) {
      try { off?.(); } catch { }
    }
    subscriptions = [];
  };
}

export function getCallKeyContext() {
  if (!keyContext) return null;
  return {
    ...keyContext,
    keys: cloneDirectionalKeys(keyContext.keys),
    frameCounters: { ...keyContext.frameCounters }
  };
}

export function supportsInsertableStreams() {
  const senderProto = typeof RTCRtpSender !== 'undefined' ? RTCRtpSender.prototype : null;
  if (!senderProto) return false;
  return typeof senderProto.createEncodedStreams === 'function'
    || typeof senderProto.createEncodedAudioStreams === 'function'
    || typeof senderProto.createEncodedVideoStreams === 'function';
}

export async function prepareCallKeyEnvelope({
  callId,
  peerAccountDigest = null,
  peerDeviceId = null,
  epoch = 1,
  media = null,
  capabilities = null,
  direction = null
} = {}) {
  if (!hasWebCrypto()) throw new Error('此瀏覽器不支援 WebCrypto');
  if (!callId) throw new Error('callId required');
  const session = getCallSessionSnapshot();
  const digest = normalizeAccountDigest(peerAccountDigest || session?.peerAccountDigest || null);
  if (!digest) throw new Error('peer account digest required');
  const deviceId = normalizePeerDeviceId(peerDeviceId || session?.peerDeviceId || null);
  if (!deviceId) throw new Error('peerDeviceId required for call key');
  const identity = buildCallPeerIdentity({ peerAccountDigest: digest, peerDeviceId: deviceId });
  const saltBytes = crypto.getRandomValues(new Uint8Array(32));
  const mediaState = getCallMediaState();
  const envelope = {
    type: 'call-key-envelope',
    callId,
    epoch,
    cmkSalt: bytesToB64(saltBytes),
    cmkProof: null,
    media: media || cloneMediaDescriptor(mediaState?.media),
    capabilities: capabilities || getCallCapability(),
    createdAt: Date.now()
  };
  const effectiveSession = {
    peerAccountDigest: identity.digest,
    peerDeviceId: identity.deviceId,
    peerKey: identity.peerKey,
    callId,
    direction: direction || session?.direction || CALL_SESSION_DIRECTION.OUTGOING
  };
  const context = await buildKeyContext({
    session: effectiveSession,
    envelope,
    saltBytes
  });
  envelope.cmkProof = context.proofB64;
  withAutoDeriveGuard(() => {
    applyCallEnvelope(envelope);
  });
  await finalizeContext(context);
  keyContext = context;
  return envelope;
}

async function maybeDeriveKeys(trigger = 'auto') {
  if (suppressAutoDerive) return null;
  const session = getCallSessionSnapshot();
  const mediaState = getCallMediaState();
  if (!session?.peerAccountDigest || !session?.peerDeviceId || !mediaState?.pendingEnvelope) return null;
  if (deriveTask) return deriveTask;
  deriveTask = deriveKeysFromEnvelope({ session, envelope: mediaState.pendingEnvelope, trigger })
    .catch((err) => {
      log({ callKeyDeriveError: err?.message || err, trigger });
    })
    .finally(() => {
      deriveTask = null;
    });
  return deriveTask;
}

async function deriveKeysFromEnvelope({ session, envelope, trigger }) {
  const mediaState = getCallMediaState();
  if (!mediaState) return null;
  setCallMediaStatus(CALL_MEDIA_STATE_STATUS.KEY_PENDING);
  const context = await buildKeyContext({ session, envelope });
  await finalizeContext(context);
  keyContext = context;
  log({ callKeyReady: true, callId: context.callId, trigger });
  return context;
}

async function buildKeyContext({ session, envelope, saltBytes = null }) {
  const digest = normalizeAccountDigest(session?.peerAccountDigest || null);
  if (!digest) throw new Error('缺少好友 account digest');
  const peerDeviceId = normalizePeerDeviceId(session?.peerDeviceId || null);
  if (!peerDeviceId) throw new Error('peerDeviceId required for call key');
  const identity = buildCallPeerIdentity({ peerAccountDigest: digest, peerDeviceId });
  const deviceId = ensureDeviceId();
  // For calls, we only need conversationToken which is shared across all devices
  const secretB64 = getConversationTokenForCall(identity.digest, { peerDeviceId });
  const callId = envelope?.callId || session?.callId || null;
  try {
    console.log('[call] key:secret-lookup', JSON.stringify({
      peerKey: identity.peerKey,
      peerDigest: identity.digest,
      lookupPeerDeviceId: peerDeviceId || null,
      found: !!secretB64,
      tokenLen: secretB64?.length || 0
    }));
  } catch { }
  logCallKeyDerive({ callId, peerKey: identity.peerKey, hasSecret: !!secretB64 });
  if (!secretB64) throw new Error('缺少好友密鑰，請重新同步聯絡人');
  const baseSecret = b64UrlToBytes(secretB64);
  if (!baseSecret || !baseSecret.length) throw new Error('無法解析好友密鑰');
  const salt = saltBytes || b64ToBytes(envelope?.cmkSalt || '');
  if (!salt || !salt.length) throw new Error('缺少通話金鑰 salt');
  const epoch = Number.isFinite(envelope?.epoch) ? envelope.epoch : 0;
  if (!callId) throw new Error('callId 無效');
  const role = toRole(session?.direction);
  const masterKey = await deriveMasterKey(baseSecret, salt, callId, epoch);
  const proofB64 = await computeProof(masterKey, callId, epoch);
  if (envelope?.cmkProof && envelope.cmkProof !== proofB64) {
    throw new Error('call master key proof 驗證失敗');
  }
  const labels = ROLE_KEY_LABELS[role] || ROLE_KEY_LABELS.caller;
  const keys = {
    audioTx: await deriveDirectionalKey(masterKey, labels.audioTxKey, labels.audioTxNonce),
    audioRx: await deriveDirectionalKey(masterKey, labels.audioRxKey, labels.audioRxNonce),
    videoTx: await deriveDirectionalKey(masterKey, labels.videoTxKey, labels.videoTxNonce),
    videoRx: await deriveDirectionalKey(masterKey, labels.videoRxKey, labels.videoRxNonce)
  };
  return {
    callId,
    peerKey: identity.peerKey,
    peerAccountDigest: identity.digest,
    peerDeviceId,
    direction: session?.direction || CALL_SESSION_DIRECTION.OUTGOING,
    epoch,
    envelope,
    masterKey,
    proofB64,
    keys,
    frameCounters: {
      audioTx: 0,
      audioRx: 0,
      videoTx: 0,
      videoRx: 0
    }
  };
}

async function deriveMasterKey(baseSecret, salt, callId, epoch) {
  const label = `call-master-key:${callId}:${epoch}`;
  const baseKey = await crypto.subtle.importKey(
    'raw',
    toU8Strict(baseSecret, 'web/src/app/features/calls/key-manager.js:222:deriveMasterKey'),
    'HKDF',
    false,
    ['deriveBits']
  );
  const info = encoder.encode(label);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    baseKey,
    512
  );
  return new Uint8Array(bits);
}

async function computeProof(masterKey, callId, epoch) {
  const data = encoder.encode(`${callId}:${epoch}`);
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    toU8Strict(masterKey, 'web/src/app/features/calls/key-manager.js:234:computeProof'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', hmacKey, data);
  return bytesToB64(new Uint8Array(mac));
}

async function deriveDirectionalKey(masterKey, keyLabel, nonceLabel) {
  const keyBytes = await deriveSubMaterial(masterKey, keyLabel, 256);
  const nonceBytes = await deriveSubMaterial(masterKey, nonceLabel, 96);
  return {
    key: keyBytes,
    nonce: nonceBytes
  };
}

async function deriveSubMaterial(masterKey, label, lengthBits) {
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    toU8Strict(masterKey, 'web/src/app/features/calls/key-manager.js:255:deriveSubMaterial'),
    'HKDF',
    false,
    ['deriveBits']
  );
  const info = encoder.encode(label);
  const salt = ZERO_SALT;
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    hkdfKey,
    lengthBits
  );
  return new Uint8Array(bits);
}

async function finalizeContext(context) {
  const state = getCallMediaState();
  if (!state) return;
  updateCallMedia({
    pendingEnvelope: null,
    derivedKeys: {
      audioTx: context.keys.audioTx,
      audioRx: context.keys.audioRx,
      videoTx: context.keys.videoTx,
      videoRx: context.keys.videoRx
    },
    frameCounters: { ...context.frameCounters },
    cmkMaterial: {
      masterKey: context.masterKey,
      proof: context.proofB64,
      epoch: context.epoch,
      callId: context.callId,
      peerKey: context.peerKey || null,
      peerAccountDigest: context.peerAccountDigest || null,
      peerDeviceId: context.peerDeviceId || null,
      salt: context.envelope?.cmkSalt || null
    }
  });
  setCallMediaStatus(CALL_MEDIA_STATE_STATUS.READY);
}

function resetKeyContext(reason) {
  if (isResettingContext) return;
  isResettingContext = true;
  keyContext = null;
  const state = getCallMediaState();
  try {
    if (state) {
      updateCallMedia({
        pendingEnvelope: null,
        derivedKeys: {
          audioTx: null,
          audioRx: null,
          videoTx: null,
          videoRx: null
        },
        frameCounters: {
          audioTx: 0,
          audioRx: 0,
          videoTx: 0,
          videoRx: 0
        },
        cmkMaterial: null
      });
      setCallMediaStatus(CALL_MEDIA_STATE_STATUS.IDLE);
    }
    if (reason) {
      log({ callKeyContextReset: reason });
    }
  } finally {
    isResettingContext = false;
  }
}

function handleCallStateEvent(session) {
  const snapshot = session || getCallSessionSnapshot();
  if (!snapshot) return;
  const state = getCallMediaState();
  const hasContext = keyContext || hasActiveMediaState(state);
  if (!snapshot.callId && !hasContext) {
    return;
  }
  if (
    snapshot.status === CALL_SESSION_STATUS.ENDED
    || snapshot.status === CALL_SESSION_STATUS.FAILED
    || snapshot.status === CALL_SESSION_STATUS.IDLE
  ) {
    if (hasContext) {
      resetKeyContext('session-complete');
    }
    return;
  }
  // When the call is connected but no key envelope was exchanged (no
  // pending envelope and no derived context), mark E2E as skipped so
  // the UI shows "通話未加密" instead of "正在準備端到端加密…".
  if (
    snapshot.status === CALL_SESSION_STATUS.IN_CALL
    && !hasContext
    && !state?.pendingEnvelope
  ) {
    const currentStatus = state?.status;
    if (currentStatus !== CALL_MEDIA_STATE_STATUS.SKIPPED) {
      setCallMediaStatus(CALL_MEDIA_STATE_STATUS.SKIPPED);
    }
    return;
  }
  maybeDeriveKeys('state');
}

function withAutoDeriveGuard(fn) {
  suppressAutoDerive = true;
  try {
    fn();
  } finally {
    suppressAutoDerive = false;
  }
}

function cloneDirectionalKeys(source) {
  if (!source) return null;
  const clone = {};
  for (const key of Object.keys(source)) {
    const entry = source[key];
    if (!entry) {
      clone[key] = null;
      continue;
    }
    clone[key] = {
      key: entry.key ? new Uint8Array(entry.key) : null,
      nonce: entry.nonce ? new Uint8Array(entry.nonce) : null
    };
  }
  return clone;
}

function cloneMediaDescriptor(media) {
  if (!media || typeof media !== 'object') return null;
  return {
    audio: media.audio ? { ...media.audio } : {},
    video: media.video ? { ...media.video } : {},
    screenshare: media.screenshare ? { ...media.screenshare } : {}
  };
}

function hasActiveMediaState(state) {
  if (!state) return false;
  if (state.pendingEnvelope) return true;
  if (state.cmkMaterial) return true;
  const keys = state.derivedKeys || {};
  return Boolean(keys.audioTx || keys.audioRx || keys.videoTx || keys.videoRx);
}
