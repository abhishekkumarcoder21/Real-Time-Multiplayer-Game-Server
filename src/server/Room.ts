/**
 * Room — an independent game instance.
 *
 * Each room encapsulates:
 * - Its own GameLoop (fixed-timestep tick)
 * - Its own set of Players
 * - Its own Simulation instance
 * - Its own LagCompensator (state history buffer)
 * - Its own InputValidator
 *
 * Rooms are completely independent — one room's tick timing, player count,
 * or errors cannot affect another room. This isolation is important for
 * fairness and for fault tolerance (a crash in one room doesn't take down
 * the server).
 *
 * LIFECYCLE:
 * 1. Created when a player requests a new room
 * 2. Game loop starts when the first player joins
 * 3. Players can join/leave at any time
 * 4. Disconnected players get a grace period to reconnect
 * 5. Room shuts down EMPTY_ROOM_TTL_MS after the last player leaves
 */

import { v4 as uuidv4 } from 'uuid';
import type WebSocket from 'ws';
import { GameLoop } from './GameLoop.js';
import { Player } from './Player.js';
import { Projectile } from './Projectile.js';
import { Simulation } from './Simulation.js';
import { InputValidator } from './InputValidator.js';
import { LagCompensator } from './LagCompensator.js';
import { serialize } from './protocol/serializer.js';
import { roomLogger } from './utils/logger.js';
import {
  EMPTY_ROOM_TTL_MS,
  DISCONNECT_GRACE_PERIOD_MS,
  MAX_PLAYERS_PER_ROOM,
  RESPAWN_DELAY_MS,
} from '../shared/constants.js';
import {
  MessageType,
  ConnectionStatus,
} from '../shared/types.js';
import type {
  PlayerInput,
  GameStateSnapshot,
  StateUpdateMessage,
  HitConfirmMessage,
  KillConfirmMessage,
  PlayerJoinedMessage,
  PlayerLeftMessage,
} from '../shared/types.js';
import {
  tickDurationHistogram,
  roomPlayerCountGauge,
  messagesSentCounter,
} from './metrics/prometheus.js';

export class Room {
  public readonly id: string;
  private _players: Map<string, Player> = new Map();
  private _projectiles: Projectile[] = [];
  private _gameLoop: GameLoop;
  private _simulation: Simulation;
  private _inputValidator: InputValidator;
  private _lagCompensator: LagCompensator;
  private _log;
  private _emptyTimeout: ReturnType<typeof setTimeout> | null = null;

  /** Callback invoked when the room should be destroyed. */
  public onDestroy?: (roomId: string) => void;

  constructor(id?: string) {
    this.id = id || uuidv4().slice(0, 8).toUpperCase();
    this._log = roomLogger(this.id);

    this._inputValidator = new InputValidator();
    this._lagCompensator = new LagCompensator();

    this._simulation = new Simulation({
      onHit: (shooterId, targetId, damage) => this._handleHit(shooterId, targetId, damage),
      onKill: (killerId, victimId) => this._handleKill(killerId, victimId),
    });

    this._gameLoop = new GameLoop(
      (tick, dt) => this._onTick(tick, dt),
      this.id
    );

    this._log.info('Room created');
  }

  // ─── Player Management ─────────────────────────────────────────────

  /**
   * Add a player to the room.
   * @returns The player's assigned ID, or null if room is full
   */
  addPlayer(ws: WebSocket, name?: string): string | null {
    const connectedCount = this._getConnectedPlayerCount();
    if (connectedCount >= MAX_PLAYERS_PER_ROOM) {
      this._log.warn('Room is full, rejecting player');
      return null;
    }

    const playerId = uuidv4();
    const player = new Player(playerId, ws, name);
    this._players.set(playerId, player);

    // Cancel empty room timeout if it's running
    if (this._emptyTimeout) {
      clearTimeout(this._emptyTimeout);
      this._emptyTimeout = null;
    }

    // Start the game loop if this is the first player
    if (!this._gameLoop.running) {
      this._gameLoop.start();
    }

    // Notify other players
    this._broadcast({
      type: MessageType.PLAYER_JOINED,
      playerId,
      playerName: player.name,
    } as PlayerJoinedMessage, playerId);

    roomPlayerCountGauge.set({ room_id: this.id }, this._getConnectedPlayerCount());
    this._log.info({ playerId, playerName: player.name }, 'Player joined');

    return playerId;
  }

  /**
   * Handle a player disconnecting.
   * The player is NOT immediately removed — they get a grace period
   * to reconnect. This handles Failure Scenario #4 (mid-match reconnect).
   */
  handleDisconnect(playerId: string): void {
    const player = this._players.get(playerId);
    if (!player) return;

    player.ws = null;
    player.connectionStatus = ConnectionStatus.DISCONNECTED;
    player.disconnectedAt = Date.now();

    this._log.info({ playerId }, 'Player disconnected, starting grace period');

    // Notify others
    this._broadcast({
      type: MessageType.PLAYER_LEFT,
      playerId,
      reason: 'disconnect',
    } as PlayerLeftMessage);

    roomPlayerCountGauge.set({ room_id: this.id }, this._getConnectedPlayerCount());

    // Start empty room timeout if no connected players remain
    if (this._getConnectedPlayerCount() === 0) {
      this._startEmptyTimeout();
    }
  }

