/**
 * TypeScript companion types for the call schema helpers.
 * Runtime implementation lives in ./schemas.js.
 */

export type CallMediaFeature = 'audio' | 'video' | 'screenshare' | 'insertable-streams' | 'sframe';

export interface CallMediaToggle {
  enabled: boolean;
  codec: string;
  profile: string | null;
  resolution: string | null;
  frameRate: number | null;
  bitrate: number | null;
  maxBitrate: number | null;
  minBitrate: number | null;
  channelCount: number | null;
}

export interface CallMediaDescriptor {
  audio: CallMediaToggle;
  video: CallMediaToggle;
  screenshare: CallMediaToggle;
}

export interface CallMediaCapability {
  audio: boolean;
  video: boolean;
  screenshare: boolean;
  insertableStreams: boolean;
  sframe: boolean;
  platform: string;
  version: number;
  features: string[];
  maxSendBitrateKbps: number | null;
  maxRecvBitrateKbps: number | null;
}

export interface CallMediaControls {
  audioMuted: boolean;
  remoteMuted: boolean;
}

export interface CallKeyEnvelope {
  type: 'call-key-envelope';
  version: number;
  callId: string;
  epoch: number;
  cmkSalt: string;
  cmkProof: string;
  media: CallMediaDescriptor;
  capabilities: CallMediaCapability | null;
  metadata?: Record<string, unknown> | null;
  createdAt: number;
  expiresAt: number | null;
}

export type CallMediaStateStatus = 'idle' | 'key_pending' | 'ready' | 'rotating' | 'failed';

export type CallKeyMaterial = Uint8Array | string | number[] | ArrayBuffer | Record<string, unknown> | null;

export interface CallDerivedKeySet {
  audioTx: CallKeyMaterial;
  audioRx: CallKeyMaterial;
  videoTx: CallKeyMaterial;
  videoRx: CallKeyMaterial;
}

export interface CallFrameCounters {
  audioTx: number;
  audioRx: number;
  videoTx: number;
  videoRx: number;
}

export interface CallMediaState {
  schemaVersion: number;
  status: CallMediaStateStatus;
  callId: string | null;
  epoch: number;
  cmkSalt: string | null;
  cmkProof: string | null;
  cmkMaterial: CallKeyMaterial;
  derivedKeys: CallDerivedKeySet;
  frameCounters: CallFrameCounters;
  media: CallMediaDescriptor;
  capabilities: CallMediaCapability;
  lastError: string | null;
  lastRotateAt: number | null;
  nextRotateAt: number | null;
  rotateIntervalMs: number;
  pendingEnvelope: CallKeyEnvelope | null;
  controls: CallMediaControls;
  createdAt: number;
  updatedAt: number;
}

export declare const CALL_KEY_ENVELOPE_TYPE: 'call-key-envelope';
export declare const CALL_KEY_ENVELOPE_VERSION: number;
export declare const CALL_MEDIA_SCHEMA_VERSION: number;
export declare const CALL_MEDIA_STATE_STATUS: Record<string, CallMediaStateStatus>;
export declare const DEFAULT_CALL_MEDIA_CAPABILITY: CallMediaCapability;

export declare function normalizeCallMediaCapability(input?: Partial<CallMediaCapability> | null): CallMediaCapability;
export declare function normalizeCallMediaOptions(input?: Partial<CallMediaDescriptor> | null): CallMediaDescriptor | null;
export declare function normalizeCallKeyEnvelope(input?: Partial<CallKeyEnvelope> | null): CallKeyEnvelope | null;
export declare function assertCallKeyEnvelope(input: Partial<CallKeyEnvelope>): CallKeyEnvelope;
export declare function createCallMediaState(options?: {
  envelope?: Partial<CallKeyEnvelope> | null;
  media?: Partial<CallMediaDescriptor> | null;
  capabilities?: Partial<CallMediaCapability> | null;
  callId?: string | null;
  epoch?: number;
  cmkSalt?: string | null;
  cmkProof?: string | null;
  rotateIntervalMs?: number;
  keyRotateIntervalMs?: number;
  derivedKeys?: Partial<CallDerivedKeySet> | null;
  frameCounters?: Partial<CallFrameCounters> | null;
  controls?: Partial<CallMediaControls> | null;
  createdAt?: number;
}): CallMediaState;
export declare function cloneCallMediaState(state: CallMediaState | null): CallMediaState | null;
export declare function applyCallKeyEnvelopeToState(state: CallMediaState, envelope: CallKeyEnvelope): CallMediaState;
export declare function setCallMediaStatus(state: CallMediaState, status: CallMediaStateStatus, error?: string | null): CallMediaState;
export declare function touchCallMediaState(state: CallMediaState, fields: Partial<CallMediaState>): CallMediaState;
export declare function buildCallCapabilitySummary(capability?: Partial<CallMediaCapability> | null): string[];
export declare function serializeCallMediaState(state: CallMediaState | null): Record<string, unknown> | null;
