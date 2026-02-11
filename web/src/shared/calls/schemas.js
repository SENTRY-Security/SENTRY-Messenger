const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_COMPACT_REGEX = /^[0-9a-f]{32}$/i;
const UID_HEX_REGEX = /^[0-9A-F]{14,64}$/;
const BASE64_REGEX = /^[0-9A-Za-z+/=_-]+$/;
const DEFAULT_ROTATE_INTERVAL_MS = 10 * 60 * 1000;

export const CALL_KEY_ENVELOPE_TYPE = 'call-key-envelope';
export const CALL_KEY_ENVELOPE_VERSION = 1;
export const CALL_MEDIA_SCHEMA_VERSION = 1;

export const CALL_MEDIA_STATE_STATUS = Object.freeze({
  IDLE: 'idle',
  KEY_PENDING: 'key_pending',
  READY: 'ready',
  ROTATING: 'rotating',
  FAILED: 'failed'
});

const DEFAULT_AUDIO_MEDIA = Object.freeze({
  enabled: true,
  codec: 'opus',
  bitrate: 32000,
  channelCount: 1
});

const DEFAULT_VIDEO_MEDIA = Object.freeze({
  enabled: false,
  codec: 'vp8',
  profile: 'medium',
  resolution: '540p',
  frameRate: 30,
  maxBitrate: 900000
});

const DEFAULT_SCREENSHARE_MEDIA = Object.freeze({
  enabled: false,
  codec: 'vp9',
  maxBitrate: 1200000,
  frameRate: 15
});

const DEFAULT_MEDIA_DESCRIPTOR = Object.freeze({
  audio: DEFAULT_AUDIO_MEDIA,
  video: DEFAULT_VIDEO_MEDIA,
  screenshare: DEFAULT_SCREENSHARE_MEDIA
});

const DEFAULT_MEDIA_CONTROLS = Object.freeze({
  audioMuted: false,
  remoteMuted: false,
  videoMuted: false,
  videoEnabled: false
});

export const DEFAULT_CALL_MEDIA_CAPABILITY = Object.freeze({
  audio: true,
  video: false,
  screenshare: false,
  insertableStreams: true,
  sframe: false,
  platform: 'web',
  version: 1,
  features: [],
  maxSendBitrateKbps: null,
  maxRecvBitrateKbps: null
});

function cloneMediaToggle(toggle = {}) {
  return {
    enabled: !!toggle.enabled,
    codec: toggle.codec ? String(toggle.codec).toLowerCase() : 'opus',
    profile: toggle.profile ? String(toggle.profile).toLowerCase() : null,
    resolution: toggle.resolution ? String(toggle.resolution).toLowerCase() : null,
    frameRate: Number.isFinite(toggle.frameRate) ? Math.max(1, Math.round(toggle.frameRate)) : null,
    bitrate: Number.isFinite(toggle.bitrate) ? Math.max(0, Math.round(toggle.bitrate)) : null,
    maxBitrate: Number.isFinite(toggle.maxBitrate) ? Math.max(0, Math.round(toggle.maxBitrate)) : null,
    minBitrate: Number.isFinite(toggle.minBitrate) ? Math.max(0, Math.round(toggle.minBitrate)) : null,
    channelCount: Number.isFinite(toggle.channelCount) ? Math.max(1, Math.round(toggle.channelCount)) : null
  };
}

function cloneMediaDescriptor(source = null) {
  const base = typeof source === 'object' && source ? source : DEFAULT_MEDIA_DESCRIPTOR;
  return {
    audio: mergeMediaToggle(DEFAULT_AUDIO_MEDIA, base.audio),
    video: mergeMediaToggle(DEFAULT_VIDEO_MEDIA, base.video),
    screenshare: mergeMediaToggle(DEFAULT_SCREENSHARE_MEDIA, base.screenshare)
  };
}

function cloneMediaControls(source = null) {
  const result = { ...DEFAULT_MEDIA_CONTROLS };
  if (!source || typeof source !== 'object') {
    return result;
  }
  for (const key of Object.keys(DEFAULT_MEDIA_CONTROLS)) {
    if (source[key] == null) continue;
    result[key] = !!source[key];
  }
  return result;
}

