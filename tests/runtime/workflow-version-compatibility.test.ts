import { describe, it, expect, afterEach } from 'vitest';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { RecoveryEngine, assertRecoveryCompatible } from '../../src/runtime/recovery.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { DurableError } from '../../src/errors.js';
import { computeOperationKey } from '../../src/serialization/operation-key.js';
import type { WorkflowFn } from '../../src/runtime/workflow.js';
import type { DurableContextImpl } from '../../src/runtime/context.js';
import type { RunConfig } from '../../src/core/types.js';

function isIncompatible(error: unknown): boolean {
  return error instanceof DurableError && error.code === 'INCOMPATIBLE_RECOVERY';
}

async function seedRunWithOneOutcome(
  store: SqliteJournalStore,
  config: RunConfig,
): Promise<string> {
  const run = await store.createRun(config);
  await store.updateRun(run.runId, { status: 'running' }, 0);

  const stepId = 'seed-step-0';
  await store.createStep(
    {
      stepId,
      runId: run.runId,
      nodeName: 'step-0',
      sequence: 0,
      status: 'completed',
      startedAt: new Date(),
      cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      attempt: 1,
    },
    0,
  );
  await store.recordOutcome(
    {
      outcomeId: 'seed-outcome-0',
      stepId,
      operationType: 'custom',
      operationKey: computeOperationKey(run.runId, 'step-0', 0),
      result: 'cached-0',
      tokens: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      durationMs: 1,
      recordedAt: new Date(),
    },
    0,
  );
  return run.runId;
}

describe('assertRecoveryCompatible matrix', () => {
  it('allows when neither side declares a version', () => {
    expect(() => assertRecoveryCompatible('r', undefined, undefined)).not.toThrow();
  });

  it('allows when both sides declare the same version', () => {
    expect(() => assertRecoveryCompatible('r', 'v2', 'v2')).not.toThrow();
  });

  it('rejects when both sides declare different versions', () => {
    expect(() => assertRecoveryCompatible('r', 'v1', 'v2')).toThrow(DurableError);
    try {
      assertRecoveryCompatible('r', 'v1', 'v2');
    } catch (e) {
      expect(isIncompatible(e)).toBe(true);
    }
  });

  it('rejects a versionless journal against a versioned workflow', () => {
    expect(() => assertRecoveryCompatible('r', undefined, 'v1')).toThrow(DurableError);
    try {
      assertRecoveryCompatible('r', undefined, 'v1');
    } catch (e) {
      expect(isIncompatible(e)).toBe(true);
    }
  });

  it('rejects a versioned journal against a versionless workflow', () => {
    expect(() => assertRecoveryCompatible('r', 'v1', undefined)).toThrow(DurableError);
    try {
      assertRecoveryCompatible('r', 'v1', undefined);
    } catch (e) {
      expect(isIncompatible(e)).toBe(true);
    }
  });
});

describe('recovery honors the workflow version compatibility matrix', () => {
  let store: SqliteJournalStore;

  afterEach(() => {
    store.close();
  });

  it('replays a legacy journal when neither side declares a version', async () => {
    store = new SqliteJournalStore(':memory:');
    const runId = await seedRunWithOneOutcome(store, { name: 'legacy' });

    let fresh = 0;
    const fn: WorkflowFn<null, string> = async (ctx: DurableContextImpl) => {
      const r0 = await ctx.step('step-0', () => {
        fresh++;
        return 'new-0';
      });
      return r0;
    };

    const engine = new RecoveryEngine(store, new EventBus(), 30_000);
    const result = await engine.recover(runId, fn, null, 0, undefined);

    expect(result).toBe('cached-0');
    expect(fresh).toBe(0);
    const run = await store.getRun(runId);
    expect(run!.status).toBe('completed');
  });

  it('replays when the persisted and current versions match', async () => {
    store = new SqliteJournalStore(':memory:');
    const runId = await seedRunWithOneOutcome(store, { name: 'versioned', workflowVersion: 'v2' });

    const fn: WorkflowFn<null, string> = async (ctx: DurableContextImpl) =>
      ctx.step('step-0', () => 'new-0');

    const engine = new RecoveryEngine(store, new EventBus(), 30_000);
    const result = await engine.recover(runId, fn, null, 0, 'v2');

    expect(result).toBe('cached-0');
    const run = await store.getRun(runId);
    expect(run!.status).toBe('completed');
  });

  it('rejects when versions differ and leaves the run re-drivable without replaying', async () => {
    store = new SqliteJournalStore(':memory:');
    const runId = await seedRunWithOneOutcome(store, { name: 'versioned', workflowVersion: 'v1' });
    const statusBefore = (await store.getRun(runId))!.status;

    let fresh = 0;
    const fn: WorkflowFn<null, string> = async (ctx: DurableContextImpl) =>
      ctx.step('step-0', () => {
        fresh++;
        return 'new-0';
      });

    const engine = new RecoveryEngine(store, new EventBus(), 30_000);

    await expect(engine.recover(runId, fn, null, 0, 'v2')).rejects.toSatisfy(isIncompatible);

    // No step ran and no terminal state was written.
    expect(fresh).toBe(0);
    const run = await store.getRun(runId);
    expect(run!.status).toBe(statusBefore);
    expect(run!.status).not.toBe('completed');
    expect(run!.status).not.toBe('failed');
  });

  it('rejects a versionless journal against a versioned workflow', async () => {
    store = new SqliteJournalStore(':memory:');
    const runId = await seedRunWithOneOutcome(store, { name: 'legacy' });

    const fn: WorkflowFn<null, string> = async (ctx: DurableContextImpl) =>
      ctx.step('step-0', () => 'new-0');

    const engine = new RecoveryEngine(store, new EventBus(), 30_000);
    await expect(engine.recover(runId, fn, null, 0, 'v1')).rejects.toSatisfy(isIncompatible);

    const run = await store.getRun(runId);
    expect(run!.status).not.toBe('completed');
  });

  it('rejects a versioned journal against a versionless workflow', async () => {
    store = new SqliteJournalStore(':memory:');
    const runId = await seedRunWithOneOutcome(store, { name: 'versioned', workflowVersion: 'v1' });

    const fn: WorkflowFn<null, string> = async (ctx: DurableContextImpl) =>
      ctx.step('step-0', () => 'new-0');

    const engine = new RecoveryEngine(store, new EventBus(), 30_000);
    await expect(engine.recover(runId, fn, null, 0, undefined)).rejects.toSatisfy(isIncompatible);

    const run = await store.getRun(runId);
    expect(run!.status).not.toBe('completed');
  });

  it('does not consume the replay cursor or heal steps on rejection', async () => {
    store = new SqliteJournalStore(':memory:');
    const runId = await seedRunWithOneOutcome(store, { name: 'versioned', workflowVersion: 'v1' });

    // A spy store that fails loudly if recovery reads steps/outcomes after a
    // rejection should have short-circuited.
    let listStepsCalls = 0;
    const originalListSteps = store.listSteps.bind(store);
    store.listSteps = async (id: string) => {
      listStepsCalls++;
      return originalListSteps(id);
    };

    const fn: WorkflowFn<null, string> = async (ctx: DurableContextImpl) =>
      ctx.step('step-0', () => 'new-0');

    const engine = new RecoveryEngine(store, new EventBus(), 30_000);
    await expect(engine.recover(runId, fn, null, 0, 'v2')).rejects.toSatisfy(isIncompatible);

    // Compatibility is checked before listSteps, so the cursor was never built.
    expect(listStepsCalls).toBe(0);
  });
});
