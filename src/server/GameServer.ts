/**
 * GameServer — top-level orchestrator.
 *
 * Responsibilities:
 * - Create and manage the HTTP server (for serving the client and metrics)
 * - Create and manage the WebSocket server (for game communication)
 * - Route incoming WebSocket messages to the appropriate Room
 * - Handle room creation, joining, and lifecycle
 *
 * This is the entry point for all client connections. When a client connects
 * via WebSocket, they must first send a CREATE_ROOM or JOIN_ROOM message.
 * Once in a room, they send INPUT messages and receive STATE_UPDATE messages.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { Room } from './Room.js';
import { deserialize, serialize } from './protocol/serializer.js';
import { logger } from './utils/logger.js';
import { MessageType } from '../shared/types.js';
import type {
  JoinRoomMessage,
  CreateRoomMessage,
  PingMessage,
  InputMessage,
  RoomJoinedMessage,
  RoomCreatedMessage,
  PongMessage,
  ErrorMessage,
} from '../shared/types.js';
import {
  metricsRegistry,
  activeRoomsGauge,
  messagesReceivedCounter,
} from './metrics/prometheus.js';
import { DEFAULT_PORT, PING_INTERVAL_MS } from '../shared/constants.js';

/** Tracks per-connection state (which room and player ID). */
interface ClientSession {
  playerId: string | null;
  roomId: string | null;
  pingInterval: ReturnType<typeof setInterval> | null;
}

export class GameServer {
  private _httpServer: http.Server;
  private _wss: WebSocketServer;
  private _rooms: Map<string, Room> = new Map();
  private _sessions: Map<WebSocket, ClientSession> = new Map();
  private _port: number;

  constructor(port: number = DEFAULT_PORT) {
    this._port = port;

    // Create HTTP server for serving client files and metrics
    this._httpServer = http.createServer((req, res) => {
      this._handleHttp(req, res);
    });

    // Create WebSocket server attached to the HTTP server
    this._wss = new WebSocketServer({ server: this._httpServer });

    this._wss.on('connection', (ws) => {
      this._handleConnection(ws);
    });
  }

  /** Start listening on the configured port. */
  start(): void {
    this._httpServer.listen(this._port, () => {
      logger.info({ port: this._port }, 'Game server listening');
      logger.info({ metricsUrl: `http://localhost:${this._port}/metrics` }, 'Metrics endpoint available');
    });
  }

  /** Shut down the server. */
  async stop(): Promise<void> {
    // Destroy all rooms
    for (const room of this._rooms.values()) {
      room.destroy();
    }
    this._rooms.clear();

    // Close all WebSocket connections
    for (const ws of this._sessions.keys()) {
      ws.close();
    }
    this._sessions.clear();

    // Close the HTTP server
    return new Promise((resolve) => {
      this._wss.close(() => {
        this._httpServer.close(() => {
          logger.info('Game server stopped');
          resolve();
        });
      });
    });
  }

  // ─── HTTP Handler ──────────────────────────────────────────────────

  private _handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || '/';

