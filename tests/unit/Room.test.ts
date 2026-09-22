import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Room } from '../../src/server/Room.js';
import { MAX_PLAYERS_PER_ROOM } from '../../src/shared/constants.js';
import { ConnectionStatus } from '../../src/shared/types.js';

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
    readyState: 1, // OPEN
    sent,
  } as any;
}

describe('Room Management and Lifecycle', () => {
  let room: Room;

  beforeEach(() => {
    vi.useFakeTimers();
    room = new Room('test-room');
  });

  afterEach(() => {
    room.destroy();
    vi.useRealTimers();
  });

  it('allows players to join up to MAX_PLAYERS_PER_ROOM and rejects beyond', () => {
    const sockets = [];
    const playerIds: string[] = [];

    for (let i = 0; i < MAX_PLAYERS_PER_ROOM; i++) {
      const ws = createMockSocket();
      sockets.push(ws);
      const id = room.addPlayer(ws, `Player_${i}`);
      expect(id).not.toBeNull();
      if (id) playerIds.push(id);
    }

    expect(room.playerCount).toBe(MAX_PLAYERS_PER_ROOM);

    // Attempt to add one more player
    const overflowWs = createMockSocket();
    const overflowId = room.addPlayer(overflowWs, 'OverflowPlayer');
    expect(overflowId).toBeNull();
  });

  it('handles disconnect and reconnect within grace period', () => {
    const ws1 = createMockSocket();
    const playerId = room.addPlayer(ws1, 'Alice');
    expect(playerId).toBeTruthy();

    const player = room.getPlayer(playerId!);
    expect(player).toBeDefined();
    expect(player?.connectionStatus).toBe(ConnectionStatus.CONNECTED);

    // Simulate disconnect
    room.handleDisconnect(playerId!);
    expect(player?.connectionStatus).toBe(ConnectionStatus.DISCONNECTED);
    expect(player?.ws).toBeNull();

    // Reconnect with new socket
    const ws2 = createMockSocket();
    const reconnected = room.handleReconnect(playerId!, ws2);
    expect(reconnected).toBe(true);
    expect(player?.connectionStatus).toBe(ConnectionStatus.CONNECTED);
    expect(player?.ws).toBe(ws2);
  });

  it('removes player cleanly on explicit leave', () => {
    const ws = createMockSocket();
    const playerId = room.addPlayer(ws, 'Bob');
    expect(room.playerCount).toBe(1);

    room.removePlayer(playerId!);
    expect(room.playerCount).toBe(0);
    expect(room.getPlayer(playerId!)).toBeUndefined();
  });

  it('queues valid input and rejects invalid inputs', () => {
    const ws = createMockSocket();
    const playerId = room.addPlayer(ws, 'Charlie');
    const player = room.getPlayer(playerId!)!;

    // Valid input
    room.queueInput(playerId!, {
      seq: 1,
      actions: { up: true, down: false, left: false, right: false, shoot: false },
      aimAngle: 0,
      timestamp: Date.now(),
    });
    expect(player.inputBuffer.length).toBe(1);

    // Stale sequence number (same seq)
    room.queueInput(playerId!, {
      seq: 1,
      actions: { up: true, down: false, left: false, right: false, shoot: false },
      aimAngle: 0,
      timestamp: Date.now(),
    });
    // Not added
    expect(player.inputBuffer.length).toBe(1);
    expect(player.violationCount).toBe(1);
  });

  it('updates player RTT using exponential moving average', () => {
    const ws = createMockSocket();
    const playerId = room.addPlayer(ws, 'Dave');
    const player = room.getPlayer(playerId!)!;

    room.updatePlayerRtt(playerId!, 100);
    expect(player.rtt).toBe(100);

    // Second ping of 50ms: 100 * 0.8 + 50 * 0.2 = 90
    room.updatePlayerRtt(playerId!, 50);
    expect(player.rtt).toBeCloseTo(90, 1);
  });

  it('invokes onDestroy callback after empty room TTL expires', () => {
    let destroyedRoomId: string | null = null;
    room.onDestroy = (id) => {
      destroyedRoomId = id;
    };

    const ws = createMockSocket();
    const playerId = room.addPlayer(ws, 'Eve');
    room.removePlayer(playerId!);

    // Fast forward 30 seconds (EMPTY_ROOM_TTL_MS)
    vi.advanceTimersByTime(35000);

    expect(destroyedRoomId).toBe('test-room');
  });
});
