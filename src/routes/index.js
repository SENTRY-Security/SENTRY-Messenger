import { Router } from 'express';
import v1msg from './v1/messages.routes.js';
import v1media from './v1/media.routes.js';
import v1calls from './v1/calls.routes.js';
import v1debug from './v1/debug.routes.js';
import v1contactSecrets from './v1/contact-secrets.routes.js';
import v1groups from './v1/groups.routes.js';
import v1subscription from './v1/subscription.routes.js';
import v1admin from './v1/admin.routes.js';
import v1messageKeyVault from './v1/message-key-vault.routes.js';
import v1account from './v1/account.routes.js';
import v1invites from './v1/invites.routes.js';
import v1contacts from './v1/contacts.routes.js';
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
r.use('/', v1msg); // Support /d1/messages direct mapping (rewrite drops v1)

r.use('/v1', v1media);
r.use('/v1', v1calls);
r.use('/v1', v1contactSecrets);
r.use('/v1', v1contacts);
r.use('/v1', v1debug);
r.use('/v1', v1groups);
r.use('/v1', v1subscription);
r.use('/v1', v1admin);
r.use('/v1', v1messageKeyVault);
r.use('/v1', v1account);
r.use('/v1', v1invites);
r.use('/v1', friends);
r.use('/', friends);
r.use('/v1', auth);
r.use('/v1', keys);
r.use('/v1', devkeys);
r.use('/v1', wsToken);

export default r;
