import { describe, it, expect, vi, afterEach } from 'vitest';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { DurableContextImpl } from '../../src/runtime/context.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { idempotent } from '../../src/adapters/idempotent.js';
import type { RunConfig, Step, RunRecoveredEvent } from '../../src/core/types.js';

vi.mock('../../src/adapters/peer-check.js', () => ({
  assertPeerDependency: vi.fn(),
}));

const { createDurableMiddleware } = await import('../../src/adapters/langgraph.js');
const { withDurability } = await import('../../src/adapters/ai-sdk.js');

describe('Cross-adapter integration', () => {
  let store: SqliteJournalStore;

  afterEach(() => {
    store?.close();
  });

  it('LangGraph middleware replays cached outcomes without duplicate recording', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();
    const config: RunConfig = {
      name: 'crash-test',
      heartbeatIntervalMs: 60_000,
      staleTimeoutMs: 30_000,
    };

    // First run: simulate agent completing 2 model calls then "crashing"
    const mw1 = createDurableMiddleware({ store, config, eventBus });
    await mw1.beforeAgent!({ runId: '', config });

    const runs1 = await store.listRuns();
    const run1 = runs1[0];

    // Record two steps via afterModel
    for (let i = 0; i < 2; i++) {
      const step: Step = {
        stepId: `step-${i}`,
        runId: run1.runId,
        nodeName: `call-${i}`,
        sequence: i,
        status: 'completed',
        startedAt: new Date(),
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        attempt: 1,
      };
      await store.createStep(step);
      await mw1.afterModel!({
        runId: run1.runId,
        step,
        response: { usage_metadata: { input_tokens: 100, output_tokens: 50 } },
      });
    }

    // "Crash" — don't call afterAgent. Backdate heartbeat to make it stale.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).db
      .prepare('UPDATE runs SET last_heartbeat = ? WHERE run_id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), run1.runId);

    // Second run: new middleware detects stale run and enters replay mode
    const recoveredEvents: RunRecoveredEvent[] = [];
    const eventBus2 = new EventBus();
    eventBus2.on('run:recovered', (e) => recoveredEvents.push(e));

    const mw2 = createDurableMiddleware({ store, config, eventBus: eventBus2 });
    await mw2.beforeAgent!({ runId: '', config });

    const allRuns = await store.listRuns();
    const run2 = allRuns.find((r) => r.runId !== run1.runId)!;

    // During replay, afterModel computes keys using the original (stale) runId,
    // so the cached outcomes match and no new outcomes are recorded.
    for (let i = 0; i < 2; i++) {
      const step: Step = {
        stepId: `new-step-${i}`,
        runId: run2.runId,
        nodeName: `call-${i}`,
        sequence: i,
        status: 'completed',
        startedAt: new Date(),
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        attempt: 1,
      };
      await store.createStep(step);
      await mw2.afterModel!({
        runId: run2.runId,
        step,
        response: { usage_metadata: { input_tokens: 200, output_tokens: 100 } },
      });
    }

    // The original run is marked failed (crash detected)
    const failedRun = await store.getRun(run1.runId);
    expect(failedRun!.status).toBe('failed');

    // Replayed steps do NOT record new outcomes (they were served from cache)
    const outcomesStep0 = await store.listOutcomes('new-step-0');
    expect(outcomesStep0.length).toBe(0);

    const outcomesStep1 = await store.listOutcomes('new-step-1');
    expect(outcomesStep1.length).toBe(0);

    // run:recovered fires after replay cursor is exhausted
    expect(recoveredEvents.length).toBe(1);
    expect(recoveredEvents[0].totalStepsRecovered).toBe(2);

    // A fresh step after replay DOES record a new outcome with the new run's key
    const freshStep: Step = {
      stepId: 'fresh-step-0',
      runId: run2.runId,
      nodeName: 'call-2',
      sequence: 2,
      status: 'completed',
      startedAt: new Date(),
      cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      attempt: 1,
    };
    await store.createStep(freshStep);
    await mw2.afterModel!({
      runId: run2.runId,
      step: freshStep,
      response: { usage_metadata: { input_tokens: 300, output_tokens: 150 } },
    });

    const freshOutcomes = await store.listOutcomes('fresh-step-0');
    expect(freshOutcomes.length).toBe(1);
    expect(freshOutcomes[0].tokens.inputTokens).toBe(300);

    // Complete the second run cleanly
    await mw2.afterAgent!({ runId: run2.runId, result: 'done', totals: run2.totals });
    const finalRun = await store.getRun(run2.runId);
    expect(finalRun!.status).toBe('completed');
  });

  it('AI SDK withDurability returns stored result on recovery without executing fn', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();
    const run = await store.createRun({ name: 'ai-sdk-recovery' });
    await store.updateRun(run.runId, { status: 'running' });

    const ctx = new DurableContextImpl({
      run,
      store,
      mode: 'fresh',
      replayCursor: new Map(),
      eventBus,
      signal: new AbortController().signal,
    });

    // First call: records outcome
    let callCount = 0;
    const response1 = { text: 'hello world', usage: { promptTokens: 100, completionTokens: 25 } };
    const result1 = await withDurability({ store, ctx, eventBus }, 'generate', async () => {
      callCount++;
      return response1;
    });
    expect(result1).toEqual(response1);
    expect(callCount).toBe(1);

    // Second call with same name: returns cached without executing
    const result2 = await withDurability({ store, ctx, eventBus }, 'generate', async () => {
      callCount++;
      return { text: 'new' };
    });
    expect(result2).toEqual(response1);
    expect(callCount).toBe(1);
  });

  it('idempotent decorator produces identical results regardless of adapter context', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();

    // Context 1: simulate AI SDK context
    const run1 = await store.createRun({ name: 'ctx-1' });
    await store.updateRun(run1.runId, { status: 'running' });
    const ctx1 = new DurableContextImpl({
      run: run1,
      store,
      mode: 'fresh',
      replayCursor: new Map(),
      eventBus,
      signal: new AbortController().signal,
    });

    // Context 2: simulate LangGraph context (different run, same store)
    const run2 = await store.createRun({ name: 'ctx-2' });
    await store.updateRun(run2.runId, { status: 'running' });
    const ctx2 = new DurableContextImpl({
      run: run2,
      store,
      mode: 'fresh',
      replayCursor: new Map(),
      eventBus,
      signal: new AbortController().signal,
    });

    // Same tool call in both contexts
    let calls1 = 0;
    let calls2 = 0;
    const result1 = await idempotent(
      ctx1,
      'send-webhook',
      { url: 'https://example.com', payload: 'data' },
      async () => {
        calls1++;
        return 'sent-1';
      },
    );
    const result2 = await idempotent(
      ctx2,
      'send-webhook',
      { url: 'https://example.com', payload: 'data' },
      async () => {
        calls2++;
        return 'sent-2';
      },
    );

    // Both execute (different runs = different operation keys)
    expect(result1).toBe('sent-1');
    expect(result2).toBe('sent-2');
    expect(calls1).toBe(1);
    expect(calls2).toBe(1);

    // Calling again with same context returns cached
    let repeat1 = 0;
    let repeat2 = 0;
    const r1 = await idempotent(
      ctx1,
      'send-webhook',
      { url: 'https://example.com', payload: 'data' },
      async () => {
        repeat1++;
        return 'new';
      },
    );
    const r2 = await idempotent(
      ctx2,
      'send-webhook',
      { url: 'https://example.com', payload: 'data' },
      async () => {
        repeat2++;
        return 'new';
      },
    );

    expect(r1).toBe('sent-1');
    expect(r2).toBe('sent-2');
    expect(repeat1).toBe(0);
    expect(repeat2).toBe(0);
  });
});
