import { Router } from 'express';
import {
  createInviteDropbox,
  deliverInviteDropbox,
  consumeInviteDropbox,
  statusInviteDropbox,
  confirmInviteDropbox,
  unconfirmedInvitesDropbox
} from '../../controllers/invites.controller.js';

const r = Router();

r.post('/invites/create', createInviteDropbox);
r.post('/invites/deliver', deliverInviteDropbox);
r.post('/invites/consume', consumeInviteDropbox);
r.post('/invites/confirm', confirmInviteDropbox);
r.post('/invites/unconfirmed', unconfirmedInvitesDropbox);
r.post('/invites/status', statusInviteDropbox);

export default r;
