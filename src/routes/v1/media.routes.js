import { Router } from 'express';
import { asyncH } from '../../middlewares/async.js';
import { z } from 'zod';
import { customAlphabet } from 'nanoid';
import { createDownloadGet, createUploadPut } from '../../services/s3.js';
import { signHmac } from '../../utils/hmac.js';

const r = Router();
const nano = customAlphabet('1234567890abcdef', 32);

const MAX_UPLOAD_BYTES = Number(process.env.UPLOAD_MAX_BYTES || 524_288_000); // default 500MB
const DATA_API = process.env.DATA_API_URL;
const HMAC_SECRET = process.env.DATA_API_HMAC;

const SYSTEM_DIR_SENT = '已傳送';
const SYSTEM_DIR_RECEIVED = '已接收';
const AccountDigestRegex = /^[0-9A-Fa-f]{64}$/;

const SignPutSchema = z.object({
  convId: z.string().min(1),
  ext: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/i).optional(),
  contentType: z.string().min(1).optional(),
  dir: z.string().max(200).optional(), // optional subdirectory inside convId (already hashed client-side)
  size: z.number().int().min(1).optional(),
  direction: z.enum(['sent', 'received']).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
});

const SignGetSchema = z.object({
  key: z.string().min(3),
  downloadName: z.string().min(1).optional()
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

// POST /api/v1/media/sign-put
r.post('/media/sign-put', asyncH(async (req, res) => {
  const input = SignPutSchema.parse(req.body);

  const ttlSec = Number(process.env.SIGNED_PUT_TTL || 900);
  const maxBytes = Number.isFinite(MAX_UPLOAD_BYTES) && MAX_UPLOAD_BYTES > 0 ? MAX_UPLOAD_BYTES : 524_288_000;

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
  const convIdCleanRaw = String(input.convId).replace(/[\u0000-\u001F\u007F]/gu, '').trim();
  const convIdClean = convIdCleanRaw || input.convId;
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
  const ttlSec = Number(process.env.SIGNED_GET_TTL || 900);
  const out = await createDownloadGet({ key: input.key, ttlSec, downloadName: input.downloadName });
  res.json({ download: out, expiresIn: ttlSec });
}));

export default r;
