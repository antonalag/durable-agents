import { describe, it, expect } from 'vitest';
import {
  detectLoop,
  type StepRecord,
} from '../../src/runtime/loop-detector.js';
import type { LoopConfig } from '../../src/core/types.js';

function step(nodeName: string, sequence: number, outputHash?: string): StepRecord {
  return { nodeName, sequence, outputHash };
}

describe('detectLoop', () => {
  describe('edge cases', () => {
    it('returns { detected: false } when config is undefined', () => {
      const history = [step('a', 0), step('a', 1), step('a', 2), step('a', 3), step('a', 4)];
      expect(detectLoop(history, undefined)).toEqual({ detected: false });
    });

    it('returns { detected: false } for empty history', () => {
      const config: LoopConfig = {};
      expect(detectLoop([], config)).toEqual({ detected: false });
    });

    it('returns { detected: false } for single step history', () => {
      const config: LoopConfig = {};
      expect(detectLoop([step('a', 0)], config)).toEqual({ detected: false });
    });

    it('returns { detected: false } when windowSize is 0 (disabled)', () => {
      const history = [step('a', 0), step('a', 1), step('a', 2), step('a', 3), step('a', 4)];
      const config: LoopConfig = { windowSize: 0 };
      expect(detectLoop(history, config)).toEqual({ detected: false });
    });
  });

  describe('same_tool detection', () => {
    it('detects 4 consecutive same-name steps (default maxRepetitions=3)', () => {
      const history = [step('tool_a', 0), step('tool_a', 1), step('tool_a', 2), step('tool_a', 3)];
      const config: LoopConfig = {};
      const result = detectLoop(history, config);
      expect(result).toEqual({
        detected: true,
        loopType: 'same_tool',
        repetitions: 4,
        action: 'graceful_stop',
      });
    });

    it('does NOT detect exactly 3 same-name steps (at threshold, must be > maxRep)', () => {
      const history = [step('tool_a', 0), step('tool_a', 1), step('tool_a', 2)];
      const config: LoopConfig = {};
      expect(detectLoop(history, config).detected).toBe(false);
    });

    it('detects 5 same-name steps with mixed prefix in window', () => {
      const history = [
        step('other', 0),
        step('tool_a', 1),
        step('tool_a', 2),
        step('tool_a', 3),
        step('tool_a', 4),
        step('tool_a', 5),
      ];
      const config: LoopConfig = {};
      const result = detectLoop(history, config);
      expect(result).toEqual({
        detected: true,
        loopType: 'same_tool',
        repetitions: 5,
        action: 'graceful_stop',
      });
    });

    it('respects custom maxRepetitions=5: 6 same → detected', () => {
      const history = Array.from({ length: 6 }, (_, i) => step('tool_a', i));
      const config: LoopConfig = { maxRepetitions: 5 };
      const result = detectLoop(history, config);
      expect(result.detected).toBe(true);
      expect(result.loopType).toBe('same_tool');
      expect(result.repetitions).toBe(6);
    });

    it('respects custom maxRepetitions=5: 5 same → not detected', () => {
      const history = Array.from({ length: 5 }, (_, i) => step('tool_a', i));
      const config: LoopConfig = { maxRepetitions: 5 };
      expect(detectLoop(history, config).detected).toBe(false);
    });
  });

  describe('no_progress detection', () => {
    it('detects 4 steps with identical outputHash (default maxNoProgressSteps=4)', () => {
      const history = Array.from({ length: 4 }, (_, i) => step(`step_${i}`, i, 'hash_abc'));
      const config: LoopConfig = {};
      const result = detectLoop(history, config);
      expect(result).toEqual({
        detected: true,
        loopType: 'no_progress',
        repetitions: 4,
        action: 'graceful_stop',
      });
    });

    it('does NOT detect 3 steps with same hash (below threshold of 4)', () => {
      const history = Array.from({ length: 3 }, (_, i) => step(`step_${i}`, i, 'hash_abc'));
      const config: LoopConfig = {};
      expect(detectLoop(history, config).detected).toBe(false);
    });

    it('does NOT detect when one step in the tail has a different hash', () => {
      const history = [
        step('a', 0, 'hash_abc'),
        step('b', 1, 'hash_abc'),
        step('c', 2, 'different'),
        step('d', 3, 'hash_abc'),
      ];
      const config: LoopConfig = {};
      expect(detectLoop(history, config).detected).toBe(false);
    });

    it('does NOT detect when outputHash is undefined (cannot determine progress)', () => {
      const history = Array.from({ length: 5 }, (_, i) => step(`step_${i}`, i, undefined));
      const config: LoopConfig = {};
      expect(detectLoop(history, config).detected).toBe(false);
    });

    it('respects custom maxNoProgressSteps=2: 3 same hash → detected', () => {
      const history = Array.from({ length: 3 }, (_, i) => step(`step_${i}`, i, 'same'));
      const config: LoopConfig = { maxNoProgressSteps: 2 };
      const result = detectLoop(history, config);
      expect(result.detected).toBe(true);
      expect(result.loopType).toBe('no_progress');
    });
  });

  describe('oscillation detection', () => {
    it('detects A-B-A-B-A-B-A-B (4 cycles, default maxRepetitions=3)', () => {
      const history = [
        step('A', 0), step('B', 1),
        step('A', 2), step('B', 3),
        step('A', 4), step('B', 5),
        step('A', 6), step('B', 7),
      ];
      const config: LoopConfig = {};
      const result = detectLoop(history, config);
      expect(result).toEqual({
        detected: true,
        loopType: 'oscillation',
        repetitions: 4,
        action: 'graceful_stop',
      });
    });

    it('does NOT detect A-B-A-B-A-B (3 cycles, at threshold)', () => {
      const history = [
        step('A', 0), step('B', 1),
        step('A', 2), step('B', 3),
        step('A', 4), step('B', 5),
      ];
      const config: LoopConfig = {};
      expect(detectLoop(history, config).detected).toBe(false);
    });

    it('does NOT detect A-B-C-A-B-C (not A-B pattern)', () => {
      const history = [
        step('A', 0), step('B', 1), step('C', 2),
        step('A', 3), step('B', 4), step('C', 5),
      ];
      const config: LoopConfig = {};
      expect(detectLoop(history, config).detected).toBe(false);
    });

    it('does NOT detect oscillation when history is too short (< 4 steps)', () => {
      const history = [step('A', 0), step('B', 1), step('A', 2)];
      const config: LoopConfig = {};
      expect(detectLoop(history, config).detected).toBe(false);
    });
  });

  describe('action field', () => {
    it('returns action: emit_only when configured', () => {
      const history = Array.from({ length: 4 }, (_, i) => step('tool_a', i));
      const config: LoopConfig = { action: 'emit_only' };
      const result = detectLoop(history, config);
      expect(result.detected).toBe(true);
      expect(result.action).toBe('emit_only');
    });

    it('returns action: graceful_stop by default', () => {
      const history = Array.from({ length: 4 }, (_, i) => step('tool_a', i));
      const config: LoopConfig = {};
      const result = detectLoop(history, config);
      expect(result.detected).toBe(true);
      expect(result.action).toBe('graceful_stop');
    });
  });
});
