/**
 * Shared physics functions used by BOTH client and server.
 *
 * !! CRITICAL: These functions MUST be identical on client and server !!
 *
 * Client-side prediction works by running the exact same physics code that
 * the server runs. If these functions diverge (e.g., the client applies
 * movement differently), the reconciliation algorithm will constantly detect
 * "errors" and trigger corrections, causing visible jitter for the player.
 *
 * All functions are pure — no side effects, no mutation of inputs, no
 * dependency on global state. Given the same inputs, they always return
 * the same output (determinism).
 */

import {
  MAX_SPEED,
  PLAYER_RADIUS,
  ARENA_WIDTH,
  ARENA_HEIGHT,
} from './constants.js';
import type { InputActions } from './types.js';

// ─── Vector Helpers ──────────────────────────────────────────────────────────

export interface Vec2 {
  x: number;
  y: number;
}

/** Calculate the Euclidean distance between two points. */
export function distance(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Normalize a vector to unit length. Returns {0,0} for zero-length vectors. */
export function normalize(v: Vec2): Vec2 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y);
  if (len === 0) return { x: 0, y: 0 };
  return { x: v.x / len, y: v.y / len };
}

// ─── Movement ────────────────────────────────────────────────────────────────

/**
 * Compute a movement direction vector from input actions.
 *
 * Diagonal movement is normalized so that pressing up+right doesn't move
 * faster than pressing just right (a common game-feel bug if you don't
 * normalize — the diagonal speed would be sqrt(2) ≈ 1.41x the cardinal speed).
 */
export function inputToDirection(actions: InputActions): Vec2 {
  let dx = 0;
  let dy = 0;

  if (actions.left) dx -= 1;
  if (actions.right) dx += 1;
  if (actions.up) dy -= 1; // Canvas Y-axis: up = negative
  if (actions.down) dy += 1;

  return normalize({ x: dx, y: dy });
}

/**
 * Apply one tick of movement to a position.
 *
 * This is THE core physics function. It:
 * 1. Converts input actions to a direction vector
 * 2. Scales by MAX_SPEED and dt to get displacement
 * 3. Adds displacement to position
 * 4. Clamps to arena bounds (with player radius margin)
 *
 * @param x - Current X position
 * @param y - Current Y position
 * @param actions - Input actions for this tick
 * @param dt - Delta time in SECONDS (e.g., 0.05 for 20Hz)
 * @returns New position after applying movement
 */
export function applyMovement(
  x: number,
  y: number,
  actions: InputActions,
  dt: number
): Vec2 {
  const dir = inputToDirection(actions);

  // Velocity = direction * max speed
  const vx = dir.x * MAX_SPEED;
  const vy = dir.y * MAX_SPEED;

  // Position = position + velocity * dt
  let newX = x + vx * dt;
  let newY = y + vy * dt;

  // Clamp to arena bounds (accounting for player radius)
  newX = clamp(newX, PLAYER_RADIUS, ARENA_WIDTH - PLAYER_RADIUS);
  newY = clamp(newY, PLAYER_RADIUS, ARENA_HEIGHT - PLAYER_RADIUS);

  return { x: newX, y: newY };
}

// ─── Collision Detection ─────────────────────────────────────────────────────

/**
 * Check if a circle (player) and a ray (hitscan shot) intersect.
 *
 * Uses the standard ray-circle intersection formula:
 * Given ray origin P, direction D (unit vector), circle center C, radius R:
 *   L = C - P  (vector from ray origin to circle center)
 *   tca = L · D  (projection of L onto ray direction)
 *   d² = L · L - tca²  (squared perpendicular distance from circle center to ray)
 *   If d² > R²: no intersection
 *   Otherwise: thc = sqrt(R² - d²), intersection at t = tca - thc
 *   If t < 0: intersection is behind the ray origin (no hit)
 *
 * @param rayOrigin - Starting point of the ray
 * @param rayAngle - Direction of the ray in radians
 * @param circleCenter - Center of the circle
 * @param circleRadius - Radius of the circle
 * @param maxRange - Maximum distance to check
 * @returns Distance to intersection, or -1 if no hit
 */
export function rayCircleIntersection(
  rayOrigin: Vec2,
  rayAngle: number,
  circleCenter: Vec2,
  circleRadius: number,
  maxRange: number
): number {
  // Ray direction unit vector
  const dx = Math.cos(rayAngle);
  const dy = Math.sin(rayAngle);

  // Vector from ray origin to circle center
  const lx = circleCenter.x - rayOrigin.x;
  const ly = circleCenter.y - rayOrigin.y;

  // Project L onto ray direction
  const tca = lx * dx + ly * dy;

  // If the closest approach is behind the ray, no hit
  if (tca < 0) return -1;

  // Squared perpendicular distance from circle center to ray
  const d2 = lx * lx + ly * ly - tca * tca;
  const r2 = circleRadius * circleRadius;

  // If perpendicular distance > radius, ray misses the circle
  if (d2 > r2) return -1;

  // Distance from closest approach to intersection point
  const thc = Math.sqrt(r2 - d2);

  // Distance along ray to first intersection
  const t = tca - thc;

  // Check if within max range
  if (t > maxRange) return -1;

  return t;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Clamp a value between min and max. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Get a random spawn position within the arena, avoiding edges.
 * The margin prevents spawning too close to walls.
 */
export function randomSpawnPosition(): Vec2 {
  const margin = PLAYER_RADIUS * 3;
  return {
    x: margin + Math.random() * (ARENA_WIDTH - margin * 2),
    y: margin + Math.random() * (ARENA_HEIGHT - margin * 2),
  };
}
