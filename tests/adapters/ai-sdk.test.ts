import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { DurableContextImpl } from '../../src/runtime/context.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { withDurability, type AiSdkDurableContext } from '../../src/adapters/ai-sdk.js';
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
    run = await store.updateRun(run.runId, { status: 'running' });

    ctx = new DurableContextImpl({
      run,
      store,
      mode: 'fresh',
      replayCursor: new Map(),
      eventBus,
      signal: new AbortController().signal,
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
