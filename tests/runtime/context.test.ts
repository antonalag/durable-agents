import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { DurableContextImpl } from '../../src/runtime/context.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { computeOperationKey } from '../../src/serialization/operation-key.js';
import type { ExecutionRun, OutcomeRecord } from '../../src/core/types.js';

describe('DurableContextImpl', () => {
  let store: SqliteJournalStore;
  let eventBus: EventBus;
  let run: ExecutionRun;

  beforeEach(async () => {
    store = new SqliteJournalStore(':memory:');
    eventBus = new EventBus();
    run = await store.createRun({ name: 'test-wf' });
    run = await store.updateRun(run.runId, { status: 'running' });
  });

  function makeContext(opts?: {
    mode?: 'fresh' | 'replay';
    replayCursor?: Map<string, OutcomeRecord>;
    signal?: AbortSignal;
  }) {
    return new DurableContextImpl({
      run,
      store,
      mode: opts?.mode ?? 'fresh',
      replayCursor: opts?.replayCursor ?? new Map(),
      eventBus,
      signal: opts?.signal ?? new AbortController().signal,
    });
  }

  it('fresh step records outcome correctly', async () => {
    const ctx = makeContext();

    const result = await ctx.step('compute', () => 42);

    expect(result).toBe(42);

    const steps = await store.listSteps(run.runId);
    expect(steps).toHaveLength(1);
    expect(steps[0].status).toBe('completed');

    const outcomes = await store.listOutcomes(steps[0].stepId);
    expect(outcomes).toHaveLength(1);

    const expectedKey = computeOperationKey(run.runId, 'compute', 0);
    expect(outcomes[0].operationKey).toBe(expectedKey);
    expect(outcomes[0].result).toBe(42);
  });

  it('replay step returns cached result without calling fn', async () => {
    const operationKey = computeOperationKey(run.runId, 'cached-step', 0);

    const cachedOutcome: OutcomeRecord = {
      outcomeId: randomUUID(),
      stepId: randomUUID(),
      operationType: 'custom',
      operationKey,
      result: 'cached-value',
      tokens: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      durationMs: 10,
      recordedAt: new Date(),
    };

    const replayCursor = new Map<string, OutcomeRecord>();
    replayCursor.set(operationKey, cachedOutcome);

    const ctx = makeContext({ mode: 'replay', replayCursor });

    const result = await ctx.step('cached-step', () => {
      throw new Error('should not execute');
    });

    expect(result).toBe('cached-value');

    const steps = await store.listSteps(run.runId);
    expect(steps).toHaveLength(0);
  });

  it('step throws AbortError when signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const ctx = makeContext({ signal: controller.signal });

    await expect(ctx.step('any', () => 'x')).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('failed step propagates error', async () => {
    const ctx = makeContext();

    await expect(
      ctx.step('failing', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const steps = await store.listSteps(run.runId);
    expect(steps).toHaveLength(1);
    expect(steps[0].status).toBe('failed');
  });

  it('parallel with all cached results', async () => {
    const replayCursor = new Map<string, OutcomeRecord>();

    for (let i = 0; i < 3; i++) {
      const key = computeOperationKey(run.runId, `s${i}`, i);
      replayCursor.set(key, {
        outcomeId: randomUUID(),
        stepId: randomUUID(),
        operationType: 'custom',
        operationKey: key,
        result: `cached-${i}`,
        tokens: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        durationMs: 5,
        recordedAt: new Date(),
      });
    }

    const ctx = makeContext({ mode: 'replay', replayCursor });

    const fnThatShouldNotRun = () => {
      throw new Error('should not execute');
    };

    const results = await ctx.parallel([
      { name: 's0', fn: fnThatShouldNotRun },
      { name: 's1', fn: fnThatShouldNotRun },
      { name: 's2', fn: fnThatShouldNotRun },
    ]);

    expect(results).toEqual(['cached-0', 'cached-1', 'cached-2']);

    const steps = await store.listSteps(run.runId);
    expect(steps).toHaveLength(0);
  });

  it('parallel with partial failure', async () => {
    const ctx = makeContext();

    await expect(
      ctx.parallel([
        { name: 'ok', fn: () => 'success' },
        {
          name: 'bad',
          fn: () => {
            throw new Error('fail');
          },
        },
      ]),
    ).rejects.toThrow('fail');

    const steps = await store.listSteps(run.runId);
    const completedSteps = steps.filter((s) => s.status === 'completed');
    expect(completedSteps.length).toBeGreaterThanOrEqual(1);

    const outcomes = await store.listOutcomes(completedSteps[0].stepId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].result).toBe('success');
  });

  it('idempotent with pre-existing outcome', async () => {
    const knownKey = 'idempotent-test-key';

    // Manually record an outcome with the known key via store
    const dummyStepId = randomUUID();
    await store.createStep({
      stepId: dummyStepId,
      runId: run.runId,
      nodeName: 'setup',
      sequence: 0,
      status: 'completed',
      startedAt: new Date(),
      cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      attempt: 1,
    });

    await store.recordOutcome({
      outcomeId: randomUUID(),
      stepId: dummyStepId,
      operationType: 'custom',
      operationKey: knownKey,
      result: 'pre-existing-result',
      tokens: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      durationMs: 1,
      recordedAt: new Date(),
    });

    const ctx = makeContext();

    const result = await ctx.idempotent(knownKey, () => {
      throw new Error('should not run');
    });

    expect(result).toBe('pre-existing-result');
  });
});
