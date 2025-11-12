import crypto from 'node:crypto';
import { z } from 'zod';
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

function parseUriList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
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
