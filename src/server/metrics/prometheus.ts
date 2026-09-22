/**
 * Prometheus metrics for observability.
 *
 * Exposes:
 * - game_tick_duration_ms: Histogram of how long each server tick takes.
 *   If this exceeds TICK_INTERVAL_MS, the server is overloaded.
 * - game_room_player_count: Gauge of players per room.
 * - game_rooms_active: Gauge of total active rooms.
 * - game_messages_received_total: Counter of inbound WS messages.
 * - game_messages_sent_total: Counter of outbound WS messages.
 * - game_input_violations_total: Counter of rejected inputs (anti-cheat).
 *
 * Access via GET /metrics on the metrics port.
 */

import client from 'prom-client';

// Create a custom registry so we don't conflict with default metrics
export const metricsRegistry = new client.Registry();

// Collect default Node.js metrics (memory, CPU, event loop lag)
client.collectDefaultMetrics({ register: metricsRegistry });

/** Histogram: tick processing duration in milliseconds. */
export const tickDurationHistogram = new client.Histogram({
  name: 'game_tick_duration_ms',
  help: 'Duration of each game tick in milliseconds',
  labelNames: ['room_id'] as const,
  buckets: [1, 2, 5, 10, 20, 30, 50, 100],
  registers: [metricsRegistry],
});

/** Gauge: number of connected players per room. */
export const roomPlayerCountGauge = new client.Gauge({
  name: 'game_room_player_count',
  help: 'Number of connected players in each room',
  labelNames: ['room_id'] as const,
  registers: [metricsRegistry],
});

/** Gauge: number of active rooms. */
export const activeRoomsGauge = new client.Gauge({
  name: 'game_rooms_active',
  help: 'Total number of active game rooms',
  registers: [metricsRegistry],
});

/** Counter: total inbound WebSocket messages. */
export const messagesReceivedCounter = new client.Counter({
  name: 'game_messages_received_total',
  help: 'Total number of WebSocket messages received',
  labelNames: ['type'] as const,
  registers: [metricsRegistry],
});

/** Counter: total outbound WebSocket messages. */
export const messagesSentCounter = new client.Counter({
  name: 'game_messages_sent_total',
  help: 'Total number of WebSocket messages sent',
  labelNames: ['type'] as const,
  registers: [metricsRegistry],
});

/** Counter: input validation violations. */
export const inputViolationsCounter = new client.Counter({
  name: 'game_input_violations_total',
  help: 'Total number of rejected inputs due to validation failures',
  labelNames: ['violation_type'] as const,
  registers: [metricsRegistry],
});

/** Gauge: current tick number per room (useful for debugging). */
export const tickCountGauge = new client.Gauge({
  name: 'game_tick_count',
  help: 'Current tick number per room',
  labelNames: ['room_id'] as const,
  registers: [metricsRegistry],
});
