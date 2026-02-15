import crypto from 'node:crypto';
import { z } from 'zod';
import baseCallNetworkConfig from '../../web/src/shared/calls/network-config.json' with { type: 'json' };
import { resolveAccountAuth, AccountAuthError } from '../utils/account-context.js';
import { normalizeAccountDigest, AccountDigestRegex } from '../utils/account-verify.js';
import { appendCallEvent, callWorkerRequest, ensureCallWorkerConfig, hasCallWorkerConfig, touchDeviceRegistry, assertDeviceIdActive, listActiveDevices } from '../services/call-worker.js';
import { CallIdRegex } from '../utils/call-validators.js';

const DEFAULT_SESSION_TTL = Number(process.env.CALL_SESSION_TTL_SECONDS || 90);
const TURN_TTL_SECONDS = Number(process.env.TURN_TTL_SECONDS || 300);

// Cloudflare TURN configuration
const CF_TURN_TOKEN_ID = process.env.CLOUDFLARE_TURN_TOKEN_ID || '';
const CF_TURN_TOKEN_KEY = process.env.CLOUDFLARE_TURN_TOKEN_KEY || '';

const DEFAULT_TURN_ENDPOINT = '/api/v1/calls/turn-credentials';
const RAW_CALL_NETWORK_CONFIG = baseCallNetworkConfig?.default ?? baseCallNetworkConfig ?? {};

const BaseAccountSchema = z.object({
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
});

const withAccountAuthGuard = (schema) => schema.superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

const CallInviteSchema = withAccountAuthGuard(BaseAccountSchema.extend({
  peerAccountDigest: z.string().regex(AccountDigestRegex),
  callId: z.string().regex(CallIdRegex).optional(),
  mode: z.enum(['voice', 'video']).optional(),
  preferredDeviceId: z.string().min(1).optional(),
  capabilities: z.record(z.any()).optional(),
  metadata: z.record(z.any()).optional(),
  expiresInSeconds: z.number().int().min(30).max(600).optional(),
  traceId: z.string().min(6).max(64).optional(),
  deviceId: z.string().min(1).optional()
}));

const CallMutateSchema = withAccountAuthGuard(BaseAccountSchema.extend({
  callId: z.string().regex(CallIdRegex),
  reason: z.string().max(48).optional(),
  traceId: z.string().max(64).optional(),
  deviceId: z.string().min(1).optional()
}));

const CallAckSchema = withAccountAuthGuard(BaseAccountSchema.extend({
  callId: z.string().regex(CallIdRegex),
  traceId: z.string().max(64).optional(),
  deviceId: z.string().min(1).optional()
}));

const CallMetricsSchema = withAccountAuthGuard(BaseAccountSchema.extend({
  callId: z.string().regex(CallIdRegex),
  metrics: z.record(z.any()),
  status: z.enum(['dialing', 'ringing', 'connected', 'ended', 'failed']).optional(),
  endReason: z.string().max(48).optional(),
  ended: z.boolean().optional(),
  deviceId: z.string().min(1).optional()
}));

const TurnCredentialSchema = withAccountAuthGuard(BaseAccountSchema.extend({
  ttlSeconds: z.number().int().min(60).max(600).optional()
}));

function cloneNetworkConfigTemplate() {
  if (!RAW_CALL_NETWORK_CONFIG || typeof RAW_CALL_NETWORK_CONFIG !== 'object') {
    return {};
  }
  if (typeof structuredClone === 'function') {
    return structuredClone(RAW_CALL_NETWORK_CONFIG);
  }
  return JSON.parse(JSON.stringify(RAW_CALL_NETWORK_CONFIG));
}

function parseUriList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
const EXTRA_STUN_URIS = parseUriList(process.env.CALL_EXTRA_STUN_URIS || '');

