import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  SERVICE_NAME: z.string().min(1).default('message-api'),
  SERVICE_VERSION: z.string().min(1).default('0.1.0'),
  // 支援逗號分隔多個來源，這裡只驗證為非空字串
  CORS_ORIGIN: z.string().min(1).optional(),
  WS_TOKEN_SECRET: z.string().min(32, 'WS_TOKEN_SECRET must be at least 32 characters long'),
  TRUST_PROXY: z.string().min(1).default('loopback')
});

export const env = EnvSchema.parse({
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT,
  SERVICE_NAME: process.env.SERVICE_NAME,
  SERVICE_VERSION: process.env.SERVICE_VERSION,
  CORS_ORIGIN: process.env.CORS_ORIGIN,
  WS_TOKEN_SECRET: process.env.WS_TOKEN_SECRET,
  TRUST_PROXY: process.env.TRUST_PROXY
});
