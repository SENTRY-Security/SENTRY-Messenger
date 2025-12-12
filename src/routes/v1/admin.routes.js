import { Router } from 'express';
import crypto from 'node:crypto';
import { signHmac } from '../../utils/hmac.js';
import { deleteObject, deleteAllWithPrefix } from '../../services/s3.js';
import { getWebSocketManager } from '../../ws/index.js';
import { logger } from '../../utils/logger.js';

const r = Router();
const DATA_API = process.env.DATA_API_URL || process.env.DATA_API;
const HMAC_SECRET = process.env.ADMIN_API_HMAC || process.env.DATA_API_HMAC || process.env.HMAC_SECRET;

function timingSafeEqual(a = '', b = '') {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function verifyIncomingHmac(req) {
  if (!HMAC_SECRET) return false;
  const sig = req.get('x-auth') || '';
  if (!sig) return false;
  const url = new URL(req.originalUrl || '/', 'http://localhost');
  const pathWithQuery = url.pathname + url.search;
  const bodyStr = req.rawBody || JSON.stringify(req.body || {});
  const hmac = (msg) => crypto.createHmac('sha256', HMAC_SECRET).update(msg).digest('base64url');
  const expectedPipe = hmac(pathWithQuery + '|' + bodyStr);
  const expectedNewline = hmac(pathWithQuery + '\n' + bodyStr);
  return timingSafeEqual(sig, expectedPipe) || timingSafeEqual(sig, expectedNewline);
}

r.post('/admin/purge-account', async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API or HMAC_SECRET missing' });
  }
  if (!verifyIncomingHmac(req)) {
    return res.status(401).json({ error: 'Unauthorized', message: 'invalid admin signature' });
  }

  const { uidDigest, accountDigest, dryRun = false } = req.body || {};
  if (!uidDigest && !accountDigest) {
    return res.status(400).json({ error: 'BadRequest', message: 'uidDigest or accountDigest required' });
  }

  const payload = {
    uidDigest: uidDigest || undefined,
    accountDigest: accountDigest || undefined,
    dryRun: !!dryRun
  };
  const bodyStr = JSON.stringify(payload);
  const path = '/d1/accounts/purge';
  const sig = signHmac(path, bodyStr, HMAC_SECRET);
  let workerRes;
  try {
    workerRes = await fetch(`${DATA_API}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth': sig
      },
      body: bodyStr
    });
  } catch (err) {
    return res.status(502).json({ error: 'UpstreamError', message: err?.message || 'fetch failed' });
  }

  let workerJson;
  try {
    const txt = await workerRes.text();
    workerJson = txt ? JSON.parse(txt) : null;
  } catch {
    workerJson = null;
  }

  if (!workerRes.ok) {
    return res.status(workerRes.status).json(workerJson || { error: 'UpstreamError', message: 'worker purge failed' });
  }

  const result = { worker: workerJson || {} };
  if (payload.dryRun || workerJson?.skipped) {
    return res.json(result);
  }

  const mediaKeys = new Set(Array.isArray(workerJson?.mediaKeys) ? workerJson.mediaKeys : []);
  const prefixes = new Set(Array.isArray(workerJson?.prefixes) ? workerJson.prefixes : []);
  const r2Summary = {
    deletedKeys: 0,
    failedKeys: [],
    prefixDeleted: 0,
    prefixFailures: []
  };

  for (const key of mediaKeys) {
    try {
      await deleteObject({ key });
      r2Summary.deletedKeys += 1;
    } catch (err) {
      logger.warn({ event: 'admin.purge.r2.delete-failed', key, error: err?.message || err });
      r2Summary.failedKeys.push({ key, error: err?.message || String(err) });
    }
  }

  for (const prefix of prefixes) {
    try {
      const { deleted } = await deleteAllWithPrefix({ prefix });
      r2Summary.prefixDeleted += Number(deleted) || 0;
    } catch (err) {
      logger.warn({ event: 'admin.purge.r2.prefix-failed', prefix, error: err?.message || err });
      r2Summary.prefixFailures.push({ prefix, error: err?.message || String(err) });
    }
  }

  result.r2 = r2Summary;

  try {
    const manager = getWebSocketManager();
    const logoutDigest = workerJson?.accountDigest || null;
    if (logoutDigest) {
      manager.forceLogout(logoutDigest, {
        reason: 'account purged'
      });
    }
  } catch (err) {
    logger.warn({ event: 'admin.purge.ws-notify-failed', error: err?.message || err });
  }

  return res.json(result);
});

export default r;
