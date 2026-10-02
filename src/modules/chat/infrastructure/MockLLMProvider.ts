import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { LLMCompletion, LLMProvider } from '../domain/ports/LLMProvider.js';

export interface MockLLMOptions {
  minLatencyMs: number;
  maxLatencyMs: number;
  /** Injected randomness (latency jitter) for deterministic tests. */
  random?: () => number;
}

/** Shape of an OpenAI Chat Completions response — what this adapter simulates. */
interface OpenAIChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: {
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: 'stop';
  }[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

const MODEL = 'gpt-4o-mini (mock)';

const OPENERS = [
  'Great question.',
  'Here is a concise answer.',
  'Let me break that down.',
  'Short version first, then details.',
];

/** Rough token estimate used by many tokenizers for English text: ~4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Simulated OpenAI: waits a random 300–1500 ms (configurable), produces a
 * deterministic-looking answer for a given prompt, estimates token usage,
 * and maps the OpenAI-shaped payload to the domain's LLMCompletion.
 */
export class MockLLMProvider implements LLMProvider {
  private readonly random: () => number;

  constructor(private readonly options: MockLLMOptions) {
    this.random = options.random ?? Math.random;
  }

  async complete(prompt: string, { signal }: { signal: AbortSignal }): Promise<LLMCompletion> {
    const { minLatencyMs, maxLatencyMs } = this.options;
    const latency = minLatencyMs + Math.floor(this.random() * (maxLatencyMs - minLatencyMs + 1));
    if (latency > 0) await sleep(latency, undefined, { signal });
    signal.throwIfAborted();

    const response = this.simulateOpenAI(prompt);
    const choice = response.choices[0];
    if (!choice) throw new Error('Mock LLM returned no choices');
    return {
      answer: choice.message.content,
      model: response.model,
      usage: {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      },
    };
  }

  private simulateOpenAI(prompt: string): OpenAIChatCompletion {
    const digest = createHash('sha256').update(prompt).digest();
    const opener = OPENERS[(digest[0] ?? 0) % OPENERS.length] ?? 'Answer:';
    const topic = prompt.length > 120 ? `${prompt.slice(0, 117)}...` : prompt;
    const content =
      `${opener} You asked: "${topic}". This is a simulated response from a mocked ` +
      `OpenAI model; in production this text would come from the real provider. ` +
      `(ref ${digest.subarray(0, 4).toString('hex')})`;
    const promptTokens = estimateTokens(prompt);
    const completionTokens = estimateTokens(content);
    return {
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  }
}
