import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { computeOperationKey } from '../../src/serialization/operation-key.js';
import type { RunConfig, Step } from '../../src/core/types.js';

vi.mock('../../src/adapters/peer-check.js', () => ({
  assertPeerDependency: vi.fn(),
}));

const { createDurableMiddleware } = await import('../../src/adapters/langgraph.js');

/**
 * Proves the LangGraph adapter replay uses the original stale runId for
 * operation key computation during replay, and switches to the new runId
 * for fresh steps after replay exhaustion.
 */
describe('LangGraph adapter replay uses original runId', () => {
  let store: SqliteJournalStore;
  let eventBus: EventBus;
  const config: RunConfig = {
    name: 'replay-test-wf',
    heartbeatIntervalMs: 60_000,
    staleTimeoutMs: 30_000,
  };

  beforeEach(() => {
    store = new SqliteJournalStore(':memory:');
    eventBus = new EventBus();
  });

  afterEach(() => {
    store.close();
  });

  async function makeStaleRun(stepCount: number) {
    const staleRun = await store.createRun({ ...config, name: 'replay-test-wf' });
    await store.updateRun(staleRun.runId, { status: 'running' });

    // Backdate heartbeat so findStaleRuns picks it up
    const oldTime = new Date(Date.now() - 60_000).toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).db
      .prepare('UPDATE runs SET last_heartbeat = ? WHERE run_id = ?')
      .run(oldTime, staleRun.runId);

    // Create completed steps with outcomes keyed by the stale runId
    for (let i = 0; i < stepCount; i++) {
      const step: Step = {
        stepId: `stale-step-${i}`,
        runId: staleRun.runId,
        nodeName: 'llm-call',
        sequence: i,
        status: 'completed',
        startedAt: new Date(),
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        attempt: 1,
      };
      await store.createStep(step);

      const operationKey = computeOperationKey(staleRun.runId, 'llm-call', i);
      await store.recordOutcome({
        outcomeId: `outcome-${i}`,
        stepId: `stale-step-${i}`,
        operationType: 'llm_call',
        operationKey,
        result: { content: `cached-response-${i}` },
        tokens: { inputTokens: 10 * (i + 1), outputTokens: 5 * (i + 1), costUsd: 0 },
        durationMs: 100,
        recordedAt: new Date(),
      });
    }

    return staleRun;
  }

  it('stale run outcomes keyed with old runId are found during replay', async () => {
    const staleRun = await makeStaleRun(2);

    const mw = createDurableMiddleware({ store, config, eventBus });
    await mw.beforeAgent!({ runId: '', config });

    // Get the new recovery run
    const allRuns = await store.listRuns();
    const newRun = allRuns.find((r) => r.runId !== staleRun.runId)!;
    expect(newRun).toBeDefined();
    expect(newRun.runId).not.toBe(staleRun.runId);

    // Replay step 0 — key computed with original stale runId must match
    const replayStep: Step = {
      stepId: 'recovery-step-0',
      runId: newRun.runId,
      nodeName: 'llm-call',
      sequence: 0,
      status: 'completed',
      startedAt: new Date(),
      cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      attempt: 1,
    };
    await store.createStep(replayStep);

    await mw.afterModel!({
      runId: newRun.runId,
      step: replayStep,
      response: { usage_metadata: { input_tokens: 999, output_tokens: 999 } },
    });

    // The outcome should NOT be recorded — it was a replay hit
    const outcomes = await store.listOutcomes('recovery-step-0');
    expect(outcomes.length).toBe(0);

    // Verify the key was computed using the stale (original) runId
    const expectedKey = computeOperationKey(staleRun.runId, 'llm-call', 0);
    const wrongKey = computeOperationKey(newRun.runId, 'llm-call', 0);
    expect(expectedKey).not.toBe(wrongKey);
  });

  it('replayed steps do not re-record outcomes', async () => {
    const staleRun = await makeStaleRun(3);

    const mw = createDurableMiddleware({ store, config, eventBus });
    await mw.beforeAgent!({ runId: '', config });

    const allRuns = await store.listRuns();
    const newRun = allRuns.find((r) => r.runId !== staleRun.runId)!;

    // Replay all 3 steps
    for (let i = 0; i < 3; i++) {
      const step: Step = {
        stepId: `new-step-${i}`,
        runId: newRun.runId,
        nodeName: 'llm-call',
        sequence: i,
        status: 'completed',
        startedAt: new Date(),
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        attempt: 1,
      };
      await store.createStep(step);

      await mw.afterModel!({
        runId: newRun.runId,
        step,
        response: { usage_metadata: { input_tokens: 500, output_tokens: 250 } },
      });

      // No new outcomes should be recorded for replayed steps
      const outcomes = await store.listOutcomes(`new-step-${i}`);
      expect(outcomes.length).toBe(0);
    }

    // Total outcomes in store should remain at 3 (original ones only)
    let totalOutcomes = 0;
    for (let i = 0; i < 3; i++) {
      const outcomes = await store.listOutcomes(`stale-step-${i}`);
      totalOutcomes += outcomes.length;
    }
    expect(totalOutcomes).toBe(3);
  });

  it('fresh steps after replay use new runId for keys', async () => {
    const staleRun = await makeStaleRun(1);

    const recoveredEvents: unknown[] = [];
    eventBus.on('run:recovered', (e) => recoveredEvents.push(e));

    const mw = createDurableMiddleware({ store, config, eventBus });
    await mw.beforeAgent!({ runId: '', config });

    const allRuns = await store.listRuns();
    const newRun = allRuns.find((r) => r.runId !== staleRun.runId)!;

    // Replay step 0 — exhausts the cursor
    const replayStep: Step = {
      stepId: 'replay-step-0',
      runId: newRun.runId,
      nodeName: 'llm-call',
      sequence: 0,
      status: 'completed',
      startedAt: new Date(),
      cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      attempt: 1,
    };
    await store.createStep(replayStep);

    await mw.afterModel!({
      runId: newRun.runId,
      step: replayStep,
      response: { usage_metadata: { input_tokens: 100, output_tokens: 50 } },
    });

    // run:recovered should fire after cursor exhaustion
    expect(recoveredEvents.length).toBe(1);

    // Fresh step 1 — uses the new run's runId for key computation
    const freshStep: Step = {
      stepId: 'fresh-step-1',
      runId: newRun.runId,
      nodeName: 'llm-call',
      sequence: 1,
      status: 'completed',
      startedAt: new Date(),
      cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      attempt: 1,
    };
    await store.createStep(freshStep);

    await mw.afterModel!({
      runId: newRun.runId,
      step: freshStep,
      response: { usage_metadata: { input_tokens: 200, output_tokens: 80 } },
    });

    // Fresh step SHOULD record an outcome
    const freshOutcomes = await store.listOutcomes('fresh-step-1');
    expect(freshOutcomes.length).toBe(1);
    expect(freshOutcomes[0].tokens.inputTokens).toBe(200);
    expect(freshOutcomes[0].tokens.outputTokens).toBe(80);

    // The outcome's operationKey should be computed with the new runId
    const expectedFreshKey = computeOperationKey(newRun.runId, 'llm-call', 1);
    expect(freshOutcomes[0].operationKey).toBe(expectedFreshKey);

    // It should NOT be the stale run's key
    const staleKey = computeOperationKey(staleRun.runId, 'llm-call', 1);
    expect(freshOutcomes[0].operationKey).not.toBe(staleKey);
  });

  it('full lifecycle: persist -> stale -> recover -> replay correct -> fresh correct', async () => {
    // Phase 1: Original run persists outcomes
    const originalRun = await store.createRun({ ...config, name: 'replay-test-wf' });
    await store.updateRun(originalRun.runId, { status: 'running' });

    const steps: Step[] = [];
    for (let i = 0; i < 2; i++) {
      const step: Step = {
        stepId: `orig-step-${i}`,
        runId: originalRun.runId,
        nodeName: 'research',
        sequence: i,
        status: 'completed',
        startedAt: new Date(),
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        attempt: 1,
      };
      await store.createStep(step);
      steps.push(step);

      const key = computeOperationKey(originalRun.runId, 'research', i);
      await store.recordOutcome({
        outcomeId: `orig-outcome-${i}`,
        stepId: `orig-step-${i}`,
        operationType: 'llm_call',
        operationKey: key,
        result: { content: `result-${i}` },
        tokens: { inputTokens: 50, outputTokens: 25, costUsd: 0.001 },
        durationMs: 200,
        recordedAt: new Date(),
      });
    }

    // Phase 2: Simulate crash — backdate heartbeat to make the run stale
    const oldTime = new Date(Date.now() - 60_000).toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).db
      .prepare('UPDATE runs SET last_heartbeat = ? WHERE run_id = ?')
      .run(oldTime, originalRun.runId);

    // Phase 3: Recovery — create middleware and start
    const recoveredEvents: unknown[] = [];
    eventBus.on('run:recovered', (e) => recoveredEvents.push(e));

    const mw = createDurableMiddleware({ store, config, eventBus });
    await mw.beforeAgent!({ runId: '', config });

    // Original run should be marked failed
    const failedRun = await store.getRun(originalRun.runId);
    expect(failedRun!.status).toBe('failed');

    // New recovery run created
    const allRuns = await store.listRuns();
    const recoveryRun = allRuns.find((r) => r.runId !== originalRun.runId)!;
    expect(recoveryRun).toBeDefined();
    expect(recoveryRun.status).toBe('running');

    // Phase 4: Replay — re-execute same steps, outcomes found from original runId
    for (let i = 0; i < 2; i++) {
      const step: Step = {
        stepId: `recovery-step-${i}`,
        runId: recoveryRun.runId,
        nodeName: 'research',
        sequence: i,
        status: 'completed',
        startedAt: new Date(),
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        attempt: 1,
      };
      await store.createStep(step);

      await mw.afterModel!({
        runId: recoveryRun.runId,
        step,
        response: { usage_metadata: { input_tokens: 999, output_tokens: 999 } },
      });

      // No new outcomes for replayed steps
      const outcomes = await store.listOutcomes(`recovery-step-${i}`);
      expect(outcomes.length).toBe(0);
    }

    // run:recovered fires after replay cursor is exhausted
    expect(recoveredEvents.length).toBe(1);

    // Phase 5: Fresh execution — new steps use recoveryRun.runId
    const freshStep: Step = {
      stepId: 'fresh-after-recovery',
      runId: recoveryRun.runId,
      nodeName: 'research',
      sequence: 2,
      status: 'completed',
      startedAt: new Date(),
      cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      attempt: 1,
    };
    await store.createStep(freshStep);

    await mw.afterModel!({
      runId: recoveryRun.runId,
      step: freshStep,
      response: { usage_metadata: { input_tokens: 300, output_tokens: 150 } },
    });

    // Fresh step records a new outcome
    const freshOutcomes = await store.listOutcomes('fresh-after-recovery');
    expect(freshOutcomes.length).toBe(1);
    expect(freshOutcomes[0].tokens.inputTokens).toBe(300);

    // Key uses the recovery run's ID
    const expectedKey = computeOperationKey(recoveryRun.runId, 'research', 2);
    expect(freshOutcomes[0].operationKey).toBe(expectedKey);

    // NOT the original run's ID
    const wrongKey = computeOperationKey(originalRun.runId, 'research', 2);
    expect(freshOutcomes[0].operationKey).not.toBe(wrongKey);
  });
});
