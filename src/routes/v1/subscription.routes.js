import { Router } from 'express';
import { asyncH } from '../../middlewares/async.js';
import multer from 'multer';
import { scanUpload } from '../../controllers/subscription.controller.js';

const r = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
});

// Only scan-upload remains on Node.js (requires jimp/jsqr).
// redeem, validate, status, token-status are now served by the Worker.
r.post('/subscription/scan-upload', upload.single('file'), asyncH(scanUpload));

export default r;
