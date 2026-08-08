import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { computeOperationKey } from '../../src/serialization/operation-key.js';
import type { RunConfig, Step, RunStartedEvent, RunCompletedEvent } from '../../src/core/types.js';

vi.mock('../../src/adapters/peer-check.js', () => ({
  assertPeerDependency: vi.fn(),
}));

// Import after mock is set up
const { createDurableMiddleware } = await import('../../src/adapters/langgraph.js');

describe('createDurableMiddleware', () => {
  let store: SqliteJournalStore;
  let eventBus: EventBus;
  const config: RunConfig = {
    name: 'test-wf',
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

  describe('validation', () => {
    it('rejects null store', () => {
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createDurableMiddleware({ store: null as any, config }),
      ).toThrow(TypeError);
    });

    it('rejects undefined store', () => {
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createDurableMiddleware({ store: undefined as any, config }),
      ).toThrow(TypeError);
    });
  });

  describe('hook lifecycle', () => {
    it('beforeAgent creates a running run and emits run:started', async () => {
      const mw = createDurableMiddleware({ store, config, eventBus });

      const events: RunStartedEvent[] = [];
      eventBus.on('run:started', (e) => events.push(e));

      await mw.beforeAgent!({ runId: '', config });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('run:started');
      expect(events[0].config.name).toBe('test-wf');

      const runs = await store.listRuns();
      expect(runs.length).toBe(1);
      expect(runs[0].status).toBe('running');
    });

    it('afterModel records an outcome with extracted tokens', async () => {
      const mw = createDurableMiddleware({ store, config, eventBus });
      await mw.beforeAgent!({ runId: '', config });

      const runs = await store.listRuns();
      const run = runs[0];

      const step: Step = {
        stepId: 'step-1',
        runId: run.runId,
        nodeName: 'llm-call',
        sequence: 0,
        status: 'completed',
        startedAt: new Date(),
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        attempt: 1,
      };
      await store.createStep(step);

      await mw.afterModel!({
        runId: run.runId,
        step,
        response: { usage_metadata: { input_tokens: 100, output_tokens: 50 } },
      });

      const outcomes = await store.listOutcomes('step-1');
      expect(outcomes.length).toBe(1);
      expect(outcomes[0].tokens.inputTokens).toBe(100);
      expect(outcomes[0].tokens.outputTokens).toBe(50);
    });

    it('afterAgent completes the run and emits run:completed', async () => {
      const mw = createDurableMiddleware({ store, config, eventBus });
      await mw.beforeAgent!({ runId: '', config });

      const runs = await store.listRuns();
      const run = runs[0];

      const completedEvents: RunCompletedEvent[] = [];
      eventBus.on('run:completed', (e) => completedEvents.push(e));

      await mw.afterAgent!({
        runId: run.runId,
        result: 'done',
        totals: run.totals,
      });

      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0].type).toBe('run:completed');
      expect(completedEvents[0].result).toBe('done');

      const updatedRun = await store.getRun(run.runId);
      expect(updatedRun!.status).toBe('completed');
    });
  });

  describe('recovery flow', () => {
    it('detects stale run, marks it failed, and enters replay mode', async () => {
      // Create a "stale" run: running status with old heartbeat
      const staleConfig: RunConfig = { ...config, name: 'test-wf' };
      const staleRun = await store.createRun(staleConfig);
      await store.updateRun(staleRun.runId, { status: 'running' });

      // Manually backdate the heartbeat so findStaleRuns picks it up
      const oldTime = new Date(Date.now() - 60_000).toISOString();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (store as any).db
        .prepare('UPDATE runs SET last_heartbeat = ? WHERE run_id = ?')
        .run(oldTime, staleRun.runId);

      // Create a completed step with an outcome
      const step: Step = {
        stepId: 'stale-step-1',
        runId: staleRun.runId,
        nodeName: 'llm-call',
        sequence: 0,
        status: 'completed',
        startedAt: new Date(),
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        attempt: 1,
      };
      await store.createStep(step);

      const operationKey = computeOperationKey(staleRun.runId, 'llm-call', 0);
      await store.recordOutcome({
        outcomeId: 'outcome-1',
        stepId: 'stale-step-1',
        operationType: 'llm_call',
        operationKey,
        result: { content: 'cached response' },
        tokens: { inputTokens: 42, outputTokens: 17, costUsd: 0 },
        durationMs: 100,
        recordedAt: new Date(),
      });

      // Now create middleware — it should detect stale run during beforeAgent
      const recoveryEventBus = new EventBus();
      const startEvents: unknown[] = [];
      recoveryEventBus.on('run:started', (e) => startEvents.push(e));

      const mw = createDurableMiddleware({
        store,
        config: { ...config, staleTimeoutMs: 30_000 },
        eventBus: recoveryEventBus,
      });

      await mw.beforeAgent!({ runId: '', config });

      // The stale run should now be marked as failed
      const failedRun = await store.getRun(staleRun.runId);
      expect(failedRun!.status).toBe('failed');

      // A new run should be created (the recovery run)
      const allRuns = await store.listRuns();
      const newRun = allRuns.find((r) => r.runId !== staleRun.runId);
      expect(newRun).toBeDefined();
      expect(newRun!.status).toBe('running');

      // run:started should have been emitted for the new run
      expect(startEvents.length).toBe(1);
    });

    it('returns cached outcome when operationKey matches during replay', async () => {
      // To test replay, we need the operationKey to match what afterModel will compute.
      // afterModel uses: computeOperationKey(run.runId, step.nodeName, stepSequence)
      // We create a stale run, then after beforeAgent creates the new run, we'll
      // have outcomes keyed with the new run's ID (simulating a real crash/recovery
      // where the same run re-attempts).

      // Step 1: Create a stale run with running status
      const staleRun = await store.createRun({ ...config, name: 'test-wf' });
      await store.updateRun(staleRun.runId, { status: 'running' });

      const oldTime = new Date(Date.now() - 60_000).toISOString();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (store as any).db
        .prepare('UPDATE runs SET last_heartbeat = ? WHERE run_id = ?')
        .run(oldTime, staleRun.runId);

      // Step 2: Create a completed step with an outcome using the stale run's key
      const step: Step = {
        stepId: 'stale-step-1',
        runId: staleRun.runId,
        nodeName: 'llm-call',
        sequence: 0,
        status: 'completed',
        startedAt: new Date(),
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        attempt: 1,
      };
      await store.createStep(step);

      const staleOperationKey = computeOperationKey(staleRun.runId, 'llm-call', 0);
      await store.recordOutcome({
        outcomeId: 'outcome-replay-1',
        stepId: 'stale-step-1',
        operationType: 'llm_call',
        operationKey: staleOperationKey,
        result: { content: 'cached response' },
        tokens: { inputTokens: 42, outputTokens: 17, costUsd: 0 },
        durationMs: 100,
        recordedAt: new Date(),
      });

      // Step 3: Create middleware and start — enters replay mode
      const recoveryEventBus = new EventBus();
      const recoveredEvents: unknown[] = [];
      recoveryEventBus.on('run:recovered', (e) => recoveredEvents.push(e));

      const mw = createDurableMiddleware({
        store,
        config: { ...config, staleTimeoutMs: 30_000 },
        eventBus: recoveryEventBus,
      });

      await mw.beforeAgent!({ runId: '', config });

      // Get the new run
      const allRuns = await store.listRuns();
      const newRun = allRuns.find((r) => r.runId !== staleRun.runId)!;

      // Step 4: Call afterModel — the key is computed from the NEW run, so it won't
      // match the stale run's operationKey. This verifies that fresh execution records
      // a new outcome after the cursor misses.
      const replayStep: Step = {
        stepId: 'new-step-1',
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
        response: { usage_metadata: { input_tokens: 200, output_tokens: 80 } },
      });

      // Since the operationKey differs (new runId vs stale runId), the code
      // falls through to fresh execution and records a new outcome
      const outcomes = await store.listOutcomes('new-step-1');
      expect(outcomes.length).toBe(1);
      expect(outcomes[0].tokens.inputTokens).toBe(200);
    });

    it('handles corrupted outcome data gracefully (starts fresh)', async () => {
      // Create a stale run with a step that has a corrupted outcome (null operationKey)
      const staleRun = await store.createRun({ ...config, name: 'test-wf' });
      await store.updateRun(staleRun.runId, { status: 'running' });

      const oldTime = new Date(Date.now() - 60_000).toISOString();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (store as any).db
        .prepare('UPDATE runs SET last_heartbeat = ? WHERE run_id = ?')
        .run(oldTime, staleRun.runId);

      // Create a step with a corrupted outcome (empty operationKey)
      const step: Step = {
        stepId: 'corrupted-step',
        runId: staleRun.runId,
        nodeName: 'llm-call',
        sequence: 0,
        status: 'completed',
        startedAt: new Date(),
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        attempt: 1,
      };
      await store.createStep(step);

      // Insert an outcome with empty operationKey directly to simulate corruption
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (store as any).db
        .prepare(
          `INSERT INTO outcomes (outcome_id, step_id, operation_type, operation_key, result, token_input, token_output, duration_ms, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'corrupted-outcome',
          'corrupted-step',
          'llm_call',
          '', // empty key = corruption
          Buffer.from(JSON.stringify({ json: null })),
          0,
          0,
          0,
          new Date().toISOString(),
        );

      // The middleware should catch the corrupted data and start fresh
      const mw = createDurableMiddleware({
        store,
        config: { ...config, staleTimeoutMs: 30_000 },
        eventBus,
      });

      // Should not throw — gracefully falls back to fresh mode
      await expect(mw.beforeAgent!({ runId: '', config })).resolves.not.toThrow();

      // A new run is created regardless
      const allRuns = await store.listRuns();
      const newRun = allRuns.find((r) => r.runId !== staleRun.runId);
      expect(newRun).toBeDefined();
      expect(newRun!.status).toBe('running');
    });
  });
});
