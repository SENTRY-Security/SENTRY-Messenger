import { z } from 'zod';
import { redeemSubscription, validateSubscription, getSubscriptionStatus } from '../services/portal-subscription.js';

const DigestRegex = /^[0-9A-Fa-f]{64}$/;

const RedeemSchema = z.object({
  payload: z.any(),
  signature_b64: z.string().min(8),
  dryRun: z.boolean().optional()
});

export const redeem = async (req, res) => {
  let input;
  try {
    input = RedeemSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err?.message || 'invalid payload' });
  }
  try {
    const data = await redeemSubscription(input);
    return res.json(data);
  } catch (err) {
    const status = err?.status || 502;
    const payload = err?.payload && typeof err.payload === 'object' ? err.payload : { error: 'PortalError', detail: err?.message || err };
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
    const data = await validateSubscription(input);
    return res.json(data);
  } catch (err) {
    const status = err?.status || 502;
    const payload = err?.payload && typeof err.payload === 'object' ? err.payload : { error: 'PortalError', detail: err?.message || err };
    return res.status(status).json(payload);
  }
};

export const status = async (req, res) => {
  const digest = typeof req.query?.digest === 'string' ? req.query.digest.trim() : '';
  const limitRaw = req.query?.limit;
  if (!DigestRegex.test(digest)) {
    return res.status(400).json({ error: 'BadRequest', message: 'invalid digest' });
  }
  const limit = Number.isFinite(Number(limitRaw)) ? Math.min(Math.max(Math.floor(Number(limitRaw)), 1), 200) : undefined;
  try {
    const data = await getSubscriptionStatus({ digest, limit });
    return res.json(data);
  } catch (err) {
    const statusCode = err?.status || 502;
    const payload = err?.payload && typeof err.payload === 'object' ? err.payload : { error: 'PortalError', detail: err?.message || err };
    return res.status(statusCode).json(payload);
  }
};
