import { buildAccountPayload } from '../../core/store.js';
import { CALL_EVENT, emitCallEvent } from './events.js';
import { setCallNetworkConfig } from './state.js';

const API_CONFIG_URL = '/api/v1/calls/network-config';
const STATIC_CONFIG_URL = '/shared/calls/network-config.json';
const DEFAULT_TURN_ENDPOINT = '/api/v1/calls/turn-credentials';

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

function normalizeIceServers(list = []) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const urlsInput = Array.isArray(item.urls) ? item.urls : [item.urls];
    const urls = urlsInput
      .map((url) => (typeof url === 'string' ? url.trim() : ''))
      .filter((url) => url.length);
    if (!urls.length) continue;
    const normalized = { urls };
    if (item.username) normalized.username = String(item.username);
    if (item.credential) normalized.credential = String(item.credential);
    out.push(normalized);
  }
  return out;
}

function normalizeIce(raw = {}) {
  return {
    iceTransportPolicy: raw.iceTransportPolicy ? String(raw.iceTransportPolicy) : 'all',
    bundlePolicy: raw.bundlePolicy ? String(raw.bundlePolicy) : 'balanced',
    continualGatheringPolicy: raw.continualGatheringPolicy ? String(raw.continualGatheringPolicy) : 'gather_continually',
    servers: normalizeIceServers(raw.servers)
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
  const endpoint = raw.turnSecretsEndpoint ? String(raw.turnSecretsEndpoint) : DEFAULT_TURN_ENDPOINT;
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
    turnSecretsEndpoint: DEFAULT_TURN_ENDPOINT,
    turnTtlSeconds: 300,
    rtcpProbe: { timeoutMs: 1500, maxAttempts: 3, targetBitrateKbps: 2000 },
    bandwidthProfiles: [
      { name: 'video-medium', minBitrate: 900000, maxBitrate: 1400000, maxFrameRate: 30, resolution: '540p' },
      { name: 'video-low', minBitrate: 300000, maxBitrate: 600000, maxFrameRate: 24, resolution: '360p' },
      { name: 'audio', minBitrate: 32000, maxBitrate: 64000 }
    ],
    ice: { iceTransportPolicy: 'all', bundlePolicy: 'balanced', continualGatheringPolicy: 'gather_continually', servers: [] },
    fallback: { maxPeerConnectionRetries: 2, relayOnlyAfterAttempts: 2, showBlockedAfterSeconds: 20 }
  });
}

function applyConfig(config) {
  cachedConfig = config;
  setCallNetworkConfig(config);
  emitCallEvent(CALL_EVENT.NETWORK_CONFIG, { config });
  return config;
}

async function fetchFromApi({ signal } = {}) {
  if (typeof fetch !== 'function') {
    throw new Error('fetch unavailable');
  }
  const auth = buildAccountPayload({ includeUid: false });
  const hasCredentials = (auth.accountToken || auth.accountDigest);
  if (!hasCredentials) {
    throw new Error('call network config auth missing');
  }
  const params = new URLSearchParams();
  if (auth.accountToken) params.set('accountToken', auth.accountToken);
  if (auth.accountDigest) params.set('accountDigest', auth.accountDigest);
  const url = `${API_CONFIG_URL}?${params.toString()}`;
  const response = await fetch(url, {
    cache: 'no-store',
    credentials: 'same-origin',
    signal
  });
  if (!response.ok) {
    throw new Error(`無法載入通話設定 (${response.status})`);
  }
  const json = await response.json();
  const payload = json?.config || json;
  return normalizeConfig(payload);
}

async function fetchStaticConfig({ signal } = {}) {
  if (typeof fetch !== 'function') {
    throw new Error('fetch unavailable');
  }
  const response = await fetch(STATIC_CONFIG_URL, {
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

async function fetchConfig({ signal } = {}) {
  if (typeof fetch !== 'function') {
    return getStaticFallback();
  }
  try {
    return await fetchFromApi({ signal });
  } catch (apiErr) {
    console.warn('[calls] network config API load failed', apiErr);
    try {
      return await fetchStaticConfig({ signal });
    } catch (staticErr) {
      console.warn('[calls] static network config load failed', staticErr);
      return getStaticFallback();
    }
  }
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
      console.warn('[calls] network config load failed after fallbacks', err);
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
