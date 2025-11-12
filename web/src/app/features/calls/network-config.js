import { CALL_EVENT, emitCallEvent } from './events.js';
import { setCallNetworkConfig } from './state.js';

const CONFIG_URL = '/shared/calls/network-config.json';

let cachedConfig = null;
let inflight = null;

function numberOrNull(value, fallback = null, { min = null } = {}) {
  if (value == null) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const normalized = min != null ? Math.max(min, num) : num;
  return Math.round(normalized);
}

function normalizeProbe(raw = {}) {
  return {
    timeoutMs: numberOrNull(raw.timeoutMs, 1500, { min: 250 }),
    maxAttempts: numberOrNull(raw.maxAttempts, 3, { min: 1 }),
    targetBitrateKbps: numberOrNull(raw.targetBitrateKbps, 2000, { min: 1 })
  };
}

function normalizeProfiles(list = []) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim();
    if (!name) continue;
    out.push({
      name,
      minBitrate: numberOrNull(item.minBitrate, null, { min: 0 }),
      maxBitrate: numberOrNull(item.maxBitrate, null, { min: 0 }),
      maxFrameRate: numberOrNull(item.maxFrameRate, null, { min: 1 }),
      resolution: item.resolution ? String(item.resolution).toLowerCase() : null
    });
  }
  return out;
}

function normalizeIce(raw = {}) {
  return {
    iceTransportPolicy: raw.iceTransportPolicy ? String(raw.iceTransportPolicy) : 'all',
    bundlePolicy: raw.bundlePolicy ? String(raw.bundlePolicy) : 'balanced',
    continualGatheringPolicy: raw.continualGatheringPolicy ? String(raw.continualGatheringPolicy) : 'gather_continually'
  };
}

function normalizeFallback(raw = {}) {
  return {
    maxPeerConnectionRetries: numberOrNull(raw.maxPeerConnectionRetries, 2, { min: 0 }),
    relayOnlyAfterAttempts: numberOrNull(raw.relayOnlyAfterAttempts, 2, { min: 0 }),
    showBlockedAfterSeconds: numberOrNull(raw.showBlockedAfterSeconds, 20, { min: 1 })
  };
}

function normalizeConfig(raw = {}) {
  const version = numberOrNull(raw.version, 1, { min: 1 });
  const endpoint = raw.turnSecretsEndpoint ? String(raw.turnSecretsEndpoint) : CONFIG_URL.replace('/shared/calls/network-config.json', '/api/v1/calls/turn-credentials');
  return {
    version,
    turnSecretsEndpoint: endpoint,
    turnTtlSeconds: numberOrNull(raw.turnTtlSeconds, 300, { min: 30 }),
    rtcpProbe: normalizeProbe(raw.rtcpProbe),
    bandwidthProfiles: normalizeProfiles(raw.bandwidthProfiles),
    ice: normalizeIce(raw.ice),
    fallback: normalizeFallback(raw.fallback)
  };
}

function getStaticFallback() {
  return normalizeConfig({
    version: 1,
    turnSecretsEndpoint: '/api/v1/calls/turn-credentials',
    turnTtlSeconds: 300,
    rtcpProbe: { timeoutMs: 1500, maxAttempts: 3, targetBitrateKbps: 2000 },
    bandwidthProfiles: [
      { name: 'video-medium', minBitrate: 900000, maxBitrate: 1400000, maxFrameRate: 30, resolution: '540p' },
      { name: 'video-low', minBitrate: 300000, maxBitrate: 600000, maxFrameRate: 24, resolution: '360p' },
      { name: 'audio', minBitrate: 32000, maxBitrate: 64000 }
    ],
    ice: { iceTransportPolicy: 'all', bundlePolicy: 'balanced', continualGatheringPolicy: 'gather_continually' },
    fallback: { maxPeerConnectionRetries: 2, relayOnlyAfterAttempts: 2, showBlockedAfterSeconds: 20 }
  });
}

function applyConfig(config) {
  cachedConfig = config;
  setCallNetworkConfig(config);
  emitCallEvent(CALL_EVENT.NETWORK_CONFIG, { config });
  return config;
}

async function fetchConfig({ signal } = {}) {
  if (typeof fetch !== 'function') {
    return getStaticFallback();
  }
  const response = await fetch(CONFIG_URL, {
    cache: 'no-store',
    credentials: 'same-origin',
    signal
  });
  if (!response.ok) {
    throw new Error(`無法載入通話設定 (${response.status})`);
  }
  const json = await response.json();
  return normalizeConfig(json);
}

export function getCachedCallNetworkConfig() {
  return cachedConfig ? { ...cachedConfig } : null;
}

export async function loadCallNetworkConfig({ forceRefresh = false, signal } = {}) {
  if (cachedConfig && !forceRefresh) {
    return { ...cachedConfig };
  }
  if (inflight && !forceRefresh) {
    return inflight;
  }
  inflight = fetchConfig({ signal })
    .then((config) => applyConfig(config))
    .catch((err) => {
      console.warn('[calls] network config load failed', err);
      const fallback = applyConfig(getStaticFallback());
      return fallback;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function primeCallNetworkConfig(config) {
  const normalized = normalizeConfig(config);
  return applyConfig(normalized);
}
