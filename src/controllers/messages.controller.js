/**
 * SECURITY POLICY – STRICT CRYPTO PROTOCOL, NO FALLBACK ALLOWED.
 *
 * 本檔案中的所有密碼協定（X3DH、Double Ratchet、AEAD、鍵派生、counter 驗證、header 驗證）
 * 禁止設計、加入或推論任何 fallback、retry、rollback、resync、auto-repair 等邏輯。
 *
 * 規則如下：
 * 1. 若解密失敗 → 一律直接 fail，不可嘗試第二組 key 或舊 ratchet state。
 * 2. 若 counter 不一致 → 一律直接拒絕，不可重送、補拉或自動對齊。
 * 3. 不允許任何協定降級（downgrade）。不得用舊版本、舊頭資訊、舊密鑰重試。
 * 4. 不允許模糊錯誤處理。不做 try-catch fallback，不做 silent recovery。
 * 5. 對話重置必須是顯式事件，不得隱式重建 state。
 *
 * 一切協定邏輯必須「單一路徑」且「強一致性」，任何 fallback 視為安全漏洞。
 */
import { CreateMessageSchema, CreateSecureMessageSchema } from '../schemas/message.schema.js';
import { signHmac } from '../utils/hmac.js';
import { z } from 'zod';
import fs from 'node:fs/promises';
import { resolveAccountAuth, AccountAuthError } from '../utils/account-context.js';
import { logger } from '../utils/logger.js';
import { normalizeConversationId, authorizeConversationAccess, isSystemOwnedConversation } from '../utils/conversation-auth.js';
import { AccountDigestRegex } from '../utils/account-verify.js';
import { getWebSocketManager } from '../ws/index.js';
import { DEBUG } from '../../web/src/app/ui/mobile/debug-flags.js';

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
  fs.appendFile(SECURE_DEBUG_LOG, `${JSON.stringify(payload)}\n`).catch(() => { });
}

const canonAccount = (v) => (typeof v === 'string' ? v.replace(/[^0-9A-Fa-f]/g, '').toUpperCase() : null);
const canonDevice = (v) => {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed || null;
};

