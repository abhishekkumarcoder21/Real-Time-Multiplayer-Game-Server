import { describe, it, expect, beforeEach } from 'vitest';
import { Simulation } from '../../src/server/Simulation.js';
import { Player } from '../../src/server/Player.js';
import { Projectile } from '../../src/server/Projectile.js';
import {
  ARENA_WIDTH,
  ARENA_HEIGHT,
  PLAYER_MAX_HP,
  PROJECTILE_DAMAGE,
  TICK_INTERVAL_S,
} from '../../src/shared/constants.js';
import type { PlayerInput } from '../../src/shared/types.js';

describe('Simulation Engine', () => {
  let simulation: Simulation;
  let players: Map<string, Player>;
  let projectiles: Projectile[];
  const mockWs = { send: () => {} } as any;

  beforeEach(() => {
    simulation = new Simulation();
    players = new Map();
    projectiles = [];
  });

  it('deterministically advances player movement given input and dt', () => {
    const p1 = new Player('p1', mockWs);
    p1.x = 100;
    p1.y = 100;
    players.set('p1', p1);

    const input: PlayerInput = {
      seq: 1,
      actions: { up: false, down: false, left: false, right: true, shoot: false },
      aimAngle: 0,
      timestamp: Date.now(),
    };
    p1.inputBuffer.push(input);

    const checkHit = () => ({ hit: false, targetId: null, distance: 0 });
    simulation.step(players, projectiles, 1, TICK_INTERVAL_S, Date.now(), checkHit);

    // Movement: 300 units/s * 0.05s = 15 units to the right
    expect(p1.x).toBeCloseTo(115, 1);
    expect(p1.y).toBe(100);
    expect(p1.lastProcessedSeq).toBe(1);
    expect(p1.inputBuffer.length).toBe(0);
  });

  it('clamps player position to arena boundaries', () => {
    const p1 = new Player('p1', mockWs);
    p1.x = 5;
    p1.y = 5;
    players.set('p1', p1);

    // Try moving left and up past bounds
    p1.inputBuffer.push({
      seq: 1,
      actions: { up: true, down: false, left: true, right: false, shoot: false },
      aimAngle: 0,
      timestamp: Date.now(),
    });

    const checkHit = () => ({ hit: false, targetId: null, distance: 0 });
    simulation.step(players, projectiles, 1, TICK_INTERVAL_S, Date.now(), checkHit);

    expect(p1.x).toBeGreaterThanOrEqual(p1.radius);
    expect(p1.y).toBeGreaterThanOrEqual(p1.radius);

    // Move past right boundary
    p1.x = ARENA_WIDTH - 2;
    p1.y = ARENA_HEIGHT - 2;
    p1.inputBuffer.push({
      seq: 2,
      actions: { up: false, down: true, left: false, right: true, shoot: false },
      aimAngle: 0,
      timestamp: Date.now(),
    });

    simulation.step(players, projectiles, 2, TICK_INTERVAL_S, Date.now(), checkHit);

    expect(p1.x).toBeLessThanOrEqual(ARENA_WIDTH - p1.radius);
    expect(p1.y).toBeLessThanOrEqual(ARENA_HEIGHT - p1.radius);
  });

  it('drains dead player input buffer while updating lastProcessedSeq', () => {
    const p1 = new Player('p1', mockWs);
    p1.x = 200;
    p1.y = 200;
    p1.alive = false;
    players.set('p1', p1);

    p1.inputBuffer.push(
      { seq: 10, actions: { up: true, down: false, left: false, right: false, shoot: false }, aimAngle: 0, timestamp: 1 },
      { seq: 11, actions: { up: true, down: false, left: false, right: false, shoot: false }, aimAngle: 0, timestamp: 2 }
    );

    const checkHit = () => ({ hit: false, targetId: null, distance: 0 });
    simulation.step(players, projectiles, 1, TICK_INTERVAL_S, Date.now(), checkHit);

    expect(p1.x).toBe(200);
    expect(p1.y).toBe(200);
    expect(p1.lastProcessedSeq).toBe(11);
    expect(p1.inputBuffer.length).toBe(0);
  });

  it('respawns dead player after respawn delay expires', () => {
    const p1 = new Player('p1', mockWs);
    p1.alive = false;
    p1.hp = 0;
    const now = 10000;
    p1.respawnAt = now + 1000;
    players.set('p1', p1);

    const checkHit = () => ({ hit: false, targetId: null, distance: 0 });

    // Step before respawn time
    simulation.step(players, projectiles, 1, TICK_INTERVAL_S, now + 500, checkHit);
    expect(p1.alive).toBe(false);

    // Step at or after respawn time
    simulation.step(players, projectiles, 2, TICK_INTERVAL_S, now + 1050, checkHit);
    expect(p1.alive).toBe(true);
    expect(p1.hp).toBe(PLAYER_MAX_HP);
  });

  it('advances projectiles and despawns expired or out-of-bounds ones', () => {
    const now = 5000;
    const activeProj = new Projectile('p1', 100, 100, 0, now);
    const outOfBoundsProj = new Projectile('p1', ARENA_WIDTH + 10, 100, 0, now);

    projectiles.push(activeProj, outOfBoundsProj);

    const checkHit = () => ({ hit: false, targetId: null, distance: 0 });
    simulation.step(players, projectiles, 1, TICK_INTERVAL_S, now + 100, checkHit);

    // outOfBoundsProj should be removed
    expect(projectiles.includes(outOfBoundsProj)).toBe(false);
    expect(projectiles.includes(activeProj)).toBe(true);
    expect(activeProj.x).toBeGreaterThan(100);
  });

  it('processes players in alphabetical ID order for deterministic resolution', () => {
    const order: string[] = [];
    const hitEvents: Array<{ shooter: string; target: string; damage: number }> = [];

    const simWithEvents = new Simulation({
      onHit: (shooter, target, damage) => {
        order.push(shooter);
        hitEvents.push({ shooter, target, damage });
      },
    });

    const pB = new Player('player-B', mockWs);
    pB.x = 200;
    pB.y = 200;
    pB.lastShotTime = 0;

    const pA = new Player('player-A', mockWs);
    pA.x = 100;
    pA.y = 100;
    pA.lastShotTime = 0;

    // Both shoot in the same tick
    pB.inputBuffer.push({
      seq: 1,
      actions: { up: false, down: false, left: false, right: false, shoot: true },
      aimAngle: 0,
      timestamp: 1000,
    });
    pA.inputBuffer.push({
      seq: 1,
      actions: { up: false, down: false, left: false, right: false, shoot: true },
      aimAngle: 0,
      timestamp: 1000,
    });

    players.set('player-B', pB);
    players.set('player-A', pA);

    const checkHit = (shooterId: string) => {
      const targetId = shooterId === 'player-A' ? 'player-B' : 'player-A';
      return { hit: true, targetId, distance: 50 };
    };

    simWithEvents.step(players, projectiles, 1, TICK_INTERVAL_S, 2000, checkHit);

    // player-A must be processed before player-B
    expect(order[0]).toBe('player-A');
    expect(order[1]).toBe('player-B');
    expect(hitEvents[0].damage).toBe(PROJECTILE_DAMAGE);
  });
});
