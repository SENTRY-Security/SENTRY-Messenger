import { Router } from 'express';
import { asyncH } from '../../middlewares/async.js';
import { z } from 'zod';
import { customAlphabet } from 'nanoid';
import { createDownloadGet, createUploadPut } from '../../services/s3.js';
import { signHmac } from '../../utils/hmac.js';
import {
  verifyAccount,
  normalizeUidHex,
  normalizeAccountDigest,
  AccountDigestRegex
} from '../../utils/account-verify.js';
import {
  normalizeConversationId,
  authorizeConversationAccess,
  isSystemOwnedConversation
} from '../../utils/conversation-auth.js';

const r = Router();
const nano = customAlphabet('1234567890abcdef', 32);

const MAX_UPLOAD_BYTES = Number(process.env.UPLOAD_MAX_BYTES || 524_288_000); // default 500MB
const DATA_API = process.env.DATA_API_URL;
const HMAC_SECRET = process.env.DATA_API_HMAC;

const SYSTEM_DIR_SENT = '已傳送';
const SYSTEM_DIR_RECEIVED = '已接收';

const SignPutSchema = z.object({
  convId: z.string().min(1),
  uidHex: z.string().min(14),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional(),
  conversationFingerprint: z.string().min(16).optional(),
  ext: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/i).optional(),
  contentType: z.string().min(1).optional(),
  dir: z.string().max(200).optional(), // optional subdirectory inside convId (already hashed client-side)
  size: z.number().int().min(1).optional(),
  direction: z.enum(['sent', 'received']).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

const SignGetSchema = z.object({
  key: z.string().min(3),
  uidHex: z.string().min(14),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional(),
  conversationFingerprint: z.string().min(16).optional(),
  downloadName: z.string().min(1).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

async function fetchMediaUsage({ convId, prefix }) {
  if (!DATA_API || !HMAC_SECRET) return null;
  const path = '/d1/media/usage';
  const payload = { convId, prefix };
  const body = JSON.stringify(payload);
  const sig = signHmac(path, body, HMAC_SECRET);
  const res = await fetch(`${DATA_API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-auth': sig },
    body
  });
  let raw = '';
  try {
    raw = await res.text();
  } catch {
    raw = '';
  }
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    if (res.status === 404) return null;
    const detail = data && typeof data === 'object' ? JSON.stringify(data) : raw;
    throw new Error(`media usage fetch failed (${res.status}): ${detail || 'unknown error'}`);
  }
  if (data?.error) throw new Error(`media usage rejected (${res.status}): ${JSON.stringify(data)}`);
  return data;
}

function extractConversationIdFromKey(key) {
  const safe = String(key || '').replace(/[\u0000-\u001F\u007F]/gu, '').trim();
  if (!safe) return null;
  const firstSlash = safe.indexOf('/');
  if (firstSlash === -1) return safe;
  return safe.slice(0, firstSlash);
}

// POST /api/v1/media/sign-put
r.post('/media/sign-put', asyncH(async (req, res) => {
  const input = SignPutSchema.parse(req.body);

  const ttlSec = Number(process.env.SIGNED_PUT_TTL || 900);
  const maxBytes = Number.isFinite(MAX_UPLOAD_BYTES) && MAX_UPLOAD_BYTES > 0 ? MAX_UPLOAD_BYTES : 524_288_000;

  const uidHex = normalizeUidHex(input.uidHex);
  if (!uidHex) {
    return res.status(400).json({ error: 'BadRequest', message: 'invalid uidHex' });
  }
  const tokenClean = input.accountToken ? String(input.accountToken).trim() : undefined;
  const digestClean = input.accountDigest ? normalizeAccountDigest(input.accountDigest) : undefined;
  const accountPayload = { uidHex };
  if (tokenClean) accountPayload.accountToken = tokenClean;
  if (digestClean) accountPayload.accountDigest = digestClean;

  let verified;
  try {
    verified = await verifyAccount(accountPayload);
  } catch (err) {
    return res.status(502).json({ error: 'VerifyFailed', message: err?.message || 'verify request failed' });
  }
  if (!verified.ok) {
    const status = verified.status || 502;
    return res.status(status).json(verified.data || { error: 'VerifyFailed' });
  }
  const resolvedDigest = normalizeAccountDigest(verified.data?.account_digest || verified.data?.accountDigest || digestClean);
  if (!resolvedDigest) {
    return res.status(502).json({ error: 'VerifyFailed', message: 'account digest missing' });
  }
  const resolvedUid = normalizeUidHex(verified.data?.uid_hex || verified.data?.uidHex || uidHex) || uidHex;

  const convId = normalizeConversationId(input.convId);
  if (!convId) {
    return res.status(400).json({ error: 'BadRequest', message: 'invalid convId' });
  }

  if (!isSystemOwnedConversation({ convId, accountDigest: resolvedDigest, uidHex: resolvedUid })) {
    try {
      await authorizeConversationAccess({
        convId,
        accountDigest: resolvedDigest,
        fingerprint: input.conversationFingerprint ? String(input.conversationFingerprint).trim() || null : null
      });
    } catch (err) {
      const status = err?.status || 502;
      const payload = err?.details && typeof err.details === 'object'
        ? err.details
        : { error: 'ConversationAccessDenied', message: err?.message || 'conversation access denied', details: err?.details || null };
      return res.status(status).json(payload);
    }
  }

  if (input.size != null) {
    const sizeNum = Number(input.size);
    if (!Number.isFinite(sizeNum) || sizeNum <= 0) {
      return res.status(400).json({ error: 'BadRequest', message: 'invalid size' });
    }
    if (sizeNum > maxBytes) {
      return res.status(413).json({
        error: 'FileTooLarge',
        message: `Payload exceeds limit ${maxBytes} bytes`,
        maxBytes
      });
    }
  }

  const uid = nano();
  // sanitize optional dir path: keep safe chars per segment
  let dirClean = '';
  if (input.dir && typeof input.dir === 'string') {
    const segments = String(input.dir)
      .replace(/\\+/g, '/').split('/').map((seg) => {
        if (!seg) return '';
        const normalized = seg.normalize('NFKC')
          .replace(/[\u0000-\u001F\u007F]/gu, '')
          .replace(/[\\/]/g, '')
          .replace(/[?#*<>"'`|]/g, '')
          .trim();
        if (!normalized) return '';
        return normalized.slice(0, 96);
      })
      .filter(Boolean);
    if (segments.length) dirClean = segments.join('/');
  }
  const direction = input.direction === 'received' ? 'received' : 'sent';
  const systemDir = direction === 'received' ? SYSTEM_DIR_RECEIVED : SYSTEM_DIR_SENT;
  const convIdClean = convId;
  const basePrefix = `${convIdClean}/${systemDir}`;
  const keyPrefix = dirClean ? `${basePrefix}/${dirClean}` : basePrefix;
  const key = `${keyPrefix}/${uid}`;

  const allowed = String(process.env.UPLOAD_ALLOWED_TYPES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const ct = input.contentType || 'application/octet-stream';
  if (allowed.length && !allowed.some(rule => rule.endsWith('/*') ? ct.startsWith(rule.slice(0, -1)) : ct === rule)) {
    return res.status(400).json({ error: 'UnsupportedType', message: `Content-Type ${ct} not allowed` });
  }

  if (input.size != null) {
    try {
      const usage = await fetchMediaUsage({ convId: convIdClean, prefix: basePrefix });
      const totalBytes = Number(usage?.totalBytes ?? usage?.total_bytes ?? 0);
      const projected = totalBytes + Number(input.size);
      if (Number.isFinite(totalBytes) && projected > maxBytes) {
        return res.status(413).json({
          error: 'FolderCapacityExceeded',
          message: `系統資料夾儲存量已達上限 ${maxBytes} bytes`,
          maxBytes,
          currentBytes: totalBytes
        });
      }
    } catch (err) {
      return res.status(502).json({ error: 'UsageLookupFailed', message: err?.message || 'failed to verify storage usage' });
    }
  }

  const upload = await createUploadPut({ key, contentType: ct, ttlSec });
  res.json({
    upload,
    expiresIn: ttlSec,
    objectPath: key
  });
}));

