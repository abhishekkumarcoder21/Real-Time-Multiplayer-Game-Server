import { describe, it, expect } from 'vitest';
import { applyMovement } from '../../src/shared/physics.js';
import {
  TICK_INTERVAL_S,
  RECONCILIATION_THRESHOLD,
  SNAP_THRESHOLD,
} from '../../src/shared/constants.js';
import type { InputActions, PlayerActions, PlayerState } from '../../src/shared/types.js';

export interface PendingInput {
  seq: number;
  actions: InputActions;
  predictedPos: { x: number; y: number };
}

export interface ReconciliationResult {
  reconciledPos: { x: number; y: number };
  corrected: boolean;
  snapped: boolean;
  discardedCount: number;
  remainingCount: number;
}

/**
 * Pure reconciliation function replicating client-side logic.
 *
 * Algorithm:
 * 1. Identify predicted position for the server's acknowledged sequence (`lastProcessedSeq`).
 * 2. Prune all acknowledged inputs (`seq <= lastProcessedSeq`).
 * 3. Calculate deviation (error distance) between recorded prediction and server truth.
 * 4. If error <= threshold: prediction was accurate, no correction required.
 * 5. If error > threshold:
 *    - Reset base position to authoritative server state.
 *    - Replay all remaining unacknowledged inputs forward.
 *    - If error >= snapThreshold, flag as immediate snap rather than lerp.
 */
export function reconcileClient(
  currentPos: { x: number; y: number },
  pendingInputs: PendingInput[],
  serverState: PlayerState,
  dt: number = TICK_INTERVAL_S,
  threshold: number = RECONCILIATION_THRESHOLD,
  snapThreshold: number = SNAP_THRESHOLD
): { result: ReconciliationResult; updatedPending: PendingInput[] } {
  // 1. Find the recorded prediction for lastProcessedSeq
  const lastProcessedInput = pendingInputs.find(i => i.seq === serverState.lastProcessedSeq);
  const recordedPrediction = lastProcessedInput ? lastProcessedInput.predictedPos : null;

  // Stale packet check: if lastProcessedSeq is older than all buffered inputs, ignore to prevent false corrections
  if (!recordedPrediction && pendingInputs.length > 0 && serverState.lastProcessedSeq < pendingInputs[0].seq) {
    return {
      result: {
        reconciledPos: currentPos,
        corrected: false,
        snapped: false,
        discardedCount: 0,
        remainingCount: pendingInputs.length,
      },
      updatedPending: pendingInputs,
    };
  }

  // 2. Discard all inputs <= lastProcessedSeq
  const initialLength = pendingInputs.length;
  const remainingInputs = pendingInputs.filter(i => i.seq > serverState.lastProcessedSeq);
  const discardedCount = initialLength - remainingInputs.length;

  // 3. Compute error
  let error = 0;
  if (recordedPrediction) {
    const dx = recordedPrediction.x - serverState.x;
    const dy = recordedPrediction.y - serverState.y;
    error = Math.hypot(dx, dy);
  } else {
    // When buffer is empty or sequence was not tracked, compare current position with server state
    const dx = currentPos.x - serverState.x;
    const dy = currentPos.y - serverState.y;
    error = Math.hypot(dx, dy);
  }

  // If error is within acceptable tolerance, no correction is required
  if (error <= threshold) {
    return {
      result: {
        reconciledPos: currentPos,
        corrected: false,
        snapped: false,
        discardedCount,
        remainingCount: remainingInputs.length,
      },
      updatedPending: remainingInputs,
    };
  }

  // 4. Divergence: start at authoritative server state and replay remaining inputs forward
  let replayPos = { x: serverState.x, y: serverState.y };
  const updatedPending: PendingInput[] = remainingInputs.map((input) => {
    replayPos = applyMovement(replayPos.x, replayPos.y, input.actions, dt);
    return {
      ...input,
      predictedPos: { ...replayPos },
    };
  });

  return {
    result: {
      reconciledPos: replayPos,
      corrected: true,
      snapped: error >= snapThreshold,
      discardedCount,
      remainingCount: remainingInputs.length,
    },
    updatedPending,
  };
}

