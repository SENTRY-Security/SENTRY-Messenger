import { Router } from 'express';
import v1subscription from './v1/subscription.routes.js';
import v1admin from './v1/admin.routes.js';
import wsToken from './ws-token.routes.js';
import { getHealth, getStatus } from '../controllers/messages.controller.js';

const r = Router();

// health & status
r.get('/health', getHealth);
r.get('/status', getStatus);

// v1 routes – only unmigrated endpoints remain;
// everything else is now served directly by the Cloudflare Worker.
// Migrated to Worker: auth, mk, contacts (uplink/downlink/avatar), admin/set-brand
r.use('/v1', v1subscription); // scan-upload still needs Node.js (jimp/jsqr)
r.use('/v1', v1admin);        // purge-account still needs R2 delete + WS force-logout
r.use('/v1', wsToken);        // WS token needs Node.js JWT + WS server

export default r;
