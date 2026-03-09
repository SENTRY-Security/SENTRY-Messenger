import { Router } from 'express';
import crypto from 'node:crypto';
import { getWebSocketManager } from '../ws/index.js';
import { logger } from '../utils/logger.js';

const r = Router();
const NOTIFY_SECRET = process.env.WS_NOTIFY_SECRET || process.env.DATA_API_HMAC || '';

function verifyNotifyHmac(req) {
  if (!NOTIFY_SECRET) return false;
  const sig = (req.headers['x-ws-notify-hmac'] || '').trim();
  if (!sig) return false;
  const bodyStr = req.rawBody || JSON.stringify(req.body || {});
  const expected = crypto.createHmac('sha256', NOTIFY_SECRET).update(bodyStr).digest('base64url');
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

/**
 * POST /internal/ws-notify
 * Receives fire-and-forget notifications from the Cloudflare Worker
 * and dispatches them to connected WebSocket clients.
 */
r.post('/internal/ws-notify', (req, res) => {
  if (!verifyNotifyHmac(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const payload = req.body;
  if (!payload || !payload.type) {
    return res.status(400).json({ error: 'BadRequest', message: 'type required' });
  }

  let manager;
  try {
    manager = getWebSocketManager();
  } catch {
    return res.status(503).json({ error: 'WsNotReady' });
  }

  const type = payload.type;
  try {
    switch (type) {
      case 'secure-message':
        manager.notifySecureMessage({
          targetAccountDigest: payload.targetAccountDigest,
          conversationId: payload.conversationId,
          messageId: payload.messageId || null,
          preview: payload.preview || '',
          ts: payload.ts || Date.now(),
          senderAccountDigest: payload.senderAccountDigest,
          senderDeviceId: payload.senderDeviceId,
          targetDeviceId: payload.targetDeviceId,
          counter: payload.counter ?? null
        });
        break;
      case 'invite-delivered':
        manager.sendInviteDelivered(null, {
          targetAccountDigest: payload.targetAccountDigest,
          targetDeviceId: payload.targetDeviceId || null,
          inviteId: payload.inviteId
        });
        break;
      case 'contact-removed':
        manager.sendContactRemoved(null, {
          fromAccountDigest: payload.ownerAccountDigest || payload.senderAccountDigest,
          targetAccountDigest: payload.peerAccountDigest || payload.targetAccountDigest,
          senderDeviceId: payload.senderDeviceId,
          targetDeviceId: payload.targetDeviceId || null,
          conversationId: payload.conversationId || null
        });
        break;
      case 'contacts-reload':
        manager.notifyContactsReload(null, payload.targetAccountDigest || payload.accountDigest);
        break;
      case 'call-invite':
      case 'call-cancel':
      case 'call-reject':
      case 'call-answer':
      case 'call-hangup':
      case 'call-ice-candidate':
      case 'call-renegotiate': {
        // Relay call signaling to the target account via WS broadcast
        const callTarget = payload.calleeAccountDigest || payload.targetAccountDigest;
        if (callTarget) {
          manager.broadcastToAccount(callTarget, {
            type: payload.type,
            callId: payload.callId,
            fromAccountDigest: payload.callerAccountDigest || payload.senderAccountDigest,
            toAccountDigest: callTarget,
            fromDeviceId: payload.senderDeviceId || null,
            toDeviceId: payload.targetDeviceId || null,
            mode: payload.mode || null,
            ts: payload.ts || Date.now(),
            payload: payload.detail || payload.payload || null
          });
        }
        break;
      }
      case 'force-logout':
        manager.forceLogout(payload.targetAccountDigest, {
          reason: payload.reason || 'account purged'
        });
        break;
      default:
        logger.warn({ event: 'ws-notify.unknown-type', type }, 'unknown notification type');
        return res.status(400).json({ error: 'UnknownType', message: `unknown type: ${type}` });
    }
  } catch (err) {
    logger.warn({ event: 'ws-notify.dispatch-failed', type, error: err?.message || err }, 'notification dispatch failed');
    return res.status(500).json({ error: 'DispatchFailed', message: err?.message || 'dispatch failed' });
  }

  return res.json({ ok: true });
});

export default r;
