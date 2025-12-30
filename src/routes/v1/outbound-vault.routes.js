import { Router } from 'express';
import { putOutboundKey, getOutboundKey } from '../../controllers/outbound-key-vault.controller.js';

const r = Router();

r.post('/outbound-key-vault/put', putOutboundKey);
r.post('/outbound-key-vault/get', getOutboundKey);

export default r;
