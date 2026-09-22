/**
 * Shared TypeScript types used by both client and server.
 *
 * The message protocol is designed around a core principle:
 *   Clients send INPUTS (intentions), not STATE (positions).
 *   The server sends STATE (authoritative truth), not ACKs.
 *
 * This asymmetry is the foundation of the anti-cheat model.
 */

// ─── Input Types ─────────────────────────────────────────────────────────────

/** The set of actions a player can take in a single input frame. */
export interface InputActions {
  /** Movement directions — multiple can be true simultaneously (e.g., up+right). */
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  /** Whether the player is firing this frame. */
  shoot: boolean;
}

/** Alias for InputActions */
export type PlayerActions = InputActions;

/**
 * A single input message from client → server.
 *
 * Key fields:
 * - `seq`: Monotonically increasing sequence number. The server echoes this
 *   back in state updates so the client knows which inputs have been processed.
 *   This is the backbone of the reconciliation algorithm.
 * - `actions`: What the player intends to do (move/shoot), NOT where they are.
 * - `aimAngle`: The angle the player is aiming, in radians [0, 2π).
 * - `timestamp`: Client-side timestamp when this input was created. Used by
 *   the server for lag compensation (calculating how far in the past the
 *   client was seeing the world when they fired).
 */
export interface PlayerInput {
  seq: number;
  actions: InputActions;
  aimAngle: number;
  timestamp: number;
}

// ─── Entity State Types ──────────────────────────────────────────────────────

/** Server-authoritative state of a single player. Broadcast to all clients each tick. */
export interface PlayerState {
  id: string;
  x: number;
  y: number;
  hp: number;
  score: number;
  /** The latest input sequence number the server has processed for this player.
   *  The client uses this to prune its pending input buffer during reconciliation. */
  lastProcessedSeq: number;
  /** Whether this player is currently alive. Dead players can't move or shoot. */
  alive: boolean;
  /** Timestamp when the player will respawn (0 if alive). */
  respawnAt: number;
}

/** State of a single projectile (visual tracer only — hits are hitscan). */
export interface ProjectileState {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  angle: number;
  speed: number;
  createdAt: number;
}

/** A complete snapshot of the game world at a specific tick. */
export interface GameStateSnapshot {
  /** Server tick number when this snapshot was generated. */
  tick: number;
  /** Server timestamp (ms) when this snapshot was generated. */
  timestamp: number;
  /** All player states. */
  players: PlayerState[];
  /** All active projectile states. */
  projectiles: ProjectileState[];
}

// ─── Message Types ───────────────────────────────────────────────────────────

/**
 * All message types in the protocol. Each message is a JSON object with
 * a `type` field from this enum plus type-specific payload fields.
 */
export enum MessageType {
  // Client → Server
  INPUT = 'input',
  JOIN_ROOM = 'join_room',
  CREATE_ROOM = 'create_room',
  PING = 'ping',

  // Server → Client
  STATE_UPDATE = 'state_update',
  ROOM_JOINED = 'room_joined',
  ROOM_CREATED = 'room_created',
  PLAYER_JOINED = 'player_joined',
  PLAYER_LEFT = 'player_left',
  PONG = 'pong',
  ERROR = 'error',
  HIT_CONFIRM = 'hit_confirm',
  KILL_CONFIRM = 'kill_confirm',
}

// ─── Wire Messages ───────────────────────────────────────────────────────────

/** Client → Server: player input for this frame. */
export interface InputMessage {
  type: MessageType.INPUT;
  input: PlayerInput;
}

/** Client → Server: request to join an existing room. */
export interface JoinRoomMessage {
  type: MessageType.JOIN_ROOM;
  roomId: string;
  playerName?: string;
}

/** Client → Server: request to create a new room. */
export interface CreateRoomMessage {
  type: MessageType.CREATE_ROOM;
  playerName?: string;
}

/** Client → Server: ping for RTT measurement. */
export interface PingMessage {
  type: MessageType.PING;
  clientTimestamp: number;
}

/** Server → Client: authoritative game state snapshot. Sent every tick. */
export interface StateUpdateMessage {
  type: MessageType.STATE_UPDATE;
  state: GameStateSnapshot;
}

/** Server → Client: confirmation that the player joined a room. */
export interface RoomJoinedMessage {
  type: MessageType.ROOM_JOINED;
  roomId: string;
  playerId: string;
  state: GameStateSnapshot;
}

/** Server → Client: confirmation that a room was created. */
export interface RoomCreatedMessage {
  type: MessageType.ROOM_CREATED;
  roomId: string;
  playerId: string;
}

/** Server → Client: another player joined the room. */
export interface PlayerJoinedMessage {
  type: MessageType.PLAYER_JOINED;
  playerId: string;
  playerName?: string;
}

/** Server → Client: another player left the room. */
export interface PlayerLeftMessage {
  type: MessageType.PLAYER_LEFT;
  playerId: string;
  reason: 'disconnect' | 'leave' | 'kicked';
}

/** Server → Client: pong response for RTT measurement. */
export interface PongMessage {
  type: MessageType.PONG;
  clientTimestamp: number;
  serverTimestamp: number;
}

/** Server → Client: error message. */
export interface ErrorMessage {
  type: MessageType.ERROR;
  code: string;
  message: string;
}

/** Server → Client: confirms a hit was registered. */
export interface HitConfirmMessage {
  type: MessageType.HIT_CONFIRM;
  targetId: string;
  damage: number;
}

/** Server → Client: confirms a kill. */
export interface KillConfirmMessage {
  type: MessageType.KILL_CONFIRM;
  killerId: string;
  victimId: string;
}

/** Union of all possible messages. */
export type GameMessage =
  | InputMessage
  | JoinRoomMessage
  | CreateRoomMessage
  | PingMessage
  | StateUpdateMessage
  | RoomJoinedMessage
  | RoomCreatedMessage
  | PlayerJoinedMessage
  | PlayerLeftMessage
  | PongMessage
  | ErrorMessage
  | HitConfirmMessage
  | KillConfirmMessage;

// ─── Internal Server Types ───────────────────────────────────────────────────

/** Connection status for a player in a room. */
export enum ConnectionStatus {
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
}

/** Violation types for anti-cheat logging. */
export enum ViolationType {
  SPEED_HACK = 'speed_hack',
  RAPID_FIRE = 'rapid_fire',
  INVALID_SEQUENCE = 'invalid_sequence',
  INPUT_FLOOD = 'input_flood',
  INVALID_AIM = 'invalid_aim',
}

/** A logged anti-cheat violation. */
export interface Violation {
  type: ViolationType;
  playerId: string;
  timestamp: number;
  details: string;
}
