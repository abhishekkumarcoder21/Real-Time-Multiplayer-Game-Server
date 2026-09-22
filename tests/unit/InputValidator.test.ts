import { describe, it, expect, beforeEach } from 'vitest';
import { InputValidator } from '../../src/server/InputValidator.js';
import { Player } from '../../src/server/Player.js';
import { MAX_INPUT_RATE, SHOOT_COOLDOWN_MS } from '../../src/shared/constants.js';
import { ViolationType } from '../../src/shared/types.js';

describe('InputValidator Anti-Cheat System', () => {
  let validator: InputValidator;
  let player: Player;
  const mockWs = { send: () => {} } as any;

  beforeEach(() => {
    validator = new InputValidator();
    player = new Player('test-player', mockWs);
    player.lastProcessedSeq = 5;
  });

  it('rejects sequence numbers <= lastProcessedSeq (replay attack protection)', () => {
    const staleResult = validator.validate(
      player,
      {
        seq: 5,
        actions: { up: false, down: false, left: false, right: false, shoot: false },
        aimAngle: 0,
        timestamp: 1000,
      },
      1000
    );

    expect(staleResult.valid).toBe(false);
    expect(staleResult.violation?.type).toBe(ViolationType.INVALID_SEQUENCE);

    const oldResult = validator.validate(
      player,
      {
        seq: 3,
        actions: { up: false, down: false, left: false, right: false, shoot: false },
        aimAngle: 0,
        timestamp: 1000,
      },
      1000
    );

    expect(oldResult.valid).toBe(false);
    expect(oldResult.violation?.type).toBe(ViolationType.INVALID_SEQUENCE);
  });

  it('accepts strictly increasing sequence numbers', () => {
    const validResult = validator.validate(
      player,
      {
        seq: 6,
        actions: { up: true, down: false, left: false, right: false, shoot: false },
        aimAngle: 1.57,
        timestamp: 1000,
      },
      1000
    );

    expect(validResult.valid).toBe(true);
    expect(validResult.violation).toBeUndefined();
  });

  it('rejects input flooding exceeding MAX_INPUT_RATE', () => {
    const now = 10000;
    // Fill up to MAX_INPUT_RATE
    for (let i = 0; i < MAX_INPUT_RATE; i++) {
      player.recentInputTimestamps.push(now - 100);
    }

    const floodResult = validator.validate(
      player,
      {
        seq: 10,
        actions: { up: false, down: false, left: false, right: false, shoot: false },
        aimAngle: 0,
        timestamp: now,
      },
      now
    );

    expect(floodResult.valid).toBe(false);
    expect(floodResult.violation?.type).toBe(ViolationType.INPUT_FLOOD);
  });

  it('rejects non-finite aim angles (NaN, Infinity)', () => {
    const nanResult = validator.validate(
      player,
      {
        seq: 10,
        actions: { up: false, down: false, left: false, right: false, shoot: false },
        aimAngle: NaN,
        timestamp: 1000,
      },
      1000
    );

    expect(nanResult.valid).toBe(false);
    expect(nanResult.violation?.type).toBe(ViolationType.INVALID_AIM);

    const infResult = validator.validate(
      player,
      {
        seq: 11,
        actions: { up: false, down: false, left: false, right: false, shoot: false },
        aimAngle: Infinity,
        timestamp: 1000,
      },
      1000
    );

    expect(infResult.valid).toBe(false);
    expect(infResult.violation?.type).toBe(ViolationType.INVALID_AIM);
  });

  it('enforces shoot cooldown strictly using server-side clock', () => {
    const firstShotTime = 5000;
    player.lastShotTime = firstShotTime;

    // Shot attempted too soon (e.g. 50ms after last shot when cooldown is 500ms)
    const rapidResult = validator.validate(
      player,
      {
        seq: 20,
        actions: { up: false, down: false, left: false, right: false, shoot: true },
        aimAngle: 0,
        timestamp: firstShotTime + 50,
      },
      firstShotTime + 50
    );

    expect(rapidResult.valid).toBe(false);
    expect(rapidResult.violation?.type).toBe(ViolationType.RAPID_FIRE);

    // Shot attempted after cooldown expires
    const allowedResult = validator.validate(
      player,
      {
        seq: 21,
        actions: { up: false, down: false, left: false, right: false, shoot: true },
        aimAngle: 0,
        timestamp: firstShotTime + SHOOT_COOLDOWN_MS + 10,
      },
      firstShotTime + SHOOT_COOLDOWN_MS + 10
    );

    expect(allowedResult.valid).toBe(true);
  });
});
