import { Router } from 'express';
import {
  createInvite,
  acceptInvite,
  deleteContact,
  shareContactUpdate,
  bootstrapFriendSession
} from '../controllers/friends.controller.js';

const r = Router();

r.post('/friends/invite', createInvite);
r.post('/friends/accept', acceptInvite);
r.post('/friends/delete', deleteContact);
r.post('/friends/contact/share', shareContactUpdate);
r.post('/friends/bootstrap-session', bootstrapFriendSession);

export default r;
