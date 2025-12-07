import { z } from 'zod';
import { redeemVoucher, validateVoucher, subscriptionStatus, voucherStatus } from '../services/subscription-local.js';

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
  const limitRaw = req.query?.limit;
  const limit = Number.isFinite(Number(limitRaw)) ? Math.min(Math.max(Math.floor(Number(limitRaw)), 1), 200) : undefined;
  try {
    const data = await subscriptionStatus({ digest, limit });
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