const inflightSecureRequests = new Map();
function inflightKey({ conversationId, cursorTs, cursorId, limit }) {
  return `${conversationId || ''}::${cursorTs || 'null'}::${cursorId || 'null'}::${limit || 'null'}`;
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
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

const DeleteSecureConversationSchema = z.object({
  conversationId: z.string().min(8),
  peerAccountDigest: z.string().regex(AccountDigestRegex),
  targetDeviceId: z.string().min(1),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

const SendStateSchema = z.object({
  conversationId: z.string().min(8),
  senderDeviceId: z.string().min(1),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

const OutgoingStatusSchema = z.object({
  conversationId: z.string().min(8),
  senderDeviceId: z.string().min(1),
  receiverAccountDigest: z.string().regex(AccountDigestRegex),
  messageIds: z.array(z.string().min(8)).max(200),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

function extractAccountFromRequest(req) {
  const readHeader = (name) => {
    const value = req.get(name);
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
  };
  const accountToken = readHeader('x-account-token');
  const accountDigestRaw = readHeader('x-account-digest');
  const accountDigestValid = accountDigestRaw && AccountDigestRegex.test(accountDigestRaw);
  const accountDigest = accountDigestValid ? accountDigestRaw : null;
  const accountDigestInvalid = !!(accountDigestRaw && !accountDigestValid);
  const deviceId = readHeader('x-device-id');
  return { accountToken, accountDigest, accountDigestInvalid, deviceId };
}

async function authorizeAccountForConversation({ conversationId, accountToken, accountDigest, deviceId = null, requireDeviceId = false }) {
  const normalizedConv = normalizeConversationId(conversationId);
  if (!normalizedConv) {
    throw new AccountAuthError('invalid conversationId', 400);
  }

  const normalizedDeviceId = deviceId ? String(deviceId).trim() : null;
  if (requireDeviceId && !normalizedDeviceId) {
    throw new AccountAuthError('deviceId required', 400);
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
        deviceId: normalizedDeviceId || null
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

  // Validate body（legacy schema，轉送到新版 secure messages）
  const input = CreateMessageSchema.parse(req.body);
  const { convId: rawConvId, accountToken, accountDigest, ...messageInput } = input;
  const account = extractAccountFromRequest(req);
  const deviceId = account.deviceId || null;
  if (!deviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'deviceId header required' });
  }

  let auth;
  try {
    auth = await authorizeAccountForConversation({
      conversationId: rawConvId,
      accountToken,
      accountDigest,
      deviceId,
      requireDeviceId: true
    });
  } catch (err) {
    return respondAccountError(res, err, 'conversation authorization failed');
  }

  // 轉成新版 Signal-style secure message格式（系統對話預設自寄自收）
  const headerJson = messageInput.header_json || JSON.stringify(messageInput.header || {});
  const ciphertextB64 = typeof messageInput.ciphertext_b64 === 'string'
    ? messageInput.ciphertext_b64
    : (typeof messageInput.ciphertext === 'string' ? messageInput.ciphertext : null);
  if (!ciphertextB64 || !ciphertextB64.trim()) {
    return res.status(400).json({ error: 'BadRequest', message: 'ciphertext_b64 required' });
  }
  const counter = Number.isFinite(messageInput.counter) ? Number(messageInput.counter) : null;
  if (!Number.isFinite(counter)) {
    return res.status(400).json({ error: 'BadRequest', message: 'counter required' });
  }
  if (!messageInput.id) {
    return res.status(400).json({ error: 'BadRequest', message: 'id (messageId) required' });
  }
  const receiverDigest = messageInput.receiver_account_digest || null;
  if (!receiverDigest) {
    return res.status(400).json({ error: 'BadRequest', message: 'receiver_account_digest required' });
  }
  const receiverDeviceId = messageInput.receiver_device_id || null;
  if (!receiverDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'receiver_device_id required' });
  }
  const senderDeviceId = canonDevice(deviceId);
  if (!senderDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'deviceId header required' });
  }
  const path = '/d1/messages';
  const body = JSON.stringify({
    conversation_id: auth.conversationId,
    sender_account_digest: auth.accountDigest,
    sender_device_id: senderDeviceId,
    receiver_account_digest: receiverDigest,
    receiver_device_id: receiverDeviceId,
    header_json: headerJson,
    ciphertext_b64: ciphertextB64,
    counter,
    id: messageInput.id,
    created_at: messageInput.created_at || messageInput.ts || undefined
  });
  const sig = signHmac(path, body, HMAC_SECRET);

  try {
    const r = await fetch(`${DATA_API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth': sig },
      body
    });
    const text = await r.text().catch(() => '');
    let workerJson = null;
    try { workerJson = text ? JSON.parse(text) : null; } catch { workerJson = text || null; }
    if (r.status === 409 && typeof workerJson === 'object' && workerJson?.error === 'CounterTooLow') {
      appendSecureDebug({
        event: 'proxy-counter-too-low',
        conversationId: auth.conversationId,
        counterSent: counter,
        maxCounter: workerJson?.maxCounter ?? null,
        senderAccountDigest: auth.accountDigest,
        senderDeviceId,
        path
      });
      if (DEBUG.drCounter) {
        logger.info({
          proxyCounterTooLow: {
            conversationId: auth.conversationId,
            counterSent: counter,
            maxCounter: workerJson?.maxCounter ?? null,
            senderAccountDigest: auth.accountDigest,
            senderDeviceId,
            path
          }
        });
      }
      return res.status(409).json({ error: 'CounterTooLow', details: workerJson });
    }
    if (!r.ok) {
      return res.status(502).json({ error: 'D1WriteFailed', status: r.status, details: workerJson });
    }

    // WS 通知接收者有新訊息
    try {
      const mgr = getWebSocketManager();
      mgr.notifySecureMessage({
        targetAccountDigest: receiverDigest,
        conversationId: auth.conversationId,
        preview: messageInput.preview || messageInput.text || '',
        ts: Number(messageInput.created_at || messageInput.ts || Date.now()),
        senderAccountDigest: auth.accountDigest,
        senderDeviceId,
        targetDeviceId: canonDevice(receiverDeviceId)
      });
    } catch (err) {
      logger.warn({ ws_notify_error: err?.message || err });
    }

    // Accepted: index stored (async any downstream processing)
    const messageId = workerJson?.id || workerJson?.message_id || messageInput.id;
    const createdAt = messageInput.created_at || messageInput.ts || undefined;
    return res.status(202).json(workerJson || {
      accepted: true,
      id: messageId,
      created_at: createdAt,
      receipt: messageId ? { type: 'delivery', message_id: messageId, delivered_at: createdAt || Math.floor(Date.now() / 1000) } : undefined
    });
  } catch (err) {
    return res.status(502).json({ error: 'UpstreamError', message: err?.message || 'fetch failed' });
  }
};

export const createSecureMessage = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }

  const rawBody = req.body && typeof req.body === 'object' ? req.body : {};
  if (!Number.isFinite(rawBody?.counter)) {
    return res.status(400).json({ error: 'BadRequest', message: 'counter required' });
  }
  const rawCiphertext = typeof rawBody?.ciphertext_b64 === 'string' ? rawBody.ciphertext_b64.trim() : '';
  if (!rawCiphertext) {
    return res.status(400).json({ error: 'BadRequest', message: 'ciphertext_b64 required' });
  }
  const account = extractAccountFromRequest(req);

  let input;
  try {
    input = CreateSecureMessageSchema.parse(rawBody);
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err?.message || 'invalid input' });
  }

  const {
    conversation_id: rawConversationId,
    accountToken,
    accountDigest,
    sender_device_id,
    receiver_device_id,
    receiver_account_digest,
    header_json,
    header,
    ciphertext_b64,
    counter,
    id,
    created_at
  } = input;
  const messageCounter = Number.isFinite(counter) ? counter : null;
  if (!Number.isFinite(messageCounter)) {
    return res.status(400).json({ error: 'BadRequest', message: 'counter required' });
  }
  const ciphertextB64 = typeof ciphertext_b64 === 'string' ? ciphertext_b64.trim() : '';
  if (!ciphertextB64) {
    return res.status(400).json({ error: 'BadRequest', message: 'ciphertext_b64 required' });
  }

  let auth;
  try {
    auth = await authorizeAccountForConversation({
      conversationId: rawConversationId,
      accountToken,
      accountDigest,
      deviceId: sender_device_id || null,
      requireDeviceId: true
    });
  } catch (err) {
    return respondAccountError(res, err, 'conversation authorization failed');
  }

  if (!receiver_account_digest) {
    return res.status(400).json({ error: 'BadRequest', message: 'receiver_account_digest required' });
  }
  const messageId = id;
  if (!messageId) {
    return res.status(400).json({ error: 'BadRequest', message: 'id (messageId) required' });
  }
  const createdAt = Number.isFinite(created_at) ? created_at : Math.floor(Date.now() / 1000);
  const headerJson = header_json || (header ? JSON.stringify(header) : null);
  if (!headerJson) {
    return res.status(400).json({ error: 'BadRequest', message: 'header_json required' });
  }
  let headerObj = null;
  try {
    headerObj = JSON.parse(headerJson);
  } catch {
    return res.status(400).json({ error: 'BadRequest', message: 'header_json invalid' });
  }
  const senderDeviceId = canonDevice(sender_device_id);
  if (!senderDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'sender_device_id required' });
  }
  const targetDeviceId = canonDevice(receiver_device_id || null);
  if (!targetDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'receiver_device_id required' });
  }
  const headerCounter = Number.isFinite(headerObj?.n) ? headerObj.n : Number(headerObj?.counter);
  if (!Number.isFinite(headerCounter)) {
    return res.status(400).json({ error: 'BadRequest', message: 'header counter invalid' });
  }
  const headerDeviceId = canonDevice(headerObj?.device_id || null);
  if (!headerDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'header device_id required' });
  }
  if (senderDeviceId && headerDeviceId !== senderDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'header device_id mismatch' });
  }
  const headerVersion = Number(headerObj?.v ?? headerObj?.version ?? 1);
  if (!Number.isFinite(headerVersion) || headerVersion <= 0) {
    return res.status(400).json({ error: 'BadRequest', message: 'header version invalid' });
  }
  if (!headerObj?.iv_b64) {
    return res.status(400).json({ error: 'BadRequest', message: 'header.iv_b64 required' });
  }

  const payload = {
    id: messageId,
    conversation_id: auth.conversationId,
    sender_account_digest: auth.accountDigest,
    sender_device_id: senderDeviceId,
    receiver_account_digest,
    receiver_device_id: targetDeviceId,
    header_json: headerJson,
    ciphertext_b64: ciphertextB64,
    counter: messageCounter,
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

    if (r.status === 409 && typeof workerJson === 'object' && workerJson?.error === 'CounterTooLow') {
      appendSecureDebug({
        event: 'proxy-counter-too-low',
        conversationId: auth.conversationId,
        counterSent: messageCounter,
        maxCounter: workerJson?.maxCounter ?? null,
        senderAccountDigest: auth.accountDigest,
        senderDeviceId,
        path
      });
      if (DEBUG.drCounter) {
        logger.info({
          proxyCounterTooLow: {
            conversationId: auth.conversationId,
            counterSent: messageCounter,
            maxCounter: workerJson?.maxCounter ?? null,
            senderAccountDigest: auth.accountDigest,
            senderDeviceId,
            path
          }
        });
      }
      return res.status(409).json({ error: 'CounterTooLow', details: workerJson });
    }

    if (!r.ok) {
      return res.status(502).json({
        error: 'D1WriteFailed',
        status: r.status,
        details: workerJson || null
      });
    }

    try {
      const mgr = getWebSocketManager();
      mgr.notifySecureMessage({
        targetAccountDigest: receiver_account_digest,
        conversationId: auth.conversationId,
        messageId: messageId,
        preview: '',
        ts: createdAt,
        senderAccountDigest: auth.accountDigest,
        senderDeviceId: canonDevice(senderDeviceId),
        targetDeviceId: canonDevice(targetDeviceId)
      });
    } catch (err) {
      logger.warn({ ws_notify_error: err?.message || err }, 'ws_notify_secure_message_failed');
    }

    return res.status(202).json({
      accepted: true,
      id: messageId,
      conversation_id: input.conversation_id,
      created_at: createdAt,
      worker: workerJson,
      receipt: { type: 'delivery', message_id: messageId, delivered_at: createdAt }
    });
  } catch (err) {
    return res.status(502).json({ error: 'UpstreamError', message: err?.message || 'fetch failed' });
  }
};

export const atomicSend = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }

  const rawBody = req.body && typeof req.body === 'object' ? req.body : {};
  const messagePayload = rawBody.message;
  const vaultPayload = rawBody.vault;
  if (!messagePayload || !vaultPayload) {
    return res.status(400).json({ error: 'BadRequest', message: 'message and vault payloads required' });
  }

  // Reuse logic from createSecureMessage (validation & auth)
  // ... or minimal forwarding since worker validates deeply?
  // We should do minimal auth check here to protect worker bandwidth.

  const account = extractAccountFromRequest(req);
  if (!account.accountToken && !account.accountDigest) {
    return res.status(400).json({ error: 'BadRequest', message: 'X-Account-Token or X-Account-Digest required' });
  }

  // Note: atomicSend might be used for FIRST message where conversationId is not fully established in DB,
  // but client provides one. authorizeAccountForConversation handles "system owned" or checks ACL.
  // For simplicity and robustness, let's forward and let Worker handle deep logic,
  // but we MUST ensure the caller has valid account credentials.

  // Resolve Auth
  let auth;
  try {
    const { accountDigest: resolvedDigest } = await resolveAccountAuth({
      accountToken: account.accountToken,
      accountDigest: account.accountDigest
    });
    auth = { accountDigest: resolvedDigest };
  } catch (err) {
    return respondAccountError(res, err, 'account authorization failed');
  }

  // Consistency Check
  const senderDevice = canonDevice(account.deviceId);
  if (!senderDevice) return res.status(400).json({ error: 'BadRequest', message: 'X-Device-Id required' });

  // Forward to Worker
  const path = '/d1/messages/atomic-send';

  // Reconstruct payload to ensure clean JSON for HMAC and Worker validation
  const payload = {
    conversationId: rawBody.conversationId,
    senderDeviceId: rawBody.senderDeviceId,
    accountDigest: auth.accountDigest, // Authenticated digest
    message: rawBody.message,
    vault: rawBody.vault,
    backup: rawBody.backup || undefined
  };

  const body = JSON.stringify(payload);
  const sig = signHmac(path, body, HMAC_SECRET);

  try {
    const r = await fetch(`${DATA_API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth': sig },
      body
    });

    let workerJson = null;
    let workerText = null;
    try {
      workerText = await r.text();
      if (workerText) {
        workerJson = JSON.parse(workerText);
      }
    } catch {
      workerJson = null;
    }

    if (r.status === 409 && typeof workerJson === 'object' && workerJson?.error === 'CounterTooLow') {
      return res.status(409).json({ error: 'CounterTooLow', details: workerJson });
    }

    if (!r.ok) {
      if (r.status >= 400 && r.status < 500) {
        return res.status(r.status).json(workerJson || { error: 'WorkerError', status: r.status, details: workerText });
      }
      return res.status(500).json({
        error: 'D1WriteFailed',
        status: r.status,
        details: workerJson || workerText || 'Empty Response'
      });
    }

    // WS Notify (Optional: if we want instant push, we can parse messagePayload and push here)
    // The previous createSecureMessage did this. We should probably replicate it.
    try {
      const receiverDigest = messagePayload.receiver_account_digest || messagePayload.receiverAccountDigest;
      const conversationId = messagePayload.conversation_id || messagePayload.conversationId;
      const messageId = messagePayload.id;
      const ts = messagePayload.created_at || messagePayload.ts;
      if (receiverDigest && conversationId && messageId) {
        const mgr = getWebSocketManager();
        mgr.notifySecureMessage({
          targetAccountDigest: receiverDigest,
          conversationId: conversationId,
          messageId: messageId,
          preview: '',
          ts: Number(ts) || Date.now(),
          senderAccountDigest: auth.accountDigest,
          senderDeviceId: senderDevice,
          targetDeviceId: canonDevice(messagePayload.receiver_device_id || messagePayload.receiverDeviceId)
        });
      }
    } catch (err) {
      logger.warn({ ws_notify_error: err?.message || err }, 'ws_notify_atomic_send_failed');
    }

    return res.status(202).json(workerJson);

  } catch (err) {
    return res.status(500).json({ error: 'UpstreamError', message: err?.message || 'fetch failed' });
  }
};

export const listMessages = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }
  const convIdRaw = req.params.convId;
  const account = extractAccountFromRequest(req);

  if (!account.accountToken && !account.accountDigest) {
    return res.status(400).json({ error: 'BadRequest', message: 'X-Account-Token or X-Account-Digest required' });
  }
  if (account.accountDigestInvalid) {
    return res.status(400).json({ error: 'BadRequest', message: 'X-Account-Digest invalid format' });
  }
  if (!account.deviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'X-Device-Id header required' });
  }

  let auth;
  try {
    auth = await authorizeAccountForConversation({
      conversationId: convIdRaw,
      accountToken: account.accountToken,
      accountDigest: account.accountDigest,
      deviceId: account.deviceId || null,
      requireDeviceId: true
    });
  } catch (err) {
    return respondAccountError(res, err, 'conversation authorization failed');
  }

  // Build query string
  const params = new URLSearchParams();
  params.append('conversationId', auth.conversationId);
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
      const items = Array.isArray(data?.items)
        ? data.items.map((it) => ({
          ...it,
          ts: typeof it.ts === 'number' ? it.ts : (typeof it.created_at === 'number' ? it.created_at : null)
        }))
        : null;
      return res.json(items ? { ...data, items } : data);
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
  if (!account.accountToken && !account.accountDigest) {
    return res.status(400).json({ error: 'BadRequest', message: 'X-Account-Token or X-Account-Digest required' });
  }
  if (account.accountDigestInvalid) {
    return res.status(400).json({ error: 'BadRequest', message: 'X-Account-Digest invalid format' });
  }
  if (!account.deviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'X-Device-Id header required' });
  }
  let auth;
  try {
    auth = await authorizeAccountForConversation({
      conversationId: conversationIdRaw,
      accountToken: account.accountToken,
      accountDigest: account.accountDigest,
      deviceId: account.deviceId || null,
      requireDeviceId: true
    });
  } catch (err) {
    return respondAccountError(res, err, 'conversation authorization failed');
  }

  const params = new URLSearchParams();
  params.set('conversationId', auth.conversationId);
  if (req.query.cursorTs) params.set('cursorTs', String(req.query.cursorTs));
  if (req.query.cursorId) params.set('cursorId', String(req.query.cursorId));
  if (req.query.cursorCounter) params.set('cursorCounter', String(req.query.cursorCounter));
  if (req.query.limit) params.set('limit', String(req.query.limit));
  if (req.query.includeKeys) params.set('includeKeys', 'true');

  const path = `/d1/messages?${params.toString()}`;
  const sig = signHmac(path, '', HMAC_SECRET);
  const inflightInfo = {
    conversationId: auth.conversationId,
    cursorTs: req.query.cursorTs ? Number(req.query.cursorTs) : null,
    cursorId: req.query.cursorId ? String(req.query.cursorId) : null,
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
      cursorId: req.query.cursorId ? String(req.query.cursorId) : null,
      limit: req.query.limit ? Number(req.query.limit) : null
    }, 'fetching secure messages from D1');
    appendSecureDebug({
      stage: 'request',
      conversationId: auth.conversationId,
      cursorTs: req.query.cursorTs ? Number(req.query.cursorTs) : null,
      cursorId: req.query.cursorId ? String(req.query.cursorId) : null,
      limit: req.query.limit ? Number(req.query.limit) : null
    });
    const controller = new AbortController();
    const cleanupInflight = trackInflight({ key, controller });
    const r = await fetch(`${DATA_API}${path}`, {
      headers: { 'x-auth': sig, 'x-account-digest': auth.accountDigest },
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
        cursorId: req.query.cursorId ? String(req.query.cursorId) : null,
        limit: req.query.limit ? Number(req.query.limit) : null,
        details: typeof data === 'string' ? data.slice(0, 200) : data
      }, 'D1 returned error for secure message list');
      appendSecureDebug({
        stage: 'error',
        conversationId: auth.conversationId,
        status: r.status,
        cursorTs: req.query.cursorTs ? Number(req.query.cursorTs) : null,
        cursorId: req.query.cursorId ? String(req.query.cursorId) : null,
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
      nextCursor: data?.nextCursor ?? null,
      nextCursorTs: data?.nextCursorTs ?? null
    }, 'received secure messages from D1');
    appendSecureDebug({
      stage: 'response',
      conversationId: auth.conversationId,
      status: r.status,
      itemCount: Array.isArray(data?.items) ? data.items.length : null,
      nextCursor: data?.nextCursor ?? null,
      nextCursorTs: data?.nextCursorTs ?? null
    });
    return res.json(data);
  } catch (err) {
    logger.warn({
      event: 'd1.listSecureMessages.fetch-failed',
      conversationId: auth.conversationId,
      cursorTs: req.query.cursorTs ? Number(req.query.cursorTs) : null,
      cursorId: req.query.cursorId ? String(req.query.cursorId) : null,
      limit: req.query.limit ? Number(req.query.limit) : null,
      error: err?.message || err
    }, 'fetch to D1 failed');
    appendSecureDebug({
      stage: 'fetch-failed',
      conversationId: auth.conversationId,
      cursorTs: req.query.cursorTs ? Number(req.query.cursorTs) : null,
      cursorId: req.query.cursorId ? String(req.query.cursorId) : null,
      limit: req.query.limit ? Number(req.query.limit) : null,
      error: err?.message || String(err)
    });
    return res.status(502).json({ error: 'UpstreamError', message: err?.message || 'fetch failed' });
  }
};

