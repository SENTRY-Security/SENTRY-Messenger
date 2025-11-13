import crypto from 'node:crypto';
import { z } from 'zod';
import baseCallNetworkConfig from '../../web/src/shared/calls/network-config.json' with { type: 'json' };
import { resolveAccountAuth, AccountAuthError } from '../utils/account-context.js';
import { normalizeUidHex, normalizeAccountDigest, AccountDigestRegex } from '../utils/account-verify.js';
import { appendCallEvent, callWorkerRequest, ensureCallWorkerConfig } from '../services/call-worker.js';
import { CallIdRegex } from '../utils/call-validators.js';

const DEFAULT_SESSION_TTL = Number(process.env.CALL_SESSION_TTL_SECONDS || 90);
const TURN_SHARED_SECRET = process.env.TURN_SHARED_SECRET || '';
const TURN_TTL_SECONDS = Number(process.env.TURN_TTL_SECONDS || 300);
const TURN_STUN_URIS = parseUriList(process.env.TURN_STUN_URIS || 'stun:turn1.sentry.mobi:3478,stun:turn2.sentry.mobi:3478');
const TURN_RELAY_URIS = parseUriList(
  process.env.TURN_RELAY_URIS
  || 'turn:turn1.sentry.mobi:3478?transport=udp,turns:turn1.sentry.mobi:5349?transport=tcp,turn:turn2.sentry.mobi:3478?transport=udp,turns:turn2.sentry.mobi:5349?transport=tcp'
);
const DEFAULT_TURN_ENDPOINT = '/api/v1/calls/turn-credentials';
const RAW_CALL_NETWORK_CONFIG = baseCallNetworkConfig?.default ?? baseCallNetworkConfig ?? {};

const UidRegex = /^[0-9A-Fa-f]{14,}$/;

const BaseAccountSchema = z.object({
  uidHex: z.string().regex(UidRegex),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
});

function ensureAccountCredentials(value, ctx) {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
}

const CallInviteSchema = BaseAccountSchema.extend({
  peerUid: z.string().regex(UidRegex),
  peerAccountDigest: z.string().regex(AccountDigestRegex).optional(),
  callId: z.string().regex(CallIdRegex).optional(),
  mode: z.enum(['voice', 'video']).optional(),
  capabilities: z.record(z.any()).optional(),
  metadata: z.record(z.any()).optional(),
  expiresInSeconds: z.number().int().min(30).max(600).optional(),
  traceId: z.string().min(6).max(64).optional()
}).superRefine(ensureAccountCredentials);

const CallMutateSchema = BaseAccountSchema.extend({
  callId: z.string().regex(CallIdRegex),
  reason: z.string().max(48).optional(),
  traceId: z.string().max(64).optional()
}).superRefine(ensureAccountCredentials);

const CallAckSchema = BaseAccountSchema.extend({
  callId: z.string().regex(CallIdRegex),
  traceId: z.string().max(64).optional()
}).superRefine(ensureAccountCredentials);

const CallMetricsSchema = BaseAccountSchema.extend({
  callId: z.string().regex(CallIdRegex),
  metrics: z.record(z.any()),
  status: z.enum(['dialing', 'ringing', 'connected', 'ended', 'failed']).optional(),
  endReason: z.string().max(48).optional(),
  ended: z.boolean().optional()
}).superRefine(ensureAccountCredentials);

const TurnCredentialSchema = BaseAccountSchema.extend({
  ttlSeconds: z.number().int().min(60).max(600).optional()
}).superRefine(ensureAccountCredentials);

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
  if (TURN_STUN_URIS.length) {
    entries.push({ urls: TURN_STUN_URIS });
  }
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

function normalizeUid(value) {
  return normalizeUidHex(value);
}

function respondAccountError(res, err, fallback = 'authorization failed') {
  if (err instanceof AccountAuthError) {
    return res.status(err.status || 400).json({ error: err.name, message: err.message, details: err.details || null });
  }
  return res.status(500).json({ error: 'AccountAuthError', message: err?.message || fallback });
}

