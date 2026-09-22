/**
 * Server entry point.
 * Instantiates and starts the GameServer.
 */

import { GameServer } from './GameServer.js';
import { logger } from './utils/logger.js';
import { DEFAULT_PORT } from '../shared/constants.js';

const port = parseInt(process.env.PORT || String(DEFAULT_PORT), 10);
const server = new GameServer(port);

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down...');
  await server.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down...');
  await server.stop();
  process.exit(0);
});

server.start();
