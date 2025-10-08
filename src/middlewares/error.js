import { ZodError } from 'zod';
import { logger } from '../utils/logger.js';

export function notFound(req, res, next) {
  res.status(404).json({ error: 'NotFound', path: req.originalUrl });
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'BadRequest', details: err.flatten() });
  }
  const status = err.status || 500;
  const code = err.code || 'InternalError';
  logger.error({ err, path: req.originalUrl }, 'request_failed');
  res.status(status).json({ error: code, message: err.message || 'Internal error' });
}