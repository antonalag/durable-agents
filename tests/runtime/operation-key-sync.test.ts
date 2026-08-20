import { describe, it, expect, afterEach } from 'vitest';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { DurableWorkflow } from '../../src/runtime/workflow.js';
import { RecoveryEngine } from '../../src/runtime/recovery.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { computeOperationKey } from '../../src/serialization/operation-key.js';

describe('Property 8: Operation key synchronization', () => {
  let store: SqliteJournalStore;

  afterEach(() => {
    store.close();
  });

  it('first step uses sequence 0', async () => {
    store = new SqliteJournalStore(':memory:');
    const workflow = new DurableWorkflow(
      'key-sync-test',
      async (ctx) => {
        return ctx.step('compute', () => 42);
      },
      { store },
    );

    await workflow.run(undefined);

    const runs = await store.listRuns();
    const run = runs[0];
    const steps = await store.listSteps(run.runId);
    expect(steps.length).toBe(1);

    const outcomes = await store.listOutcomes(steps[0].stepId);
    expect(outcomes.length).toBe(1);

    const expectedKey = computeOperationKey(run.runId, 'compute', 0);
    expect(outcomes[0].operationKey).toBe(expectedKey);
  });

  it('multiple sequential steps use sequences 0, 1, 2', async () => {
    store = new SqliteJournalStore(':memory:');
    const workflow = new DurableWorkflow(
      'key-sync-test',
      async (ctx) => {
        await ctx.step('a', () => 'A');
        await ctx.step('b', () => 'B');
        await ctx.step('c', () => 'C');
        return 'done';
      },
      { store },
    );

    await workflow.run(undefined);

    const runs = await store.listRuns();
    const run = runs[0];
    const steps = await store.listSteps(run.runId);
    expect(steps.length).toBe(3);

    for (let i = 0; i < 3; i++) {
      const outcomes = await store.listOutcomes(steps[i].stepId);
      const expectedKey = computeOperationKey(run.runId, steps[i].nodeName, i);
      expect(outcomes[0].operationKey).toBe(expectedKey);
    }
  });

  it('recovery replays cached outcomes proving key match, then fresh steps use correct sequence', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();

    const run = await store.createRun({ name: 'key-sync-test' });
    await store.updateRun(run.runId, { status: 'running' });

    for (let i = 0; i < 2; i++) {
      const stepId = `step-${i}`;
      await store.createStep({
        stepId,
        runId: run.runId,
        nodeName: `step-${i}`,
        sequence: i,
        status: 'completed',
        startedAt: new Date(),
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        attempt: 1,
      });
      await store.recordOutcome({
        outcomeId: `outcome-${i}`,
        stepId,
        operationType: 'custom',
        operationKey: computeOperationKey(run.runId, `step-${i}`, i),
        result: `cached-${i}`,
        tokens: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        durationMs: 10,
        recordedAt: new Date(),
      });
    }

    let freshCount = 0;
    const engine = new RecoveryEngine(store, eventBus, 30_000);
    await engine.recover(
      run.runId,
      async (ctx) => {
        const r0 = await ctx.step('step-0', () => {
          freshCount++;
          return 'new-0';
        });
        const r1 = await ctx.step('step-1', () => {
          freshCount++;
          return 'new-1';
        });
        await ctx.step('step-2', () => {
          freshCount++;
          return 'fresh-2';
        });
        await ctx.step('step-3', () => {
          freshCount++;
          return 'fresh-3';
        });
        expect(r0).toBe('cached-0');
        expect(r1).toBe('cached-1');
        return 'done';
      },
      undefined,
    );

    expect(freshCount).toBe(2);

    const allSteps = await store.listSteps(run.runId);
    const freshSteps = allSteps.filter((s) => s.sequence >= 2);
    for (const s of freshSteps) {
      const outcomes = await store.listOutcomes(s.stepId);
      if (outcomes.length > 0) {
        const expectedKey = computeOperationKey(run.runId, s.nodeName, s.sequence);
        expect(outcomes[0].operationKey).toBe(expectedKey);
      }
    }
  });

  it('recovery followed by fresh execution uses correct operation keys for all steps', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();

    const run = await store.createRun({ name: 'key-sync-recovery' });
    await store.updateRun(run.runId, { status: 'running' });

    // Pre-persist 2 outcomes (simulating a partial run)
    for (let i = 0; i < 2; i++) {
      const stepId = `pre-step-${i}`;
      await store.createStep({
        stepId,
        runId: run.runId,
        nodeName: `action-${i}`,
        sequence: i,
        status: 'completed',
        startedAt: new Date(),
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        attempt: 1,
      });
      await store.recordOutcome({
        outcomeId: `pre-outcome-${i}`,
        stepId,
        operationType: 'custom',
        operationKey: computeOperationKey(run.runId, `action-${i}`, i),
        result: `pre-${i}`,
        tokens: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        durationMs: 5,
        recordedAt: new Date(),
      });
    }

    const executionLog: string[] = [];
    const engine = new RecoveryEngine(store, eventBus, 30_000);
    await engine.recover(
      run.runId,
      async (ctx) => {
        const r0 = await ctx.step('action-0', () => {
          executionLog.push('action-0');
          return 'fresh-0';
        });
        const r1 = await ctx.step('action-1', () => {
          executionLog.push('action-1');
          return 'fresh-1';
        });
        const r2 = await ctx.step('action-2', () => {
          executionLog.push('action-2');
          return 'fresh-2';
        });
        const r3 = await ctx.step('action-3', () => {
          executionLog.push('action-3');
          return 'fresh-3';
        });

        // Steps 0-1 were replayed
        expect(r0).toBe('pre-0');
        expect(r1).toBe('pre-1');
        // Steps 2-3 executed fresh
        expect(r2).toBe('fresh-2');
        expect(r3).toBe('fresh-3');
        return 'complete';
      },
      undefined,
    );

    // Only fresh steps should have executed
    expect(executionLog).toEqual(['action-2', 'action-3']);

    // Verify fresh step operation keys are correct
    const allSteps = await store.listSteps(run.runId);
    const freshSteps = allSteps.filter((s) => s.sequence >= 2);
    expect(freshSteps.length).toBe(2);

    for (const s of freshSteps) {
      const outcomes = await store.listOutcomes(s.stepId);
      expect(outcomes.length).toBe(1);
      const expectedKey = computeOperationKey(run.runId, s.nodeName, s.sequence);
      expect(outcomes[0].operationKey).toBe(expectedKey);
    }
  });
});
