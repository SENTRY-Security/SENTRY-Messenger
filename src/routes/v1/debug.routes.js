import { Router } from 'express';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import { resolveAccountAuth, AccountAuthError } from '../../utils/account-context.js';
import { normalizeUidHex, normalizeAccountDigest, AccountDigestRegex } from '../../utils/account-verify.js';

const UidRegex = /^[0-9A-Fa-f]{14,}$/;

const router = Router();

const REMOTE_CONSOLE_ENABLED = /^(1|true|yes)$/i.test(process.env.REMOTE_CONSOLE_ENABLED || '');
const CONSOLE_ENDPOINT_PATH = '/api/v1/debug/console';

function ensureAccountCredentials(value, ctx) {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
}

const BaseSchema = z.object({
  uidHex: z.string().regex(UidRegex),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
});

const ConsoleEntrySchema = z.object({
  level: z.string().optional(),
  message: z.string().optional(),
  args: z.array(z.any()).optional(),
  source: z.string().optional(),
  ts: z.number().optional()
});

const ConsolePayloadSchema = BaseSchema.extend({
  entries: z.array(ConsoleEntrySchema).min(1),
  clientTs: z.number().optional(),
  meta: z.record(z.any()).optional()
}).superRefine(ensureAccountCredentials);

function respondAccountError(res, err, fallback = 'authorization failed') {
  if (err instanceof AccountAuthError) {
    return res.status(err.status || 400).json({ error: err.name, message: err.message, details: err.details || null });
  }
  return res.status(500).json({ error: 'AccountAuthError', message: err?.message || fallback });
}

router.get('/debug/config', (req, res) => {
  if (!REMOTE_CONSOLE_ENABLED) {
    return res.status(200).json({ enabled: false });
  }
  return res.status(200).json({ enabled: true, endpoint: CONSOLE_ENDPOINT_PATH });
});

router.post('/debug/console', async (req, res) => {
  if (!REMOTE_CONSOLE_ENABLED) {
    return res.status(403).json({ error: 'Disabled', message: 'remote console relay disabled by server config' });
  }
  const parsed = ConsolePayloadSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'BadRequest', details: parsed.error.issues });
  }
  const input = parsed.data;
  const uidHex = normalizeUidHex(input.uidHex);
  const accountDigest = normalizeAccountDigest(input.accountDigest);
  try {
    await resolveAccountAuth({
      uidHex,
      accountToken: input.accountToken,
      accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }

  const safeEntries = input.entries.slice(0, 50);
  for (const entry of safeEntries) {
    logger.info({
      remoteConsole: {
        uidHex,
        accountDigest,
        level: entry.level || 'log',
        message: entry.message || '',
        args: entry.args || [],
        source: entry.source || 'app',
        ts: entry.ts || Date.now(),
        meta: input.meta || null
      }
    }, entry.message || 'remote-console');
  }

  return res.status(200).json({ ok: true, stored: safeEntries.length });
});

export default router;
