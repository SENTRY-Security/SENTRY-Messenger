import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import routes from './routes/index.js';
import { env } from './utils/env.js';
import { logger } from './utils/logger.js';
import { notFound, errorHandler } from './middlewares/error.js';

const app = express();

// trust loopback proxy (Nginx) for accurate client IP headers
app.set('trust proxy', 'loopback');

// 安全與效能
app.use(helmet());
app.use(compression());

// CORS（Cloudflare Pages 網域）— 支援逗號分隔 allowlist
const allowList = (env.CORS_ORIGIN ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const corsOrigin = allowList.length
  ? (origin, cb) => {
    // Allow requests with no Origin header (non-browser / same-origin).
    // Reject Origin: null (sandboxed iframes, file://, redirects).
    if (origin === undefined) return cb(null, true);
    cb(null, allowList.includes(origin));
  }
  : false;
app.use(cors({ origin: corsOrigin, credentials: false }));

// 解析 JSON
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => {
    try {
      req.rawBody = buf.toString('utf8');
    } catch {
      req.rawBody = '';
    }
  }
}));

// 日誌
app.use(pinoHttp({ logger }));

// API 基礎 Rate Limit（預設啟用；僅可透過 DISABLE_RATE_LIMIT=1 明確停用）
const enableRateLimit = process.env.DISABLE_RATE_LIMIT !== '1';
if (enableRateLimit) {
  const apiRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 300, // 每分鐘 300 次
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next, options) => {
      logger.warn({
        event: 'api.rate-limit',
        path: req.originalUrl,
        method: req.method,
        ip: req.ip,
        limit: options.limit,
        windowMs: options.windowMs,
        current: req.rateLimit?.current ?? null
      }, 'API rate limit triggered');
      const statusCode = options.statusCode ?? 429;
      const message = typeof options.message === 'string'
        ? options.message
        : 'Too many requests, please try again later.';
      res.status(statusCode).json({
        error: 'TooManyRequests',
        message,
        limit: options.limit,
        windowMs: options.windowMs
      });
    }
  });
  app.use('/api/', apiRateLimiter);
}

// 路由
app.use('/api', routes);

// 404 & 錯誤處理
app.use(notFound);
app.use(errorHandler);

export default app;