// POST /api/v1/media/sign-get
r.post('/media/sign-get', asyncH(async (req, res) => {
  const input = SignGetSchema.parse(req.body);

  const uidHex = normalizeUidHex(input.uidHex);
  if (!uidHex) {
    return res.status(400).json({ error: 'BadRequest', message: 'invalid uidHex' });
  }
  const tokenClean = input.accountToken ? String(input.accountToken).trim() : undefined;
  const digestClean = input.accountDigest ? normalizeAccountDigest(input.accountDigest) : undefined;
  const accountPayload = { uidHex };
  if (tokenClean) accountPayload.accountToken = tokenClean;
  if (digestClean) accountPayload.accountDigest = digestClean;

  let verified;
  try {
    verified = await verifyAccount(accountPayload);
  } catch (err) {
    return res.status(502).json({ error: 'VerifyFailed', message: err?.message || 'verify request failed' });
  }
  if (!verified.ok) {
    const status = verified.status || 502;
    return res.status(status).json(verified.data || { error: 'VerifyFailed' });
  }
  const resolvedDigest = normalizeAccountDigest(verified.data?.account_digest || verified.data?.accountDigest || digestClean);
  if (!resolvedDigest) {
    return res.status(502).json({ error: 'VerifyFailed', message: 'account digest missing' });
  }
  const resolvedUid = normalizeUidHex(verified.data?.uid_hex || verified.data?.uidHex || uidHex) || uidHex;

  const convIdFragment = extractConversationIdFromKey(input.key);
  const convId = convIdFragment ? normalizeConversationId(convIdFragment) : null;
  if (!convId) {
    return res.status(400).json({ error: 'BadRequest', message: 'invalid object key' });
  }

  if (!isSystemOwnedConversation({ convId, accountDigest: resolvedDigest, uidHex: resolvedUid })) {
    try {
      await authorizeConversationAccess({
        convId,
        accountDigest: resolvedDigest,
        fingerprint: input.conversationFingerprint ? String(input.conversationFingerprint).trim() || null : null
      });
    } catch (err) {
      const status = err?.status || 502;
      const payload = err?.details && typeof err.details === 'object'
        ? err.details
        : { error: 'ConversationAccessDenied', message: err?.message || 'conversation access denied', details: err?.details || null };
      return res.status(status).json(payload);
    }
  }

  const ttlSec = Number(process.env.SIGNED_GET_TTL || 900);
  const out = await createDownloadGet({ key: input.key, ttlSec, downloadName: input.downloadName });
  res.json({ download: out, expiresIn: ttlSec });
}));

export default r;
