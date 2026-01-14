import { Router } from 'express';
import { putMessageKeyVault, getMessageKeyVault, getVaultPutCount } from '../../controllers/message-key-vault.controller.js';

const r = Router();

r.post('/message-key-vault/put', putMessageKeyVault);
r.post('/message-key-vault/get', getMessageKeyVault);
r.post('/message-key-vault/count', getVaultPutCount);

export default r;