    // Prometheus metrics endpoint
    if (url === '/metrics') {
      metricsRegistry.metrics().then((metrics) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(metrics);
      }).catch((_err) => {
        res.writeHead(500);
        res.end('Error generating metrics');
      });
      return;
    }

    // Health check
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        rooms: this._rooms.size,
        connections: this._sessions.size,
      }));
      return;
    }

    // Serve static client files
    this._serveStaticFile(url, res);
  }

  private _serveStaticFile(url: string, res: http.ServerResponse): void {
    // Map URL to file path
    let filePath: string;
    if (url === '/' || url === '/index.html') {
      filePath = path.join(process.cwd(), 'src', 'client', 'index.html');
      if (!fs.existsSync(filePath)) {
        filePath = path.join(process.cwd(), 'dist', 'client', 'index.html');
      }
    } else if (url.startsWith('/client/')) {
      filePath = path.join(process.cwd(), 'src', url);
      if (!fs.existsSync(filePath)) {
        filePath = path.join(process.cwd(), 'dist', url);
      }
    } else {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    // Read and serve the file
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const ext = path.extname(filePath);
      const contentType: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
      };

      res.writeHead(200, { 'Content-Type': contentType[ext] || 'text/plain' });
      res.end(data);
    });
  }

  // ─── WebSocket Handler ─────────────────────────────────────────────

  private _handleConnection(ws: WebSocket): void {
    const session: ClientSession = {
      playerId: null,
      roomId: null,
      pingInterval: null,
    };
    this._sessions.set(ws, session);

    logger.info('New WebSocket connection');

    ws.on('message', (data) => {
      const message = deserialize(data.toString());
      if (!message) {
        logger.warn('Received invalid message, ignoring');
        return;
      }

      messagesReceivedCounter.inc({ type: message.type });

      switch (message.type) {
        case MessageType.CREATE_ROOM:
          this._handleCreateRoom(ws, session, message as CreateRoomMessage);
          break;
        case MessageType.JOIN_ROOM:
          this._handleJoinRoom(ws, session, message as JoinRoomMessage);
          break;
        case MessageType.INPUT:
          this._handleInput(session, message as InputMessage);
          break;
        case MessageType.PING:
          this._handlePing(ws, session, message as PingMessage);
          break;
        default:
          logger.warn({ type: message.type }, 'Unknown message type');
      }
    });

    ws.on('close', () => {
      this._handleDisconnect(ws, session);
    });

    ws.on('error', (err) => {
      logger.error({ err }, 'WebSocket error');
      this._handleDisconnect(ws, session);
    });
  }

  // ─── Message Handlers ──────────────────────────────────────────────

  private _handleCreateRoom(ws: WebSocket, session: ClientSession, msg: CreateRoomMessage): void {
    const room = new Room();
    this._rooms.set(room.id, room);
    activeRoomsGauge.set(this._rooms.size);

    room.onDestroy = (roomId) => {
      this._rooms.delete(roomId);
      activeRoomsGauge.set(this._rooms.size);
    };

    const playerId = room.addPlayer(ws, msg.playerName);
    if (!playerId) {
      this._sendError(ws, 'ROOM_FULL', 'Could not join room');
      return;
    }

    session.playerId = playerId;
    session.roomId = room.id;

    // Start ping/pong for RTT measurement
    this._startPingInterval(ws, session);

    // Send room created confirmation
    ws.send(serialize({
      type: MessageType.ROOM_CREATED,
      roomId: room.id,
      playerId,
    } as RoomCreatedMessage));

    // Send initial state
    ws.send(serialize({
      type: MessageType.ROOM_JOINED,
      roomId: room.id,
      playerId,
      state: room.currentState,
    } as RoomJoinedMessage));

    logger.info({ roomId: room.id, playerId }, 'Room created');
  }

  private _handleJoinRoom(ws: WebSocket, session: ClientSession, msg: JoinRoomMessage): void {
    const room = this._rooms.get(msg.roomId);

    if (!room) {
      this._sendError(ws, 'ROOM_NOT_FOUND', `Room ${msg.roomId} not found`);
      return;
    }

    const playerId = room.addPlayer(ws, msg.playerName);
    if (!playerId) {
      this._sendError(ws, 'ROOM_FULL', 'Room is full');
      return;
    }

    session.playerId = playerId;
    session.roomId = room.id;

    // Start ping/pong
    this._startPingInterval(ws, session);

    // Send join confirmation with current state
    ws.send(serialize({
      type: MessageType.ROOM_JOINED,
      roomId: room.id,
      playerId,
      state: room.currentState,
    } as RoomJoinedMessage));

    logger.info({ roomId: room.id, playerId }, 'Player joined room');
  }

  private _handleInput(session: ClientSession, msg: InputMessage): void {
    if (!session.roomId || !session.playerId) return;

    const room = this._rooms.get(session.roomId);
    if (!room) return;

    room.queueInput(session.playerId, msg.input);
  }

  private _handlePing(ws: WebSocket, _session: ClientSession, msg: PingMessage): void {
    // Respond with pong immediately
    ws.send(serialize({
      type: MessageType.PONG,
      clientTimestamp: msg.clientTimestamp,
      serverTimestamp: Date.now(),
    } as PongMessage));
  }

  private _handleDisconnect(ws: WebSocket, session: ClientSession): void {
    // Stop ping interval
    if (session.pingInterval) {
      clearInterval(session.pingInterval);
      session.pingInterval = null;
    }

    // Notify the room
    if (session.roomId && session.playerId) {
      const room = this._rooms.get(session.roomId);
      if (room) {
        room.handleDisconnect(session.playerId);
      }
    }

    this._sessions.delete(ws);
    logger.info({ playerId: session.playerId, roomId: session.roomId }, 'Client disconnected');
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private _startPingInterval(ws: WebSocket, session: ClientSession): void {
    session.pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(serialize({
          type: MessageType.PONG,
          clientTimestamp: Date.now(),
          serverTimestamp: Date.now(),
        } as PongMessage));
      }
    }, PING_INTERVAL_MS);
  }

  private _sendError(ws: WebSocket, code: string, message: string): void {
    ws.send(serialize({
      type: MessageType.ERROR,
      code,
      message,
    } as ErrorMessage));
  }

  /** Get the number of active rooms (for testing). */
  get roomCount(): number {
    return this._rooms.size;
  }

  /** Get a room by ID (for testing). */
  getRoom(roomId: string): Room | undefined {
    return this._rooms.get(roomId);
  }
}
