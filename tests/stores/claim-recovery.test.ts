import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { statusBadge } from '../../src/dashboard/views/status-badge.js';
import { DurableWorkflow } from '../../src/runtime/workflow.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { DurableError } from '../../src/errors.js';
import type { WorkflowFn } from '../../src/runtime/workflow.js';
import type { OutcomeRecord, Step, TokenCost } from '../../src/core/types.js';

const ZERO_COST: TokenCost = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

function backdateHeartbeat(store: SqliteJournalStore, runId: string): void {
  const stale = new Date(Date.now() - 60_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (store as any).db
    .prepare('UPDATE runs SET last_heartbeat = ? WHERE run_id = ?')
    .run(stale, runId);
}

function makeStep(runId: string, sequence: number): Omit<Step, 'completedAt'> {
  return {
    stepId: randomUUID(),
    runId,
    nodeName: `step-${sequence}`,
    sequence,
    status: 'running',
    startedAt: new Date(),
    cost: ZERO_COST,
    attempt: 1,
  };
}

function makeOutcome(stepId: string): OutcomeRecord {
  return {
    outcomeId: randomUUID(),
    stepId,
    operationType: 'custom',
    operationKey: randomUUID(),
    result: { ok: true },
    tokens: ZERO_COST,
    durationMs: 1,
    recordedAt: new Date(),
  };
}

function isFenced(error: unknown): boolean {
  return error instanceof DurableError && error.code === 'FENCED';
}

describe('claimRunForRecovery behavior', () => {
  it('claims a running run, flips it to recovering, and advances the generation', async () => {
    const store = new SqliteJournalStore(':memory:');
    try {
      const run = await store.createRun({ name: 'claim-running' });
      await store.updateRun(run.runId, { status: 'running' }, 0);

      const claim = await store.claimRunForRecovery(run.runId);
      expect(claim).not.toBeNull();
      expect(claim!.run.status).toBe('recovering');
      expect(claim!.generation).toBe(1);
      expect(claim!.ownerToken).toBeTruthy();
    } finally {
      store.close();
    }
  });

  it('returns null for a completed run', async () => {
    const store = new SqliteJournalStore(':memory:');
    try {
      const run = await store.createRun({ name: 'claim-completed' });
      await store.updateRun(run.runId, { status: 'completed' }, 0);

      expect(await store.claimRunForRecovery(run.runId)).toBeNull();
    } finally {
      store.close();
    }
  });

  it('re-claims a recovering run whose heartbeat has expired at a higher generation', async () => {
    const store = new SqliteJournalStore(':memory:');
    try {
      const run = await store.createRun({ name: 'claim-recovering' });
      await store.updateRun(run.runId, { status: 'running' }, 0);
      const first = await store.claimRunForRecovery(run.runId);
      backdateHeartbeat(store, run.runId);

      const reclaimed = await store.claimRunForRecovery(run.runId);
      expect(reclaimed).not.toBeNull();
      expect(reclaimed!.run.status).toBe('recovering');
      expect(reclaimed!.generation).toBe(first!.generation + 1);
    } finally {
      store.close();
    }
  });
});

describe('findStaleRuns eligibility', () => {
  it('includes both running and recovering runs with an expired heartbeat', async () => {
    const store = new SqliteJournalStore(':memory:');
    try {
      const runningRun = await store.createRun({ name: 'stale-running' });
      await store.updateRun(runningRun.runId, { status: 'running' }, 0);
      backdateHeartbeat(store, runningRun.runId);

      const recoveringRun = await store.createRun({ name: 'stale-recovering' });
      await store.updateRun(recoveringRun.runId, { status: 'running' }, 0);
      await store.claimRunForRecovery(recoveringRun.runId);
      backdateHeartbeat(store, recoveringRun.runId);

      const stale = await store.findStaleRuns(30_000);
      const ids = stale.map((r) => r.runId);
      expect(ids).toContain(runningRun.runId);
      expect(ids).toContain(recoveringRun.runId);
    } finally {
      store.close();
    }
  });

  it('excludes a recovering run whose heartbeat is fresh', async () => {
    const store = new SqliteJournalStore(':memory:');
    try {
      const run = await store.createRun({ name: 'fresh-recovering' });
      await store.updateRun(run.runId, { status: 'running' }, 0);
      const claim = await store.claimRunForRecovery(run.runId);
      await store.updateHeartbeat(run.runId, claim!.generation);

      const stale = await store.findStaleRuns(30_000);
      expect(stale.some((r) => r.runId === run.runId)).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe('a superseded owner is fenced on every write type (A=gen1, B reclaims gen2)', () => {
  async function setupReclaimed() {
    const store = new SqliteJournalStore(':memory:');
    const run = await store.createRun({ name: 'ab-fencing' });
    await store.updateRun(run.runId, { status: 'running' }, 0);
    backdateHeartbeat(store, run.runId);

    const claimA = await store.claimRunForRecovery(run.runId);
    const genA = claimA!.generation;

    // A seeds a step while it still owns the run, to update/heal later.
    const step = makeStep(run.runId, 0);
    await store.createStep(step, genA);

    // A crashes; B reclaims at a higher generation.
    backdateHeartbeat(store, run.runId);
    const claimB = await store.claimRunForRecovery(run.runId);
    const genB = claimB!.generation;

    return { store, runId: run.runId, genA, genB, stepId: step.stepId };
  }

  it('rejects a fenced heartbeat without applying it', async () => {
    const { store, runId, genA } = await setupReclaimed();
    try {
      expect(await store.updateHeartbeat(runId, genA)).toBe(false);
    } finally {
      store.close();
    }
  });

  it('rejects a fenced terminal write', async () => {
    const { store, runId, genA } = await setupReclaimed();
    try {
      await expect(
        store.updateRun(runId, { status: 'terminated' }, genA),
      ).rejects.toSatisfy(isFenced);
      const persisted = await store.getRun(runId);
      expect(persisted!.status).toBe('recovering');
    } finally {
      store.close();
    }
  });

  it('rejects a fenced outcome record', async () => {
    const { store, genA, stepId } = await setupReclaimed();
    try {
      await expect(
        store.recordOutcome(makeOutcome(stepId), genA),
      ).rejects.toSatisfy(isFenced);
    } finally {
      store.close();
    }
  });

  it('rejects a fenced createStep and updateStep', async () => {
    const { store, runId, genA, stepId } = await setupReclaimed();
    try {
      await expect(
        store.createStep(makeStep(runId, 1), genA),
      ).rejects.toSatisfy(isFenced);
      await expect(
        store.updateStep(stepId, { status: 'completed' }, genA),
      ).rejects.toSatisfy(isFenced);
    } finally {
      store.close();
    }
  });

  it('lets the winner at the current generation write and terminate', async () => {
    const { store, runId, genB, stepId } = await setupReclaimed();
    try {
      expect(await store.updateHeartbeat(runId, genB)).toBe(true);
      await expect(
        store.recordOutcome(makeOutcome(stepId), genB),
      ).resolves.toBeDefined();
      await expect(
        store.updateStep(stepId, { status: 'completed' }, genB),
      ).resolves.toBeDefined();
      await expect(
        store.updateRun(runId, { status: 'terminated' }, genB),
      ).resolves.toBeDefined();

      const persisted = await store.getRun(runId);
      expect(persisted!.status).toBe('terminated');
    } finally {
      store.close();
    }
  });
});

describe('stale-run recovery gate', () => {
  it('does not recover a run when the claim is not granted', async () => {
    const store = new SqliteJournalStore(':memory:');
    try {
      const eventBus = new EventBus();

      const staleRun = await store.createRun({
        name: 'skip-recovery',
        heartbeatIntervalMs: 10_000,
        staleTimeoutMs: 30_000,
        metadata: { input: null },
      });
      await store.updateRun(staleRun.runId, { status: 'running' }, 0);
      backdateHeartbeat(store, staleRun.runId);

      // Another worker already holds the claim → this worker's claim fails.
      const claimSpy = vi
        .spyOn(store, 'claimRunForRecovery')
        .mockResolvedValue(null);

      let fnRan = false;
      const workflowFn: WorkflowFn<null, string> = async (ctx) => {
        fnRan = true;
        await ctx.step('s', () => 'x');
        return 'done';
      };

      new DurableWorkflow<null, string>('skip-recovery', workflowFn, {
        store,
        eventBus,
        autoRecover: true,
        staleTimeoutMs: 10,
        heartbeatIntervalMs: 2,
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(claimSpy).toHaveBeenCalledWith(staleRun.runId);
      expect(fnRan).toBe(false);
      const stillRunning = await store.getRun(staleRun.runId);
      expect(stillRunning!.status).toBe('running');
    } finally {
      store.close();
    }
  });
});

describe('statusBadge renders recovering distinctly', () => {
  it('uses the badge-recovering class rather than the unknown fallback', () => {
    const html = statusBadge('recovering');
    expect(html).toContain('badge-recovering');
    expect(html).not.toContain('badge-unknown');
    expect(html).toContain('>recovering<');
  });
});
