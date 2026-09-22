/**
 * Projectile entity (visual tracer).
 *
 * IMPORTANT DESIGN NOTE:
 * Projectiles in this game are purely visual. Actual hit detection uses
 * instant hitscan raycasting (see LagCompensator.ts). The visible projectile
 * gives players visual feedback ("I fired and the bullet went that way"),
 * but whether the shot actually hits is determined by the raycast at fire time.
 *
 * This separation exists because:
 * 1. Hitscan is simpler to lag-compensate (one raycast at fire time vs
 *    tracking a moving projectile across multiple ticks in the past)
 * 2. Fast projectiles would skip over targets between ticks anyway
 *    (the "tunneling" problem)
 * 3. The visual tracer is just eye candy — it doesn't affect gameplay
 */

import { v4 as uuidv4 } from 'uuid';
import type { ProjectileState } from '../shared/types.js';
import {
  PROJECTILE_SPEED,
  PROJECTILE_LIFETIME_MS,
  ARENA_WIDTH,
  ARENA_HEIGHT,
} from '../shared/constants.js';

export class Projectile {
  public readonly id: string;
  public readonly ownerId: string;
  public x: number;
  public y: number;
  public readonly angle: number;
  public readonly speed: number;
  public readonly createdAt: number;

  constructor(ownerId: string, x: number, y: number, angle: number, createdAt: number) {
    this.id = uuidv4();
    this.ownerId = ownerId;
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.speed = PROJECTILE_SPEED;
    this.createdAt = createdAt;
  }

  /**
   * Advance the projectile by dt seconds.
   * Returns true if the projectile is still alive, false if it should be removed.
   */
  update(dt: number, currentTimeMs: number): boolean {
    // Move in the direction of the angle
    this.x += Math.cos(this.angle) * this.speed * dt;
    this.y += Math.sin(this.angle) * this.speed * dt;

    // Remove if out of bounds
    if (this.x < 0 || this.x > ARENA_WIDTH || this.y < 0 || this.y > ARENA_HEIGHT) {
      return false;
    }

    // Remove if lifetime expired
    if (currentTimeMs - this.createdAt > PROJECTILE_LIFETIME_MS) {
      return false;
    }

    return true;
  }

  /** Convert to a plain state object for network transmission. */
  toState(): ProjectileState {
    return {
      id: this.id,
      ownerId: this.ownerId,
      x: this.x,
      y: this.y,
      angle: this.angle,
      speed: this.speed,
      createdAt: this.createdAt,
    };
  }
}