export async function inviteCall(req, res) {
  if (!ensureCallWorkerConfig(res)) return;
  const parsed = CallInviteSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'BadRequest', details: parsed.error.issues });
  }
  const input = parsed.data;
  const callerUid = normalizeUid(input.uidHex);
  try {
    var auth = await resolveAccountAuth({
      uidHex: callerUid,
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }
  const callId = (input.callId && input.callId.toLowerCase()) || crypto.randomUUID();
  const ttlSeconds = clamp(input.expiresInSeconds ?? DEFAULT_SESSION_TTL, 30, 600);
  const expiresAt = Date.now() + ttlSeconds * 1000;
  const calleeUid = normalizeUid(input.peerUid);
  const calleeDigest = input.peerAccountDigest ? normalizeAccountDigest(input.peerAccountDigest) : null;
  const sessionPayload = {
    callId,
    callerUid: auth.uidHex,
    calleeUid,
    callerAccountDigest: auth.accountDigest,
    calleeAccountDigest: calleeDigest,
    status: 'dialing',
    mode: input.mode || 'voice',
    capabilities: input.capabilities || null,
    metadata: {
      ...(input.metadata || {}),
      traceId: input.traceId || null,
      initiatedBy: auth.uidHex
    },
    expiresAt
  };
  let workerRes;
  try {
    workerRes = await callWorkerRequest('/d1/calls/session', { method: 'POST', body: sessionPayload });
  } catch (err) {
    return res.status(err.status || 502).json({ error: 'CallSessionUpsertFailed', message: err?.message, details: err?.payload || null });
  }
  await appendCallEvent({
    callId,
    type: 'call-invite',
    payload: { traceId: input.traceId || null, mode: input.mode || 'voice', capabilities: input.capabilities || null },
    fromUid: auth.uidHex,
    toUid: calleeUid,
    traceId: input.traceId || null
  });
  return res.status(200).json({
    ok: true,
    callId,
    session: workerRes?.session || null,
    expiresInSeconds: ttlSeconds
  });
}

export async function cancelCall(req, res) {
  if (!ensureCallWorkerConfig(res)) return;
  const parsed = CallMutateSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'BadRequest', details: parsed.error.issues });
  }
  const input = parsed.data;
  try {
    var auth = await resolveAccountAuth({
      uidHex: input.uidHex,
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }
  const payload = {
    callId: input.callId,
    status: 'ended',
    endReason: input.reason || 'cancelled',
    endedAt: Date.now(),
    expiresAt: Date.now() + 30_000,
    metadata: {
      cancelledBy: auth.uidHex
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
    fromUid: auth.uidHex,
    traceId: input.traceId || null
  });
  return res.status(200).json({ ok: true, session: workerRes?.session || null });
}

export async function acknowledgeCall(req, res) {
  if (!ensureCallWorkerConfig(res)) return;
  const parsed = CallAckSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'BadRequest', details: parsed.error.issues });
  }
  const input = parsed.data;
  try {
    var auth = await resolveAccountAuth({
      uidHex: input.uidHex,
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }
  const payload = {
    callId: input.callId,
    status: 'ringing',
    expiresAt: Date.now() + 90_000,
    metadata: {
      lastAckUid: auth.uidHex
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
    payload: { ackUid: auth.uidHex },
    fromUid: auth.uidHex,
    traceId: input.traceId || null
  });
  return res.status(200).json({ ok: true, session: workerRes?.session || null });
}

export async function reportCallMetrics(req, res) {
  if (!ensureCallWorkerConfig(res)) return;
  const parsed = CallMetricsSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'BadRequest', details: parsed.error.issues });
  }
  const input = parsed.data;
  try {
    var auth = await resolveAccountAuth({
      uidHex: input.uidHex,
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }
  const payload = {
    callId: input.callId,
    metrics: input.metrics,
    status: input.status,
    endReason: input.endReason,
    endedAt: input.ended ? Date.now() : undefined
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
    fromUid: auth.uidHex
  });
  return res.status(200).json({ ok: true, session: workerRes?.session || null });
}

export async function getCallSession(req, res) {
  if (!ensureCallWorkerConfig(res)) return;
  const callId = String(req.params?.callId || '').trim().toLowerCase();
  if (!CallIdRegex.test(callId)) {
    return res.status(400).json({ error: 'BadRequest', message: 'invalid call id' });
  }
  const uidHex = req.query.uidHex || req.query.uid || req.query.uid_hex;
  const accountToken = req.query.accountToken || req.query.account_token;
  const accountDigest = req.query.accountDigest || req.query.account_digest;
  if (!uidHex || (!accountToken && !accountDigest)) {
    return res.status(400).json({ error: 'BadRequest', message: 'uidHex and account credential required' });
  }
  try {
    var auth = await resolveAccountAuth({
      uidHex,
      accountToken,
      accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }
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
  const requesterMatches = session.callerUid === auth.uidHex
    || session.calleeUid === auth.uidHex
    || (session.callerAccountDigest && session.callerAccountDigest === auth.accountDigest)
    || (session.calleeAccountDigest && session.calleeAccountDigest === auth.accountDigest);
  if (!requesterMatches) {
    return res.status(403).json({ error: 'Forbidden', message: 'not a participant of this call' });
  }
  return res.status(200).json({ ok: true, session });
}

export async function getCallNetworkConfig(req, res) {
  const uidHexRaw = req.query.uidHex || req.query.uid || req.query.uid_hex;
  const accountToken = req.query.accountToken || req.query.account_token;
  const accountDigest = req.query.accountDigest || req.query.account_digest;
  if (!uidHexRaw || (!accountToken && !accountDigest)) {
    return res.status(400).json({ error: 'BadRequest', message: 'uidHex and account credential required' });
  }
  const uidHex = normalizeUid(uidHexRaw);
  if (!uidHex) {
    return res.status(400).json({ error: 'BadRequest', message: 'invalid uid' });
  }
  try {
    await resolveAccountAuth({ uidHex, accountToken, accountDigest });
  } catch (err) {
    return respondAccountError(res, err);
  }
  const config = buildCallNetworkConfig();
  return res.status(200).json({ ok: true, config });
}

export async function issueTurnCredentials(req, res) {
  if (!TURN_SHARED_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'TURN_SHARED_SECRET missing' });
  }
  const parsed = TurnCredentialSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'BadRequest', details: parsed.error.issues });
  }
  const input = parsed.data;
  try {
    var auth = await resolveAccountAuth({
      uidHex: input.uidHex,
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }
  const ttlSeconds = clamp(input.ttlSeconds ?? TURN_TTL_SECONDS, 60, 600);
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = `${expiresAt}:${auth.uidHex}`;
  const credential = crypto.createHmac('sha1', TURN_SHARED_SECRET).update(username).digest('base64');
  const iceServers = [];
  if (TURN_STUN_URIS.length) {
    iceServers.push({ urls: TURN_STUN_URIS });
  }
  if (TURN_RELAY_URIS.length) {
    iceServers.push({
      urls: TURN_RELAY_URIS,
      username,
      credential
    });
  }
  return res.status(200).json({
    ttl: ttlSeconds,
    expiresAt,
    iceServers
  });
}
