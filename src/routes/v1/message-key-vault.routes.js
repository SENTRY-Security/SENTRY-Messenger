import { Router } from 'express';
import { putMessageKeyVault, getMessageKeyVault } from '../../controllers/message-key-vault.controller.js';

const r = Router();

r.post('/message-key-vault/put', putMessageKeyVault);
r.post('/message-key-vault/get', getMessageKeyVault);

export default r;
