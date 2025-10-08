import { Router } from 'express';
import { createInvite, acceptInvite, attachInviteContact, deleteContact, shareContactUpdate } from '../controllers/friends.controller.js';

const r = Router();

r.post('/friends/invite', createInvite);
r.post('/friends/invite/contact', attachInviteContact);
r.post('/friends/accept', acceptInvite);
r.post('/friends/delete', deleteContact);
r.post('/friends/contact/share', shareContactUpdate);

export default r;