  /**
   * Handle a player reconnecting.
   * Restores their connection and sends them the current state.
   */
  handleReconnect(playerId: string, ws: WebSocket): boolean {
    const player = this._players.get(playerId);
    if (!player) return false;

    player.ws = ws;
    player.connectionStatus = ConnectionStatus.CONNECTED;
    player.disconnectedAt = 0;

    // Cancel empty room timeout
    if (this._emptyTimeout) {
      clearTimeout(this._emptyTimeout);
      this._emptyTimeout = null;
    }

    // Send current state to the reconnected player
    this._sendToPlayer(player, {
      type: MessageType.STATE_UPDATE,
      state: this._buildSnapshot(),
    } as StateUpdateMessage);

    // Notify others
    this._broadcast({
      type: MessageType.PLAYER_JOINED,
      playerId,
      playerName: player.name,
    } as PlayerJoinedMessage, playerId);

    roomPlayerCountGauge.set({ room_id: this.id }, this._getConnectedPlayerCount());
    this._log.info({ playerId }, 'Player reconnected');

    return true;
  }

  /**
   * Fully remove a player from the room (voluntary leave or grace period expired).
   */
  removePlayer(playerId: string): void {
    this._players.delete(playerId);

    this._broadcast({
      type: MessageType.PLAYER_LEFT,
      playerId,
      reason: 'leave',
    } as PlayerLeftMessage);

    roomPlayerCountGauge.set({ room_id: this.id }, this._getConnectedPlayerCount());
    this._log.info({ playerId }, 'Player removed');

    if (this._getConnectedPlayerCount() === 0 && this._players.size === 0) {
      this._startEmptyTimeout();
    }
  }

  // ─── Input Handling ────────────────────────────────────────────────

  /**
   * Queue an input from a player for processing in the next tick.
   * The input is validated before being queued.
   */
  queueInput(playerId: string, input: PlayerInput): void {
    const player = this._players.get(playerId);
    if (!player) return;

    const serverTimeMs = Date.now();
    const result = this._inputValidator.validate(player, input, serverTimeMs);

    if (!result.valid) {
      player.violationCount++;
      this._log.warn(
        { playerId, violation: result.violation, totalViolations: player.violationCount },
        'Input rejected'
      );
      return;
    }

    // Input is valid — queue it for processing in the next tick
    player.inputBuffer.push(input);
  }

  // ─── RTT Measurement ───────────────────────────────────────────────

  /** Update a player's measured RTT (called from pong handler). */
  updatePlayerRtt(playerId: string, rttMs: number): void {
    const player = this._players.get(playerId);
    if (player) {
      // Exponential moving average to smooth out jitter
      player.rtt = player.rtt === 0 ? rttMs : player.rtt * 0.8 + rttMs * 0.2;
    }
  }

  // ─── Tick Loop ─────────────────────────────────────────────────────

  /**
   * The core tick callback — called every TICK_INTERVAL_MS by the GameLoop.
   *
   * This is where the server-authoritative magic happens:
   * 1. Clean up expired disconnected players
   * 2. Run the simulation (process inputs, move projectiles)
   * 3. Record state for lag compensation history
   * 4. Broadcast authoritative state to all connected clients
   * 5. Record metrics
   */
  private _onTick(tick: number, dt: number): void {
    const currentTimeMs = Date.now();

    // 1. Clean up players whose grace period expired
    this._cleanupDisconnectedPlayers(currentTimeMs);

    // 2. Run simulation
    this._simulation.step(
      this._players,
      this._projectiles,
      tick,
      dt,
      currentTimeMs,
      (shooterId, x, y, angle, rtt) =>
        this._lagCompensator.checkHit(shooterId, x, y, angle, rtt, tick)
    );

    // 3. Build state snapshot
    const snapshot = this._buildSnapshot(tick, currentTimeMs);

    // 4. Record snapshot for lag compensation history
    this._lagCompensator.recordSnapshot(tick, currentTimeMs, [...this._players.values()]);

    // 5. Broadcast state to all connected clients
    const stateMsg: StateUpdateMessage = {
      type: MessageType.STATE_UPDATE,
      state: snapshot,
    };
    this._broadcastState(stateMsg);

    // 6. Record metrics
    tickDurationHistogram.observe(
      { room_id: this.id },
      this._gameLoop.lastTickDurationMs
    );
  }

  // ─── Event Handlers ────────────────────────────────────────────────

  private _handleHit(shooterId: string, targetId: string, damage: number): void {
    const target = this._players.get(targetId);
    const shooter = this._players.get(shooterId);
    if (!target || !shooter) return;

    const killed = target.takeDamage(damage);

    // Send hit confirmation to the shooter
    this._sendToPlayer(shooter, {
      type: MessageType.HIT_CONFIRM,
      targetId,
      damage,
    } as HitConfirmMessage);

    if (killed) {
      this._handleKill(shooterId, targetId);
    }

    // Spawn visual projectile
    const projectile = new Projectile(
      shooterId,
      shooter.x,
      shooter.y,
      // We need the aim angle — retrieve from the shooter's last processed input
      0, // Will be set properly when we integrate
      Date.now()
    );
    this._projectiles.push(projectile);
  }

