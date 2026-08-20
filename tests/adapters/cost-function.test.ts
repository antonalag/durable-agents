import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { DurableContextImpl } from '../../src/runtime/context.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { DurableError } from '../../src/errors.js';
import type { ExecutionRun, RunConfig, Step } from '../../src/core/types.js';

vi.mock('../../src/adapters/peer-check.js', () => ({
  assertPeerDependency: vi.fn(),
}));

const { createDurableMiddleware } = await import('../../src/adapters/langgraph.js');
const { withDurability } = await import('../../src/adapters/ai-sdk.js');
import type { AiSdkDurableContext } from '../../src/adapters/ai-sdk.js';

describe('costFunction in adapters', () => {
  let store: SqliteJournalStore;
  let eventBus: EventBus;

  beforeEach(() => {
    store = new SqliteJournalStore(':memory:');
    eventBus = new EventBus();
  });

  afterEach(() => {
    store.close();
  });

  describe('LangGraph adapter', () => {
    it('computes correct costUsd via costFunction', async () => {
      const costFunction = vi.fn(
        (t: { inputTokens: number; outputTokens: number }) =>
          t.inputTokens * 0.001 + t.outputTokens * 0.002,
      );
      const config: RunConfig = {
        name: 'cost-test',
        heartbeatIntervalMs: 60_000,
        staleTimeoutMs: 30_000,
        budget: { costFunction },
      };

      const mw = createDurableMiddleware({ store, config, eventBus });
      await mw.beforeAgent!({ runId: '', config });

      const runs = await store.listRuns();
      const run = runs[0];

      const step: Step = {
        stepId: 'step-cost-1',
        runId: run.runId,
        nodeName: 'llm-call',
        sequence: 0,
        status: 'completed',
        startedAt: new Date(),
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        attempt: 1,
      };
      await store.createStep(step);

      // Spy on recordOutcome to capture the tokens passed in
      const recordSpy = vi.spyOn(store, 'recordOutcome');

      await mw.afterModel!({
        runId: run.runId,
        step,
        response: { usage_metadata: { input_tokens: 100, output_tokens: 50 } },
      });

      // Verify costFunction was called with the extracted tokens
      expect(costFunction).toHaveBeenCalledWith({ inputTokens: 100, outputTokens: 50 });

      // Verify the tokens passed to recordOutcome include the computed costUsd
      expect(recordSpy).toHaveBeenCalledOnce();
      const recordedOutcome = recordSpy.mock.calls[0][0];
      expect(recordedOutcome.tokens.costUsd).toBeCloseTo(0.2); // 100*0.001 + 50*0.002
    });

    it('costFunction that throws → step fails, no outcome persisted', async () => {
      const config: RunConfig = {
        name: 'cost-throw-test',
        heartbeatIntervalMs: 60_000,
        staleTimeoutMs: 30_000,
        budget: {
          costFunction: () => {
            throw new Error('pricing API unavailable');
          },
        },
      };

      const mw = createDurableMiddleware({ store, config, eventBus });
      await mw.beforeAgent!({ runId: '', config });

      const runs = await store.listRuns();
      const run = runs[0];

      const step: Step = {
        stepId: 'step-throw-1',
        runId: run.runId,
        nodeName: 'llm-call',
        sequence: 0,
        status: 'completed',
        startedAt: new Date(),
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        attempt: 1,
      };
      await store.createStep(step);

      await expect(
        mw.afterModel!({
          runId: run.runId,
          step,
          response: { usage_metadata: { input_tokens: 10, output_tokens: 5 } },
        }),
      ).rejects.toThrow('pricing API unavailable');

      const outcomes = await store.listOutcomes('step-throw-1');
      expect(outcomes).toHaveLength(0);
    });

    it('costFunction returns NaN → DurableError thrown', async () => {
      const config: RunConfig = {
        name: 'cost-nan-test',
        heartbeatIntervalMs: 60_000,
        staleTimeoutMs: 30_000,
        budget: {
          costFunction: () => NaN,
        },
      };

      const mw = createDurableMiddleware({ store, config, eventBus });
      await mw.beforeAgent!({ runId: '', config });

      const runs = await store.listRuns();
      const run = runs[0];

      const step: Step = {
        stepId: 'step-nan-1',
        runId: run.runId,
        nodeName: 'llm-call',
        sequence: 0,
        status: 'completed',
        startedAt: new Date(),
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        attempt: 1,
      };
      await store.createStep(step);

      await expect(
        mw.afterModel!({
          runId: run.runId,
          step,
          response: { usage_metadata: { input_tokens: 10, output_tokens: 5 } },
        }),
      ).rejects.toThrow(DurableError);
    });

    it('costFunction returns Infinity → DurableError thrown', async () => {
      const config: RunConfig = {
        name: 'cost-inf-test',
        heartbeatIntervalMs: 60_000,
        staleTimeoutMs: 30_000,
        budget: {
          costFunction: () => Infinity,
        },
      };

      const mw = createDurableMiddleware({ store, config, eventBus });
      await mw.beforeAgent!({ runId: '', config });

      const runs = await store.listRuns();
      const run = runs[0];

      const step: Step = {
        stepId: 'step-inf-1',
        runId: run.runId,
        nodeName: 'llm-call',
        sequence: 0,
        status: 'completed',
        startedAt: new Date(),
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        attempt: 1,
      };
      await store.createStep(step);

      await expect(
        mw.afterModel!({
          runId: run.runId,
          step,
          response: { usage_metadata: { input_tokens: 10, output_tokens: 5 } },
        }),
      ).rejects.toThrow(DurableError);
    });

    it('costFunction returns negative → DurableError thrown', async () => {
      const config: RunConfig = {
        name: 'cost-neg-test',
        heartbeatIntervalMs: 60_000,
        staleTimeoutMs: 30_000,
        budget: {
          costFunction: () => -1,
        },
      };

      const mw = createDurableMiddleware({ store, config, eventBus });
      await mw.beforeAgent!({ runId: '', config });

      const runs = await store.listRuns();
      const run = runs[0];

      const step: Step = {
        stepId: 'step-neg-1',
        runId: run.runId,
        nodeName: 'llm-call',
        sequence: 0,
        status: 'completed',
        startedAt: new Date(),
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        attempt: 1,
      };
      await store.createStep(step);

      await expect(
        mw.afterModel!({
          runId: run.runId,
          step,
          response: { usage_metadata: { input_tokens: 10, output_tokens: 5 } },
        }),
      ).rejects.toThrow(DurableError);
    });

    it('no costFunction configured → costUsd remains 0', async () => {
      const config: RunConfig = {
        name: 'no-cost-fn-test',
        heartbeatIntervalMs: 60_000,
        staleTimeoutMs: 30_000,
      };

      const mw = createDurableMiddleware({ store, config, eventBus });
      await mw.beforeAgent!({ runId: '', config });

      const runs = await store.listRuns();
      const run = runs[0];

      const step: Step = {
        stepId: 'step-no-cost-1',
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

      const outcomes = await store.listOutcomes('step-no-cost-1');
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].tokens.costUsd).toBe(0);
    });
  });

  describe('AI SDK adapter', () => {
    let run: ExecutionRun;
    let ctx: DurableContextImpl;
    const costFn = (t: { inputTokens: number; outputTokens: number }) =>
      t.inputTokens * 0.003 + t.outputTokens * 0.006;

    beforeEach(async () => {
      run = await store.createRun({
        name: 'ai-sdk-cost-test',
        budget: { costFunction: costFn },
      });
      await store.updateRun(run.runId, { status: 'running' });

      // The run returned by createRun still has costFunction in-memory,
      // but updateRun re-reads from DB (losing the function). Use the original
      // config with the costFunction patched back in.
      run = { ...run, status: 'running' as const };

      ctx = new DurableContextImpl({
        run,
        store,
        mode: 'fresh',
        replayCursor: new Map(),
        eventBus,
        signal: new AbortController().signal,
      });
    });

    it('computes correct costUsd via costFunction', async () => {
      const durableCtx: AiSdkDurableContext = { store, ctx, eventBus };
      const mockResponse = {
        text: 'hello',
        usage: { promptTokens: 200, completionTokens: 80 },
      };

      // Spy on recordOutcome to capture the tokens passed in
      const recordSpy = vi.spyOn(store, 'recordOutcome');

      await withDurability(durableCtx, 'generate', async () => mockResponse);

      // Verify the tokens passed to recordOutcome include the computed costUsd
      expect(recordSpy).toHaveBeenCalledOnce();
      const recordedOutcome = recordSpy.mock.calls[0][0];
      expect(recordedOutcome.tokens.costUsd).toBeCloseTo(1.08); // 200*0.003 + 80*0.006

      // Also verify the step's cost field is updated with correct costUsd
      const steps = await store.listSteps(run.runId);
      const step = steps.find((s) => s.nodeName === 'generate');
      expect(step?.cost.costUsd).toBeCloseTo(1.08);
    });

    it('costFunction that throws → step fails, no outcome persisted', async () => {
      const throwRun = await store.createRun({
        name: 'ai-sdk-throw-test',
        budget: {
          costFunction: () => {
            throw new Error('pricing broke');
          },
        },
      });
      await store.updateRun(throwRun.runId, { status: 'running' });

      const throwCtx = new DurableContextImpl({
        run: { ...throwRun, status: 'running' as const },
        store,
        mode: 'fresh',
        replayCursor: new Map(),
        eventBus,
        signal: new AbortController().signal,
      });

      const durableCtx: AiSdkDurableContext = { store, ctx: throwCtx, eventBus };

      await expect(
        withDurability(durableCtx, 'gen-throw', async () => ({
          text: 'hi',
          usage: { promptTokens: 10, completionTokens: 5 },
        })),
      ).rejects.toThrow('pricing broke');

      const steps = await store.listSteps(throwRun.runId);
      const step = steps.find((s) => s.nodeName === 'gen-throw');
      expect(step?.status).toBe('failed');

      const outcomes = await store.listOutcomes(step!.stepId);
      expect(outcomes).toHaveLength(0);
    });

    it('costFunction returns NaN → DurableError thrown', async () => {
      const nanRun = await store.createRun({
        name: 'ai-sdk-nan-test',
        budget: { costFunction: () => NaN },
      });
      await store.updateRun(nanRun.runId, { status: 'running' });

      const nanCtx = new DurableContextImpl({
        run: { ...nanRun, status: 'running' as const },
        store,
        mode: 'fresh',
        replayCursor: new Map(),
        eventBus,
        signal: new AbortController().signal,
      });

      const durableCtx: AiSdkDurableContext = { store, ctx: nanCtx, eventBus };

      await expect(
        withDurability(durableCtx, 'gen-nan', async () => ({
          usage: { promptTokens: 10, completionTokens: 5 },
        })),
      ).rejects.toThrow(DurableError);
    });

    it('costFunction returns Infinity → DurableError thrown', async () => {
      const infRun = await store.createRun({
        name: 'ai-sdk-inf-test',
        budget: { costFunction: () => Infinity },
      });
      await store.updateRun(infRun.runId, { status: 'running' });

      const infCtx = new DurableContextImpl({
        run: { ...infRun, status: 'running' as const },
        store,
        mode: 'fresh',
        replayCursor: new Map(),
        eventBus,
        signal: new AbortController().signal,
      });

      const durableCtx: AiSdkDurableContext = { store, ctx: infCtx, eventBus };

      await expect(
        withDurability(durableCtx, 'gen-inf', async () => ({
          usage: { promptTokens: 10, completionTokens: 5 },
        })),
      ).rejects.toThrow(DurableError);
    });

    it('costFunction returns negative → DurableError thrown', async () => {
      const negRun = await store.createRun({
        name: 'ai-sdk-neg-test',
        budget: { costFunction: () => -1 },
      });
      await store.updateRun(negRun.runId, { status: 'running' });

      const negCtx = new DurableContextImpl({
        run: { ...negRun, status: 'running' as const },
        store,
        mode: 'fresh',
        replayCursor: new Map(),
        eventBus,
        signal: new AbortController().signal,
      });

      const durableCtx: AiSdkDurableContext = { store, ctx: negCtx, eventBus };

      await expect(
        withDurability(durableCtx, 'gen-neg', async () => ({
          usage: { promptTokens: 10, completionTokens: 5 },
        })),
      ).rejects.toThrow(DurableError);
    });

    it('no costFunction configured → costUsd remains 0', async () => {
      const noCostRun = await store.createRun({ name: 'ai-sdk-no-cost' });
      await store.updateRun(noCostRun.runId, { status: 'running' });

      const noCostCtx = new DurableContextImpl({
        run: { ...noCostRun, status: 'running' as const },
        store,
        mode: 'fresh',
        replayCursor: new Map(),
        eventBus,
        signal: new AbortController().signal,
      });

      const durableCtx: AiSdkDurableContext = { store, ctx: noCostCtx, eventBus };

      await withDurability(durableCtx, 'gen-no-cost', async () => ({
        text: 'result',
        usage: { promptTokens: 100, completionTokens: 50 },
      }));

      const steps = await store.listSteps(noCostRun.runId);
      const step = steps.find((s) => s.nodeName === 'gen-no-cost');
      expect(step).toBeDefined();

      const outcomes = await store.listOutcomes(step!.stepId);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].tokens.costUsd).toBe(0);
    });
  });
});
