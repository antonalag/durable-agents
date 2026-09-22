export type RunPhase = 'running' | 'stopping' | 'terminated';

export type TerminationReason = 'budget_exceeded' | 'loop_detected' | 'kill_switch';

export interface RunLifecycleState {
  phase: RunPhase;
  terminationReason?: TerminationReason;
  summaryStepAllowed: boolean;
}

export const SUMMARY_STEP_TIMEOUT_MS = 30_000;

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Summary step timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
