import { Router } from 'express';
import { asyncH } from '../../middlewares/async.js';
import { z } from 'zod';
import { customAlphabet } from 'nanoid';
import { createDownloadGet, createUploadPut } from '../../services/s3.js';
import { signHmac } from '../../utils/hmac.js';
import {
  verifyAccount,
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
const DRIVE_QUOTA_BYTES = Number(process.env.DRIVE_QUOTA_BYTES || 3 * 1024 * 1024 * 1024); // default 3GB total per system dir
const DATA_API = process.env.DATA_API_URL;
const HMAC_SECRET = process.env.DATA_API_HMAC;

const SYSTEM_DIR_SENT = '__SYS_SENT__';
const SYSTEM_DIR_RECEIVED = '__SYS_RECV__';

const SignPutSchema = z.object({
  conv_id: z.string().min(1),
  account_token: z.string().min(8).optional(),
  account_digest: z.string().regex(AccountDigestRegex).optional(),
  ext: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/i).optional(),
  content_type: z.string().min(1).optional(),
  dir: z.string().max(200).optional(),
  size: z.number().int().min(1).optional(),
  direction: z.enum(['sent', 'received']).optional()
}).superRefine((value, ctx) => {
  if (!value.account_token && !value.account_digest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'account_token or account_digest required' });
  }
});

const SignGetSchema = z.object({
  key: z.string().min(3),
  account_token: z.string().min(8).optional(),
  account_digest: z.string().regex(AccountDigestRegex).optional(),
  download_name: z.string().min(1).optional()
}).superRefine((value, ctx) => {
  if (!value.account_token && !value.account_digest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'account_token or account_digest required' });
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

  const tokenClean = input.account_token ? String(input.account_token).trim() : undefined;
  const digestClean = input.account_digest ? normalizeAccountDigest(input.account_digest) : undefined;
  const accountPayload = {};
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
  const convId = normalizeConversationId(input.conv_id);
  if (!convId) {
    return res.status(400).json({ error: 'BadRequest', message: 'invalid conv_id' });
  }

  if (!isSystemOwnedConversation({ convId, accountDigest: resolvedDigest })) {
    try {
      await authorizeConversationAccess({
        convId,
        accountDigest: resolvedDigest,
        deviceId: req.get('x-device-id') || null
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
  const direction = input.direction === 'received' ? 'received' : (input.direction === 'sent' ? 'sent' : null);
  const convIdClean = convId;
  let basePrefix = convIdClean;
  if (direction === 'received') {
    basePrefix = `${convIdClean}/${SYSTEM_DIR_RECEIVED}`;
  } else if (direction === 'sent') {
    basePrefix = `${convIdClean}/${SYSTEM_DIR_SENT}`;
  }
  const keyPrefix = dirClean ? `${basePrefix}/${dirClean}` : basePrefix;
  const key = `${keyPrefix}/${uid}`;

  // 不限制 Content-Type，全部允許；若要限制可透過 env 重啟後再加入檢查。
  const allowed = [];

  const ct = input.content_type || 'application/octet-stream';

  if (input.size != null) {
    try {
      const usage = await fetchMediaUsage({ convId: convIdClean, prefix: basePrefix });
      const totalBytes = Number(usage?.totalBytes ?? usage?.total_bytes ?? 0);
      const projected = totalBytes + Number(input.size);
      const quotaBytes = Number.isFinite(DRIVE_QUOTA_BYTES) && DRIVE_QUOTA_BYTES > 0
        ? DRIVE_QUOTA_BYTES
        : 3 * 1024 * 1024 * 1024;
      if (Number.isFinite(totalBytes) && projected > quotaBytes) {
        return res.status(413).json({
          error: 'FolderCapacityExceeded',
          message: `空間不足，上限 ${quotaBytes} bytes`,
          maxBytes: quotaBytes,
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

  const tokenClean = input.account_token ? String(input.account_token).trim() : undefined;
  const digestClean = input.account_digest ? normalizeAccountDigest(input.account_digest) : undefined;
  const accountPayload = {};
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
  const convIdFragment = extractConversationIdFromKey(input.key);
  const convId = convIdFragment ? normalizeConversationId(convIdFragment) : null;
  if (!convId) {
    return res.status(400).json({ error: 'BadRequest', message: 'invalid object key' });
  }

  if (!isSystemOwnedConversation({ convId, accountDigest: resolvedDigest })) {
    try {
      await authorizeConversationAccess({
        convId,
        accountDigest: resolvedDigest,
        deviceId: req.get('x-device-id') || null
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
  const out = await createDownloadGet({ key: input.key, ttlSec, downloadName: input.download_name });
  res.json({ download: out, expiresIn: ttlSec });
}));

export default r;
