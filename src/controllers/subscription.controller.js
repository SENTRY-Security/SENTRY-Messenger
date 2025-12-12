import { z } from 'zod';
import { redeemVoucher, validateVoucher, subscriptionStatus, voucherStatus } from '../services/subscription-local.js';
import Jimp from 'jimp';
import QrCode from 'qrcode-reader';
import jsQR from 'jsqr';

const DigestRegex = /^[0-9A-Fa-f]{64}$/;

const RedeemSchema = z.object({
  token: z.string().min(8),
  dryRun: z.boolean().optional(),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(DigestRegex).optional()
});

export const redeem = async (req, res) => {
  let input;
  try {
    input = RedeemSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err?.message || 'invalid payload' });
  }
  try {
    const data = await redeemVoucher(input);
    return res.json(data);
  } catch (err) {
    const status = err?.status || 502;
    const payload = err?.payload && typeof err.payload === 'object' ? err.payload : { error: err?.code || 'RedeemFailed', detail: err?.message || err };
    return res.status(status).json(payload);
  }
};

export const validate = async (req, res) => {
  let input;
  try {
    input = RedeemSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err?.message || 'invalid payload' });
  }
  try {
    const data = await validateVoucher({ ...input, dryRun: true });
    return res.json(data);
  } catch (err) {
    const status = err?.status || 502;
    const payload = err?.payload && typeof err.payload === 'object' ? err.payload : { error: err?.code || 'ValidateFailed', detail: err?.message || err };
    return res.status(status).json(payload);
  }
};

export const status = async (req, res) => {
  const digest = typeof req.query?.digest === 'string' ? req.query.digest.trim() : '';
  const uidDigest = typeof req.query?.uidDigest === 'string' ? req.query.uidDigest.trim() : '';
  if (!digest && !uidDigest) {
    return res.status(400).json({ error: 'BadRequest', message: 'digest or uidDigest required' });
  }
  const limitRaw = req.query?.limit;
  const limit = Number.isFinite(Number(limitRaw)) ? Math.min(Math.max(Math.floor(Number(limitRaw)), 1), 200) : undefined;
  try {
    const data = await subscriptionStatus({ digest, uidDigest, limit });
    return res.json(data);
  } catch (err) {
    const statusCode = err?.status || 502;
    const payload = err?.payload && typeof err.payload === 'object' ? err.payload : { error: err?.code || 'StatusFailed', detail: err?.message || err };
    return res.status(statusCode).json(payload);
  }
};

export const tokenStatus = async (req, res) => {
  const tokenId = typeof req.query?.tokenId === 'string' ? req.query.tokenId.trim()
    : (typeof req.query?.voucherId === 'string' ? req.query.voucherId.trim()
      : (typeof req.query?.jti === 'string' ? req.query.jti.trim() : ''));
  if (!tokenId) {
    return res.status(400).json({ error: 'BadRequest', message: 'tokenId required' });
  }
  try {
    const data = await voucherStatus({ tokenId });
    return res.json(data);
  } catch (err) {
    const statusCode = err?.status || 502;
    const payload = err?.payload && typeof err.payload === 'object' ? err.payload : { error: err?.code || 'TokenStatusFailed', detail: err?.message || err };
    return res.status(statusCode).json(payload);
  }
};

async function decodeQrBuffer(buffer) {
  const base = await Jimp.read(buffer);

  const variants = [];
  const pushVariantSet = (img) => {
    variants.push(img.clone());
    variants.push(img.clone().grayscale().contrast(0.6).normalize());
    variants.push(img.clone().invert().contrast(0.6).normalize());
    variants.push(img.clone().grayscale().contrast(1).posterize(2));
  };
  pushVariantSet(base);
  if (base.bitmap.width < 900) {
    pushVariantSet(base.clone().scale(2));
    pushVariantSet(base.clone().scale(3));
  }
  const minSide = Math.min(base.bitmap.width, base.bitmap.height);
  if (minSide > 0) {
    const x = Math.floor((base.bitmap.width - minSide) / 2);
    const y = Math.floor((base.bitmap.height - minSide) / 2);
    const cropped = base.clone().crop(x, y, minSide, minSide);
    pushVariantSet(cropped);
    if (minSide < 900) pushVariantSet(cropped.clone().scale(2));
  }

  const tryVariant = (img) => {
    const tryQrcodeReader = () => new Promise((resolve, reject) => {
      const qr = new QrCode();
      qr.callback = (err, value) => {
        if (err || !value?.result) {
          reject(new Error('未辨識到 QRCode'));
          return;
        }
        resolve(value.result);
      };
      try {
        qr.decode(img.bitmap);
      } catch (err) {
        reject(err);
      }
    });

    const tryJsqr = () => {
      const { data, width, height } = img.bitmap;
      const clamped = new Uint8ClampedArray(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      const result = jsQR(clamped, width, height, { inversionAttempts: 'attemptBoth' });
      if (result?.data) return result.data;
      throw new Error('未辨識到 QRCode');
    };

    return tryQrcodeReader().catch(() => tryJsqr());
  };

  let lastErr = null;
  for (const variant of variants) {
    try {
      return await tryVariant(variant);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('未辨識到 QRCode');
}

export const scanUpload = async (req, res) => {
  const file = req.file;
  if (!file || !file.buffer) {
    return res.status(400).json({ ok: false, error: 'BadRequest', message: '請上傳 QRCode 圖片' });
  }
  const accountToken = typeof req.headers['x-account-token'] === 'string' ? req.headers['x-account-token'].trim() : null;
  const accountDigest = typeof req.headers['x-account-digest'] === 'string' ? req.headers['x-account-digest'].trim() : null;
  let tokenText;
  try {
    tokenText = await decodeQrBuffer(file.buffer);
  } catch (err) {
    return res.status(400).json({ ok: false, error: 'InvalidQr', message: err?.message || '未辨識到 QRCode' });
  }
  try {
    const data = await redeemVoucher({ token: tokenText, accountToken, accountDigest });
    return res.json({ ok: true, token: tokenText, ...data });
  } catch (err) {
    const status = err?.status || 502;
    const message = err?.message || err?.payload?.message || '展期失敗，請稍後再試';
    return res.status(status).json({ ok: false, error: err?.code || 'RedeemFailed', message });
  }
};
