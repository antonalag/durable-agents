import { randomUUID } from 'node:crypto';
import type {
  ExecutionRun,
  OutcomeRecord,
  RunConfig,
  RunStartedEvent,
  RunCompletedEvent,
  RunRecoveredEvent,
  TokenCost,
} from '../core/types.js';
import type { JournalStore } from '../stores/interface.js';
import type { DurableMiddleware } from './types.js';
import { DurableContextImpl, type ContextMode } from '../runtime/context.js';
import { EventBus } from '../runtime/event-bus.js';
import { Heartbeat } from '../runtime/heartbeat.js';
import { assertPeerDependency } from './peer-check.js';
import { computeOperationKey } from '../serialization/operation-key.js';
import { DurableError } from '../errors.js';

export function extractLangGraphTokens(response: unknown): TokenCost {
  const meta = (response as Record<string, unknown>)?.usage_metadata as
    | Record<string, unknown>
    | undefined;

  if (!meta || typeof meta !== 'object') {
    return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }

  return {
    inputTokens: typeof meta.input_tokens === 'number' ? meta.input_tokens : 0,
    outputTokens: typeof meta.output_tokens === 'number' ? meta.output_tokens : 0,
    costUsd: 0,
  };
}

export interface LangGraphDurableOptions {
  store: JournalStore;
  config: RunConfig;
  eventBus?: EventBus;
}

export function createDurableMiddleware(options: LangGraphDurableOptions): DurableMiddleware {
  assertPeerDependency('@langchain/langgraph', '0.2.0', 'langgraph');

  const { store, config, eventBus = new EventBus() } = options;

  if (!store) {
    throw new TypeError('createDurableMiddleware requires a valid JournalStore');
  }

  let run: ExecutionRun;
  let heartbeat: Heartbeat;
  let _ctx: DurableContextImpl;
  let stepSequence = 0;
  let mode: ContextMode = 'fresh';
  let replayCursor = new Map<string, OutcomeRecord>();
  let totalRecovered = 0;
  let originalRunId: string | undefined;

  const beforeAgent: DurableMiddleware['beforeAgent'] = async () => {
    const staleTimeoutMs = config.staleTimeoutMs ?? 30_000;
    const staleRuns = await store.findStaleRuns(staleTimeoutMs);
    const existingStale = staleRuns.find((r) => r.config.name === config.name);

    if (existingStale) {
      originalRunId = existingStale.runId;
      try {
        const steps = await store.listSteps(existingStale.runId);
        for (const step of steps) {
          const outcomes = await store.listOutcomes(step.stepId);
          for (const outcome of outcomes) {
            if (!outcome.operationKey || outcome.result === undefined) {
              throw new Error('Corrupted outcome data: missing operationKey or result');
            }
            replayCursor.set(outcome.operationKey, outcome);
          }
        }
        if (replayCursor.size > 0) {
          mode = 'replay';
          totalRecovered = replayCursor.size;
        }
      } catch {
        // Corrupted outcome data — start fresh
        replayCursor = new Map<string, OutcomeRecord>();
        mode = 'fresh';
        totalRecovered = 0;
      }
      await store.updateRun(existingStale.runId, { status: 'failed' });
    }

    run = await store.createRun(config);
    await store.updateRun(run.runId, { status: 'running' });
    run = { ...run, status: 'running' };

    const heartbeatInterval = config.heartbeatIntervalMs ?? 10_000;
    heartbeat = new Heartbeat(store, run.runId, heartbeatInterval);
    heartbeat.start();

    _ctx = new DurableContextImpl({
      run,
      store,
      mode,
      replayCursor,
      eventBus,
      signal: new AbortController().signal,
    });
    void _ctx;

    eventBus.emit('run:started', {
      type: 'run:started',
      timestamp: new Date(),
      runId: run.runId,
      config,
    } satisfies RunStartedEvent);
  };

  const afterModel: DurableMiddleware['afterModel'] = async ({ step, response }) => {
    const keyRunId = (mode === 'replay' && originalRunId) ? originalRunId : run.runId;
    const operationKey = computeOperationKey(keyRunId, step.nodeName, stepSequence);

    const cachedOutcome = replayCursor.get(operationKey);
    if (cachedOutcome) {
      replayCursor.delete(operationKey);
      stepSequence++;

      if (replayCursor.size === 0 && mode === 'replay') {
        mode = 'fresh';
        eventBus.emit('run:recovered', {
          type: 'run:recovered',
          timestamp: new Date(),
          runId: run.runId,
          recoveredFromStep: stepSequence,
          totalStepsRecovered: totalRecovered,
        } satisfies RunRecoveredEvent);
      }
      return;
    }

    const tokens = extractLangGraphTokens(response);
    const costFn = config.budget?.costFunction;
    if (costFn) {
      const costUsd = costFn({ inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens });
      if (!Number.isFinite(costUsd) || costUsd < 0) {
        throw new DurableError('INVALID_CONFIG', `costFunction returned invalid value: ${costUsd}`);
      }
      tokens.costUsd = costUsd;
    }

    await store.recordOutcome({
      outcomeId: randomUUID(),
      stepId: step.stepId,
      operationType: 'llm_call',
      operationKey,
      result: response,
      tokens,
      durationMs: 0,
      recordedAt: new Date(),
    });

    stepSequence++;
  };

  const afterAgent: DurableMiddleware['afterAgent'] = async ({ result, totals }) => {
    heartbeat.stop();

    const finalTotals = totals ?? run.totals;
    await store.updateRun(run.runId, {
      status: 'completed',
      totals: finalTotals,
    });

    eventBus.emit('run:completed', {
      type: 'run:completed',
      timestamp: new Date(),
      runId: run.runId,
      result,
      totals: finalTotals,
    } satisfies RunCompletedEvent);
  };

  return { beforeAgent, afterModel, afterAgent };
}
