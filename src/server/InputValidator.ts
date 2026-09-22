/**
 * Input validation and anti-cheat system.
 *
 * DESIGN PHILOSOPHY:
 * In a server-authoritative model, the server is the sole arbiter of what
 * inputs are valid. This module enforces the game's rules at the input level,
 * before inputs are ever applied to the simulation.
 *
 * WHAT THIS PREVENTS:
 * ✅ Speed hacking — movement inputs produce at most MAX_SPEED displacement
 * ✅ Teleporting — positions are never accepted from clients, only computed
 * ✅ Rapid-fire — shoot cooldown enforced server-side
 * ✅ Input flooding — rate limiting prevents DoS via message spam
 * ✅ Replay attacks — sequence numbers must increase monotonically
 *
 * WHAT THIS DOES NOT PREVENT:
 * ❌ Aimbots — aim angle is a valid input; we can't distinguish human vs bot
 * ❌ Wallhacks — we send all player positions (visibility culling is out of scope)
 * ❌ Superhuman reaction times — information attacks are hard to detect
 *
 * Understanding these limits is important — pretending server-authority
 * solves everything would be dishonest. The honest answer is: it solves
 * state-manipulation cheats but not information-exploitation cheats.
 */

import type { Player } from './Player.js';
import type { PlayerInput, Violation, ViolationType } from '../shared/types.js';
import { ViolationType as VType } from '../shared/types.js';
import {
  MAX_INPUT_RATE,
  SHOOT_COOLDOWN_MS,
} from '../shared/constants.js';
import { inputViolationsCounter } from './metrics/prometheus.js';
import { logger } from './utils/logger.js';

export interface ValidationResult {
  valid: boolean;
  violation?: Violation;
}

export class InputValidator {
  /**
   * Validate a player input before it's applied to the simulation.
   *
   * @param player - The player who sent this input
   * @param input - The input to validate
   * @param serverTimeMs - Current server time in milliseconds
   * @returns Validation result with optional violation details
   */
  validate(player: Player, input: PlayerInput, serverTimeMs: number): ValidationResult {
    const highestQueuedSeq = player.inputBuffer.length > 0
      ? player.inputBuffer[player.inputBuffer.length - 1].seq
      : player.lastProcessedSeq;

    if (input.seq <= highestQueuedSeq) {
      return this._violation(player.id, VType.INVALID_SEQUENCE, serverTimeMs,
        `Input seq ${input.seq} <= last processed/queued ${highestQueuedSeq}`);
    }

    // 2. Rate limiting: too many inputs per second = either flooding or a
    //    modified client trying to get more movement by sending more inputs.
    const now = serverTimeMs;
    player.recentInputTimestamps.push(now);

    // Keep only timestamps within the last second
    const oneSecondAgo = now - 1000;
    player.recentInputTimestamps = player.recentInputTimestamps.filter(t => t > oneSecondAgo);

    if (player.recentInputTimestamps.length > MAX_INPUT_RATE) {
      return this._violation(player.id, VType.INPUT_FLOOD, serverTimeMs,
        `${player.recentInputTimestamps.length} inputs in last second (max: ${MAX_INPUT_RATE})`);
    }

    // 3. Aim angle validation: must be a finite number.
    //    NaN or Infinity would break the raycast math.
    if (!Number.isFinite(input.aimAngle)) {
      return this._violation(player.id, VType.INVALID_AIM, serverTimeMs,
        `Invalid aim angle: ${input.aimAngle}`);
    }

    // 4. Shoot cooldown: prevent rapid-fire by checking server-side time
    //    between shots. We use server time, not client time, because
    //    the client could lie about their timestamps.
    if (input.actions.shoot) {
      const timeSinceLastShot = now - player.lastShotTime;
      if (timeSinceLastShot < SHOOT_COOLDOWN_MS * 0.9) {
        // 10% tolerance for timing jitter
        return this._violation(player.id, VType.RAPID_FIRE, serverTimeMs,
          `Shot fired ${timeSinceLastShot.toFixed(0)}ms after last shot (cooldown: ${SHOOT_COOLDOWN_MS}ms)`);
      }
      player.lastShotTime = now;
    }

    return { valid: true };
  }

  /** Create a violation result and update metrics. */
  private _violation(
    playerId: string,
    type: ViolationType,
    timestamp: number,
    details: string
  ): ValidationResult {
    const violation: Violation = { type, playerId, timestamp, details };

    // Update Prometheus counter
    inputViolationsCounter.inc({ violation_type: type });

    logger.warn({ playerId, violationType: type, details }, 'Input violation detected');

    return { valid: false, violation };
  }
}