  private _handleKill(killerId: string, victimId: string): void {
    const killer = this._players.get(killerId);
    const victim = this._players.get(victimId);
    if (!killer || !victim) return;

    killer.score++;
    victim.respawnAt = Date.now() + RESPAWN_DELAY_MS;

    // Notify all players
    this._broadcast({
      type: MessageType.KILL_CONFIRM,
      killerId,
      victimId,
    } as KillConfirmMessage);

    this._log.info({ killerId, victimId, killerScore: killer.score }, 'Player killed');
  }

  // ─── Networking Helpers ────────────────────────────────────────────

  /** Broadcast a message to all connected players (optionally excluding one). */
  private _broadcast(message: object, excludeId?: string): void {
    const data = serialize(message as any);
    for (const player of this._players.values()) {
      if (player.id === excludeId) continue;
      if (player.ws && player.connectionStatus === ConnectionStatus.CONNECTED) {
        try {
          player.ws.send(data);
          messagesSentCounter.inc({ type: (message as any).type });
        } catch {
          // Socket error — will be handled by disconnect event
        }
      }
    }
  }

  /** Broadcast state update to all connected players. */
  private _broadcastState(message: StateUpdateMessage): void {
    const data = serialize(message);
    for (const player of this._players.values()) {
      if (player.ws && player.connectionStatus === ConnectionStatus.CONNECTED) {
        try {
          player.ws.send(data);
          messagesSentCounter.inc({ type: MessageType.STATE_UPDATE });
        } catch {
          // Socket error
        }
      }
    }
  }

  /** Send a message to a specific player. */
  private _sendToPlayer(player: Player, message: object): void {
    if (player.ws && player.connectionStatus === ConnectionStatus.CONNECTED) {
      try {
        player.ws.send(serialize(message as any));
        messagesSentCounter.inc({ type: (message as any).type });
      } catch {
        // Socket error
      }
    }
  }

  // ─── State Building ────────────────────────────────────────────────

  /** Build a state snapshot from current player and projectile state. */
  private _buildSnapshot(tick?: number, timestamp?: number): GameStateSnapshot {
    return {
      tick: tick || this._gameLoop.tickCount,
      timestamp: timestamp || Date.now(),
      players: [...this._players.values()].map(p => p.toState()),
      projectiles: this._projectiles.map(p => p.toState()),
    };
  }

  // ─── Cleanup / Lifecycle ───────────────────────────────────────────

  /** Remove players whose disconnect grace period has expired. */
  private _cleanupDisconnectedPlayers(currentTimeMs: number): void {
    for (const [id, player] of this._players) {
      if (
        player.connectionStatus === ConnectionStatus.DISCONNECTED &&
        player.disconnectedAt > 0 &&
        currentTimeMs - player.disconnectedAt > DISCONNECT_GRACE_PERIOD_MS
      ) {
        this._log.info({ playerId: id }, 'Disconnect grace period expired, removing player');
        this._players.delete(id);
      }
    }
  }

  /** Start the timer to destroy this room after it's been empty. */
  private _startEmptyTimeout(): void {
    if (this._emptyTimeout) return;

    this._log.info(`Room empty, will destroy in ${EMPTY_ROOM_TTL_MS / 1000}s`);

    this._emptyTimeout = setTimeout(() => {
      if (this._getConnectedPlayerCount() === 0) {
        this.destroy();
      }
    }, EMPTY_ROOM_TTL_MS);
  }

  /** Shut down this room completely. */
  destroy(): void {
    this._gameLoop.stop();
    this._lagCompensator.clear();
    this._players.clear();
    this._projectiles = [];

    if (this._emptyTimeout) {
      clearTimeout(this._emptyTimeout);
      this._emptyTimeout = null;
    }

    roomPlayerCountGauge.remove({ room_id: this.id });
    this._log.info('Room destroyed');
    this.onDestroy?.(this.id);
  }

  // ─── Accessors ─────────────────────────────────────────────────────

  get playerCount(): number {
    return this._players.size;
  }

  get connectedPlayerCount(): number {
    return this._getConnectedPlayerCount();
  }

  private _getConnectedPlayerCount(): number {
    let count = 0;
    for (const player of this._players.values()) {
      if (player.connectionStatus === ConnectionStatus.CONNECTED) count++;
    }
    return count;
  }

  get isRunning(): boolean {
    return this._gameLoop.running;
  }

  /** Get current state snapshot (for reconnecting players). */
  get currentState(): GameStateSnapshot {
    return this._buildSnapshot();
  }

  /** Check if a player ID exists in this room. */
  hasPlayer(playerId: string): boolean {
    return this._players.has(playerId);
  }

  /** Get a player by ID. */
  getPlayer(playerId: string): Player | undefined {
    return this._players.get(playerId);
  }
}