export const getSecureMaxCounter = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }

  const conversationIdRaw = req.query.conversationId || req.query.conversation_id;
  if (!conversationIdRaw || String(conversationIdRaw).trim().length < 8) {
    return res.status(400).json({ error: 'BadRequest', message: 'conversationId required' });
  }
  const senderDeviceId = canonDevice(req.query.senderDeviceId || req.query.sender_device_id || null);
  if (!senderDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'senderDeviceId required' });
  }

  const account = extractAccountFromRequest(req);
  if (!account.accountToken && !account.accountDigest) {
    return res.status(400).json({ error: 'BadRequest', message: 'X-Account-Token or X-Account-Digest required' });
  }
  if (account.accountDigestInvalid) {
    return res.status(400).json({ error: 'BadRequest', message: 'X-Account-Digest invalid format' });
  }
  if (!account.deviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'X-Device-Id header required' });
  }

  let auth;
  try {
    auth = await authorizeAccountForConversation({
      conversationId: conversationIdRaw,
      accountToken: account.accountToken,
      accountDigest: account.accountDigest,
      deviceId: account.deviceId || null,
      requireDeviceId: true
    });
  } catch (err) {
    return respondAccountError(res, err, 'conversation authorization failed');
  }

  const path = '/d1/messages/secure/max-counter';
  const body = JSON.stringify({
    conversationId: auth.conversationId,
    senderDeviceId
  });
  const sig = signHmac(path, body, HMAC_SECRET);

  try {
    const r = await fetchWithTimeout(`${DATA_API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth': sig },
      body
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!r.ok) {
      return res.status(502).json({ error: 'D1ReadFailed', status: r.status, details: data });
    }
    const maxCounterRaw = data?.maxCounter ?? data?.max_counter ?? null;
    const maxCounter = Number.isFinite(Number(maxCounterRaw)) ? Number(maxCounterRaw) : null;
    const tsRaw = data?.ts ?? data?.serverTime ?? data?.server_time ?? null;
    const ts = Number.isFinite(Number(tsRaw)) ? Number(tsRaw) : null;
    return res.json({
      conversationId: auth.conversationId,
      senderDeviceId,
      maxCounter,
      ts
    });
  } catch (err) {
    return res.status(502).json({ error: 'UpstreamError', message: err?.message || 'fetch failed' });
  }
};

export const getSecureMessageByCounter = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }

  const conversationIdRaw = req.query.conversationId || req.query.conversation_id;
  if (!conversationIdRaw) {
    return res.status(400).json({ error: 'BadRequest', message: 'conversationId required' });
  }
  const counter = Number(req.query.counter);
  if (!Number.isFinite(counter)) {
    return res.status(400).json({ error: 'BadRequest', message: 'counter required' });
  }

  const account = extractAccountFromRequest(req);
  if (!account.accountToken && !account.accountDigest) {
    return res.status(400).json({ error: 'BadRequest', message: 'X-Account-Token or X-Account-Digest required' });
  }
  if (account.accountDigestInvalid) {
    return res.status(400).json({ error: 'BadRequest', message: 'X-Account-Digest invalid format' });
  }
  if (!account.deviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'X-Device-Id header required' });
  }

  let auth;
  try {
    auth = await authorizeAccountForConversation({
      conversationId: conversationIdRaw,
      accountToken: account.accountToken,
      accountDigest: account.accountDigest,
      deviceId: account.deviceId || null,
      requireDeviceId: true
    });
  } catch (err) {
    return respondAccountError(res, err, 'conversation authorization failed');
  }

  const params = new URLSearchParams();
  params.set('conversationId', auth.conversationId);
  params.set('counter', String(counter));
  const senderDeviceId = canonDevice(req.query.senderDeviceId || req.query.sender_device_id || null);
  if (senderDeviceId) params.set('senderDeviceId', senderDeviceId);
  const senderAccountDigest = canonAccount(req.query.senderAccountDigest || req.query.sender_account_digest || null);
  if (senderAccountDigest) params.set('senderAccountDigest', senderAccountDigest);

  const path = `/d1/messages/by-counter?${params.toString()}`;
  const sig = signHmac(path, '', HMAC_SECRET);
  try {
    const r = await fetch(`${DATA_API}${path}`, {
      headers: { 'x-auth': sig }
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!r.ok) {
      return res.status(r.status === 404 ? 404 : 502).json({ error: 'D1ReadFailed', status: r.status, details: data });
    }
    return res.json(data);
  } catch (err) {
    return res.status(502).json({ error: 'UpstreamError', message: err?.message || 'fetch failed' });
  }
};

export const getSendState = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }

  let input;
  try {
    input = SendStateSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err?.errors?.[0]?.message || 'invalid input' });
  }

  const account = extractAccountFromRequest(req);
  if (!account.accountToken && !account.accountDigest) {
    return res.status(400).json({ error: 'BadRequest', message: 'X-Account-Token or X-Account-Digest required' });
  }
  if (account.accountDigestInvalid) {
    return res.status(400).json({ error: 'BadRequest', message: 'X-Account-Digest invalid format' });
  }
  if (!account.deviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'X-Device-Id header required' });
  }

  let auth;
  try {
    auth = await authorizeAccountForConversation({
      conversationId: input.conversationId,
      accountToken: input.accountToken || account.accountToken,
      accountDigest: input.accountDigest || account.accountDigest,
      deviceId: account.deviceId || null,
      requireDeviceId: true
    });
  } catch (err) {
    return respondAccountError(res, err, 'conversation authorization failed');
  }

  const senderDeviceId = canonDevice(input.senderDeviceId || account.deviceId);
  if (!senderDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'senderDeviceId required' });
  }
  const headerDeviceId = canonDevice(account.deviceId || null);
  if (headerDeviceId && senderDeviceId !== headerDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'senderDeviceId mismatch' });
  }

  const path = '/d1/messages/send-state';
  const body = JSON.stringify({
    accountDigest: auth.accountDigest,
    conversationId: auth.conversationId,
    senderDeviceId
  });
  const sig = signHmac(path, body, HMAC_SECRET);

  try {
    const r = await fetchWithTimeout(`${DATA_API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth': sig },
      body
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

export const listOutgoingStatus = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }

  let input;
  try {
    input = OutgoingStatusSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err?.errors?.[0]?.message || 'invalid input' });
  }

  const account = extractAccountFromRequest(req);
  if (!account.accountToken && !account.accountDigest) {
    return res.status(400).json({ error: 'BadRequest', message: 'X-Account-Token or X-Account-Digest required' });
  }
  if (account.accountDigestInvalid) {
    return res.status(400).json({ error: 'BadRequest', message: 'X-Account-Digest invalid format' });
  }
  if (!account.deviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'X-Device-Id header required' });
  }

  let auth;
  try {
    auth = await authorizeAccountForConversation({
      conversationId: input.conversationId,
      accountToken: input.accountToken || account.accountToken,
      accountDigest: input.accountDigest || account.accountDigest,
      deviceId: account.deviceId || null,
      requireDeviceId: true
    });
  } catch (err) {
    return respondAccountError(res, err, 'conversation authorization failed');
  }

  const senderDeviceId = canonDevice(input.senderDeviceId || account.deviceId);
  if (!senderDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'senderDeviceId required' });
  }
  const headerDeviceId = canonDevice(account.deviceId || null);
  if (headerDeviceId && senderDeviceId !== headerDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'senderDeviceId mismatch' });
  }

  const messageIds = Array.from(new Set((input.messageIds || []).map((id) => String(id || '').trim()).filter(Boolean)));
  if (!messageIds.length) {
    return res.status(400).json({ error: 'BadRequest', message: 'messageIds required' });
  }

  const path = '/d1/messages/outgoing-status';
  const body = JSON.stringify({
    conversationId: auth.conversationId,
    senderAccountDigest: auth.accountDigest,
    receiverAccountDigest: input.receiverAccountDigest,
    senderDeviceId,
    messageIds
  });
  const sig = signHmac(path, body, HMAC_SECRET);

  try {
    const r = await fetchWithTimeout(`${DATA_API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth': sig },
      body
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

  const account = extractAccountFromRequest(req);
  let auth;
  try {
    auth = await authorizeAccountForConversation({
      conversationId: input.conversationId,
      accountToken: input.accountToken || account.accountToken,
      accountDigest: input.accountDigest || account.accountDigest,
      deviceId: account.deviceId || null,
      requireDeviceId: true
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

  const account = extractAccountFromRequest(req);
  let auth;
  try {
    auth = await authorizeAccountForConversation({
      conversationId: input.conversationId,
      accountToken: input.accountToken || account.accountToken,
      accountDigest: input.accountDigest || account.accountDigest,
      deviceId: account.deviceId || null,
      requireDeviceId: true
    });
  } catch (err) {
    return respondAccountError(res, err, 'conversation authorization failed');
  }

  const payload = {
    conversationId: auth.conversationId,
    accountDigest: auth.accountDigest
  };
  if (input.accountToken) payload.accountToken = String(input.accountToken).trim();
  const peerAccountDigest = input.peerAccountDigest ? input.peerAccountDigest.toUpperCase() : null;
  if (!peerAccountDigest) {
    return res.status(400).json({ error: 'BadRequest', message: 'peerAccountDigest required' });
  }
  const senderDeviceId = account.deviceId || null;
  const targetDeviceId = canonDevice(input.targetDeviceId || null);
  if (!targetDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'targetDeviceId required' });
  }

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
    try {
      const manager = getWebSocketManager();
      if (manager && peerAccountDigest) {
        manager.notifyConversationDeleted({
          targetAccountDigest: peerAccountDigest,
          conversationId: payload.conversationId,
          senderAccountDigest: auth.accountDigest,
          senderDeviceId,
          targetDeviceId
        });
      }
    } catch (err) {
      logger.warn({ err: err?.message || err }, 'ws_notify_conversation_deleted_failed');
    }
    return res.json(data);
  } catch (err) {
    return res.status(504).json({
      error: 'DeleteConversationTimeout',
      message: err?.message || 'fetch aborted'
    });
  }
};

export const setDeletionCursor = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }

  const rawBody = req.body && typeof req.body === 'object' ? req.body : {};
  const conversationIdRaw = rawBody.conversation_id || rawBody.conversationId;
  const minCounter = Number(rawBody.min_counter || rawBody.minCounter);

  if (!conversationIdRaw) {
    return res.status(400).json({ error: 'BadRequest', message: 'conversation_id required' });
  }
  if (!Number.isFinite(minCounter)) {
    return res.status(400).json({ error: 'BadRequest', message: 'min_counter required' });
  }

  const account = extractAccountFromRequest(req);
  if (!account.accountToken && !account.accountDigest) {
    return res.status(400).json({ error: 'BadRequest', message: 'token required' });
  }

  let auth;
  try {
    auth = await authorizeAccountForConversation({
      conversationId: conversationIdRaw,
      accountToken: account.accountToken,
      accountDigest: account.accountDigest,
      deviceId: account.deviceId
    });
  } catch (err) {
    return respondAccountError(res, err, 'conversation authorization failed');
  }

  const path = '/d1/deletion/cursor';
  const payload = {
    conversationId: auth.conversationId,
    accountDigest: auth.accountDigest,
    minCounter
  };
  const body = JSON.stringify(payload);
  const sig = signHmac(path, body, HMAC_SECRET);

  try {
    const r = await fetchWithTimeout(`${DATA_API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth': sig },
      body
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!r.ok) {
      return res.status(502).json({ error: 'D1WriteFailed', status: r.status, details: data });
    }
    return res.json(data);
    return res.status(502).json({ error: 'UpstreamError', message: err?.message || 'fetch failed' });
  }
};

