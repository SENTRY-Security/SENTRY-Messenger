import { Router } from 'express';

const router = Router();

router.get('/debug/config', (_req, res) => {
  return res.status(200).json({ enabled: false });
});

router.post('/debug/console', (_req, res) => {
  return res.status(403).json({ error: 'Disabled', message: 'remote console is disabled' });
});

export default router;
