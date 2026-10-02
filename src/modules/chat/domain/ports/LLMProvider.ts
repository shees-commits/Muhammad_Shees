import type { TokenUsage } from '../entities/ChatMessage.js';

export interface LLMCompletion {
  answer: string;
  model: string;
  usage: TokenUsage;
}

/**
 * Port for the language model. The mock adapter simulates OpenAI; a real
 * provider can be plugged in at the composition root without touching the domain.
 */
export interface LLMProvider {
  complete(prompt: string, options: { signal: AbortSignal }): Promise<LLMCompletion>;
}
