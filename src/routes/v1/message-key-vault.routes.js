import { Router } from 'express';
import { putMessageKeyVault, getMessageKeyVault, getVaultPutCount, deleteMessageKeyVault, getLatestStateVault } from '../../controllers/message-key-vault.controller.js';

const r = Router();

r.post('/message-key-vault/put', putMessageKeyVault);
r.post('/message-key-vault/get', getMessageKeyVault);
r.post('/message-key-vault/latest-state', getLatestStateVault);
r.post('/message-key-vault/count', getVaultPutCount);
r.post('/message-key-vault/delete', deleteMessageKeyVault);

export default r;
