import { describe, it, expect, afterEach } from 'vitest';
import { DurableWorkflow } from '../../src/runtime/workflow.js';
import { RecoveryEngine } from '../../src/runtime/recovery.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { SqliteJournalStore } from '../../src/stores/sqlite.js';

/**
 * Side-Effect Window Test
 *
 * This test documents EXPECTED v0.1.0 behavior, NOT a bug.
 *
 * There is a known window between fn() returning and recordOutcome() persisting
 * the result. If a crash (or error) occurs in that window, the step's outcome
 * is lost. On recovery, since no outcome was persisted, fn() executes AGAIN.
 *
 * This is a known limitation of the v0.1.0 durability model. For non-idempotent
 * side effects (e.g., sending an email, charging a payment), users should use
 * external idempotency keys to guard against duplicate execution.
 *
 * See: docs/concepts.md "Crash Window" section for full explanation.
 */
describe('Side-effect window: re-execution on recovery', () => {
  let store: SqliteJournalStore;

  afterEach(() => {
    store.close();
  });

  it('fn() is called again on recovery when recordOutcome fails (documenting expected behavior)', async () => {
    store = new SqliteJournalStore(':memory:');
    const eventBus = new EventBus();

    let callCount = 0;
    let shouldThrowOnRecord = true;

    // Monkey-patch recordOutcome to throw on the first call,
    // simulating a crash after fn() returns but before persistence completes.
    const originalRecordOutcome = store.recordOutcome.bind(store);
    store.recordOutcome = async (...args) => {
      if (shouldThrowOnRecord) {
        throw new Error('Simulated crash: persistence failed after fn() returned');
      }
      return originalRecordOutcome(...args);
    };

    const workflow = new DurableWorkflow(
      'crash-window-test',
      async (ctx) => {
        const result = await ctx.step('side-effect-step', () => {
          callCount++;
          return `executed-${callCount}`;
        });
        return result;
      },
      { store, eventBus, heartbeatIntervalMs: 5_000, staleTimeoutMs: 30_000 },
    );

    // First run: fn() executes but recordOutcome throws, so the run fails.
    // The step result is NOT persisted — this IS the crash window.
    await expect(workflow.run('input')).rejects.toThrow('Simulated crash');
    expect(callCount).toBe(1);

    // Verify the run is marked as 'failed' in the store
    const runs = await store.listRuns({ status: 'failed' });
    expect(runs).toHaveLength(1);
    const failedRunId = runs[0].runId;

    // Fix the monkey-patch so subsequent calls succeed
    shouldThrowOnRecord = false;
    store.recordOutcome = originalRecordOutcome;

    // Recovery: since no outcome was persisted for this step, fn() executes AGAIN.
    // This is the EXPECTED behavior — the crash window means the step must re-run.
    const recoveryEngine = new RecoveryEngine(store, eventBus, 30_000);
    const result = await recoveryEngine.recover(
      failedRunId,
      async (ctx) => {
        const r = await ctx.step('side-effect-step', () => {
          callCount++;
          return `executed-${callCount}`;
        });
        return r;
      },
      'input',
    );

    // fn() was called TWICE total — once in the original run, once in recovery.
    // This proves re-execution happens when the outcome was not persisted.
    expect(callCount).toBe(2);
    expect(result).toBe('executed-2');
  });
});
