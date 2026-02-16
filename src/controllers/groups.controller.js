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
  account_digest: z.string().regex(AccountDigestRegex),
  role: z.enum(['owner', 'admin', 'member']).optional(),
  inviter_account_digest: z.string().regex(AccountDigestRegex).optional(),
  status: z.enum(['active', 'left', 'kicked', 'removed']).optional()
});

const CreateGroupSchema = z.object({
  group_id: z.string().regex(GroupIdRegex),
  conversation_id: z.string().regex(ConversationIdRegex),
  name: z.string().min(1).max(120).optional(),
  avatar: z.any().optional(),
  members: z.array(GroupMemberSchema).optional(),
  account_token: z.string().min(8).optional(),
  account_digest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.account_token && !value.account_digest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'account_token or account_digest required' });
  }
});

const AddMembersSchema = z.object({
  group_id: z.string().regex(GroupIdRegex),
  members: z.array(GroupMemberSchema).min(1),
  account_token: z.string().min(8).optional(),
  account_digest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.account_token && !value.account_digest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'account_token or account_digest required' });
  }
});

const RemoveMembersSchema = z.object({
  group_id: z.string().regex(GroupIdRegex),
  members: z.array(z.object({
    account_digest: z.string().regex(AccountDigestRegex),
    status: z.enum(['active', 'left', 'kicked', 'removed']).optional()
  })).min(1),
  status: z.enum(['active', 'left', 'kicked', 'removed']).optional(),
  account_token: z.string().min(8).optional(),
  account_digest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.account_token && !value.account_digest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'account_token or account_digest required' });
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
      accountToken: input.account_token,
      accountDigest: input.account_digest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }

  const payload = {
    groupId: input.group_id,
    conversationId: input.conversation_id,
    creatorAccountDigest: auth.accountDigest,
    name: input.name || null,
    avatar: input.avatar ?? null,
    members: (input.members || []).map((m) => ({
      accountDigest: m.account_digest
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
      accountToken: input.account_token,
      accountDigest: input.account_digest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }

  const payload = {
    groupId: input.group_id,
    members: (input.members || []).map((m) => ({
      accountDigest: m.account_digest
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
      accountToken: input.account_token,
      accountDigest: input.account_digest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }

  const payload = {
    groupId: input.group_id,
    members: (input.members || []).map((m) => ({
      accountDigest: m.account_digest
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
  const accountDigest = req.query?.account_digest || req.query?.accountDigest;
  if (!accountDigest) {
    return res.status(400).json({ error: 'BadRequest', message: 'account_digest required' });
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