function pickNumber(value, fallback) {
  if (value == null) return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function boundedNumber(value, fallback, min, max) {
  const resolved = pickNumber(value, fallback);
  if (!Number.isFinite(resolved)) return fallback;
  return clamp(resolved, min, max);
}

function sanitizeIceServers(list = []) {
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const urlsInput = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
      const urls = urlsInput
        .map((url) => (typeof url === 'string' ? url.trim() : ''))
        .filter((url) => url.length);
      if (!urls.length) return null;
      const normalized = { urls };
      if (entry.username) normalized.username = String(entry.username);
      if (entry.credential) normalized.credential = String(entry.credential);
      return normalized;
    })
    .filter(Boolean);
}

function dedupeIceServers(list = []) {
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const urls = Array.isArray(entry.urls) ? entry.urls : [];
    const normalizedUrls = urls
      .map((url) => (typeof url === 'string' ? url.trim() : ''))
      .filter((url) => url.length);
    if (!normalizedUrls.length) continue;
    const server = { urls: normalizedUrls };
    if (entry.username) server.username = String(entry.username);
    if (entry.credential) server.credential = String(entry.credential);
    const key = `${server.username || ''}|${normalizedUrls.slice().sort().join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(server);
  }
  return out;
}

function buildEnvStunServers() {
  const entries = [];
  // Only use extra STUN URIs from env if configured
  if (EXTRA_STUN_URIS.length) {
    entries.push({ urls: EXTRA_STUN_URIS });
  }
  return entries;
}

function buildIceConfig(initial = {}) {
  const base = {
    iceTransportPolicy: typeof initial?.iceTransportPolicy === 'string' ? initial.iceTransportPolicy : 'all',
    bundlePolicy: typeof initial?.bundlePolicy === 'string' ? initial.bundlePolicy : 'balanced',
    continualGatheringPolicy: typeof initial?.continualGatheringPolicy === 'string' ? initial.continualGatheringPolicy : 'gather_continually',
    servers: sanitizeIceServers(initial?.servers || [])
  };
  const config = {
    iceTransportPolicy: process.env.CALL_ICE_TRANSPORT_POLICY || base.iceTransportPolicy,
    bundlePolicy: process.env.CALL_ICE_BUNDLE_POLICY || base.bundlePolicy,
    continualGatheringPolicy: process.env.CALL_ICE_GATHER_POLICY || base.continualGatheringPolicy
  };
  config.servers = dedupeIceServers([...base.servers, ...buildEnvStunServers()]);
  return config;
}

function buildRtcpProbeConfig(initial = {}) {
  const defaults = {
    timeoutMs: Number.isFinite(initial?.timeoutMs) ? initial.timeoutMs : 1500,
    maxAttempts: Number.isFinite(initial?.maxAttempts) ? initial.maxAttempts : 3,
    targetBitrateKbps: Number.isFinite(initial?.targetBitrateKbps) ? initial.targetBitrateKbps : 2000
  };
  return {
    timeoutMs: boundedNumber(process.env.CALL_RTCP_TIMEOUT_MS, defaults.timeoutMs, 250, 10000),
    maxAttempts: boundedNumber(process.env.CALL_RTCP_MAX_ATTEMPTS, defaults.maxAttempts, 1, 10),
    targetBitrateKbps: boundedNumber(process.env.CALL_RTCP_TARGET_KBPS, defaults.targetBitrateKbps, 64, 10000)
  };
}

function buildFallbackConfig(initial = {}) {
  const defaults = {
    maxPeerConnectionRetries: Number.isFinite(initial?.maxPeerConnectionRetries) ? initial.maxPeerConnectionRetries : 2,
    relayOnlyAfterAttempts: Number.isFinite(initial?.relayOnlyAfterAttempts) ? initial.relayOnlyAfterAttempts : 2,
    showBlockedAfterSeconds: Number.isFinite(initial?.showBlockedAfterSeconds) ? initial.showBlockedAfterSeconds : 20
  };
  return {
    maxPeerConnectionRetries: boundedNumber(process.env.CALL_FALLBACK_MAX_RETRIES, defaults.maxPeerConnectionRetries, 0, 10),
    relayOnlyAfterAttempts: boundedNumber(process.env.CALL_FALLBACK_RELAY_AFTER, defaults.relayOnlyAfterAttempts, 0, 10),
    showBlockedAfterSeconds: boundedNumber(process.env.CALL_FALLBACK_BLOCKED_AFTER, defaults.showBlockedAfterSeconds, 1, 120)
  };
}

function buildCallNetworkConfig() {
  const template = cloneNetworkConfigTemplate();
  const config = typeof template === 'object' && template ? template : {};
  const versionFallback = Number.isFinite(config.version) ? config.version : 1;
  config.version = boundedNumber(process.env.CALL_NETWORK_VERSION, versionFallback, 1, 999);
  config.turnSecretsEndpoint = (process.env.CALL_TURN_ENDPOINT || config.turnSecretsEndpoint || DEFAULT_TURN_ENDPOINT).trim();
  const ttlFallback = Number.isFinite(config.turnTtlSeconds) ? config.turnTtlSeconds : TURN_TTL_SECONDS;
  config.turnTtlSeconds = boundedNumber(process.env.TURN_TTL_SECONDS, ttlFallback, 60, 3600);
  config.rtcpProbe = buildRtcpProbeConfig(config.rtcpProbe);
  config.bandwidthProfiles = Array.isArray(config.bandwidthProfiles) ? config.bandwidthProfiles : [];
  config.ice = buildIceConfig(config.ice);
  config.fallback = buildFallbackConfig(config.fallback);
  return config;
}

function clamp(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.max(min, Math.min(max, num));
}

function respondAccountError(res, err, fallback = 'authorization failed') {
  if (err instanceof AccountAuthError) {
    return res.status(err.status || 400).json({ error: err.name, message: err.message, details: err.details || null });
  }
  return res.status(500).json({ error: 'AccountAuthError', message: err?.message || fallback });
}

async function assertActiveDeviceOrFail(res, accountDigest, deviceId) {
  try {
    await touchDeviceRegistry({ accountDigest, deviceId });
    await assertDeviceIdActive({ accountDigest, deviceId });
  } catch (err) {
    const status = err?.status || 403;
    const code = err?.code || 'DEVICE_NOT_ACTIVE';
    res.status(status).json({ error: code, message: err?.message || 'device not active' });
    return false;
  }
  return true;
}

async function resolveTargetDeviceId(peerAccountDigest, preferredDeviceId = null) {
  if (preferredDeviceId) {
    await assertDeviceIdActive({ accountDigest: peerAccountDigest, deviceId: preferredDeviceId });
    return preferredDeviceId;
  }
  const devices = await listActiveDevices({ accountDigest: peerAccountDigest });
  if (!devices.length) {
    const err = new Error('peer-no-active-device');
    err.status = 409;
    err.code = 'peer-no-active-device';
    throw err;
  }
  const first = devices[0];
  if (!first?.deviceId) {
    const err = new Error('peer-no-active-device');
    err.status = 409;
    err.code = 'peer-no-active-device';
    throw err;
  }
  return first.deviceId;
}

export async function inviteCall(req, res) {
  const workerAvailable = hasCallWorkerConfig();
  const parsed = CallInviteSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'BadRequest', details: parsed.error.issues });
  }
  const input = parsed.data;
  const senderDeviceId = req.get('x-device-id') || null;
  if (!senderDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'deviceId header required' });
  }
  const peerDigest = normalizeAccountDigest(input.peerAccountDigest);
  if (!peerDigest) {
    return res.status(400).json({ error: 'BadRequest', message: 'peerAccountDigest required' });
  }
  try {
    var auth = await resolveAccountAuth({
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }
  const callId = (input.callId && input.callId.toLowerCase()) || crypto.randomUUID();
  const ttlSeconds = clamp(input.expiresInSeconds ?? DEFAULT_SESSION_TTL, 30, 600);

  // Degraded mode: Data API worker not configured — skip device validation
  // and D1 session creation, but still allow calls via WebSocket signaling.
  if (!workerAvailable) {
    const targetDeviceId = input.preferredDeviceId || null;
    if (!targetDeviceId) {
      return res.status(400).json({ error: 'BadRequest', message: 'preferredDeviceId required when data worker is unavailable' });
    }
    return res.status(200).json({
      ok: true,
      callId,
      targetDeviceId,
      session: null,
      expiresInSeconds: ttlSeconds,
      degraded: true
    });
  }

  // Attempt full flow with Data API worker; fall back to degraded mode on worker failure.
  try {
    const okDevice = await assertActiveDeviceOrFail(res, auth.accountDigest, senderDeviceId);
    if (!okDevice) return;
    let targetDeviceId;
    try {
      targetDeviceId = await resolveTargetDeviceId(peerDigest, input.preferredDeviceId || null);
    } catch (err) {
      // If preferred device was given and device validation failed, fall through to degraded
      if (!input.preferredDeviceId) {
        const status = err?.status || 409;
        const code = err?.code || 'peer-device-not-active';
        return res.status(status).json({ error: code, message: err?.message || code });
      }
      throw err; // let outer catch handle with degraded fallback
    }
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const sessionPayload = {
      callId,
      callerAccountDigest: auth.accountDigest,
      calleeAccountDigest: peerDigest,
      callerDeviceId: senderDeviceId,
      status: 'dialing',
      mode: input.mode || 'voice',
      capabilities: input.capabilities || null,
      metadata: {
        ...(input.metadata || {}),
        traceId: input.traceId || null,
        initiatedBy: auth.accountDigest
      },
      targetDeviceId,
      expiresAt
    };
    let workerRes;
    try {
      workerRes = await callWorkerRequest('/d1/calls/session', { method: 'POST', body: sessionPayload });
    } catch (err) {
      // Session creation failed but we already validated devices — return degraded success
      console.error('[calls] session upsert failed, using degraded mode:', err?.message || err);
      return res.status(200).json({
        ok: true,
        callId,
        targetDeviceId,
        session: null,
        expiresInSeconds: ttlSeconds,
        degraded: true
      });
    }
    await appendCallEvent({
      callId,
      type: 'call-invite',
      payload: { traceId: input.traceId || null, mode: input.mode || 'voice', capabilities: input.capabilities || null, targetDeviceId },
      fromAccountDigest: auth.accountDigest,
      toAccountDigest: peerDigest,
      traceId: input.traceId || null
    });
    return res.status(200).json({
      ok: true,
      callId,
      targetDeviceId,
      session: workerRes?.session || null,
      expiresInSeconds: ttlSeconds
    });
  } catch (workerErr) {
    // Data API worker is configured but unreachable/broken — fall back to degraded mode
    console.error('[calls] worker unavailable, using degraded mode:', workerErr?.message || workerErr);
    const targetDeviceId = input.preferredDeviceId || null;
    if (!targetDeviceId) {
      return res.status(400).json({ error: 'BadRequest', message: 'preferredDeviceId required when data worker is unavailable' });
    }
    return res.status(200).json({
      ok: true,
      callId,
      targetDeviceId,
      session: null,
      expiresInSeconds: ttlSeconds,
      degraded: true
    });
  }
}

export async function cancelCall(req, res) {
  const workerAvailable = hasCallWorkerConfig();
  const parsed = CallMutateSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'BadRequest', details: parsed.error.issues });
  }
  const input = parsed.data;
  const senderDeviceId = req.get('x-device-id') || null;
  if (!senderDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'deviceId header required' });
  }
  try {
    var auth = await resolveAccountAuth({
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }
  if (!workerAvailable) {
    return res.status(200).json({ ok: true, session: null, degraded: true });
  }
  const okDevice = await assertActiveDeviceOrFail(res, auth.accountDigest, senderDeviceId);
  if (!okDevice) return;
  const payload = {
    callId: input.callId,
    status: 'ended',
    endReason: input.reason || 'cancelled',
    endedAt: Date.now(),
    expiresAt: Date.now() + 30_000,
    metadata: {
      cancelledBy: auth.accountDigest,
      cancelledByDeviceId: senderDeviceId
    }
  };
  let workerRes;
  try {
    workerRes = await callWorkerRequest('/d1/calls/session', { method: 'POST', body: payload });
  } catch (err) {
    return res.status(err.status || 502).json({ error: 'CallCancelFailed', message: err?.message, details: err?.payload || null });
  }
  await appendCallEvent({
    callId: input.callId,
    type: 'call-cancel',
    payload: { reason: input.reason || 'cancelled' },
    fromAccountDigest: auth.accountDigest,
    traceId: input.traceId || null
  });
  return res.status(200).json({ ok: true, session: workerRes?.session || null });
}

export async function acknowledgeCall(req, res) {
  const workerAvailable = hasCallWorkerConfig();
  const parsed = CallAckSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'BadRequest', details: parsed.error.issues });
  }
  const input = parsed.data;
  const senderDeviceId = req.get('x-device-id') || null;
  if (!senderDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'deviceId header required' });
  }
  try {
    var auth = await resolveAccountAuth({
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }
  if (!workerAvailable) {
    return res.status(200).json({ ok: true, session: null, degraded: true });
  }
  const okDevice = await assertActiveDeviceOrFail(res, auth.accountDigest, senderDeviceId);
  if (!okDevice) return;
  const payload = {
    callId: input.callId,
    status: 'ringing',
    expiresAt: Date.now() + 90_000,
    metadata: {
      lastAckAccountDigest: auth.accountDigest,
      lastAckDeviceId: senderDeviceId
    }
  };
  let workerRes;
  try {
    workerRes = await callWorkerRequest('/d1/calls/session', { method: 'POST', body: payload });
  } catch (err) {
    return res.status(err.status || 502).json({ error: 'CallAckFailed', message: err?.message, details: err?.payload || null });
  }
  await appendCallEvent({
    callId: input.callId,
    type: 'call-ack',
    payload: { ackAccountDigest: auth.accountDigest },
    fromAccountDigest: auth.accountDigest,
    traceId: input.traceId || null
  });
  return res.status(200).json({ ok: true, session: workerRes?.session || null });
}

export async function reportCallMetrics(req, res) {
  const workerAvailable = hasCallWorkerConfig();
  const parsed = CallMetricsSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'BadRequest', details: parsed.error.issues });
  }
  const input = parsed.data;
  const senderDeviceId = req.get('x-device-id') || null;
  if (!senderDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'deviceId header required' });
  }
  try {
    var auth = await resolveAccountAuth({
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }
  if (!workerAvailable) {
    return res.status(200).json({ ok: true, session: null, degraded: true });
  }
  const okDevice = await assertActiveDeviceOrFail(res, auth.accountDigest, senderDeviceId);
  if (!okDevice) return;
  const payload = {
    callId: input.callId,
    metrics: input.metrics,
    status: input.status,
    endReason: input.endReason,
    endedAt: input.ended ? Date.now() : undefined,
    senderDeviceId
  };
  let workerRes;
  try {
    workerRes = await callWorkerRequest('/d1/calls/session', { method: 'POST', body: payload });
  } catch (err) {
    return res.status(err.status || 502).json({ error: 'CallMetricsFailed', message: err?.message, details: err?.payload || null });
  }
  await appendCallEvent({
    callId: input.callId,
    type: 'call-report-metrics',
    payload: input.metrics,
    fromAccountDigest: auth.accountDigest
  });
  return res.status(200).json({ ok: true, session: workerRes?.session || null });
}

export async function getCallSession(req, res) {
  if (!hasCallWorkerConfig()) {
    return res.status(200).json({ ok: true, session: null, degraded: true });
  }
  const callId = String(req.params?.callId || '').trim().toLowerCase();
  if (!CallIdRegex.test(callId)) {
    return res.status(400).json({ error: 'BadRequest', message: 'invalid call id' });
  }
  const accountToken = req.get('x-account-token');
  const accountDigest = req.get('x-account-digest');
  const senderDeviceId = req.get('x-device-id') || null;
  if (!accountToken && !accountDigest) {
    return res.status(400).json({ error: 'BadRequest', message: 'accountToken or accountDigest required' });
  }
  if (!senderDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'deviceId header required' });
  }
  try {
    var auth = await resolveAccountAuth({
      accountToken,
      accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }
  const okDevice = await assertActiveDeviceOrFail(res, auth.accountDigest, senderDeviceId);
  if (!okDevice) return;
  let workerRes;
  try {
    workerRes = await callWorkerRequest(`/d1/calls/session?callId=${encodeURIComponent(callId)}`, { method: 'GET' });
  } catch (err) {
    return res.status(err.status || 502).json({ error: 'CallFetchFailed', message: err?.message, details: err?.payload || null });
  }
  const session = workerRes?.session;
  if (!session) {
    return res.status(404).json({ error: 'NotFound', message: 'call session absent' });
  }
  const requesterMatches = (session.caller_account_digest && session.caller_account_digest === auth.accountDigest)
    || (session.callee_account_digest && session.callee_account_digest === auth.accountDigest);
  if (!requesterMatches) {
    return res.status(403).json({ error: 'Forbidden', message: 'not a participant of this call' });
  }
  return res.status(200).json({ ok: true, session });
}

export async function getCallNetworkConfig(req, res) {
  const accountToken = req.get('x-account-token');
  const accountDigest = req.get('x-account-digest');
  const senderDeviceId = req.get('x-device-id') || null;
  if (!accountToken && !accountDigest) {
    return res.status(400).json({ error: 'BadRequest', message: 'accountToken or accountDigest required' });
  }
  if (!senderDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'deviceId header required' });
  }
  try {
    var auth = await resolveAccountAuth({ accountToken, accountDigest });
  } catch (err) {
    return respondAccountError(res, err);
  }
  if (hasCallWorkerConfig()) {
    const okDevice = await assertActiveDeviceOrFail(res, auth.accountDigest, senderDeviceId);
    if (!okDevice) return;
  }
  const config = buildCallNetworkConfig();
  return res.status(200).json({ ok: true, config });
}

export async function issueTurnCredentials(req, res) {
  // Check Cloudflare TURN configuration
  if (!CF_TURN_TOKEN_ID || !CF_TURN_TOKEN_KEY) {
    return res.status(500).json({ error: 'ConfigError', message: 'Cloudflare TURN credentials not configured' });
  }
  const senderDeviceId = req.get('x-device-id') || null;
  if (!senderDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'deviceId header required' });
  }
  const parsed = TurnCredentialSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'BadRequest', details: parsed.error.issues });
  }
  const input = parsed.data;
  try {
    var auth = await resolveAccountAuth({
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }
  if (hasCallWorkerConfig()) {
    const okDevice = await assertActiveDeviceOrFail(res, auth.accountDigest, senderDeviceId);
    if (!okDevice) return;
  }
  const ttlSeconds = clamp(input.ttlSeconds ?? TURN_TTL_SECONDS, 60, 600);

  // Request credentials from Cloudflare TURN API
  try {
    const cfResponse = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${CF_TURN_TOKEN_ID}/credentials/generate`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CF_TURN_TOKEN_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ttl: ttlSeconds })
      }
    );

    if (!cfResponse.ok) {
      const errorText = await cfResponse.text();
      console.error('[TURN] Cloudflare API error:', cfResponse.status, errorText);
      return res.status(502).json({ 
        error: 'TurnCredentialsFailed', 
        message: `Cloudflare TURN API error: ${cfResponse.status}` 
      });
    }

    const cfData = await cfResponse.json();
    
    // Cloudflare returns: { iceServers: { urls: [...], username, credential } }
    const iceServers = [];
    
    if (cfData.iceServers) {
      // Cloudflare returns a single iceServers object, wrap in array
      const cfServer = cfData.iceServers;
      if (cfServer.urls && cfServer.username && cfServer.credential) {
        iceServers.push({
          urls: Array.isArray(cfServer.urls) ? cfServer.urls : [cfServer.urls],
          username: cfServer.username,
          credential: cfServer.credential
        });
      }
    }

    return res.status(200).json({
      ttl: ttlSeconds,
      expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
      iceServers
    });

  } catch (err) {
    console.error('[TURN] Cloudflare API request failed:', err);
    return res.status(502).json({ 
      error: 'TurnCredentialsFailed', 
      message: err?.message || 'Cloudflare TURN API request failed' 
    });
  }
}
