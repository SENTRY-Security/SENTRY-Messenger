import { Router } from 'express';
import { asyncH } from '../../middlewares/async.js';
import { redeem, validate, status, tokenStatus } from '../../controllers/subscription.controller.js';

const r = Router();

r.post('/subscription/redeem', asyncH(redeem));
r.post('/subscription/validate', asyncH(validate));
r.get('/subscription/status', asyncH(status));
r.get('/subscription/token-status', asyncH(tokenStatus));

export default r;
