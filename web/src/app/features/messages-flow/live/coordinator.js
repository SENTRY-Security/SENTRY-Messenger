// /app/features/messages-flow/live/coordinator.js
// B-route live coordinator: orchestrates live decrypt + catchup.
// Stub only in this phase.

import { logCapped } from '../../core/log.js';

const LIVE_COORDINATOR_LOG_CAP = 5;
const PREFIX_LEN = 8;
const SUFFIX_LEN = 4;

function slicePrefix(value, len = PREFIX_LEN) {
  if (value === null || value === undefined) return null;
  const str = String(value);
  if (!str) return null;
  return str.slice(0, len);
}

function sliceSuffix(value, len = SUFFIX_LEN) {
  if (value === null || value === undefined) return null;
  const str = String(value);
  if (!str) return null;
  return str.slice(-len);
}

function normalizeCounter(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function sanitizeParams(params = {}) {
  const conversationId = params?.conversationId || null;
  const peerAccountDigest = params?.peerAccountDigest || null;
  const peerDeviceId = params?.peerDeviceId || null;
  const tokenB64 = params?.tokenB64 || null;
  return {
    triggerSource: params?.triggerSource || null,
    mode: params?.mode || null,
    conversationIdPrefix8: slicePrefix(conversationId, 8),
    peerAccountDigestPrefix8: slicePrefix(peerAccountDigest, 8),
    peerAccountDigestSuffix4: sliceSuffix(peerAccountDigest, 4),
    peerDeviceIdSuffix4: sliceSuffix(peerDeviceId, 4),
    tokenPrefix4: slicePrefix(tokenB64, 4),
    tokenSuffix4: sliceSuffix(tokenB64, 4),
    tokenLen: tokenB64 ? String(tokenB64).length : 0,
    targetCounter: normalizeCounter(params?.targetCounter)
  };
}

// Main entry point for live catchup (B-route).
export async function runLiveCatchupForConversation(params = {}, deps = {}) {
  const logger = typeof deps.logCapped === 'function' ? deps.logCapped : logCapped;
  logger('liveCoordinatorTrace', sanitizeParams(params), LIVE_COORDINATOR_LOG_CAP);

  const adapters = deps?.adapters || null;

  // TODO: implement live catchup using adapters + gap-fill queue.
  // This stub intentionally does not change runtime behavior.
  return {
    ok: true,
    status: 'noop',
    adaptersReady: !!adapters
  };
}
