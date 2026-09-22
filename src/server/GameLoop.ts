/**
 * Fixed-timestep game loop.
 *
 * WHY FIXED TIMESTEP?
 * In a variable-timestep loop, the simulation runs with whatever dt
 * happened between frames. This causes two problems for multiplayer:
 * 1. Non-determinism: different machines produce different results
 *    for the same inputs because dt differs.
 * 2. Exploitation: a player could artificially change their frame rate
 *    to gain advantages (physics behaves differently at different dt).
 *
 * A fixed-timestep loop always advances the simulation by the same dt
 * (e.g., 50ms for 20Hz). If a tick runs late, we still use the fixed dt
 * for physics, preserving determinism. The only consequence of a late tick
 * is that the WALL-CLOCK time between state broadcasts stretches, but the
 * SIMULATED time always advances by exactly dt.
 *
 * IMPLEMENTATION:
 * Uses setInterval rather than setTimeout chaining. setInterval provides
 * more consistent timing because it schedules the NEXT tick based on the
 * START of the current one, not the END. If a tick takes 10ms, the next
 * one fires 40ms later (for 50ms interval), keeping the average rate stable.
 *
 * We also measure the actual wall-clock duration of each tick for metrics,
 * so we can detect when ticks are running over budget (a sign of overload).
 */

import { TICK_INTERVAL_MS, TICK_INTERVAL_S } from '../shared/constants.js';
import { nowMs } from './utils/Clock.js';
import { logger } from './utils/logger.js';

export type TickCallback = (tick: number, dt: number) => void;

export class GameLoop {
  private _intervalId: ReturnType<typeof setInterval> | null = null;
  private _tickCount = 0;
  private _running = false;
  private _onTick: TickCallback;
  private _lastTickDurationMs = 0;

  /** Label for logging (usually the room ID). */
  private _label: string;

  constructor(onTick: TickCallback, label: string = 'default') {
    this._onTick = onTick;
    this._label = label;
  }

  /** Start the fixed-timestep loop. */
  start(): void {
    if (this._running) return;
    this._running = true;

    logger.info({ label: this._label }, `Game loop starting at ${TICK_INTERVAL_MS}ms interval (${1000 / TICK_INTERVAL_MS}Hz)`);

    this._intervalId = setInterval(() => {
      this._executeTick();
    }, TICK_INTERVAL_MS);
  }

  /** Stop the loop. */
  stop(): void {
    if (!this._running) return;
    this._running = false;

    if (this._intervalId !== null) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }

    logger.info({ label: this._label, totalTicks: this._tickCount }, 'Game loop stopped');
  }

  /** Execute a single tick, measuring its duration. */
  private _executeTick(): void {
    const startTime = nowMs();

    this._tickCount++;

    try {
      // Always use fixed dt for determinism, regardless of actual elapsed time
      this._onTick(this._tickCount, TICK_INTERVAL_S);
    } catch (err) {
      logger.error({ err, tick: this._tickCount, label: this._label }, 'Error in tick callback');
    }

    this._lastTickDurationMs = nowMs() - startTime;

    // Warn if tick exceeded budget — this means the server is overloaded
    if (this._lastTickDurationMs > TICK_INTERVAL_MS) {
      logger.warn(
        {
          tick: this._tickCount,
          durationMs: this._lastTickDurationMs.toFixed(2),
          budgetMs: TICK_INTERVAL_MS,
          label: this._label,
        },
        'Tick exceeded budget! Server may be overloaded.'
      );
    }
  }

  /** Whether the loop is currently running. */
  get running(): boolean {
    return this._running;
  }

  /** Current tick count. */
  get tickCount(): number {
    return this._tickCount;
  }

  /** Duration of the most recent tick in milliseconds. */
  get lastTickDurationMs(): number {
    return this._lastTickDurationMs;
  }
}
