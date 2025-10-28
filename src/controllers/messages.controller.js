import { CreateMessageSchema, CreateSecureMessageSchema } from '../schemas/message.schema.js';
import crypto from 'node:crypto';
import { signHmac } from '../utils/hmac.js';
import { z } from 'zod';

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
  ids: z.array(z.string().min(1))
});

const DeleteSecureConversationSchema = z.object({
  conversationId: z.string().min(8),
  uidHex: z.string().optional(),
  accountToken: z.string().optional(),
  accountDigest: z.string().optional()
}).superRefine((value, ctx) => {
  if (!value.uidHex && !value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'uidHex or accountToken/accountDigest required' });
  }
});

export const createMessage = async (req, res) => {
  // Validate body
  const input = CreateMessageSchema.parse(req.body);

  // Build payload to D1 (index only, never plaintext)
  const payload = {
    msgId: crypto.randomUUID(),
    convId: input.convId,
    senderId: req.headers['x-client-id'] || 'unknown',
    type: input.type,
    aead: input.aead,
    headerJson: JSON.stringify(input.header || {}),
    objKey: input.header?.obj || null,
    sizeBytes: input.header?.size ?? null,
    ts: Math.floor(Date.now() / 1000)
  };

  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }

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

  const messageId = input.id || crypto.randomUUID();
  const createdAt = Number.isFinite(input.created_at) ? input.created_at : Math.floor(Date.now() / 1000);

  const payload = {
    id: messageId,
    conversation_id: input.conversation_id,
    payload_envelope: input.payload_envelope,
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
  const convId = req.params.convId;
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }
  // Build query string
  const params = new URLSearchParams();
  if (convId) params.append('convId', convId);
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

  const conversationId = req.query.conversationId || req.query.conversation_id;
  if (!conversationId) {
    return res.status(400).json({ error: 'BadRequest', message: 'conversationId required' });
  }

  const params = new URLSearchParams();
  params.set('conversationId', conversationId);
  if (req.query.cursorTs) params.set('cursorTs', String(req.query.cursorTs));
  if (req.query.limit) params.set('limit', String(req.query.limit));

  const path = `/d1/messages?${params.toString()}`;
  const sig = signHmac(path, '', HMAC_SECRET);

  try {
    const r = await fetch(`${DATA_API}${path}`, {
      headers: { 'x-auth': sig }
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!r.ok) {
      return res.status(502).json({ error: 'D1ReadFailed', status: r.status, details: data });
    }
    return res.json(data);
  } catch (err) {
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

  const ids = Array.from(new Set((input.ids || []).map(k => String(k || '').trim()).filter(Boolean)));

  const path = '/d1/messages/delete';
  const body = JSON.stringify({ ids });
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

  const sanitizeUidHex = (value) => {
    if (!value) return undefined;
    const cleaned = String(value).replace(/[^0-9a-f]/gi, '').toUpperCase();
    return cleaned.length >= 14 ? cleaned : undefined;
  };

  const payload = {
    conversationId: input.conversationId
  };
  const uidHex = sanitizeUidHex(input.uidHex);
  if (uidHex) payload.uidHex = uidHex;
  if (input.accountToken) payload.accountToken = String(input.accountToken).trim();
  if (input.accountDigest) payload.accountDigest = String(input.accountDigest).trim().toUpperCase();

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
