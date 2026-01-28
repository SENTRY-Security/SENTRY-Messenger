import { Router } from 'express';
import { asyncH } from '../../middlewares/async.js';
import {
  backupContactSecrets,
  fetchContactSecretsBackup
} from '../../controllers/contact-secrets.controller.js';

const r = Router();

r.post('/contact-secrets/backup', asyncH(backupContactSecrets));
r.get('/contact-secrets/backup', asyncH(fetchContactSecretsBackup));

export default r;
