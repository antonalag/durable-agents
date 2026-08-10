import type { LoopConfig } from '../core/types.js';

export type LoopType = 'same_tool' | 'no_progress' | 'oscillation';
export type LoopAction = 'graceful_stop' | 'emit_only';

export interface StepRecord {
  nodeName: string;
  sequence: number;
  outputHash?: string;
}

export interface LoopDetectionResult {
  detected: boolean;
  loopType?: LoopType;
  repetitions?: number;
  action?: LoopAction;
}

export function detectLoop(
  history: readonly StepRecord[],
  config: LoopConfig | undefined,
): LoopDetectionResult {
  if (config === undefined) return { detected: false };

  const windowSize = config.windowSize ?? 10;
  if (windowSize <= 0) return { detected: false };

  const window = history.slice(-windowSize);
  if (window.length === 0) return { detected: false };

  const action = config.action ?? 'graceful_stop';
  const maxRep = config.maxRepetitions ?? 3;

  // Check 1: Same-tool repetition
  const last = window[window.length - 1].nodeName;
  let count = 0;
  for (let i = window.length - 1; i >= 0; i--) {
    if (window[i].nodeName === last) count++;
    else break;
  }
  if (count > maxRep) {
    return { detected: true, loopType: 'same_tool', repetitions: count, action };
  }

  // Check 2: No progress (identical outputHashes)
  const maxNoProgress = config.maxNoProgressSteps ?? 4;
  if (window.length >= maxNoProgress) {
    const tail = window.slice(-maxNoProgress);
    const firstHash = tail[0].outputHash;
    if (firstHash !== undefined && tail.every((s) => s.outputHash === firstHash)) {
      return { detected: true, loopType: 'no_progress', repetitions: maxNoProgress, action };
    }
  }

  // Check 3: Oscillation (A-B-A-B pattern)
  if (window.length >= 4) {
    const a = window[window.length - 2].nodeName;
    const b = window[window.length - 1].nodeName;
    if (a !== b) {
      let cycles = 0;
      for (let i = window.length - 1; i >= 1; i -= 2) {
        if (window[i].nodeName === b && window[i - 1].nodeName === a) {
          cycles++;
        } else {
          break;
        }
      }
      if (cycles > maxRep) {
        return { detected: true, loopType: 'oscillation', repetitions: cycles, action };
      }
    }
  }

  return { detected: false };
}
