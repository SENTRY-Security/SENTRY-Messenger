import { CreateMessageSchema, CreateSecureMessageSchema } from '../schemas/message.schema.js';
import crypto from 'node:crypto';
import { signHmac } from '../utils/hmac.js';
import { z } from 'zod';
import fs from 'node:fs/promises';
import { resolveAccountAuth, AccountAuthError } from '../utils/account-context.js';
import { logger } from '../utils/logger.js';
import { normalizeConversationId, authorizeConversationAccess, isSystemOwnedConversation } from '../utils/conversation-auth.js';
import { AccountDigestRegex } from '../utils/account-verify.js';

export const getHealth = (req, res) => {
  res.json({ ok: true, ts: Date.now() });
};

export const getStatus = (req, res) => {
  res.json({
    name: process.env.SERVICE_NAME,
    version: process.env.SERVICE_VERSION,
    env: process.env.NODE_ENV
  });
};

const DATA_API = process.env.DATA_API_URL;     // e.g. https://message-data.<account>.workers.dev
const HMAC_SECRET = process.env.DATA_API_HMAC; // must match the Worker secret HMAC_SECRET
const FETCH_TIMEOUT_MS = Number(process.env.DATA_API_TIMEOUT_MS || 8000);
const SECURE_DEBUG_LOG = process.env.SECURE_MSG_DEBUG_LOG || '';

function appendSecureDebug(entry) {
  if (!SECURE_DEBUG_LOG) return;
  const payload = { ts: Date.now(), ...entry };
  fs.appendFile(SECURE_DEBUG_LOG, `${JSON.stringify(payload)}\n`).catch(() => {});
}

const inflightSecureRequests = new Map();
function inflightKey({ conversationId, cursorTs, limit }) {
  return `${conversationId || ''}::${cursorTs || 'null'}::${limit || 'null'}`;
}
function trackInflight({ key, controller }) {
  inflightSecureRequests.set(key, { startedAt: Date.now(), controller });
  const cleanup = () => inflightSecureRequests.delete(key);
  controller.signal.addEventListener('abort', cleanup, { once: true });
  return cleanup;
}

