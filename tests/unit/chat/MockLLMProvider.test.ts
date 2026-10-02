import { describe, expect, it } from 'vitest';
import {
  estimateTokens,
  MockLLMProvider,
} from '../../../src/modules/chat/infrastructure/MockLLMProvider.js';

describe('MockLLMProvider', () => {
  it('returns a deterministic answer and estimated token usage', async () => {
    const llm = new MockLLMProvider({ minLatencyMs: 0, maxLatencyMs: 0 });
    const signal = new AbortController().signal;
    const a = await llm.complete('Explain CQRS', { signal });
    const b = await llm.complete('Explain CQRS', { signal });

    expect(a.answer).toBe(b.answer);
    expect(a.answer).toContain('Explain CQRS');
    expect(a.usage.promptTokens).toBe(estimateTokens('Explain CQRS'));
    expect(a.usage.totalTokens).toBe(a.usage.promptTokens + a.usage.completionTokens);
  });

  it('simulates latency within the configured range', async () => {
    const llm = new MockLLMProvider({ minLatencyMs: 30, maxLatencyMs: 30, random: () => 0.5 });
    const started = performance.now();
    await llm.complete('q', { signal: new AbortController().signal });
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
  });

  it('stops waiting when aborted', async () => {
    const llm = new MockLLMProvider({ minLatencyMs: 5000, maxLatencyMs: 5000 });
    const controller = new AbortController();
    const pending = llm.complete('q', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});
