import { describe, it, expect } from 'vitest';
import { extractLangGraphTokens } from '../../src/adapters/langgraph.js';
import { extractAiSdkTokens } from '../../src/adapters/ai-sdk.js';

describe('extractLangGraphTokens', () => {
  it('extracts tokens from a valid response', () => {
    const response = { usage_metadata: { input_tokens: 100, output_tokens: 50 } };
    expect(extractLangGraphTokens(response)).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0,
    });
  });

  it('returns zeros for null response', () => {
    expect(extractLangGraphTokens(null)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it('returns zeros for undefined response', () => {
    expect(extractLangGraphTokens(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it('returns zeros when usage_metadata is missing', () => {
    expect(extractLangGraphTokens({ content: 'hello' })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it('handles partial fields (only input_tokens)', () => {
    const response = { usage_metadata: { input_tokens: 42 } };
    expect(extractLangGraphTokens(response)).toEqual({
      inputTokens: 42,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it('returns zeros for non-number fields', () => {
    const response = { usage_metadata: { input_tokens: 'abc', output_tokens: null } };
    expect(extractLangGraphTokens(response)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it('returns zeros for empty object', () => {
    expect(extractLangGraphTokens({})).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });
});

describe('extractAiSdkTokens', () => {
  it('extracts tokens from a valid response', () => {
    const response = { usage: { promptTokens: 200, completionTokens: 80 } };
    expect(extractAiSdkTokens(response)).toEqual({
      inputTokens: 200,
      outputTokens: 80,
      costUsd: 0,
    });
  });

  it('returns zeros for null response', () => {
    expect(extractAiSdkTokens(null)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it('returns zeros for undefined response', () => {
    expect(extractAiSdkTokens(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it('returns zeros when usage is missing', () => {
    expect(extractAiSdkTokens({ text: 'hello' })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it('handles partial fields (only promptTokens)', () => {
    const response = { usage: { promptTokens: 55 } };
    expect(extractAiSdkTokens(response)).toEqual({
      inputTokens: 55,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it('returns zeros for non-number fields', () => {
    const response = { usage: { promptTokens: true, completionTokens: [] } };
    expect(extractAiSdkTokens(response)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it('handles zero values correctly', () => {
    const response = { usage: { promptTokens: 0, completionTokens: 0 } };
    expect(extractAiSdkTokens(response)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });
});
