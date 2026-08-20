import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { extractLangGraphTokens } from '../../src/adapters/langgraph.js';
import { extractAiSdkTokens } from '../../src/adapters/ai-sdk.js';

/**
 * Property 3: Missing token metadata defaults to zero
 */

const zeros = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

const invalidLangGraphResponse = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.constant({}),
  fc.constant({ usage_metadata: null }),
  fc.constant({ usage_metadata: undefined }),
  fc.constant({ usage_metadata: 'not-an-object' }),
  fc.constant({ usage_metadata: 42 }),
  fc.constant({ usage_metadata: [] }),
  fc.record({ content: fc.string() }),
  fc.record({
    usage_metadata: fc.record({
      input_tokens: fc.oneof(
        fc.constant(null),
        fc.constant('abc'),
        fc.constant(undefined),
        fc.boolean(),
      ),
      output_tokens: fc.oneof(
        fc.constant(null),
        fc.constant('xyz'),
        fc.constant(undefined),
        fc.boolean(),
      ),
    }),
  }),
);

const invalidAiSdkResponse = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.constant({}),
  fc.constant({ usage: null }),
  fc.constant({ usage: undefined }),
  fc.constant({ usage: 'not-an-object' }),
  fc.constant({ usage: 42 }),
  fc.constant({ usage: [] }),
  fc.record({ text: fc.string() }),
  fc.record({
    usage: fc.record({
      promptTokens: fc.oneof(
        fc.constant(null),
        fc.constant('abc'),
        fc.constant(undefined),
        fc.boolean(),
      ),
      completionTokens: fc.oneof(
        fc.constant(null),
        fc.constant('xyz'),
        fc.constant(undefined),
        fc.boolean(),
      ),
    }),
  }),
);

describe('Property 3: Missing token metadata defaults to zero', () => {
  it('extractLangGraphTokens returns zeros for any invalid/missing metadata', () => {
    fc.assert(
      fc.property(invalidLangGraphResponse, (response) => {
        const result = extractLangGraphTokens(response);
        expect(result).toEqual(zeros);
      }),
      { numRuns: 100 },
    );
  });

  it('extractAiSdkTokens returns zeros for any invalid/missing metadata', () => {
    fc.assert(
      fc.property(invalidAiSdkResponse, (response) => {
        const result = extractAiSdkTokens(response);
        expect(result).toEqual(zeros);
      }),
      { numRuns: 100 },
    );
  });
});
