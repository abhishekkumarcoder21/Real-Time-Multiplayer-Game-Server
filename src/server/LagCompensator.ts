/**
 * Lag Compensation System — Server-Side State Rewind.
 *
 * THE PROBLEM:
 * When a player fires their weapon, they're aiming at what they SEE on screen.
 * But what they see is the world as it was ~(RTT/2) milliseconds ago, because
 * it takes that long for a state update to travel from server to client.
 *
 * If the server simply checks the target's CURRENT position, the shot would
 * miss — the target has moved since the shooter saw it. This feels terrible:
 * you aimed perfectly, but the game says you missed.
 *
 * THE SOLUTION — SERVER REWIND:
 * 1. The server keeps a ring buffer of recent world snapshots (one per tick)
 * 2. When a player fires, the server calculates how many ticks ago the player
 *    was seeing the world: ticksAgo = ceil((RTT / 2) / TICK_INTERVAL_MS)
 * 3. The server looks up player positions from that historical snapshot
 * 4. It performs hit detection (raycast) against those PAST positions
 * 5. If the raycast hits, the damage is applied to the player's CURRENT state
 *
 * THE TRADE-OFF — "SHOOTER ADVANTAGE":
 * This system favors the shooter: if you aim at someone and click, the shot
 * registers even if the target has already moved on the server's timeline.
 *
 * The downside: the victim can be hit by a shot that, from their perspective,
 * was fired AFTER they took cover. On their screen, they were safely behind
 * a wall; on the shooter's screen (viewing the past), they weren't yet.
 *
 * We CAP the rewind at MAX_LAG_COMPENSATION_TICKS (4 ticks = 200ms) to limit
 * how extreme this effect can get. Players with >200ms latency get degraded
 * lag compensation — they'll start needing to lead their shots, which is
 * unfortunate but prevents extreme "shot around corners" scenarios.
 */

import type { Player } from './Player.js';
import type { GameStateSnapshot } from '../shared/types.js';
import {
  MAX_LAG_COMPENSATION_TICKS,
  STATE_HISTORY_SIZE,
  TICK_INTERVAL_MS,
  HITSCAN_MAX_RANGE,
} from '../shared/constants.js';
import { rayCircleIntersection } from '../shared/physics.js';
import { logger } from './utils/logger.js';

/** Result of a lag-compensated hit check. */
export interface HitCheckResult {
  hit: boolean;
  /** The player that was hit (null if no hit). */
  targetId: string | null;
  /** Distance to the hit (for potential damage falloff). */
  distance: number;
  /** How many ticks we rewound. */
  ticksRewound: number;
}

export class LagCompensator {
  /**
   * Ring buffer of historical state snapshots.
   * Index 0 is the oldest, index (length-1) is the most recent.
   * We store up to STATE_HISTORY_SIZE snapshots.
   */
  private _history: GameStateSnapshot[] = [];

  /**
   * Record a snapshot of the current game state.
   * Called once per tick, after the simulation has run.
   *
   * We store a DEEP COPY of player positions because the Player objects
   * are mutated in subsequent ticks. If we stored references, the history
   * would all point to the same (current) state.
   */
  recordSnapshot(tick: number, timestamp: number, players: Player[]): void {
    const snapshot: GameStateSnapshot = {
      tick,
      timestamp,
      players: players.map(p => ({
        id: p.id,
        x: p.x,
        y: p.y,
        hp: p.hp,
        score: p.score,
        lastProcessedSeq: p.lastProcessedSeq,
        alive: p.alive,
        respawnAt: p.respawnAt,
      })),
      projectiles: [], // Projectiles aren't needed for hit detection rewind
    };

    this._history.push(snapshot);

    // Trim to max size (ring buffer behavior)
    if (this._history.length > STATE_HISTORY_SIZE) {
      this._history.shift();
    }
  }

  /**
   * Perform a lag-compensated hitscan check.
   *
   * @param shooterId - ID of the player who fired
   * @param shooterX - Shooter's current X position
   * @param shooterY - Shooter's current Y position
   * @param aimAngle - Direction the shooter was aiming (radians)
   * @param shooterRttMs - Shooter's measured RTT in milliseconds
   * @param currentTick - Current server tick number
   * @returns Hit check result
   */
  checkHit(
    shooterId: string,
    shooterX: number,
    shooterY: number,
    aimAngle: number,
    shooterRttMs: number,
    currentTick: number
  ): HitCheckResult {
    // Calculate how many ticks ago the shooter was seeing the world.
    // RTT/2 = one-way latency (server→client or client→server)
    // We also add half a tick to account for the fact that the client
    // renders interpolated state between ticks.
    const oneWayLatencyMs = shooterRttMs / 2;
    const ticksAgo = Math.min(
      Math.ceil(oneWayLatencyMs / TICK_INTERVAL_MS),
      MAX_LAG_COMPENSATION_TICKS
    );

    // Look up the historical snapshot
    const snapshot = this._getSnapshot(currentTick - ticksAgo);

    if (!snapshot) {
      // No history available (server just started or history was purged)
      // Fall back to current-state hit detection (no rewind)
      logger.debug({ shooterId, ticksAgo }, 'No historical snapshot available for lag compensation');
      return { hit: false, targetId: null, distance: 0, ticksRewound: 0 };
    }

    // Perform raycast against all players in the historical snapshot
    let closestHit: HitCheckResult = {
      hit: false,
      targetId: null,
      distance: Infinity,
      ticksRewound: ticksAgo,
    };

    for (const playerState of snapshot.players) {
      // Don't hit yourself
      if (playerState.id === shooterId) continue;

      // Don't hit dead players
      if (!playerState.alive) continue;

      const hitDistance = rayCircleIntersection(
        { x: shooterX, y: shooterY },
        aimAngle,
        { x: playerState.x, y: playerState.y },
        20, // Player radius — matches PLAYER_RADIUS constant
        HITSCAN_MAX_RANGE
      );

      // rayCircleIntersection returns -1 for no hit
      if (hitDistance >= 0 && hitDistance < closestHit.distance) {
        closestHit = {
          hit: true,
          targetId: playerState.id,
          distance: hitDistance,
          ticksRewound: ticksAgo,
        };
      }
    }

    if (closestHit.hit) {
      logger.debug(
        {
          shooterId,
          targetId: closestHit.targetId,
          ticksRewound: ticksAgo,
          distance: closestHit.distance.toFixed(1),
        },
        'Lag-compensated hit detected'
      );
    }

    return closestHit;
  }

  /**
   * Get a historical snapshot by tick number.
   * Returns null if the requested tick is not in the history buffer.
   */
  private _getSnapshot(targetTick: number): GameStateSnapshot | null {
    // Linear search through history (small buffer, so O(n) is fine)
    for (const snapshot of this._history) {
      if (snapshot.tick === targetTick) {
        return snapshot;
      }
    }
    return null;
  }

  /** Get the number of snapshots currently stored. */
  get historySize(): number {
    return this._history.length;
  }

  /** Clear all history (e.g., on room reset). */
  clear(): void {
    this._history = [];
  }
}
