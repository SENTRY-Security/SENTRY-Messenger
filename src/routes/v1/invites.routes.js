import { Router } from 'express';
import {
  createInviteDropbox,
  deliverInviteDropbox,
  consumeInviteDropbox,
  statusInviteDropbox
} from '../../controllers/invites.controller.js';

const r = Router();

r.post('/invites/create', createInviteDropbox);
r.post('/invites/deliver', deliverInviteDropbox);
r.post('/invites/consume', consumeInviteDropbox);
r.post('/invites/status', statusInviteDropbox);

export default r;