describe('Client-Side Server Reconciliation', () => {
  it('does not correct when prediction exactly matches server state', () => {
    let pos = { x: 100, y: 100 };
    const pendingInputs: PendingInput[] = [];

    // Client applies 3 movement inputs to the right
    for (let seq = 1; seq <= 3; seq++) {
      const actions: PlayerActions = { up: false, down: false, left: false, right: true, shoot: false };
      pos = applyMovement(pos.x, pos.y, actions, TICK_INTERVAL_S);
      pendingInputs.push({ seq, actions, predictedPos: { ...pos } });
    }

    // Server acknowledged up to seq 2. Server state matches predicted state at seq 2.
    const serverState: PlayerState = {
      id: 'local-client',
      x: pendingInputs[1].predictedPos.x,
      y: pendingInputs[1].predictedPos.y,
      hp: 100,
      score: 0,
      lastProcessedSeq: 2,
      alive: true,
      respawnAt: 0,
    };

    const { result, updatedPending } = reconcileClient(pos, pendingInputs, serverState);

    expect(result.corrected).toBe(false);
    expect(result.discardedCount).toBe(2);
    expect(result.remainingCount).toBe(1);
    expect(updatedPending[0].seq).toBe(3);
    expect(result.reconciledPos.x).toBe(pos.x);
  });

  it('corrects and replays remaining inputs when prediction diverged (e.g. server wall collision)', () => {
    // Client thought it could move freely right, but hit a wall on server at x=115
    const pendingInputs: PendingInput[] = [
      {
        seq: 1,
        actions: { up: false, down: false, left: false, right: true, shoot: false },
        predictedPos: { x: 115, y: 100 },
      },
      {
        seq: 2,
        actions: { up: false, down: false, left: false, right: true, shoot: false },
        predictedPos: { x: 130, y: 100 },
      },
      {
        seq: 3,
        actions: { up: true, down: false, left: false, right: false, shoot: false },
        predictedPos: { x: 130, y: 85 },
      },
    ];

    // Server says at seq 2, player was stopped at x=115 due to an obstacle
    const serverState: PlayerState = {
      id: 'local-client',
      x: 115,
      y: 100,
      hp: 100,
      score: 0,
      lastProcessedSeq: 2,
      alive: true,
      respawnAt: 0,
    };

    const { result, updatedPending } = reconcileClient({ x: 130, y: 85 }, pendingInputs, serverState);

    expect(result.corrected).toBe(true);
    expect(result.discardedCount).toBe(2);
    expect(result.remainingCount).toBe(1);
    // After replaying seq 3 (moving UP from (115, 100))
    expect(result.reconciledPos.x).toBe(115);
    expect(result.reconciledPos.y).toBeCloseTo(85, 1);
    expect(updatedPending[0].predictedPos.x).toBe(115);
    expect(updatedPending[0].predictedPos.y).toBeCloseTo(85, 1);
  });

  it('triggers an immediate snap if prediction divergence exceeds snapThreshold (anti-rubberbanding)', () => {
    const pendingInputs: PendingInput[] = [
      {
        seq: 1,
        actions: { up: false, down: false, left: false, right: false, shoot: false },
        predictedPos: { x: 500, y: 500 },
      },
    ];

    // Server says player was at (100, 100) (400+ units away, e.g. teleport hack or respawn)
    const serverState: PlayerState = {
      id: 'local-client',
      x: 100,
      y: 100,
      hp: 100,
      score: 0,
      lastProcessedSeq: 1,
      alive: true,
      respawnAt: 0,
    };

    const { result } = reconcileClient({ x: 500, y: 500 }, pendingInputs, serverState, TICK_INTERVAL_S, 0.5, 50);

    expect(result.corrected).toBe(true);
    expect(result.snapped).toBe(true);
    expect(result.reconciledPos.x).toBe(100);
    expect(result.reconciledPos.y).toBe(100);
  });

  it('ignores stale/out-of-order server updates whose sequence has already been discarded', () => {
    // Current client buffer only has inputs starting from seq 10
    const pendingInputs: PendingInput[] = [
      {
        seq: 10,
        actions: { up: false, down: false, left: false, right: true, shoot: false },
        predictedPos: { x: 300, y: 100 },
      },
    ];

    // Server sends delayed packet for seq 5
    const serverState: PlayerState = {
      id: 'local-client',
      x: 200,
      y: 100,
      hp: 100,
      score: 0,
      lastProcessedSeq: 5,
      alive: true,
      respawnAt: 0,
    };

    const { result, updatedPending } = reconcileClient({ x: 300, y: 100 }, pendingInputs, serverState);

    expect(result.corrected).toBe(false);
    expect(result.discardedCount).toBe(0);
    expect(updatedPending.length).toBe(1);
    expect(result.reconciledPos.x).toBe(300);
  });
});
