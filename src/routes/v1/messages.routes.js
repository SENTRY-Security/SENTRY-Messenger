import { Router } from 'express';
import { asyncH } from '../../middlewares/async.js';
import { createMessage, createSecureMessage, listMessages, listSecureMessages, deleteMessages } from '../../controllers/messages.controller.js';

const r = Router();

// POST /api/v1/messages/secure
r.post('/messages/secure', asyncH(createSecureMessage));

// POST /api/v1/messages
r.post('/messages', asyncH(createMessage));

// GET /api/v1/conversations/:convId/messages
r.get('/conversations/:convId/messages', asyncH(listMessages));

// GET /api/v1/messages/secure?conversationId=
r.get('/messages/secure', asyncH(listSecureMessages));

// POST /api/v1/messages/delete
r.post('/messages/delete', asyncH(deleteMessages));

// 之後可加：GET /api/v1/conversations/:id/messages?cursor=...
export default r;
