import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { DurableContextImpl } from '../../src/runtime/context.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { withDurability, type AiSdkDurableContext } from '../../src/adapters/ai-sdk.js';
import { computeOperationKey } from '../../src/serialization/operation-key.js';
import type { ExecutionRun } from '../../src/core/types.js';

vi.mock('../../src/adapters/peer-check.js', () => ({
  assertPeerDependency: vi.fn(),
}));

describe('withDurability', () => {
  let store: SqliteJournalStore;
  let eventBus: EventBus;
  let run: ExecutionRun;
  let ctx: DurableContextImpl;
  let durableCtx: AiSdkDurableContext;

  beforeEach(async () => {
    store = new SqliteJournalStore(':memory:');
    eventBus = new EventBus();
    run = await store.createRun({ name: 'test-ai-sdk' });
    run = await store.updateRun(run.runId, { status: 'running' }, 0);

    ctx = new DurableContextImpl({
      run,
      store,
      mode: 'fresh',
      replayCursor: new Map(),
      eventBus,
      signal: new AbortController().signal,
      generation: 0,
    });

    durableCtx = { store, ctx, eventBus };
  });

  afterEach(() => {
    store.close();
  });

  describe('validation', () => {
    it('rejects when ctx is null', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const invalid = { store: null, ctx: null, eventBus: new EventBus() } as any;
      await expect(
        withDurability(invalid, 'test', async () => 'x'),
      ).rejects.toThrow(TypeError);
    });

    it('rejects when durableCtx is null', async () => {
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        withDurability(null as any, 'test', async () => 'x'),
      ).rejects.toThrow();
    });
  });

  describe('successful execution', () => {
    it('records outcome with correct tokens from AI SDK response', async () => {
      const mockResponse = {
        text: 'hello',
        usage: { promptTokens: 150, completionTokens: 30 },
      };

      const result = await withDurability(durableCtx, 'generate', async () => mockResponse);

      expect(result).toEqual(mockResponse);

      const steps = await store.listSteps(run.runId);
      expect(steps.length).toBeGreaterThan(0);

      const outcomes = await store.listOutcomes(steps[0].stepId);
      expect(outcomes[0].tokens.inputTokens).toBe(150);
      expect(outcomes[0].tokens.outputTokens).toBe(30);
    });

    it('marks step as completed', async () => {
      await withDurability(durableCtx, 'complete-step', async () => ({
        text: 'done',
        usage: { promptTokens: 10, completionTokens: 5 },
      }));

      const steps = await store.listSteps(run.runId);
      const step = steps.find((s) => s.nodeName === 'complete-step');
      expect(step?.status).toBe('completed');
    });

    it('records zero tokens and emits nothing when the response lacks usage data', async () => {
      const seen: string[] = [];
      const spy = (event: { type: string }) => seen.push(event.type);
      // Subscribe by raw type name to catch any event, including one that no
      // longer exists in the typed event map.
      (eventBus as unknown as { on(type: string, handler: (e: { type: string }) => void): void }).on(
        'adapter:warning',
        spy,
      );

      await withDurability(durableCtx, 'no-usage', async () => ({ text: 'reply' }));

      expect(seen).toHaveLength(0);

      const steps = await store.listSteps(run.runId);
      const step = steps.find((s) => s.nodeName === 'no-usage')!;
      const outcomes = await store.listOutcomes(step.stepId);
      expect(outcomes[0].tokens.inputTokens).toBe(0);
      expect(outcomes[0].tokens.outputTokens).toBe(0);
      expect(outcomes[0].tokens.costUsd).toBe(0);
    });
  });

  describe('operation-key contract', () => {
    it('treats two calls with the same name in one run as the same operation', async () => {
      const first = { text: 'first', usage: { promptTokens: 10, completionTokens: 5 } };
      const second = { text: 'second', usage: { promptTokens: 99, completionTokens: 99 } };

      const r1 = await withDurability(durableCtx, 'shared-name', async () => first);
      const r2 = await withDurability(durableCtx, 'shared-name', async () => second);

      // The second call replays the first outcome instead of running again.
      expect(r1).toEqual(first);
      expect(r2).toEqual(first);

      const outcome = await store.getOutcomeByKey(
        computeOperationKey(run.runId, 'shared-name'),
      );
      expect(outcome).not.toBeNull();
      expect(outcome!.result).toEqual(first);
    });

    it('treats calls with different names as distinct operations', async () => {
      const a = { text: 'a', usage: { promptTokens: 1, completionTokens: 1 } };
      const b = { text: 'b', usage: { promptTokens: 2, completionTokens: 2 } };

      const ra = await withDurability(durableCtx, 'name-a', async () => a);
      const rb = await withDurability(durableCtx, 'name-b', async () => b);

      expect(ra).toEqual(a);
      expect(rb).toEqual(b);

      const keyA = computeOperationKey(run.runId, 'name-a');
      const keyB = computeOperationKey(run.runId, 'name-b');
      expect(keyA).not.toBe(keyB);

      const outcomeA = await store.getOutcomeByKey(keyA);
      const outcomeB = await store.getOutcomeByKey(keyB);
      expect(outcomeA!.result).toEqual(a);
      expect(outcomeB!.result).toEqual(b);
    });
  });

  describe('recovery', () => {
    it('returns stored result without re-executing', async () => {
      let callCount = 0;
      const mockResponse = {
        text: 'cached',
        usage: { promptTokens: 50, completionTokens: 10 },
      };

      await withDurability(durableCtx, 'generate', async () => {
        callCount++;
        return mockResponse;
      });
      expect(callCount).toBe(1);

      const result2 = await withDurability(durableCtx, 'generate', async () => {
        callCount++;
        return { text: 'new' };
      });

      expect(callCount).toBe(1);
      expect(result2).toEqual(mockResponse);
    });
  });

  describe('error propagation', () => {
    it('propagates errors and marks step as failed', async () => {
      const error = new Error('LLM API failed');

      await expect(
        withDurability(durableCtx, 'failing-call', async () => {
          throw error;
        }),
      ).rejects.toThrow('LLM API failed');

      const steps = await store.listSteps(run.runId);
      const failedStep = steps.find((s) => s.nodeName === 'failing-call');
      expect(failedStep?.status).toBe('failed');
    });
  });
});
