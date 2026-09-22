/**
 * Game simulation engine.
 *
 * This module contains the pure simulation logic — given player inputs and
 * current state, produce the next state. It has NO networking, NO WebSocket,
 * NO I/O. This separation is intentional:
 *
 * 1. Testability: We can unit test the simulation without mocking sockets
 * 2. Determinism: The simulation is a pure function of (state, inputs, dt)
 * 3. Reusability: The same simulation runs on the server (authoritative)
 *    and could theoretically run on the client for prediction
 *
 * The simulation processes inputs in a specific order to ensure deterministic
 * outcomes for contested resources (Failure Scenario #5):
 * - Players are processed in alphabetical ID order within each tick
 * - This is arbitrary but DETERMINISTIC — same inputs always produce same output
 */

import type { Player } from './Player.js';
import type { Projectile } from './Projectile.js';
import type { PlayerInput } from '../shared/types.js';
import { applyMovement } from '../shared/physics.js';
import {
  PROJECTILE_DAMAGE,
  SHOOT_COOLDOWN_MS,
} from '../shared/constants.js';
import { logger } from './utils/logger.js';

/** Events emitted by the simulation for the Room to handle. */
export interface SimulationEvents {
  onHit?: (shooterId: string, targetId: string, damage: number) => void;
  onKill?: (killerId: string, victimId: string) => void;
}

export class Simulation {
  private _events: SimulationEvents;

  constructor(events: SimulationEvents = {}) {
    this._events = events;
  }

  /**
   * Process one tick of the simulation.
   *
   * Order of operations (deterministic):
   * 1. Sort players by ID (deterministic ordering for contested resources)
   * 2. Process each player's queued inputs (movement + shoot)
   * 3. Advance projectiles
   * 4. Handle respawns
   *
   * @param players - Map of all players in the room
   * @param projectiles - Array of active projectiles (mutated in place)
   * @param tick - Current tick number
   * @param dt - Delta time in seconds
   * @param currentTimeMs - Current server time in milliseconds
   * @param checkHit - Callback to perform lag-compensated hit detection
   */
  step(
    players: Map<string, Player>,
    projectiles: Projectile[],
    _tick: number,
    dt: number,
    currentTimeMs: number,
    checkHit: (shooterId: string, x: number, y: number, angle: number, rtt: number) => { hit: boolean; targetId: string | null; distance: number }
  ): void {
    // Sort players by ID for deterministic processing order.
    // This matters for Failure Scenario #5: if two players contest the same
    // resource in the same tick, the one with the "first" ID gets processed first.
    const sortedPlayers = [...players.values()].sort((a, b) => a.id.localeCompare(b.id));

    // ── 1. Process player inputs ───────────────────────────────────────
    for (const player of sortedPlayers) {
      if (!player.alive) {
        // Dead players can't act — drain their input buffer silently
        // but still update lastProcessedSeq so reconciliation works
        if (player.inputBuffer.length > 0) {
          const lastInput = player.inputBuffer[player.inputBuffer.length - 1];
          player.lastProcessedSeq = lastInput.seq;
          player.inputBuffer = [];
        }
        continue;
      }

      // Process all queued inputs for this player.
      // In a perfect world, there's exactly 1 input per tick. But latency
      // can cause 0 inputs (packet delayed) or multiple (burst after delay).
      // We process ALL queued inputs to keep the client's lastProcessedSeq
      // up to date, which is essential for reconciliation.
      for (const input of player.inputBuffer) {
        this._processInput(player, input, dt, currentTimeMs, checkHit);
      }

      // Clear the buffer — all inputs have been processed
      player.inputBuffer = [];
    }

    // ── 2. Advance projectiles ─────────────────────────────────────────
    // Remove expired/out-of-bounds projectiles
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const alive = projectiles[i].update(dt, currentTimeMs);
      if (!alive) {
        projectiles.splice(i, 1);
      }
    }

    // ── 3. Handle respawns ─────────────────────────────────────────────
    for (const player of sortedPlayers) {
      if (!player.alive && player.respawnAt > 0 && currentTimeMs >= player.respawnAt) {
        player.respawn();
        logger.info({ playerId: player.id }, 'Player respawned');
      }
    }
  }

  /**
   * Process a single input for a player.
   */
  private _processInput(
    player: Player,
    input: PlayerInput,
    dt: number,
    currentTimeMs: number,
    checkHit: (shooterId: string, x: number, y: number, angle: number, rtt: number) => { hit: boolean; targetId: string | null; distance: number }
  ): void {
    // Apply movement using shared physics
    const newPos = applyMovement(player.x, player.y, input.actions, dt);
    player.x = newPos.x;
    player.y = newPos.y;

    // Handle shooting
    if (input.actions.shoot) {
      // Cooldown check is done in InputValidator, but double-check here
      const timeSinceLastShot = currentTimeMs - player.lastShotTime;
      if (timeSinceLastShot >= SHOOT_COOLDOWN_MS * 0.9) {
        player.lastShotTime = currentTimeMs;

        // Perform lag-compensated hit detection
        const hitResult = checkHit(
          player.id,
          player.x,
          player.y,
          input.aimAngle,
          player.rtt
        );

        if (hitResult.hit && hitResult.targetId) {
          // Find the target player and apply damage
          // The target lookup happens against CURRENT state, even though
          // hit detection used HISTORICAL positions. This is correct:
          // we rewind to determine IF there was a hit, but damage is
          // applied to the player's current HP.
          this._events.onHit?.(player.id, hitResult.targetId, PROJECTILE_DAMAGE);
        }
      }
    }

    // Update the last processed sequence number
    player.lastProcessedSeq = input.seq;
  }
}
