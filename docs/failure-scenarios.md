# Failure Scenarios & Edge Cases

This document details the five critical edge cases and failure scenarios inherent in real-time server-authoritative multiplayer architectures, their theoretical challenges, our implementation mitigations, and automated test verifications.

---

## 1. High-Latency Client (300ms Ping)

### The Challenge
When a client experiences 300ms round-trip time (RTT), their inputs take 150ms to reach the server, and server snapshots take 150ms to return. Without client-side prediction, the player would feel a 150ms input delay for every tap of WASD, making the game unplayable. Furthermore, if they shoot at a moving enemy, that enemy has moved 150ms ahead on the server timeline.

### Mitigation & Architecture
1. **Client-Side Prediction**: The client applies local inputs instantly using shared physics equations (`applyMovement`). The local player entity moves immediately on frame render.
2. **Server Reconciliation**: The client buffers all unacknowledged inputs. When an authoritative state arrives containing `lastProcessedSeq`, the client compares its recorded prediction at that sequence with the server's authoritative position. Minor discrepancies are smoothed using linear interpolation (100ms lerp window); major deviations (>50 units) trigger an instant snap to eliminate ghosting.
3. **Lag Compensation**: The server maintains a ring buffer of the last 10 snapshots (500ms history). When the high-ping player fires, the server rewinds to `min(ceil((RTT / 2) / TICK_INTERVAL_MS), MAX_LAG_COMPENSATION_TICKS)` ticks in the past and performs hitscan raycasting against the enemies' historical positions.
4. **Capped Rewind Ceiling**: Lag compensation is hard-capped at 200ms (`MAX_LAG_COMPENSATION_TICKS = 4`). A player with 300ms ping gets 200ms of rewind; this deliberately sacrifices extreme high-ping accuracy to protect low-ping players from being shot deep behind cover ("shot around corners").

### Automated Verification
- `tests/integration/latency-simulator.test.ts`: Verifies rewind ticks across 50ms, 150ms, 300ms, and 600ms pings, ensuring the 200ms cap is strictly enforced.
- `tests/unit/reconciliation.test.ts`: Validates input replay and smooth lerping vs snap thresholds.

---

## 2. Malicious Client Sending Impossible Inputs

### The Challenge
In client-authoritative games, cheaters manipulate memory to teleport across maps, fire automatic weapons with zero cooldown, or report arbitrary health/kills to the server.

### Mitigation & Architecture
The server is 100% authoritative over world state. The client is only allowed to send **intentions** (inputs), never outcomes:
1. **Input Sequence Enforcement**: Every incoming input must have a strictly increasing sequence number (`input.seq > highestQueuedSeq`). Replay attacks and out-of-order packet injections are immediately rejected with `INVALID_SEQUENCE`.
2. **Rate Limiting**: Clients sending more than 60 inputs per second (`MAX_INPUT_RATE`) are throttled and flagged with `INPUT_FLOOD`.
3. **Shoot Cooldown Server Enforcement**: Weapons can only fire every 500ms (`SHOOT_COOLDOWN_MS`). If an input attempts to shoot before `currentTimeMs - lastShotTime >= 450ms`, the shoot flag is stripped, the shot is not spawned, and a `RAPID_FIRE` violation is recorded.
4. **Deterministic Movement Limits**: Movement is calculated on the server via `applyMovement` using `MAX_SPEED * dt`. Even if a client sends manipulated key states or spoofed positions, the server never reads position coordinates from the client.
5. **Math Poisoning Defense**: Floating-point poisoning attacks (`NaN`, `Infinity`) in `aimAngle` are caught and rejected with `INVALID_AIM` before reaching raycast routines.

### What Server Authority Does NOT Solve
- **Aimbots**: An aimbot computes the mathematical angle between the shooter and target and sends valid input packets with the ideal `aimAngle`. Because the angle itself is valid and within normal physical constraints, server-authority cannot distinguish human aiming from bot aiming. (Mitigation requires behavioral heuristics or client anti-cheat binaries).
- **Wallhacks / State Inspection**: Because the server broadcasts the positions of all players in the room to everyone, a modified client can render opponents through obstacles. (Mitigation requires server-side visibility culling / occlusion raycasting).

