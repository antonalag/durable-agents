import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';
import { DurableContextImpl } from '../../src/runtime/context.js';
import { EventBus } from '../../src/runtime/event-bus.js';

describe('Property 8: Monotonically increasing sequence numbers', () => {
  function createContext(store: SqliteJournalStore, runId: string) {
    return new DurableContextImpl({
      run: {
        runId,
        status: 'running',
        config: { name: 'test-workflow' },
        metadata: {},
        totals: { cost: 0, tokens: 0, steps: 0, recoveryCount: 0 },
        createdAt: new Date(),
        updatedAt: new Date(),
        lastHeartbeat: new Date(),
      },
      store,
      mode: 'fresh',
      replayCursor: new Map(),
      eventBus: new EventBus(),
      signal: new AbortController().signal,
    });
  }

  it('sequential steps produce sequence 0, 1, ..., N-1', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 50 }), async (n) => {
        const store = new SqliteJournalStore(':memory:');
        const run = await store.createRun({ name: 'seq-test' });
        await store.updateRun(run.runId, { status: 'running' });

        const ctx = createContext(store, run.runId);

        for (let i = 0; i < n; i++) {
          await ctx.step(`step-${i}`, () => i);
        }

        const steps = await store.listSteps(run.runId);
        expect(steps).toHaveLength(n);

        for (let i = 0; i < n; i++) {
          expect(steps[i].sequence).toBe(i);
        }

        store.close();
      }),
      { numRuns: 100 },
    );
  });

  it('parallel steps produce contiguous range 0..N-1', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 10 }), async (n) => {
        const store = new SqliteJournalStore(':memory:');
        const run = await store.createRun({ name: 'par-test' });
        await store.updateRun(run.runId, { status: 'running' });

        const ctx = createContext(store, run.runId);

        const parallelSteps = Array.from({ length: n }, (_, i) => ({
          name: `parallel-${i}`,
          fn: () => i,
        }));

        await ctx.parallel(parallelSteps);

        const steps = await store.listSteps(run.runId);
        expect(steps).toHaveLength(n);

        const sequences = steps.map((s) => s.sequence).sort((a, b) => a - b);
        for (let i = 0; i < n; i++) {
          expect(sequences[i]).toBe(i);
        }

        store.close();
      }),
      { numRuns: 100 },
    );
  });

  it('mixed sequential + parallel: sequential [0, K-1], parallel [K, K+M-1]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 10 }),
        async (k, m) => {
          const store = new SqliteJournalStore(':memory:');
          const run = await store.createRun({ name: 'mixed-test' });
          await store.updateRun(run.runId, { status: 'running' });

          const ctx = createContext(store, run.runId);

          for (let i = 0; i < k; i++) {
            await ctx.step(`seq-${i}`, () => i);
          }

          const parallelSteps = Array.from({ length: m }, (_, i) => ({
            name: `par-${i}`,
            fn: () => i + k,
          }));

          await ctx.parallel(parallelSteps);

          const steps = await store.listSteps(run.runId);
          expect(steps).toHaveLength(k + m);

          const sequences = steps.map((s) => s.sequence).sort((a, b) => a - b);

          // Verify full contiguous range [0, K+M-1] with no gaps or overlaps
          for (let i = 0; i < k + m; i++) {
            expect(sequences[i]).toBe(i);
          }

          // Verify sequential steps got [0, K-1]
          const seqSteps = steps.filter((s) => s.nodeName.startsWith('seq-'));
          for (let i = 0; i < k; i++) {
            expect(seqSteps[i].sequence).toBe(i);
          }

          // Verify parallel steps got [K, K+M-1]
          const parSteps = steps
            .filter((s) => s.nodeName.startsWith('par-'))
            .sort((a, b) => a.sequence - b.sequence);
          for (let i = 0; i < m; i++) {
            expect(parSteps[i].sequence).toBe(k + i);
          }

          store.close();
        },
      ),
      { numRuns: 100 },
    );
  });
});