export const getSecureMessageById = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }
  const { messageId } = req.params;
  const conversationId = req.query.conversationId || req.query.conversation_id;
  if (!messageId || !conversationId) {
    return res.status(400).json({ error: 'BadRequest', message: 'conversationId and messageId required' });
  }

  const account = extractAccountFromRequest(req);
  if (!account.accountToken && !account.accountDigest) {
    return res.status(400).json({ error: 'BadRequest', message: 'Auth required' });
  }

  // Resolve Auth
  let auth;
  try {
    const { accountDigest: resolvedDigest } = await resolveAccountAuth({
      accountToken: account.accountToken,
      accountDigest: account.accountDigest
    });
    // Check conversation access
    const { allowed, role } = await authorizeAccountForConversation(resolvedDigest, conversationId);
    if (!allowed) {
      return res.status(403).json({ error: 'Forbidden', message: 'Conversation access denied' });
    }
    auth = { accountDigest: resolvedDigest };
  } catch (err) {
    return respondAccountError(res, err, 'account authorization failed');
  }

  // Forward to Worker
  const path = `/d1/messages/secure/${messageId}`;
  const includeKeys = req.query.include_keys === 'true'; // Propagate key request

  // We sign a GET request URL? Usually HMAC signs body.
  // For GET, we sign the path + query.
  // Worker expects path match.
  // Let's construct the full path with query params for the worker.
  const workerQuery = new URLSearchParams();
  workerQuery.set('conversationId', conversationId);
  workerQuery.set('senderDeviceId', account.deviceId); // Used for logging/context
  if (includeKeys) workerQuery.set('include_keys', 'true');

  const fullPath = `${path}?${workerQuery.toString()}`;
  const sig = signHmac(fullPath, '', HMAC_SECRET); // Empty body for GET

  try {
    const r = await fetch(`${DATA_API}${fullPath}`, {
      method: 'GET',
      headers: { 'x-auth': sig }
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }

    if (!r.ok) {
      if (r.status === 404) return res.status(404).json({ error: 'NotFound', message: 'Message not found in vault' });
      return res.status(502).json({ error: 'WorkerError', status: r.status, details: data });
    }
    return res.json(data);
  } catch (err) {
    return res.status(502).json({ error: 'FetchError', message: err?.message || 'worker fetch failed' });
  }
};
