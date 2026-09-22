/**
 * Structured logger using pino.
 *
 * All log entries include:
 * - timestamp (ISO 8601)
 * - level (info, warn, error, debug)
 * - Optional context fields: roomId, playerId, tick
 *
 * In production, these logs can be shipped to any structured log aggregator
 * (ELK, Datadog, Cloud Logging) because they're JSON-formatted.
 */

import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? {
          target: 'pino/file',
          options: { destination: 1 }, // stdout
        }
      : undefined,
  formatters: {
    level(label: string) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/** Create a child logger with room context. */
export function roomLogger(roomId: string) {
  return logger.child({ roomId });
}

/** Create a child logger with player context. */
export function playerLogger(playerId: string, roomId?: string) {
  return logger.child({ playerId, roomId });
}
