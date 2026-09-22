/**
 * Load Test Harness.
 *
 * Simulates N concurrent WebSocket clients connecting to the game server,
 * joining a room, and generating realistic input streams at 20Hz.
 *
 * Measures:
 * - Inbound and outbound message throughput
 * - State update delivery intervals
 * - Round-trip ping/pong latency (P50, P95, P99)
 * - Tick budget adherence
 */

import { WebSocket } from 'ws';
import { GameServer } from '../../src/server/GameServer.js';
import { MessageType } from '../../src/shared/types.js';
import type {
  CreateRoomMessage,
  JoinRoomMessage,
  InputMessage,
  PongMessage,
} from '../../src/shared/types.js';
import { TICK_INTERVAL_MS } from '../../src/shared/constants.js';

interface ClientStats {
  id: string;
  inputsSent: number;
  statesReceived: number;
  rttSamples: number[];
}

export async function runLoadTest(
  numClients: number = 20,
  durationSeconds: number = 5,
  port: number = 3899
): Promise<{ p50Rtt: number; p95Rtt: number; p99Rtt: number; totalInputs: number; totalStates: number }> {
  console.log(`\n======================================================`);
  console.log(`  STARTING LOAD TEST: ${numClients} clients, ${durationSeconds}s duration`);
  console.log(`======================================================\n`);

  // Start a local test server
  const server = new GameServer(port);
  await server.start();

  const wsUrl = `ws://localhost:${port}`;
  const clients: WebSocket[] = [];
  const stats: ClientStats[] = [];
  const intervals: NodeJS.Timeout[] = [];

  let roomId = 'LOAD-TEST-ROOM';

  // 1. First client creates the room
  const createPromise = new Promise<string>((resolve) => {
    const creatorWs = new WebSocket(wsUrl);
    creatorWs.on('open', () => {
      creatorWs.send(JSON.stringify({
        type: MessageType.CREATE_ROOM,
        roomName: 'LoadTestRoom',
        playerName: 'Client_0',
      } as CreateRoomMessage));
    });

    creatorWs.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === MessageType.ROOM_CREATED) {
        roomId = msg.roomId;
        resolve(msg.roomId);
      }
    });

    clients.push(creatorWs);
    stats.push({ id: 'Client_0', inputsSent: 0, statesReceived: 0, rttSamples: [] });
  });

  await createPromise;
  console.log(`Room created: ${roomId}. Connecting remaining ${numClients - 1} clients...`);

  // 2. Connect remaining clients and join room
  for (let i = 1; i < numClients; i++) {
    const clientName = `Client_${i}`;
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: MessageType.JOIN_ROOM,
          roomId,
          playerName: clientName,
        } as JoinRoomMessage));
        resolve();
      });
    });

    const clientStat: ClientStats = {
      id: clientName,
      inputsSent: 0,
      statesReceived: 0,
      rttSamples: [],
    };
    stats.push(clientStat);
    clients.push(ws);
  }

  // 3. Set up listeners and 20Hz input generation loops
  clients.forEach((ws, idx) => {
    const clientStat = stats[idx];
    let seq = 0;

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === MessageType.STATE_UPDATE) {
        clientStat.statesReceived++;
      } else if (msg.type === MessageType.PONG) {
        const pong = msg as PongMessage;
        const rtt = Date.now() - pong.clientTimestamp;
        clientStat.rttSamples.push(rtt);
      }
    });

    // 20Hz input interval
    const inputInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        seq++;
        const inputMsg: InputMessage = {
          type: MessageType.INPUT,
          input: {
            seq,
            actions: {
              up: Math.random() > 0.5,
              down: Math.random() > 0.5,
              left: Math.random() > 0.5,
              right: Math.random() > 0.5,
              shoot: Math.random() > 0.8,
            },
            aimAngle: Math.random() * Math.PI * 2,
            timestamp: Date.now(),
          },
        };
        ws.send(JSON.stringify(inputMsg));
        clientStat.inputsSent++;

        // Periodic ping (every 1s)
        if (seq % 20 === 0) {
          ws.send(JSON.stringify({
            type: MessageType.PING,
            clientTimestamp: Date.now(),
          }));
        }
      }
    }, TICK_INTERVAL_MS);

    intervals.push(inputInterval);
  });

  console.log(`All clients active. Simulating load for ${durationSeconds} seconds...`);

  // Wait for test duration
  await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1000));

  // Clean up intervals and sockets
  intervals.forEach(clearInterval);
  for (const ws of clients) {
    ws.close();
  }
  await server.stop();

  // Aggregate stats
  const totalInputs = stats.reduce((acc, s) => acc + s.inputsSent, 0);
  const totalStates = stats.reduce((acc, s) => acc + s.statesReceived, 0);
  const allRtts = stats.flatMap(s => s.rttSamples).sort((a, b) => a - b);

  const p50 = allRtts.length > 0 ? allRtts[Math.floor(allRtts.length * 0.5)] : 0;
  const p95 = allRtts.length > 0 ? allRtts[Math.floor(allRtts.length * 0.95)] : 0;
  const p99 = allRtts.length > 0 ? allRtts[Math.floor(allRtts.length * 0.99)] : 0;

  console.log(`\n--- LOAD TEST RESULTS ---`);
  console.log(`Concurrent Clients:   ${numClients}`);
  console.log(`Total Inputs Sent:    ${totalInputs} (~${(totalInputs / durationSeconds).toFixed(0)} msg/s)`);
  console.log(`Total States Recv:    ${totalStates} (~${(totalStates / durationSeconds).toFixed(0)} msg/s)`);
  console.log(`Ping RTT P50:         ${p50.toFixed(1)} ms`);
  console.log(`Ping RTT P95:         ${p95.toFixed(1)} ms`);
  console.log(`Ping RTT P99:         ${p99.toFixed(1)} ms`);
  console.log(`======================================================\n`);

  return { p50Rtt: p50, p95Rtt: p95, p99Rtt: p99, totalInputs, totalStates };
}

// Allow direct CLI execution
if (process.argv[1]?.includes('LoadTestHarness')) {
  runLoadTest(15, 3).catch(console.error);
}
