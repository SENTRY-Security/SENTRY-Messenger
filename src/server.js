import 'dotenv/config';
import http from 'node:http';
import app from './app.js';
import { env } from './utils/env.js';
import { logger } from './utils/logger.js';

// WebSocket server has been migrated to Cloudflare Durable Objects.
// Node.js now only serves scan-upload and any remaining proxied routes.
const server = http.createServer(app);

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'server_started');
});

// 平滑關機
const shutdown = (sig) => () => {
  logger.warn({ sig }, 'shutdown_signal');
  server.close(() => process.exit(0));
};
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, shutdown(sig)));
