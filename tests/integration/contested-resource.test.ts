import { describe, it, expect } from 'vitest';
import { Simulation } from '../../src/server/Simulation.js';
import { Player } from '../../src/server/Player.js';
import { TICK_INTERVAL_S } from '../../src/shared/constants.js';

describe('Integration — Contested Resource / Same-Tick Conflict (Scenario #5)', () => {
  const mockWs = { send: () => {} } as any;

  it('deterministically resolves simultaneous fatal shots in alphabetical player ID order', () => {
    // Both Alice (ID: "player-1-alice") and Bob (ID: "player-2-bob") shoot at victim (ID: "player-3-victim")
    // on the exact same tick. Victim only has 25 HP (one shot will kill them).
    const events: string[] = [];
    const sim = new Simulation({
      onHit: (shooter, target, damage) => {
        events.push(`HIT: ${shooter} -> ${target} (${damage} dmg)`);
        victim.takeDamage(damage);
      },
      onKill: (killer, victimName) => {
        events.push(`KILL: ${killer} killed ${victimName}`);
      },
    });

    const players = new Map<string, Player>();

    const alice = new Player('player-1-alice', mockWs);
    alice.x = 100;
    alice.y = 100;
    alice.lastShotTime = 0;

    const bob = new Player('player-2-bob', mockWs);
    bob.x = 100;
    bob.y = 200;
    bob.lastShotTime = 0;

    const victim = new Player('player-3-victim', mockWs);
    victim.x = 250;
    victim.y = 100;
    victim.hp = 25; // 1 shot to kill
    victim.alive = true;

    players.set(alice.id, alice);
    players.set(bob.id, bob);
    players.set(victim.id, victim);

    // Both players queue shoot actions for the same tick
    alice.inputBuffer.push({
      seq: 1,
      actions: { up: false, down: false, left: false, right: false, shoot: true },
      aimAngle: 0,
      timestamp: 1000,
    });

    bob.inputBuffer.push({
      seq: 1,
      actions: { up: false, down: false, left: false, right: false, shoot: true },
      aimAngle: -0.785, // Aiming towards victim
      timestamp: 1000,
    });

    // Custom hit detection mocking historical hit check
    const checkHit = (_shooterId: string) => {
      // If victim is alive, it's a hit
      if (victim.alive) {
        return { hit: true, targetId: victim.id, distance: 150 };
      }
      return { hit: false, targetId: null, distance: 0 };
    };

    sim.step(players, [], 1, TICK_INTERVAL_S, 2000, checkHit);

    // Alice has lower ID ('player-1-alice' < 'player-2-bob')
    // Alice's shot must process first and kill the victim
    expect(events.length).toBe(1);
    expect(events[0]).toContain('player-1-alice');
    expect(victim.hp).toBe(0);
    expect(victim.alive).toBe(false);
  });

  it('prevents mutually fatal simultaneous shots if player A kills player B before player B acts', () => {
    // Both Alice (ID: "player-A") and Bob (ID: "player-B") fire fatal shots directly at each other.
    // Both only have 25 HP.
    const kills: string[] = [];
    const sim = new Simulation({
      onKill: (killer, victim) => {
        kills.push(`${killer}->${victim}`);
      },
      onHit: (_shooter, targetId, damage) => {
        const target = targetId === 'player-A' ? playerA : playerB;
        if (target.takeDamage(damage)) {
          sim['_events'].onKill?.(_shooter, targetId);
        }
      },
    });

    const playerA = new Player('player-A', mockWs);
    playerA.hp = 25;
    playerA.lastShotTime = 0;

    const playerB = new Player('player-B', mockWs);
    playerB.hp = 25;
    playerB.lastShotTime = 0;

    const players = new Map<string, Player>([
      ['player-A', playerA],
      ['player-B', playerB],
    ]);

    playerA.inputBuffer.push({
      seq: 1,
      actions: { up: false, down: false, left: false, right: false, shoot: true },
      aimAngle: 0,
      timestamp: 1000,
    });
    playerB.inputBuffer.push({
      seq: 1,
      actions: { up: false, down: false, left: false, right: false, shoot: true },
      aimAngle: Math.PI,
      timestamp: 1000,
    });

    const checkHit = (shooterId: string) => {
      const targetId = shooterId === 'player-A' ? 'player-B' : 'player-A';
      const target = players.get(targetId)!;
      if (target.alive) {
        return { hit: true, targetId, distance: 100 };
      }
      return { hit: false, targetId: null, distance: 0 };
    };

    sim.step(players, [], 1, TICK_INTERVAL_S, 2000, checkHit);

    // Player A acts first, kills Player B
    // Player B is now dead, so their queued input in the same tick is dropped
    expect(kills).toEqual(['player-A->player-B']);
    expect(playerA.alive).toBe(true);
    expect(playerB.alive).toBe(false);
  });
});