async function fetchWithTimeout(url, options = {}, timeout = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const DeleteMessagesSchema = z.object({
  ids: z.array(z.string().min(1)),
  conversationId: z.string().min(1),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional(),
  conversationFingerprint: z.string().min(8).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

const DeleteSecureConversationSchema = z.object({
  conversationId: z.string().min(8),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional(),
  conversationFingerprint: z.string().min(8).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

function firstString(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const resolved = firstString(entry);
      if (resolved) return resolved;
    }
  }
  return null;
}

function extractAccountFromRequest(req) {
  const header = (name) => firstString(req.get(name));
  const queryVal = (name) => firstString(req.query?.[name]);
  const accountToken = firstString(
    header('x-account-token'),
    queryVal('accountToken'),
    queryVal('account_token')
  );
  const accountDigest = firstString(
    header('x-account-digest'),
    queryVal('accountDigest'),
    queryVal('account_digest')
  );
  const conversationFingerprint = firstString(
    header('x-conversation-fingerprint'),
    queryVal('conversationFingerprint'),
    queryVal('conversation_fingerprint')
  );
  return { accountToken, accountDigest, conversationFingerprint };
}

async function authorizeAccountForConversation({ conversationId, accountToken, accountDigest, fingerprint }) {
  const normalizedConv = normalizeConversationId(conversationId);
  if (!normalizedConv) {
    throw new AccountAuthError('invalid conversationId', 400);
  }

  const { accountDigest: resolvedDigest } = await resolveAccountAuth({
    accountToken,
    accountDigest
  });

  if (!isSystemOwnedConversation({ convId: normalizedConv, accountDigest: resolvedDigest })) {
    try {
      await authorizeConversationAccess({
        convId: normalizedConv,
        accountDigest: resolvedDigest,
        fingerprint: fingerprint || null
      });
    } catch (err) {
      const status = err?.status || 502;
      const details = err?.details;
      const message = err?.message || 'conversation access denied';
      throw new AccountAuthError(message, status, details);
    }
  }

  return { conversationId: normalizedConv, accountDigest: resolvedDigest };
}

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

export const createMessage = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }

  // Validate body
  const input = CreateMessageSchema.parse(req.body);
  const {
    convId: rawConvId,
    accountToken,
    accountDigest,
    conversationFingerprint,
    ...messageInput
  } = input;

  let auth;
  try {
    auth = await authorizeAccountForConversation({
      conversationId: rawConvId,
      accountToken,
      accountDigest,
      fingerprint: conversationFingerprint
    });
  } catch (err) {
    return respondAccountError(res, err, 'conversation authorization failed');
  }

  // Build payload to D1 (index only, never plaintext)
  const payload = {
    msgId: crypto.randomUUID(),
    convId: auth.conversationId,
    senderId: req.headers['x-client-id'] || auth.accountDigest || 'unknown',
    type: messageInput.type,
    aead: messageInput.aead,
    headerJson: JSON.stringify(messageInput.header || {}),
    objKey: messageInput.header?.obj || null,
    sizeBytes: messageInput.header?.size ?? null,
    ts: Math.floor(Date.now() / 1000)
  };

  const path = '/d1/messages';
  const body = JSON.stringify(payload);
  const sig = signHmac(path, body, HMAC_SECRET);

  try {
    const r = await fetch(`${DATA_API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth': sig },
      body
    });

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return res.status(502).json({ error: 'D1WriteFailed', status: r.status, details: text });
    }

    // Accepted: index stored (async any downstream processing)
    return res.status(202).json({
      accepted: true,
      convId: payload.convId,
      msgId: payload.msgId
    });
  } catch (err) {
    return res.status(502).json({ error: 'UpstreamError', message: err?.message || 'fetch failed' });
  }
};

export const createSecureMessage = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }

  let input;
  try {
    input = CreateSecureMessageSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err?.message || 'invalid input' });
  }

  const {
    conversation_id: rawConversationId,
    accountToken,
    accountDigest,
    conversationFingerprint,
    ...messageInput
  } = input;

  let auth;
  try {
    auth = await authorizeAccountForConversation({
      conversationId: rawConversationId,
      accountToken,
      accountDigest,
      fingerprint: conversationFingerprint
    });
  } catch (err) {
    return respondAccountError(res, err, 'conversation authorization failed');
  }

  const messageId = messageInput.id || crypto.randomUUID();
  const createdAt = Number.isFinite(messageInput.created_at) ? messageInput.created_at : Math.floor(Date.now() / 1000);

  const payload = {
    id: messageId,
    conversation_id: auth.conversationId,
    payload_envelope: messageInput.payload_envelope,
    created_at: createdAt
  };

  const path = '/d1/messages';
  const body = JSON.stringify(payload);
  const sig = signHmac(path, body, HMAC_SECRET);

  try {
    const r = await fetch(`${DATA_API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth': sig },
      body
    });

    let workerJson = null;
    try {
      workerJson = await r.json();
    } catch {
      workerJson = null;
    }

    if (!r.ok) {
      return res.status(502).json({
        error: 'D1WriteFailed',
        status: r.status,
        details: workerJson || null
      });
    }

    return res.status(202).json({
      accepted: true,
      id: messageId,
      conversation_id: input.conversation_id,
      created_at: createdAt,
      worker: workerJson
    });
  } catch (err) {
    return res.status(502).json({ error: 'UpstreamError', message: err?.message || 'fetch failed' });
  }
};
export const listMessages = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }
  const convIdRaw = req.params.convId;
  const account = extractAccountFromRequest(req);

  let auth;
  try {
    auth = await authorizeAccountForConversation({
      conversationId: convIdRaw,
      accountToken: account.accountToken,
      accountDigest: account.accountDigest,
      fingerprint: account.conversationFingerprint
    });
  } catch (err) {
    return respondAccountError(res, err, 'conversation authorization failed');
  }

  // Build query string
  const params = new URLSearchParams();
  params.append('convId', auth.conversationId);
  if (req.query.cursorTs) params.append('cursorTs', req.query.cursorTs);
  if (req.query.limit) params.append('limit', req.query.limit);
  const path = `/d1/messages?${params.toString()}`;
  const sig = signHmac(path, '', HMAC_SECRET);
  try {
    const r = await fetch(`${DATA_API}${path}`, {
      headers: { 'x-auth': sig }
    });
    if (!r.ok) {
      let details;
      try {
        details = await r.json();
      } catch {
        details = await r.text().catch(() => '');
      }
      return res.status(502).json({ error: 'D1ReadFailed', status: r.status, details });
    }
    try {
      const data = await r.json();
      return res.json(data);
    } catch (err) {
      return res.status(502).json({ error: 'ParseError', message: err?.message || 'invalid JSON from worker' });
    }
  } catch (err) {
    return res.status(502).json({ error: 'UpstreamError', message: err?.message || 'fetch failed' });
  }
};

