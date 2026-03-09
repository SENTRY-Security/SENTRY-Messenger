import { Router } from 'express';
import v1subscription from './v1/subscription.routes.js';
import v1admin from './v1/admin.routes.js';
import v1contacts from './v1/contacts.routes.js';
import wsToken from './ws-token.routes.js';
import { getHealth, getStatus } from '../controllers/messages.controller.js';

const r = Router();

// health & status
r.get('/health', getHealth);
r.get('/status', getStatus);

// v1 routes – only unmigrated endpoints remain;
// everything else is now served directly by the Cloudflare Worker.
r.use('/v1', v1subscription); // scan-upload still needs Node.js (jimp/jsqr)
r.use('/v1', v1contacts);     // avatar sign-put/sign-get still uses S3 SDK
r.use('/v1', v1admin);
r.use('/v1', wsToken);

export default r;
