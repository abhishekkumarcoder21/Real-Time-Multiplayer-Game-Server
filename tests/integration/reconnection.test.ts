import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Room } from '../../src/server/Room.js';
import { ConnectionStatus, MessageType } from '../../src/shared/types.js';
import { DISCONNECT_GRACE_PERIOD_MS } from '../../src/shared/constants.js';

function createMockSocket() {
  const sent: any[] = [];
  return {
    send: (data: string) => {
      try {
        sent.push(JSON.parse(data));
      } catch {
        sent.push(data);
      }
    },
    readyState: 1,
    sent,
  } as any;
}

describe('Integration — Mid-Match Disconnect and Reconnect (Scenario #4)', () => {
  let room: Room;

  beforeEach(() => {
    vi.useFakeTimers();
    room = new Room('reconnect-room');
  });

  afterEach(() => {
    room.destroy();
    vi.useRealTimers();
  });

  it('preserves player state, position, and score during disconnect grace period', () => {
    const ws1 = createMockSocket();
    const playerId = room.addPlayer(ws1, 'Survivor');
    expect(playerId).toBeTruthy();

    const player = room.getPlayer(playerId!)!;
    player.score = 5;
    player.x = 250;
    player.y = 350;

    // 1. Player disconnects unexpectedly
    room.handleDisconnect(playerId!);
    expect(player.connectionStatus).toBe(ConnectionStatus.DISCONNECTED);
    expect(player.ws).toBeNull();
    expect(player.score).toBe(5);

    // 2. 5 seconds elapse (well within the 30s grace period)
    vi.advanceTimersByTime(5000);

    // 3. Player reconnects with a fresh WebSocket connection
    const ws2 = createMockSocket();
    const reconnectSuccess = room.handleReconnect(playerId!, ws2);
    expect(reconnectSuccess).toBe(true);
    expect(player.connectionStatus).toBe(ConnectionStatus.CONNECTED);
    expect(player.ws).toBe(ws2);
    expect(player.score).toBe(5);
    expect(player.x).toBe(250);
    expect(player.y).toBe(350);

    // 4. Verify server sent authoritative state update to the reconnected socket
    const stateUpdateMsg = ws2.sent.find((m: any) => m.type === MessageType.STATE_UPDATE);
    expect(stateUpdateMsg).toBeDefined();
    expect(stateUpdateMsg.state.players.some((p: any) => p.id === playerId && p.score === 5)).toBe(true);
  });

  it('expires disconnected player after grace period elapses', () => {
    const ws = createMockSocket();
    const playerId = room.addPlayer(ws, 'Ghost');
    expect(room.playerCount).toBe(1);

    room.handleDisconnect(playerId!);

    // Advance beyond grace period (30s)
    vi.advanceTimersByTime(DISCONNECT_GRACE_PERIOD_MS + 1000);

    // Trigger cleanup (via tick or direct remove)
    // When grace period is expired, reconnecting should fail
    const wsNew = createMockSocket();
    const reconnectSuccess = room.handleReconnect(playerId!, wsNew);
    expect(reconnectSuccess).toBe(false);
  });
});
