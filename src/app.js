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
      if (!origin) return cb(null, true); // non-browser or same-origin
      cb(null, allowList.includes(origin));
    }
  : false;
app.use(cors({ origin: corsOrigin, credentials: false }));

// 解析 JSON
app.use(express.json({ limit: '2mb' }));

// 日誌
app.use(pinoHttp({ logger }));

// API 基礎 Rate Limit（僅在正式環境啟用，可視路徑細分）
const enableRateLimit = process.env.NODE_ENV === 'production' && process.env.DISABLE_RATE_LIMIT !== '1';
if (enableRateLimit) {
  app.use('/api/', rateLimit({
    windowMs: 60 * 1000,
    limit: 300, // 每分鐘 300 次
    standardHeaders: true,
    legacyHeaders: false
  }));
}

// 路由
app.use('/api', routes);

// 404 & 錯誤處理
app.use(notFound);
app.use(errorHandler);

export default app;
