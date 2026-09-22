/**
 * Message serialization/deserialization.
 *
 * Currently uses JSON for simplicity and debuggability. In a production
 * game, you'd switch to a binary format (Protocol Buffers, FlatBuffers,
 * or a custom binary protocol) to reduce payload size and CPU overhead.
 *
 * JSON is fine for this portfolio project because:
 * 1. It's human-readable in DevTools Network tab (great for demos)
 * 2. The bottleneck in a 20Hz game with <10 players is not serialization
 * 3. The architecture supports swapping serializers without changing any
 *    other code — this module is the only place that touches the wire format
 */

import type { GameMessage } from '../../shared/types.js';

/**
 * Serialize a game message to a string for transmission over WebSocket.
 * @param message - The message object to serialize
 * @returns JSON string
 */
export function serialize(message: GameMessage): string {
  return JSON.stringify(message);
}

/**
 * Deserialize a WebSocket message string into a typed game message.
 * Returns null if the message is malformed or not valid JSON.
 *
 * @param data - Raw string received from WebSocket
 * @returns Parsed message, or null if invalid
 */
export function deserialize(data: string): GameMessage | null {
  try {
    const parsed = JSON.parse(data);

    // Basic structural validation: must have a 'type' field
    if (!parsed || typeof parsed.type !== 'string') {
      return null;
    }

    return parsed as GameMessage;
  } catch {
    return null;
  }
}
