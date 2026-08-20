import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { extractLangGraphTokens } from '../../src/adapters/langgraph.js';
import { extractAiSdkTokens } from '../../src/adapters/ai-sdk.js';

describe('Property 2: Token extraction round-trip', () => {
  it('extractLangGraphTokens extracts exact values from valid response', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 1_000_000 }),
        fc.nat({ max: 1_000_000 }),
        (inputTokens, outputTokens) => {
          const response = {
            usage_metadata: { input_tokens: inputTokens, output_tokens: outputTokens },
          };
          const result = extractLangGraphTokens(response);
          expect(result.inputTokens).toBe(inputTokens);
          expect(result.outputTokens).toBe(outputTokens);
          expect(result.costUsd).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('extractAiSdkTokens extracts exact values from valid response', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 1_000_000 }),
        fc.nat({ max: 1_000_000 }),
        (promptTokens, completionTokens) => {
          const response = {
            usage: { promptTokens, completionTokens },
          };
          const result = extractAiSdkTokens(response);
          expect(result.inputTokens).toBe(promptTokens);
          expect(result.outputTokens).toBe(completionTokens);
          expect(result.costUsd).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});
