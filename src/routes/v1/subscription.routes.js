import { Router } from 'express';
import { asyncH } from '../../middlewares/async.js';
import multer from 'multer';
import { redeem, validate, status, tokenStatus, scanUpload } from '../../controllers/subscription.controller.js';

const r = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
});

r.post('/subscription/redeem', asyncH(redeem));
r.post('/subscription/validate', asyncH(validate));
r.get('/subscription/status', asyncH(status));
r.get('/subscription/token-status', asyncH(tokenStatus));
r.post('/subscription/scan-upload', upload.single('file'), asyncH(scanUpload));

export default r;
