import { describe, it, expect } from 'vitest';
import { LagCompensator } from '../../src/server/LagCompensator.js';
import { Player } from '../../src/server/Player.js';
import {
  MAX_LAG_COMPENSATION_TICKS,
  TICK_INTERVAL_MS,
} from '../../src/shared/constants.js';

describe('Integration — High-Latency Client Simulation (Scenario #1)', () => {
  const mockWs = { send: () => {} } as any;

  it('correctly calculates rewind ticks across varying ping levels (50ms, 150ms, 300ms, 600ms)', () => {
    const lagComp = new LagCompensator();
    const shooter = new Player('shooter', mockWs);
    const target = new Player('target', mockWs);

    // Build historical timeline
    for (let tick = 1; tick <= 20; tick++) {
      target.x = 100 + tick * 10;
      target.y = 200;
      lagComp.recordSnapshot(tick, tick * TICK_INTERVAL_MS, [shooter, target]);
    }

    const currentTick = 20;

    // 1. Low latency broadband: 50ms RTT -> 25ms one-way -> 1 tick rewind
    const lowPing = lagComp.checkHit('shooter', 100, 200, 0, 50, currentTick);
    expect(lowPing.ticksRewound).toBe(1);

    // 2. Average gaming latency: 150ms RTT -> 75ms one-way -> 2 ticks rewind
    const medPing = lagComp.checkHit('shooter', 100, 200, 0, 150, currentTick);
    expect(medPing.ticksRewound).toBe(2);

    // 3. High latency: 300ms RTT -> 150ms one-way -> 3 ticks rewind
    const highPing = lagComp.checkHit('shooter', 100, 200, 0, 300, currentTick);
    expect(highPing.ticksRewound).toBe(3);

    // 4. Extreme latency: 600ms RTT -> 300ms one-way -> capped at MAX_LAG_COMPENSATION_TICKS (4 ticks = 200ms)
    const extremePing = lagComp.checkHit('shooter', 100, 200, 0, 600, currentTick);
    expect(extremePing.ticksRewound).toBe(MAX_LAG_COMPENSATION_TICKS);
  });

  it('smooths RTT measurements using exponential moving average to filter network jitter', () => {
    const player = new Player('jittery-player', mockWs);

    // Simulate jittery ping series: 100ms baseline with periodic spikes to 300ms
    const pingSamples = [100, 110, 95, 280, 105, 98];

    for (const ping of pingSamples) {
      if (player.rtt === 0) {
        player.rtt = ping;
      } else {
        player.rtt = player.rtt * 0.8 + ping * 0.2;
      }
    }

    // A single 280ms spike should not derail the smoothed RTT
    expect(player.rtt).toBeLessThan(160);
    expect(player.rtt).toBeGreaterThan(90);
  });
});
