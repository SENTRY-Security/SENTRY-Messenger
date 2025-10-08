import { Router } from 'express';
import { asyncH } from '../../middlewares/async.js';
import { z } from 'zod';
import { customAlphabet } from 'nanoid';
import { createDownloadGet, createUploadPut } from '../../services/s3.js';

const r = Router();
const nano = customAlphabet('1234567890abcdef', 32);

const SignPutSchema = z.object({
  convId: z.string().min(1),
  ext: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/i).optional(),
  contentType: z.string().min(1).optional(),
  dir: z.string().max(200).optional() // optional subdirectory inside convId (already hashed client-side)
});

const SignGetSchema = z.object({
  key: z.string().min(3),
  downloadName: z.string().min(1).optional()
});

// POST /api/v1/media/sign-put
r.post('/media/sign-put', asyncH(async (req, res) => {
  const input = SignPutSchema.parse(req.body);

  const ttlSec = Number(process.env.SIGNED_PUT_TTL || 900);

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
  const key = dirClean
    ? `${input.convId}/${dirClean}/${uid}`
    : `${input.convId}/${uid}`;

  const allowed = String(process.env.UPLOAD_ALLOWED_TYPES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const ct = input.contentType || 'application/octet-stream';
  if (allowed.length && !allowed.some(rule => rule.endsWith('/*') ? ct.startsWith(rule.slice(0, -1)) : ct === rule)) {
    return res.status(400).json({ error: 'UnsupportedType', message: `Content-Type ${ct} not allowed` });
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
