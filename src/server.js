import 'dotenv/config';
import http from 'node:http';
import app from './app.js';
import { env } from './utils/env.js';
import { logger } from './utils/logger.js';
import { setupWebSocket } from './ws/index.js';

const server = http.createServer(app);
setupWebSocket(server);

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'server_started');
});

// 平滑關機
const shutdown = (sig) => () => {
  logger.warn({ sig }, 'shutdown_signal');
  server.close(() => process.exit(0));
};
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, shutdown(sig)));