export const listSecureMessages = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }

  const conversationIdRaw = req.query.conversationId || req.query.conversation_id;
  if (!conversationIdRaw) {
    return res.status(400).json({ error: 'BadRequest', message: 'conversationId required' });
  }

  const account = extractAccountFromRequest(req);
  let auth;
  try {
    auth = await authorizeAccountForConversation({
      conversationId: conversationIdRaw,
      accountToken: account.accountToken,
      accountDigest: account.accountDigest,
      fingerprint: account.conversationFingerprint
    });
  } catch (err) {
    return respondAccountError(res, err, 'conversation authorization failed');
  }

  const params = new URLSearchParams();
  params.set('conversationId', auth.conversationId);
  if (req.query.cursorTs) params.set('cursorTs', String(req.query.cursorTs));
  if (req.query.limit) params.set('limit', String(req.query.limit));

  const path = `/d1/messages?${params.toString()}`;
  const sig = signHmac(path, '', HMAC_SECRET);
  const inflightInfo = {
    conversationId: auth.conversationId,
    cursorTs: req.query.cursorTs ? Number(req.query.cursorTs) : null,
    limit: req.query.limit ? Number(req.query.limit) : null
  };
  const key = inflightKey(inflightInfo);
  if (inflightSecureRequests.has(key)) {
    logger.warn({
      event: 'd1.listSecureMessages.dedup',
      ...inflightInfo
    }, 'duplicate listSecureMessages request detected');
    appendSecureDebug({ stage: 'dedup', ...inflightInfo });
  }

  try {
    logger.debug({
      event: 'd1.listSecureMessages.request',
      conversationId: auth.conversationId,
      cursorTs: req.query.cursorTs ? Number(req.query.cursorTs) : null,
      limit: req.query.limit ? Number(req.query.limit) : null
    }, 'fetching secure messages from D1');
    appendSecureDebug({
      stage: 'request',
      conversationId: auth.conversationId,
      cursorTs: req.query.cursorTs ? Number(req.query.cursorTs) : null,
      limit: req.query.limit ? Number(req.query.limit) : null
    });
    const controller = new AbortController();
    const cleanupInflight = trackInflight({ key, controller });
    const r = await fetch(`${DATA_API}${path}`, {
      headers: { 'x-auth': sig },
      signal: controller.signal
    }).finally(() => cleanupInflight());
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!r.ok) {
      logger.warn({
        event: 'd1.listSecureMessages.error',
        conversationId: auth.conversationId,
        status: r.status,
        cursorTs: req.query.cursorTs ? Number(req.query.cursorTs) : null,
        limit: req.query.limit ? Number(req.query.limit) : null,
        details: typeof data === 'string' ? data.slice(0, 200) : data
      }, 'D1 returned error for secure message list');
      appendSecureDebug({
        stage: 'error',
        conversationId: auth.conversationId,
        status: r.status,
        cursorTs: req.query.cursorTs ? Number(req.query.cursorTs) : null,
        limit: req.query.limit ? Number(req.query.limit) : null,
        details: typeof data === 'string' ? data.slice(0, 200) : data
      });
      return res.status(502).json({ error: 'D1ReadFailed', status: r.status, details: data });
    }
    logger.debug({
      event: 'd1.listSecureMessages.response',
      conversationId: auth.conversationId,
      status: r.status,
      itemCount: Array.isArray(data?.items) ? data.items.length : null,
      nextCursorTs: data?.nextCursorTs ?? null
    }, 'received secure messages from D1');
    appendSecureDebug({
      stage: 'response',
      conversationId: auth.conversationId,
      status: r.status,
      itemCount: Array.isArray(data?.items) ? data.items.length : null,
      nextCursorTs: data?.nextCursorTs ?? null
    });
    return res.json(data);
  } catch (err) {
    logger.warn({
      event: 'd1.listSecureMessages.fetch-failed',
      conversationId: auth.conversationId,
      cursorTs: req.query.cursorTs ? Number(req.query.cursorTs) : null,
      limit: req.query.limit ? Number(req.query.limit) : null,
      error: err?.message || err
    }, 'fetch to D1 failed');
    appendSecureDebug({
      stage: 'fetch-failed',
      conversationId: auth.conversationId,
      cursorTs: req.query.cursorTs ? Number(req.query.cursorTs) : null,
      limit: req.query.limit ? Number(req.query.limit) : null,
      error: err?.message || String(err)
    });
    return res.status(502).json({ error: 'UpstreamError', message: err?.message || 'fetch failed' });
  }
};

