/**
 * High-resolution timing utilities.
 *
 * Uses process.hrtime.bigint() for nanosecond precision. This is critical
 * for measuring tick duration accurately — the difference between a 48ms
 * tick and a 52ms tick matters when your budget is 50ms.
 */

/** Get current time in milliseconds with sub-millisecond precision. */
export function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

/** Get current time in seconds with sub-millisecond precision. */
export function nowS(): number {
  return Number(process.hrtime.bigint()) / 1_000_000_000;
}

/**
 * Measure the duration of a synchronous function call.
 * @returns [result, durationMs]
 */
export function measureDuration<T>(fn: () => T): [T, number] {
  const start = nowMs();
  const result = fn();
  const duration = nowMs() - start;
  return [result, duration];
}

/**
 * Simple monotonic clock for game time.
 * Provides a consistent time source that increases by fixed dt each tick,
 * regardless of actual wall-clock time. This keeps the simulation
 * deterministic even if a tick runs late.
 */
export class GameClock {
  private _tickCount = 0;
  private _dtS: number;

  constructor(dtS: number) {
    this._dtS = dtS;
  }

  /** Advance the clock by one tick. Returns the new tick count. */
  tick(): number {
    return ++this._tickCount;
  }

  /** Current tick number. */
  get tickCount(): number {
    return this._tickCount;
  }

  /** Current game time in seconds (tick * dt). */
  get timeS(): number {
    return this._tickCount * this._dtS;
  }

  /** Current game time in milliseconds. */
  get timeMs(): number {
    return this._tickCount * this._dtS * 1000;
  }

  /** Delta time per tick in seconds. */
  get dt(): number {
    return this._dtS;
  }
}
