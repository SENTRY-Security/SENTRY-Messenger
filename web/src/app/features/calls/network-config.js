import { buildAccountPayload, ensureDeviceId } from '../../core/store.js';
import { CALL_EVENT, emitCallEvent } from './events.js';
import { setCallNetworkConfig } from './state.js';

const API_CONFIG_URL = '/api/v1/calls/network-config';

// Hardcoded fallback so calls can proceed even when the API endpoint is unreachable.
const FALLBACK_CONFIG = Object.freeze({
  version: 1,
  turnSecretsEndpoint: '/api/v1/calls/turn-credentials',
  turnTtlSeconds: 300,
  rtcpProbe: { timeoutMs: 1500, maxAttempts: 3, targetBitrateKbps: 2000 },
  bandwidthProfiles: [],
  ice: {
    iceTransportPolicy: 'all',
    bundlePolicy: 'balanced',
    continualGatheringPolicy: 'gather_continually',
    servers: [{ urls: ['stun:stun.cloudflare.com:3478'] }]
  },
  fallback: {
    maxPeerConnectionRetries: 2,
    relayOnlyAfterAttempts: 2,
    showBlockedAfterSeconds: 20
  }
});

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
  const version = numberOrNull(raw.version, null, { min: 1 });
  const endpoint = raw.turnSecretsEndpoint ? String(raw.turnSecretsEndpoint) : null;
  return {
    version,
    turnSecretsEndpoint: endpoint,
    turnTtlSeconds: numberOrNull(raw.turnTtlSeconds, null, { min: 30 }),
    rtcpProbe: normalizeProbe(raw.rtcpProbe),
    bandwidthProfiles: normalizeProfiles(raw.bandwidthProfiles),
    ice: normalizeIce(raw.ice),
    fallback: normalizeFallback(raw.fallback)
  };
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
  const headers = {};
  if (auth.accountToken) headers['X-Account-Token'] = auth.accountToken;
  if (auth.accountDigest) headers['X-Account-Digest'] = auth.accountDigest;
  const deviceId = ensureDeviceId();
  if (!deviceId) {
    throw new Error('deviceId missing for call network config');
  }
  headers['X-Device-Id'] = deviceId;
  const url = API_CONFIG_URL;
  const response = await fetch(url, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers,
    signal
  });
  if (!response.ok) {
    throw new Error(`無法載入通話設定 (${response.status})`);
  }
  const json = await response.json();
  const payload = json?.config || json;
  return normalizeConfig(payload);
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('call network config missing');
  }
  const servers = Array.isArray(config.ice?.servers) ? config.ice.servers : [];
  if (!servers.length) {
    throw new Error('call network config missing ICE servers');
  }
  for (const entry of servers) {
    const urls = Array.isArray(entry?.urls) ? entry.urls : [];
    const normalized = urls.map((u) => (typeof u === 'string' ? u.trim() : '')).filter(Boolean);
    if (!normalized.length) {
      throw new Error('call network config contains invalid ICE server entry');
    }
  }
  if (!config.turnSecretsEndpoint || typeof config.turnSecretsEndpoint !== 'string') {
    throw new Error('call network config missing turnSecretsEndpoint');
  }
  return config;
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
  inflight = fetchFromApi({ signal })
    .then((config) => validateConfig(config))
    .then((config) => applyConfig(config))
    .catch((err) => {
      // API unreachable or returned an error — use hardcoded fallback so the
      // call can still proceed with STUN (TURN credentials are fetched separately).
      console.warn('[call] network-config fetch failed, using fallback:', err?.message || err);
      return applyConfig(normalizeConfig(FALLBACK_CONFIG));
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