export const deleteMessages = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }

  let input; try {
    input = DeleteMessagesSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err?.message || 'invalid input' });
  }

  let auth;
  try {
    auth = await authorizeAccountForConversation({
      conversationId: input.conversationId,
      accountToken: input.accountToken,
      accountDigest: input.accountDigest,
      fingerprint: input.conversationFingerprint
    });
  } catch (err) {
    return respondAccountError(res, err, 'conversation authorization failed');
  }

  const ids = Array.from(new Set((input.ids || []).map(k => String(k || '').trim()).filter(Boolean)));

  const path = '/d1/messages/delete';
  const body = JSON.stringify({ ids, conversationId: auth.conversationId });
  const sig = signHmac(path, body, HMAC_SECRET);

  let workerRes;
  try {
    workerRes = await fetch(`${DATA_API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth': sig },
      body
    });
  } catch (err) {
    return res.status(502).json({ error: 'UpstreamError', message: err?.message || 'fetch failed' });
  }

  let workerJson = { results: [] };
  if (workerRes.status !== 404) {
    try {
      workerJson = await workerRes.json();
    } catch (err) {
      const txt = await workerRes.text().catch(() => '');
      return res.status(502).json({ error: 'ParseError', message: err?.message || 'invalid JSON from worker', details: txt });
    }

    if (!workerRes.ok) {
      return res.status(workerRes.status).json({ error: 'DeleteFailed', details: workerJson });
    }
  }

  return res.json({ ok: true, worker: workerJson?.results || [] });
};

export const deleteSecureConversation = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }

  let input;
  try {
    input = DeleteSecureConversationSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err?.message || 'invalid input' });
  }

  let auth;
  try {
    auth = await authorizeAccountForConversation({
      conversationId: input.conversationId,
      accountToken: input.accountToken,
      accountDigest: input.accountDigest,
      fingerprint: input.conversationFingerprint
    });
  } catch (err) {
    return respondAccountError(res, err, 'conversation authorization failed');
  }

  const payload = {
    conversationId: auth.conversationId,
    accountDigest: auth.accountDigest
  };
  if (input.accountToken) payload.accountToken = String(input.accountToken).trim();
  if (input.conversationFingerprint) payload.conversationFingerprint = String(input.conversationFingerprint).trim();

  const path = '/d1/messages/secure/delete-conversation';
  const body = JSON.stringify(payload);
  const sig = signHmac(path, body, HMAC_SECRET);

  try {
    const upstream = await fetchWithTimeout(`${DATA_API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth': sig },
      body
    });
    const text = await upstream.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (upstream.status === 404) {
      return res.json({ ok: true, deleted_secure: 0, deleted_general: 0, conversation_id: payload.conversationId, skipped: true });
    }
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: 'DeleteConversationFailed', details: data });
    }
    return res.json(data);
  } catch (err) {
    return res.status(504).json({
      error: 'DeleteConversationTimeout',
      message: err?.message || 'fetch aborted'
    });
  }
};
