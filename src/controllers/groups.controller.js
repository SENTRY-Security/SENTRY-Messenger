import { z } from 'zod';
import { signHmac } from '../utils/hmac.js';
import { resolveAccountAuth, AccountAuthError } from '../utils/account-context.js';
import { AccountDigestRegex } from '../utils/account-verify.js';
import { ConversationIdRegex } from '../utils/conversation-auth.js';

const DATA_API = process.env.DATA_API_URL;
const HMAC_SECRET = process.env.DATA_API_HMAC;
const FETCH_TIMEOUT_MS = Number(process.env.DATA_API_TIMEOUT_MS || 8000);

const GroupIdRegex = /^[A-Za-z0-9_-]{8,128}$/;

async function fetchWithTimeout(url, options = {}, timeout = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const GroupMemberSchema = z.object({
  accountDigest: z.string().regex(AccountDigestRegex),
  role: z.enum(['owner', 'admin', 'member']).optional(),
  inviterAccountDigest: z.string().regex(AccountDigestRegex).optional(),
  status: z.enum(['active', 'left', 'kicked', 'removed']).optional()
});

const CreateGroupSchema = z.object({
  groupId: z.string().regex(GroupIdRegex),
  conversationId: z.string().regex(ConversationIdRegex),
  name: z.string().min(1).max(120).optional(),
  avatar: z.any().optional(),
  members: z.array(GroupMemberSchema).optional(),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

const AddMembersSchema = z.object({
  groupId: z.string().regex(GroupIdRegex),
  members: z.array(GroupMemberSchema).min(1),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

const RemoveMembersSchema = z.object({
  groupId: z.string().regex(GroupIdRegex),
  members: z.array(z.object({
    accountDigest: z.string().regex(AccountDigestRegex),
    status: z.enum(['active', 'left', 'kicked', 'removed']).optional()
  })).min(1),
  status: z.enum(['active', 'left', 'kicked', 'removed']).optional(),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

function respondAccountError(res, err, fallback = 'authorization failed') {
  if (err instanceof AccountAuthError) {
    const status = err.status || 400;
    if (err.details && typeof err.details === 'object') {
      return res.status(status).json(err.details);
    }
    return res.status(status).json({ error: 'AccountAuthFailed', message: err.message || fallback });
  }
  return res.status(500).json({ error: 'AccountAuthFailed', message: err?.message || fallback });
}

export const createGroup = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }

  let input;
  try {
    input = CreateGroupSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err?.message || 'invalid payload' });
  }

  let auth;
  try {
    auth = await resolveAccountAuth({
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }

  const payload = {
    groupId: input.groupId,
    conversationId: input.conversationId,
    creatorAccountDigest: auth.accountDigest,
    name: input.name || null,
    avatar: input.avatar ?? null,
    members: (input.members || []).map((m) => ({
      accountDigest: m.accountDigest
    }))
  };

  const path = '/d1/groups/create';
  const body = JSON.stringify(payload);
  const sig = signHmac(path, body, HMAC_SECRET);
  let upstream;
  try {
    upstream = await fetchWithTimeout(`${DATA_API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth': sig },
      body
    });
  } catch (err) {
    return res.status(502).json({ error: 'UpstreamError', message: err?.message || 'fetch failed' });
  }

  let data = null;
  try { data = await upstream.json(); } catch { data = null; }
  if (!upstream.ok) {
    return res.status(upstream.status).json({ error: 'WorkerError', details: data });
  }
  return res.json(data || { ok: true });
};

export const addGroupMembers = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }
  let input;
  try {
    input = AddMembersSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err?.message || 'invalid payload' });
  }

  try {
    await resolveAccountAuth({
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }

  const payload = {
    groupId: input.groupId,
    members: (input.members || []).map((m) => ({
      accountDigest: m.accountDigest
    }))
  };
  const path = '/d1/groups/members/add';
  const body = JSON.stringify(payload);
  const sig = signHmac(path, body, HMAC_SECRET);

  let upstream;
  try {
    upstream = await fetchWithTimeout(`${DATA_API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth': sig },
      body
    });
  } catch (err) {
    return res.status(502).json({ error: 'UpstreamError', message: err?.message || 'fetch failed' });
  }
  let data = null;
  try { data = await upstream.json(); } catch { data = null; }
  if (!upstream.ok) {
    return res.status(upstream.status).json({ error: 'WorkerError', details: data });
  }
  return res.json(data || { ok: true });
};

export const removeGroupMembers = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }
  let input;
  try {
    input = RemoveMembersSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err?.message || 'invalid payload' });
  }

  try {
    await resolveAccountAuth({
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }

  const payload = {
    groupId: input.groupId,
    members: (input.members || []).map((m) => ({
      accountDigest: m.accountDigest
    })),
    status: input.status || null
  };

  const path = '/d1/groups/members/remove';
  const body = JSON.stringify(payload);
  const sig = signHmac(path, body, HMAC_SECRET);

  let upstream;
  try {
    upstream = await fetchWithTimeout(`${DATA_API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth': sig },
      body
    });
  } catch (err) {
    return res.status(502).json({ error: 'UpstreamError', message: err?.message || 'fetch failed' });
  }
  let data = null;
  try { data = await upstream.json(); } catch { data = null; }
  if (!upstream.ok) {
    return res.status(upstream.status).json({ error: 'WorkerError', details: data });
  }
  return res.json(data || { ok: true });
};

export const getGroup = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }
  const groupId = String(req.params.groupId || '').trim();
  if (!GroupIdRegex.test(groupId)) {
    return res.status(400).json({ error: 'BadRequest', message: 'invalid groupId' });
  }

  const query = new URLSearchParams();
  query.set('groupId', groupId);
  const accountDigest = req.query?.accountDigest;
  if (!accountDigest) {
    return res.status(400).json({ error: 'BadRequest', message: 'accountDigest required' });
  }
  query.set('accountDigest', accountDigest);
  const path = `/d1/groups/get?${query.toString()}`;
  const sig = signHmac(path, '', HMAC_SECRET);
  let upstream;
  try {
    upstream = await fetchWithTimeout(`${DATA_API}${path}`, {
      method: 'GET',
      headers: { 'x-auth': sig }
    });
  } catch (err) {
    return res.status(502).json({ error: 'UpstreamError', message: err?.message || 'fetch failed' });
  }
  let data = null;
  try { data = await upstream.json(); } catch { data = null; }
  if (!upstream.ok) {
    return res.status(upstream.status).json({ error: 'WorkerError', details: data });
  }
  return res.json(data || { ok: true });
};
