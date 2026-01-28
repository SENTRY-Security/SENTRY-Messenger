import { Router } from 'express';
import { asyncH } from '../../middlewares/async.js';
import {
  createMessage,
  createSecureMessage,
  atomicSend, // [ATOMIC-SEND]
  listMessages,
  listSecureMessages,
  getSecureMaxCounter,
  getSecureMessageByCounter,
  getSendState,
  listOutgoingStatus,
  deleteMessages,
  deleteSecureConversation,
  setDeletionCursor
} from '../../controllers/messages.controller.js';

const r = Router();

// POST /api/v1/messages/atomic-send
r.post('/messages/atomic-send', asyncH(atomicSend));

// POST /api/v1/messages/secure
r.post('/messages/secure', asyncH(createSecureMessage));

// POST /api/v1/messages
r.post('/messages', asyncH(createMessage));

// GET /api/v1/conversations/:convId/messages
r.get('/conversations/:convId/messages', asyncH(listMessages));

// GET /api/v1/messages/secure?conversationId=
r.get('/messages/secure', asyncH(listSecureMessages));

// GET /api/v1/messages/secure/max-counter?conversationId=&senderDeviceId=
r.get('/messages/secure/max-counter', asyncH(getSecureMaxCounter));

// GET /api/v1/messages/by-counter?conversationId=&counter=
r.get('/messages/by-counter', asyncH(getSecureMessageByCounter));

// POST /api/v1/messages/send-state
r.post('/messages/send-state', asyncH(getSendState));

// POST /api/v1/messages/outgoing-status
r.post('/messages/outgoing-status', asyncH(listOutgoingStatus));

// POST /api/v1/messages/delete
r.post('/messages/delete', asyncH(deleteMessages));

// POST /api/v1/messages/secure/delete-conversation
r.post('/messages/secure/delete-conversation', asyncH(deleteSecureConversation));

// POST /api/v1/deletion/cursor
r.post('/deletion/cursor', asyncH(setDeletionCursor));

// 之後可加：GET /api/v1/conversations/:id/messages?cursor=...
export default r;