### Automated Verification
- `tests/integration/malicious-client.test.ts`: Tests rapid-fire bursts, input floods, stale sequence numbers, and `NaN`/`Infinity` injections.
- `tests/unit/InputValidator.test.ts`: Unit tests individual validator rules.

---

## 3. Server Tick Overload (Spikes & Budget Exhaustion)

### The Challenge
At 20Hz, each tick has a strict budget of 50ms (`TICK_INTERVAL_MS`). Under heavy computational load (dozens of players, hundreds of active projectiles, or GC pauses), a tick might take 65ms or 100ms.

### Mitigation & Architecture
1. **Fixed Timestep Invariance**: `GameLoop.ts` advances the physics simulation by a constant `dt = 0.05s` regardless of actual wall-clock execution time. This guarantees that physics calculations remain completely deterministic and unaffected by CPU spikes.
2. **Timing Drift Warning**: The loop measures execution time using `process.hrtime.bigint()` via `Clock.ts`. When a tick exceeds 50ms, a warning log is emitted containing the exact overrun duration.
3. **Prometheus Observability**: The `game_tick_duration_ms` histogram exposes tick durations in real time. Alerts can be set in Prometheus/Grafana if P95 tick duration exceeds 35ms.
4. **Room Isolation**: Each `Room` maintains an independent `GameLoop`. If Room A is heavily loaded, Room B's loop runs in an uncoupled event loop cycle and is not blocked.

### Production Scaling Note
For large-scale deployments, Node.js worker threads or horizontal process clustering (sharding rooms across CPU cores) should be used so that single-threaded CPU saturation does not cascade across rooms.

---

## 4. Mid-Match Disconnect and Reconnect

### The Challenge
Mobile and wireless connections suffer transient dropouts. If a player momentarily loses Wi-Fi or refreshes their browser, they should not be kicked immediately, lose their match score, or have their character vanish abruptly.

### Mitigation & Architecture
1. **Disconnect Grace Period**: When a player socket closes, `Room.handleDisconnect()` transitions the player status to `DISCONNECTED` and records `disconnectedAt = Date.now()`.
2. **30-Second TTL**: The player entity remains in the room for 30 seconds (`DISCONNECT_GRACE_PERIOD_MS`). While disconnected, the entity remains visible (vulnerable to being shot) or inert, preserving game integrity.
3. **Seamless Resumption**: When the client reconnects via `RECONNECT`, `Room.handleReconnect()` re-attaches the new WebSocket connection, sends the full authoritative snapshot, resets input sequence tracking, and broadcasts `PLAYER_JOINED` to peers.
4. **Cleanup on Expiration**: If 30 seconds elapse without a reconnect, the player is permanently pruned from `Room.players`, and `PLAYER_LEFT` is emitted.

### Automated Verification
- `tests/integration/reconnection.test.ts`: Verifies socket drop, timer advancement, successful reconnection with preserved score and position, and expiration after the grace period.

---

## 5. Contested Resource / Same-Tick Conflict

### The Challenge
What happens when two players shoot at each other, or both shoot at the same target with 10 HP remaining, on the **exact same server tick**? In real life, physics is continuous. In a discrete tick loop, both inputs arrive in the same 50ms processing bucket.

### Mitigation & Architecture
1. **Deterministic Player Processing Order**: `Simulation.step` sorts all players alphabetically by their unique ID:
   ```typescript
   const sortedPlayers = [...players.values()].sort((a, b) => a.id.localeCompare(b.id));
   ```
2. **Atomic Resolution**:
   - The player with the lexicographically earlier ID (e.g. `player-A`) is simulated first.
   - If `player-A` lands a kill shot on `player-B`, `player-B.takeDamage()` returns `true`, and `player-B.alive` is set to `false`.
   - When the simulation loop proceeds to `player-B` in that same tick, `if (!player.alive) continue` executes: dead players cannot shoot, and their queued actions are discarded.
   - If both players fired at a third victim with low HP, `player-A` lands the hit and scores the kill. When `player-B` fires, `checkHit` encounters `if (!target.alive) continue` and returns `hit: false`. No double-kill or ghost score can occur.

### Automated Verification
- `tests/integration/contested-resource.test.ts`: Tests simultaneous mutual kill shots and third-party contested kills, proving strict deterministic resolution.
