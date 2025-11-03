import { Router } from 'express';
import v1msg from './v1/messages.routes.js';
import v1media from './v1/media.routes.js';
import auth from './auth.routes.js';
import keys from './keys.routes.js';
import devkeys from './devkeys.routes.js';
import friends from './friends.routes.js';
import wsToken from './ws-token.routes.js';
import { getHealth, getStatus } from '../controllers/messages.controller.js';

const r = Router();

// health & status
r.get('/health', getHealth);
r.get('/status', getStatus);

// v1 routes
r.use('/v1', v1msg);
r.use('/v1', v1media);
r.use('/v1', friends);
r.use('/', friends);
r.use('/v1', auth);
r.use('/v1', keys);
r.use('/v1', devkeys);
r.use('/v1', wsToken);

export default r;