function mergeMediaToggle(defaults, override) {
  const merged = cloneMediaToggle(defaults);
  if (!override || typeof override !== 'object') {
    return normalizeToggleDefaults(merged, defaults);
  }
  if (override.enabled != null) merged.enabled = !!override.enabled;
  if (override.codec) merged.codec = String(override.codec).toLowerCase();
  if (override.profile) merged.profile = String(override.profile).toLowerCase();
  if (override.resolution) merged.resolution = String(override.resolution).toLowerCase();
  if (override.frameRate != null && Number.isFinite(override.frameRate)) {
    merged.frameRate = Math.max(1, Math.round(Number(override.frameRate)));
  }
  if (override.bitrate != null && Number.isFinite(override.bitrate)) {
    merged.bitrate = Math.max(0, Math.round(Number(override.bitrate)));
  }
  if (override.maxBitrate != null && Number.isFinite(override.maxBitrate)) {
    merged.maxBitrate = Math.max(0, Math.round(Number(override.maxBitrate)));
  }
  if (override.minBitrate != null && Number.isFinite(override.minBitrate)) {
    merged.minBitrate = Math.max(0, Math.round(Number(override.minBitrate)));
  }
  if (override.channelCount != null && Number.isFinite(override.channelCount)) {
    merged.channelCount = Math.max(1, Math.round(Number(override.channelCount)));
  }
  return normalizeToggleDefaults(merged, defaults);
}

function normalizeToggleDefaults(merged, defaults) {
  const out = { ...merged };
  if (out.codec == null && defaults.codec) out.codec = defaults.codec;
  if (out.profile == null && defaults.profile != null) out.profile = defaults.profile;
  if (out.resolution == null && defaults.resolution != null) out.resolution = defaults.resolution;
  if (out.frameRate == null && defaults.frameRate != null) out.frameRate = defaults.frameRate;
  if (out.bitrate == null && defaults.bitrate != null) out.bitrate = defaults.bitrate;
  if (out.maxBitrate == null && defaults.maxBitrate != null) out.maxBitrate = defaults.maxBitrate;
  if (out.minBitrate == null && defaults.minBitrate != null) out.minBitrate = defaults.minBitrate;
  if (out.channelCount == null && defaults.channelCount != null) out.channelCount = defaults.channelCount;
  return out;
}

function cloneFeatures(list = []) {
  const arr = Array.isArray(list) ? list : [];
  const normalized = [];
  for (const item of arr) {
    const token = String(item || '').trim().toLowerCase();
    if (!token) continue;
    if (!normalized.includes(token)) normalized.push(token);
  }
  return normalized;
}

