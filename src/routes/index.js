import { Router } from 'express';
import v1subscription from './v1/subscription.routes.js';
import { getHealth, getStatus } from '../controllers/messages.controller.js';

const r = Router();

// health & status
r.get('/health', getHealth);
r.get('/status', getStatus);

// v1 routes – only scan-upload remains on Node.js (requires jimp/jsqr).
// Everything else is now served directly by the Cloudflare Worker:
//   auth, mk, ws/token, contacts, invites, friends, messages,
//   media, groups, keys, devkeys, subscription (redeem/validate/status),
//   admin (set-brand, purge-account), calls, deletion
r.use('/v1', v1subscription);

export default r;
