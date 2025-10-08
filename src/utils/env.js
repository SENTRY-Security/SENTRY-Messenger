import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  SERVICE_NAME: z.string().min(1).default('message-api'),
  SERVICE_VERSION: z.string().min(1).default('0.1.0'),
  CORS_ORIGIN: z.string().url().optional()
});

export const env = EnvSchema.parse({
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT,
  SERVICE_NAME: process.env.SERVICE_NAME,
  SERVICE_VERSION: process.env.SERVICE_VERSION,
  CORS_ORIGIN: process.env.CORS_ORIGIN
});