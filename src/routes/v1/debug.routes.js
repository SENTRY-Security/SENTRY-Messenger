import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import { resolveAccountAuth, AccountAuthError } from '../../utils/account-context.js';
import { normalizeAccountDigest, AccountDigestRegex } from '../../utils/account-verify.js';

const router = Router();

const REMOTE_CONSOLE_ENABLED = /^(1|true|yes)$/i.test(process.env.REMOTE_CONSOLE_ENABLED || '');
const CONSOLE_ENDPOINT_PATH = '/api/v1/debug/console';
const REMOTE_CONSOLE_LOG_PATH = process.env.REMOTE_CONSOLE_LOG
  ? path.resolve(process.env.REMOTE_CONSOLE_LOG)
  : path.resolve(process.cwd(), 'logs', 'remote-console.log');

function ensureAccountCredentials(value, ctx) {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
}

const ConsoleEntrySchema = z.object({
  level: z.string().optional(),
  message: z.string().optional(),
  args: z.array(z.any()).optional(),
  source: z.string().optional(),
  device: z.string().optional(),
  ts: z.number().optional()
});

const ConsolePayloadSchema = z.object({
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional(),
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
  const accountDigest = normalizeAccountDigest(input.accountDigest);
  try {
    await resolveAccountAuth({
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
        accountDigest,
        level: entry.level || 'log',
        message: entry.message || '',
        args: entry.args || [],
        source: entry.source || 'app',
        device: entry.device || null,
        ts: entry.ts || Date.now(),
        meta: input.meta || null
      }
    }, entry.message || 'remote-console');

    // 追加寫入本地檔案，便於離線比對與長期保存。
    try {
      const payload = {
        ts: entry.ts || Date.now(),
        level: entry.level || 'log',
        message: entry.message || '',
        args: entry.args || [],
        source: entry.source || 'app',
        device: entry.device || null,
        accountDigest,
        meta: input.meta || null
      };
      await fs.mkdir(path.dirname(REMOTE_CONSOLE_LOG_PATH), { recursive: true });
      await fs.appendFile(REMOTE_CONSOLE_LOG_PATH, `${JSON.stringify(payload)}\n`);
    } catch (fileErr) {
      logger.warn({ remoteConsoleWriteError: fileErr?.message || fileErr, path: REMOTE_CONSOLE_LOG_PATH });
    }
  }

  return res.status(200).json({ ok: true, stored: safeEntries.length });
});

export default router;
