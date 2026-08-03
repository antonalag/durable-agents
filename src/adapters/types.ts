import type { ExecutionRun, RunConfig, Step, DurableEvent } from '../core/types.js';
import type { JournalStore } from '../stores/interface.js';

/**
 * Context passed to the workflow function during execution.
 * Provides step/parallel primitives for recording durable outcomes.
 */
export interface DurableContext {
  step<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
  parallel<T>(steps: Array<{ name: string; fn: () => T | Promise<T> }>): Promise<T[]>;
  /** Skips fn if operationKey already has a recorded outcome. */
  idempotent<T>(operationKey: string, fn: () => T | Promise<T>): Promise<T>;
  run: ExecutionRun;
  signal: AbortSignal;
}

export interface AdapterConfig {
  store: JournalStore;
  runConfig: RunConfig;
}

export type BeforeAgentHook = (ctx: { runId: string; config: RunConfig }) => void | Promise<void>;

export type AfterModelHook = (ctx: {
  runId: string;
  step: Step;
  response: unknown;
}) => void | Promise<void>;

export type AfterAgentHook = (ctx: {
  runId: string;
  result: unknown;
  totals: ExecutionRun['totals'];
}) => void | Promise<void>;

/**
 * Middleware shape for framework integration (matches LangGraph.js pattern).
 * Adapters produce this — frameworks consume it.
 */
export interface DurableMiddleware {
  beforeAgent?: BeforeAgentHook;
  afterModel?: AfterModelHook;
  afterAgent?: AfterAgentHook;
}

export interface FrameworkAdapter {
  name: string;
  createMiddleware(config: AdapterConfig): DurableMiddleware;
}

export interface AgentExecutor<TInput = unknown, TOutput = unknown> {
  run(input: TInput, options?: { signal?: AbortSignal }): Promise<TOutput>;
  /** Resume a stale run from its last journaled checkpoint. */
  recover(runId: string): Promise<TOutput>;
}

export type EventListener<E extends DurableEvent = DurableEvent> = (event: E) => void;
