/**
 * Server-side Player entity.
 *
 * Represents a player's authoritative state on the server. The server owns
 * and controls all player state — clients never directly modify these values.
 *
 * Notable fields:
 * - inputBuffer: Queued inputs waiting to be processed in the next tick.
 *   Inputs arrive between ticks (via WebSocket) and are buffered here.
 * - rtt: Measured round-trip time, updated via ping/pong. Used by the
 *   lag compensator to know how far in the past this player sees the world.
 * - violations: Counter for anti-cheat tracking.
 */

import type WebSocket from 'ws';
import type { PlayerInput, PlayerState, ConnectionStatus } from '../shared/types.js';
import { ConnectionStatus as ConnStatus } from '../shared/types.js';
import { PLAYER_MAX_HP, PLAYER_RADIUS } from '../shared/constants.js';
import { randomSpawnPosition } from '../shared/physics.js';

export class Player {
  public readonly id: string;
  public x: number;
  public y: number;
  public hp: number;
  public score: number;
  public alive: boolean;
  public respawnAt: number;

  /** The last input sequence number the server has processed. */
  public lastProcessedSeq: number;

  /** Queued inputs from the client, waiting to be consumed in the next tick. */
  public inputBuffer: PlayerInput[];

  /** Current WebSocket connection (null if disconnected). */
  public ws: WebSocket | null;

  /** Connection status. */
  public connectionStatus: ConnectionStatus;

  /** Timestamp when the player disconnected (for grace period tracking). */
  public disconnectedAt: number;

  /** Measured round-trip time in milliseconds. Updated via ping/pong. */
  public rtt: number;

  /** Last time this player fired (server timestamp, for cooldown enforcement). */
  public lastShotTime: number;

  /** Anti-cheat: cumulative violation count. */
  public violationCount: number;

  /** Anti-cheat: timestamps of recent inputs (for rate limiting). */
  public recentInputTimestamps: number[];

  /** Optional display name. */
  public name: string;

  constructor(id: string, ws: WebSocket, name?: string) {
    this.id = id;
    this.ws = ws;
    this.name = name || `Player-${id.slice(0, 6)}`;

    // Spawn at a random position
    const spawn = randomSpawnPosition();
    this.x = spawn.x;
    this.y = spawn.y;

    this.hp = PLAYER_MAX_HP;
    this.score = 0;
    this.alive = true;
    this.respawnAt = 0;

    this.lastProcessedSeq = 0;
    this.inputBuffer = [];

    this.connectionStatus = ConnStatus.CONNECTED;
    this.disconnectedAt = 0;
    this.rtt = 0;
    this.lastShotTime = 0;
    this.violationCount = 0;
    this.recentInputTimestamps = [];
  }

  /** Convert to a plain state object for network transmission. */
  toState(): PlayerState {
    return {
      id: this.id,
      x: this.x,
      y: this.y,
      hp: this.hp,
      score: this.score,
      lastProcessedSeq: this.lastProcessedSeq,
      alive: this.alive,
      respawnAt: this.respawnAt,
    };
  }

  /** Respawn the player at a random position with full HP. */
  respawn(): void {
    const spawn = randomSpawnPosition();
    this.x = spawn.x;
    this.y = spawn.y;
    this.hp = PLAYER_MAX_HP;
    this.alive = true;
    this.respawnAt = 0;
  }

  /** Apply damage. Returns true if the player died from this damage. */
  takeDamage(damage: number): boolean {
    if (!this.alive) return false;
    this.hp = Math.max(0, this.hp - damage);
    if (this.hp <= 0) {
      this.alive = false;
      return true;
    }
    return false;
  }

  /** Check if the player is within their invulnerability window after respawn. */
  isInvulnerable(_currentTimeMs: number): boolean {
    return false;
  }

  /** Get the player's hitbox radius. */
  get radius(): number {
    return PLAYER_RADIUS;
  }
}
