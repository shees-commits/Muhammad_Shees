import type { QuotaSource } from './QuotaSource.js';

export const ChatMessageStatus = {
  PENDING: 'PENDING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;

export type ChatMessageStatus = (typeof ChatMessageStatus)[keyof typeof ChatMessageStatus];

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatMessage {
  id: string;
  userId: string;
  question: string;
  answer: string | null;
  status: ChatMessageStatus;
  usage: TokenUsage | null;
  model: string | null;
  quotaSource: QuotaSource;
  subscriptionId: string | null;
  requestId: string;
  latencyMs: number | null;
  createdAt: Date;
  completedAt: Date | null;
}
