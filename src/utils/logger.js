import pino from 'pino';
import { createRequire } from 'node:module';
import { env } from './env.js';

const require = createRequire(import.meta.url);

function resolvePrettyTransport() {
  if (env.NODE_ENV === 'production') return undefined;
  try {
    require.resolve('pino-pretty');
    return { target: 'pino-pretty' };
  } catch {
    return undefined;
  }
}

export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport: resolvePrettyTransport(),
  base: { service: env.SERVICE_NAME, version: env.SERVICE_VERSION }
});
