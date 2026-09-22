import { describe, it, expect, beforeEach } from 'vitest';
import { LagCompensator } from '../../src/server/LagCompensator.js';
import { Player } from '../../src/server/Player.js';
import {
  MAX_LAG_COMPENSATION_TICKS,
  STATE_HISTORY_SIZE,
  TICK_INTERVAL_MS,
} from '../../src/shared/constants.js';

describe('LagCompensator State Rewind', () => {
  let lagComp: LagCompensator;
  const mockWs = { send: () => {} } as any;

  beforeEach(() => {
    lagComp = new LagCompensator();
  });

  it('records snapshots in ring buffer and caps history at STATE_HISTORY_SIZE', () => {
    const dummyPlayer = new Player('p1', mockWs);
    for (let tick = 1; tick <= STATE_HISTORY_SIZE + 5; tick++) {
      lagComp.recordSnapshot(tick, tick * TICK_INTERVAL_MS, [dummyPlayer]);
    }

    expect(lagComp.historySize).toBe(STATE_HISTORY_SIZE);
  });

  it('calculates correct rewind ticks based on RTT/2 and caps at MAX_LAG_COMPENSATION_TICKS', () => {
    const shooter = new Player('shooter', mockWs);
    shooter.x = 100;
    shooter.y = 100;

    const target = new Player('target', mockWs);
    target.x = 200;
    target.y = 100;

    // Record 10 ticks: target moves to the right each tick
    for (let tick = 1; tick <= 10; tick++) {
      target.x = 200 + (tick - 1) * 20; // tick 1: 200, tick 5: 280, tick 10: 380
      lagComp.recordSnapshot(tick, tick * TICK_INTERVAL_MS, [shooter, target]);
    }

    // Current tick = 10. Target at tick 10 is at x=380.
    // Shooter has 200ms RTT -> oneWay = 100ms -> ticksAgo = ceil(100 / 50) = 2 ticks.
    // Historical tick = 10 - 2 = 8.
    // Aim angle = 0 (towards positive X).
    const result200ms = lagComp.checkHit('shooter', 100, 100, 0, 200, 10);
    expect(result200ms.ticksRewound).toBe(2);

    // Extreme latency: 1000ms RTT.
    // Should cap at MAX_LAG_COMPENSATION_TICKS (4 ticks = 200ms).
    const resultHighLat = lagComp.checkHit('shooter', 100, 100, 0, 1000, 10);
    expect(resultHighLat.ticksRewound).toBe(MAX_LAG_COMPENSATION_TICKS);
  });

  it('successfully detects a hit against a target at their historical position', () => {
    const shooter = new Player('shooter', mockWs);
    shooter.x = 100;
    shooter.y = 100;

    const target = new Player('target', mockWs);

    // Tick 1: target was directly in shooter line of sight at (200, 100)
    target.x = 200;
    target.y = 100;
    lagComp.recordSnapshot(1, 1000, [shooter, target]);

    // Tick 2: target moved away to (200, 400)
    target.x = 200;
    target.y = 400;
    lagComp.recordSnapshot(2, 1050, [shooter, target]);

    // Tick 3: target moved further to (200, 600)
    target.x = 200;
    target.y = 600;
    lagComp.recordSnapshot(3, 1100, [shooter, target]);

    // At tick 3, shooter fires with 200ms RTT (one way = 100ms = 2 ticks ago -> Tick 1)
    // Shooter aims at angle 0 (straight right along y=100)
    const hitResult = lagComp.checkHit('shooter', 100, 100, 0, 200, 3);

    expect(hitResult.hit).toBe(true);
    expect(hitResult.targetId).toBe('target');
    expect(hitResult.ticksRewound).toBe(2);
    // Target was at (200, 100), shooter at (100, 100), radius 20 -> distance = 100 - 20 = 80
    expect(hitResult.distance).toBeCloseTo(80, 1);
  });

  it('misses if the raycast does not intersect target hitbox in historical state', () => {
    const shooter = new Player('shooter', mockWs);
    shooter.x = 100;
    shooter.y = 100;

    const target = new Player('target', mockWs);
    target.x = 200;
    target.y = 300; // Far off to the side

    lagComp.recordSnapshot(1, 1000, [shooter, target]);

    // Shooter fires horizontally (angle 0)
    const result = lagComp.checkHit('shooter', 100, 100, 0, 100, 1);
    expect(result.hit).toBe(false);
    expect(result.targetId).toBeNull();
  });

  it('does not hit shooter themselves or dead targets in history', () => {
    const shooter = new Player('shooter', mockWs);
    shooter.x = 100;
    shooter.y = 100;

    const deadTarget = new Player('dead-guy', mockWs);
    deadTarget.x = 200;
    deadTarget.y = 100;
    deadTarget.alive = false;

    lagComp.recordSnapshot(1, 1000, [shooter, deadTarget]);

    const result = lagComp.checkHit('shooter', 100, 100, 0, 100, 1);
    expect(result.hit).toBe(false);
  });
});