function normalizeUuid(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (UUID_V4_REGEX.test(raw)) return raw.toLowerCase();
  if (UUID_COMPACT_REGEX.test(raw)) {
    return (
      `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
    ).toLowerCase();
  }
  return null;
}

function normalizeUidHex(value) {
  const str = String(value || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  return UID_HEX_REGEX.test(str) ? str : null;
}

function normalizeBase64(value) {
  const str = String(value || '').trim();
  if (!str || str.length < 8) return null;
  return BASE64_REGEX.test(str) ? str : null;
}

function normalizeEpoch(value) {
  if (value == null) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const normalized = Math.max(0, Math.round(num));
  return Number.isFinite(normalized) ? normalized : null;
}

function normalizeRotateInterval(value) {
  if (value == null) return DEFAULT_ROTATE_INTERVAL_MS;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 30_000) return DEFAULT_ROTATE_INTERVAL_MS;
  return Math.round(num);
}

function cloneDerivedKeys(source = null) {
  const base = {
    audioTx: null,
    audioRx: null,
    videoTx: null,
    videoRx: null
  };
  if (!source || typeof source !== 'object') return base;
  for (const key of Object.keys(base)) {
    if (!(key in source)) continue;
    base[key] = cloneKeyMaterial(source[key]);
  }
  return base;
}

function cloneFrameCounters(source = null) {
  const base = {
    audioTx: 0,
    audioRx: 0,
    videoTx: 0,
    videoRx: 0
  };
  if (!source || typeof source !== 'object') return base;
  for (const key of Object.keys(base)) {
    if (!(key in source)) continue;
    const num = Number(source[key]);
    base[key] = Number.isFinite(num) && num >= 0 ? Math.floor(num) : 0;
  }
  return base;
}

function cloneKeyMaterial(value) {
  if (!value) return null;
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return new Uint8Array(value);
  if (value?.buffer instanceof ArrayBuffer) return new Uint8Array(value.buffer.slice(0));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      const val = value[key];
      if (val instanceof Uint8Array) {
        out[key] = new Uint8Array(val);
      } else if (Array.isArray(val)) {
        out[key] = new Uint8Array(val);
      } else {
        out[key] = val;
      }
    }
    return out;
  }
  return null;
}

export function normalizeCallMediaCapability(input = null) {
  const source = input && typeof input === 'object' ? input : {};
  const capability = {
    audio: source.audio !== undefined ? !!source.audio : DEFAULT_CALL_MEDIA_CAPABILITY.audio,
    video: source.video !== undefined ? !!source.video : DEFAULT_CALL_MEDIA_CAPABILITY.video,
    screenshare: source.screenshare !== undefined ? !!source.screenshare : DEFAULT_CALL_MEDIA_CAPABILITY.screenshare,
    insertableStreams: source.insertableStreams !== undefined ? !!source.insertableStreams : DEFAULT_CALL_MEDIA_CAPABILITY.insertableStreams,
    sframe: source.sframe !== undefined ? !!source.sframe : DEFAULT_CALL_MEDIA_CAPABILITY.sframe,
    platform: source.platform ? String(source.platform).toLowerCase() : DEFAULT_CALL_MEDIA_CAPABILITY.platform,
    version: Number.isFinite(source.version) ? Math.max(1, Math.round(Number(source.version))) : DEFAULT_CALL_MEDIA_CAPABILITY.version,
    features: cloneFeatures(source.features),
    maxSendBitrateKbps: source.maxSendBitrateKbps != null && Number.isFinite(source.maxSendBitrateKbps)
      ? Math.max(0, Math.round(Number(source.maxSendBitrateKbps)))
      : DEFAULT_CALL_MEDIA_CAPABILITY.maxSendBitrateKbps,
    maxRecvBitrateKbps: source.maxRecvBitrateKbps != null && Number.isFinite(source.maxRecvBitrateKbps)
      ? Math.max(0, Math.round(Number(source.maxRecvBitrateKbps)))
      : DEFAULT_CALL_MEDIA_CAPABILITY.maxRecvBitrateKbps
  };
  return capability;
}

export function normalizeCallMediaOptions(input = null) {
  if (input && typeof input !== 'object') return null;
  return cloneMediaDescriptor(input);
}

export function normalizeCallKeyEnvelope(input = null) {
  if (!input || typeof input !== 'object') return null;
  const type = input.type ? String(input.type) : CALL_KEY_ENVELOPE_TYPE;
  if (type !== CALL_KEY_ENVELOPE_TYPE) return null;
  const callId = normalizeUuid(input.callId);
  if (!callId) return null;
  const epoch = normalizeEpoch(input.epoch);
  if (epoch == null) return null;
  const cmkSalt = normalizeBase64(input.cmkSalt || input.cmkSalt_b64 || input.salt);
  const cmkProof = normalizeBase64(input.cmkProof || input.cmkProof_b64 || input.proof);
  if (!cmkSalt || !cmkProof) return null;
  const media = normalizeCallMediaOptions(input.media) || cloneMediaDescriptor();
  const capabilities = input.capabilities ? normalizeCallMediaCapability(input.capabilities) : null;
  const createdAt = input.createdAt && Number.isFinite(input.createdAt) ? Number(input.createdAt) : Date.now();
  const expiresAt = input.expiresAt && Number.isFinite(input.expiresAt) ? Number(input.expiresAt) : null;
  const metadata = input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : null;
  return {
    type: CALL_KEY_ENVELOPE_TYPE,
    version: Number.isFinite(input.version) && input.version > 0 ? Math.round(Number(input.version)) : CALL_KEY_ENVELOPE_VERSION,
    callId,
    epoch,
    cmkSalt,
    cmkProof,
    media,
    capabilities,
    metadata,
    createdAt,
    expiresAt
  };
}

export function assertCallKeyEnvelope(input) {
  const normalized = normalizeCallKeyEnvelope(input);
  if (!normalized) {
    throw new Error('call-key-envelope payload 無效');
  }
  return normalized;
}

export function createCallMediaState(options = {}) {
  const envelope = options.envelope ? normalizeCallKeyEnvelope(options.envelope) : null;
  const now = Date.now();
  const media = normalizeCallMediaOptions(options.media || envelope?.media) || cloneMediaDescriptor();
  const capabilities = normalizeCallMediaCapability(options.capabilities || envelope?.capabilities || DEFAULT_CALL_MEDIA_CAPABILITY);
  const callId = normalizeUuid(options.callId || envelope?.callId);
  const epoch = envelope?.epoch ?? normalizeEpoch(options.epoch) ?? 0;
  const cmkSalt = envelope?.cmkSalt || normalizeBase64(options.cmkSalt);
  const cmkProof = envelope?.cmkProof || normalizeBase64(options.cmkProof);
  const rotateIntervalMs = normalizeRotateInterval(options.rotateIntervalMs ?? options.keyRotateIntervalMs);
  return {
    schemaVersion: CALL_MEDIA_SCHEMA_VERSION,
    status: CALL_MEDIA_STATE_STATUS.IDLE,
    callId,
    epoch,
    cmkSalt: cmkSalt || null,
    cmkProof: cmkProof || null,
    cmkMaterial: null,
    derivedKeys: cloneDerivedKeys(options.derivedKeys),
    frameCounters: cloneFrameCounters(options.frameCounters),
    media,
    capabilities,
    lastError: null,
    lastRotateAt: null,
    nextRotateAt: rotateIntervalMs ? now + rotateIntervalMs : null,
    rotateIntervalMs,
    pendingEnvelope: null,
    controls: cloneMediaControls(options.controls),
    createdAt: options.createdAt && Number.isFinite(options.createdAt) ? Number(options.createdAt) : now,
    updatedAt: now
  };
}

export function cloneCallMediaState(state) {
  if (!state || typeof state !== 'object') return null;
  return {
    ...state,
    derivedKeys: cloneDerivedKeys(state.derivedKeys),
    frameCounters: cloneFrameCounters(state.frameCounters),
    media: cloneMediaDescriptor(state.media),
    capabilities: state.capabilities ? { ...state.capabilities, features: cloneFeatures(state.capabilities.features) } : null,
    pendingEnvelope: state.pendingEnvelope ? { ...state.pendingEnvelope } : null,
    controls: cloneMediaControls(state.controls)
  };
}

export function applyCallKeyEnvelopeToState(state, envelopeInput) {
  if (!state) throw new Error('call media state is required');
  const envelope = assertCallKeyEnvelope(envelopeInput);
  state.pendingEnvelope = envelope;
  state.cmkSalt = envelope.cmkSalt;
  state.cmkProof = envelope.cmkProof;
  state.epoch = envelope.epoch;
  state.media = cloneMediaDescriptor(envelope.media);
  state.capabilities = envelope.capabilities ? normalizeCallMediaCapability(envelope.capabilities) : state.capabilities;
  state.updatedAt = Date.now();
  return state;
}

export function setCallMediaStatus(state, status, error = null) {
  if (!state) throw new Error('call media state is required');
  if (!Object.values(CALL_MEDIA_STATE_STATUS).includes(status)) {
    throw new Error(`未知的 call media 狀態：${status}`);
  }
  state.status = status;
  state.updatedAt = Date.now();
  state.lastError = error ? String(error) : null;
  return state;
}

export function touchCallMediaState(state, fields = {}) {
  if (!state) throw new Error('call media state is required');
  if (fields.frameCounters) {
    state.frameCounters = cloneFrameCounters({
      ...state.frameCounters,
      ...fields.frameCounters
    });
  }
  if (fields.derivedKeys) {
    state.derivedKeys = cloneDerivedKeys({
      ...state.derivedKeys,
      ...fields.derivedKeys
    });
  }
  if (fields.media) {
    state.media = cloneMediaDescriptor({ ...state.media, ...fields.media });
  }
  if (fields.capabilities) {
    state.capabilities = normalizeCallMediaCapability({ ...state.capabilities, ...fields.capabilities });
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'pendingEnvelope')) {
    if (fields.pendingEnvelope) {
      state.pendingEnvelope = assertCallKeyEnvelope(fields.pendingEnvelope);
    } else {
      state.pendingEnvelope = null;
    }
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'cmkMaterial')) {
    state.cmkMaterial = fields.cmkMaterial ? cloneKeyMaterial(fields.cmkMaterial) : null;
  }
  if (fields.controls) {
    state.controls = cloneMediaControls({
      ...state.controls,
      ...fields.controls
    });
  }
  if (fields.rotateIntervalMs) {
    state.rotateIntervalMs = normalizeRotateInterval(fields.rotateIntervalMs);
  }
  if (fields.nextRotateAt != null && Number.isFinite(fields.nextRotateAt)) {
    state.nextRotateAt = Math.max(0, Math.round(Number(fields.nextRotateAt)));
  }
  if (fields.lastRotateAt != null && Number.isFinite(fields.lastRotateAt)) {
    state.lastRotateAt = Math.max(0, Math.round(Number(fields.lastRotateAt)));
  }
  state.updatedAt = Date.now();
  return state;
}

export function buildCallCapabilitySummary(capability) {
  const cap = normalizeCallMediaCapability(capability);
  const summary = [];
  if (cap.audio) summary.push('audio');
  if (cap.video) summary.push('video');
  if (cap.screenshare) summary.push('screenshare');
  if (cap.insertableStreams) summary.push('insertable-streams');
  if (cap.sframe) summary.push('sframe');
  return summary;
}

export function serializeCallMediaState(state) {
  const clone = cloneCallMediaState(state);
  if (!clone) return null;
  const json = {
    schemaVersion: clone.schemaVersion,
    status: clone.status,
    callId: clone.callId,
    epoch: clone.epoch,
    cmkSalt: clone.cmkSalt,
    cmkProof: clone.cmkProof,
    media: clone.media,
    capabilities: clone.capabilities,
    frameCounters: clone.frameCounters,
    rotateIntervalMs: clone.rotateIntervalMs,
    nextRotateAt: clone.nextRotateAt,
    lastRotateAt: clone.lastRotateAt,
    createdAt: clone.createdAt,
    updatedAt: clone.updatedAt,
    controls: clone.controls
  };
  return json;
}
