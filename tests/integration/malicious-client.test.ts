import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Room } from '../../src/server/Room.js';
import { MAX_INPUT_RATE } from '../../src/shared/constants.js';

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

describe('Integration — Malicious Client & Anti-Cheat (Scenario #2)', () => {
  let room: Room;

  beforeEach(() => {
    room = new Room('security-room');
  });

  afterEach(() => {
    room.destroy();
  });

  it('drops rapid-fire spam and logs RAPID_FIRE violation', () => {
    const ws = createMockSocket();
    const playerId = room.addPlayer(ws, 'Spammer')!;
    const player = room.getPlayer(playerId)!;

    // First shot is valid
    room.queueInput(playerId, {
      seq: 1,
      actions: { up: false, down: false, left: false, right: false, shoot: true },
      aimAngle: 0,
      timestamp: Date.now(),
    });
    expect(player.inputBuffer.length).toBe(1);

    // Immediate second shot (5ms later) - should be rejected by InputValidator
    room.queueInput(playerId, {
      seq: 2,
      actions: { up: false, down: false, left: false, right: false, shoot: true },
      aimAngle: 0,
      timestamp: Date.now(),
    });

    expect(player.inputBuffer.length).toBe(1); // Still 1, 2nd shot was rejected
    expect(player.violationCount).toBe(1);
  });

  it('defends against input flooding by rejecting messages exceeding MAX_INPUT_RATE', () => {
    const ws = createMockSocket();
    const playerId = room.addPlayer(ws, 'Flooder')!;
    const player = room.getPlayer(playerId)!;

    // Send MAX_INPUT_RATE + 10 inputs
    for (let seq = 1; seq <= MAX_INPUT_RATE + 10; seq++) {
      room.queueInput(playerId, {
        seq,
        actions: { up: true, down: false, left: false, right: false, shoot: false },
        aimAngle: 0,
        timestamp: Date.now(),
      });
    }

    // At least 10 inputs must have been rejected as flood
    expect(player.violationCount).toBeGreaterThanOrEqual(10);
  });

  it('rejects replay attacks where client sends old or duplicate sequence numbers', () => {
    const ws = createMockSocket();
    const playerId = room.addPlayer(ws, 'Replayer')!;
    const player = room.getPlayer(playerId)!;

    // Process seq 10
    player.lastProcessedSeq = 10;

    // Attempt to inject seq 5
    room.queueInput(playerId, {
      seq: 5,
      actions: { up: true, down: false, left: false, right: false, shoot: false },
      aimAngle: 0,
      timestamp: Date.now(),
    });

    expect(player.inputBuffer.length).toBe(0);
    expect(player.violationCount).toBe(1);
  });

  it('rejects mathematical poison inputs like NaN or Infinity for aim angles', () => {
    const ws = createMockSocket();
    const playerId = room.addPlayer(ws, 'Poisoner')!;
    const player = room.getPlayer(playerId)!;

    room.queueInput(playerId, {
      seq: 1,
      actions: { up: false, down: false, left: false, right: false, shoot: true },
      aimAngle: NaN,
      timestamp: Date.now(),
    });

    expect(player.inputBuffer.length).toBe(0);
    expect(player.violationCount).toBe(1);

    room.queueInput(playerId, {
      seq: 2,
      actions: { up: false, down: false, left: false, right: false, shoot: true },
      aimAngle: Infinity,
      timestamp: Date.now(),
    });

    expect(player.inputBuffer.length).toBe(0);
    expect(player.violationCount).toBe(2);
  });
});
