import { Router } from 'express';
import { asyncH } from '../../middlewares/async.js';
import { getAccountEvidence } from '../../controllers/account.controller.js';

const r = Router();

r.get('/account/evidence', asyncH(getAccountEvidence));

export default r;
