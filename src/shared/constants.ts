/**
 * Shared constants used by both client and server.
 * Every game-tuning parameter lives here — no magic numbers elsewhere.
 *
 * Naming convention: ALL_CAPS for constants that affect gameplay or networking.
 */

// ─── Tick / Timing ───────────────────────────────────────────────────────────
/** Server simulation frequency in Hz. 20Hz = 50ms per tick.
 *  This is the heartbeat of the game — all physics, input processing, and
 *  state broadcasts happen at this cadence. 20Hz is standard for games like
 *  Overwatch/Valorant at the server level; higher rates increase bandwidth
 *  but reduce the window for client-side prediction errors. */
export const TICK_RATE = 20;

/** Milliseconds between each server tick. Derived from TICK_RATE. */
export const TICK_INTERVAL_MS = 1000 / TICK_RATE; // 50ms

/** Seconds per tick — used in physics calculations (velocity * dt). */
export const TICK_INTERVAL_S = TICK_INTERVAL_MS / 1000; // 0.05s

// ─── Arena ───────────────────────────────────────────────────────────────────
/** Arena dimensions in game units. The playable area is [0, WIDTH] x [0, HEIGHT]. */
export const ARENA_WIDTH = 1600;
export const ARENA_HEIGHT = 900;

// ─── Player Movement ─────────────────────────────────────────────────────────
/** Maximum player speed in game units per second. A player holding a
 *  direction key moves at exactly this speed; diagonal movement is
 *  normalized so it doesn't exceed this either. */
export const MAX_SPEED = 300;

/** Player hitbox radius in game units. Used for collision detection with
 *  projectiles and for clamping to arena bounds. */
export const PLAYER_RADIUS = 20;

/** Starting HP for each player. */
export const PLAYER_MAX_HP = 100;

/** Damage dealt per successful hit. */
export const PROJECTILE_DAMAGE = 25;

// ─── Shooting ────────────────────────────────────────────────────────────────
/** Minimum time between shots in milliseconds. Prevents rapid-fire cheats
 *  and defines the weapon's fire rate. 500ms = 2 shots/sec. */
export const SHOOT_COOLDOWN_MS = 500;

/** Projectile speed in game units per second. Only used for the visual
 *  "tracer" — actual hit detection is hitscan (instant raycast). */
export const PROJECTILE_SPEED = 800;

/** How long a visual projectile lives (ms) before being removed. */
export const PROJECTILE_LIFETIME_MS = 2000;

/** Maximum distance for hitscan raycast in game units.
 *  Beyond this, shots don't register even if aimed correctly. */
export const HITSCAN_MAX_RANGE = 2000;

// ─── Lag Compensation ────────────────────────────────────────────────────────
/** Maximum number of ticks the server will rewind for lag compensation.
 *  At 20Hz, 4 ticks = 200ms. Players with higher latency than this won't
 *  get full lag compensation — a deliberate cap to prevent extreme
 *  "shot around corners" scenarios. */
export const MAX_LAG_COMPENSATION_TICKS = 4;

/** Size of the state history ring buffer. Should be >= MAX_LAG_COMPENSATION_TICKS. */
export const STATE_HISTORY_SIZE = 30; // ~1.5 seconds of history

// ─── Reconciliation (Client-Side) ────────────────────────────────────────────
/** Position difference (in game units) below which the client doesn't
 *  bother correcting — the prediction was "close enough". */
export const RECONCILIATION_THRESHOLD = 0.5;

/** If the error exceeds this many units, snap instantly instead of lerping.
 *  A large error usually indicates cheating or extreme lag, not normal drift. */
export const SNAP_THRESHOLD = 50;

/** Duration (ms) over which to lerp visual corrections for small errors.
 *  100ms is fast enough to correct within a few frames but slow enough to
 *  avoid visible "popping". */
export const SNAP_SMOOTHING_DURATION_MS = 100;

/** Maximum number of unacknowledged inputs the client will buffer.
 *  Safety cap to prevent unbounded memory growth on very laggy connections. */
export const MAX_PENDING_INPUTS = 120;

// ─── Anti-Cheat / Input Validation ───────────────────────────────────────────
/** Maximum inputs per second before the server considers a client suspicious.
 *  Set to 3x tick rate to allow burst input patterns (e.g., multiple key
 *  presses in one frame) while still catching flooding attacks. */
export const MAX_INPUT_RATE = TICK_RATE * 3;

/** Speed tolerance multiplier for input validation. Allows 10% over MAX_SPEED
 *  to account for timing jitter between client and server clocks. */
export const SPEED_TOLERANCE = 1.1;

/** Number of violations before a player is flagged as suspicious. */
export const SUSPICIOUS_THRESHOLD = 10;

// ─── Room / Session ──────────────────────────────────────────────────────────
/** Maximum players per room. Kept small for this demo; load tests will
 *  push beyond this to measure tick stability. */
export const MAX_PLAYERS_PER_ROOM = 8;

/** How long (ms) to keep a room alive after the last player leaves.
 *  Allows reconnection without losing room state. */
export const EMPTY_ROOM_TTL_MS = 30_000; // 30 seconds

/** How long (ms) to keep a disconnected player's slot reserved.
 *  If they don't reconnect within this window, they're removed. */
export const DISCONNECT_GRACE_PERIOD_MS = 30_000; // 30 seconds

/** Respawn invulnerability duration in milliseconds. */
export const RESPAWN_INVULNERABILITY_MS = 2000;

/** Respawn delay after death in milliseconds. */
export const RESPAWN_DELAY_MS = 3000;

// ─── Network ─────────────────────────────────────────────────────────────────
/** Default server port. */
export const DEFAULT_PORT = 3000;

/** Metrics endpoint port (Prometheus). */
export const METRICS_PORT = 9090;

/** Ping interval for RTT measurement (ms). */
export const PING_INTERVAL_MS = 1000;
