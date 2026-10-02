import type { ChatMessage as ChatMessageRow } from '@prisma/client';
import type { ChatMessage } from '../domain/entities/ChatMessage.js';

/** Persistence row → domain entity (explicit mapping; Prisma types stop at this layer). */
export function toChatMessage(row: ChatMessageRow): ChatMessage {
  const usage =
    row.promptTokens !== null && row.completionTokens !== null && row.totalTokens !== null
      ? {
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          totalTokens: row.totalTokens,
        }
      : null;
  return {
    id: row.id,
    userId: row.userId,
    question: row.question,
    answer: row.answer,
    status: row.status,
    usage,
    model: row.model,
    quotaSource: row.quotaSource,
    subscriptionId: row.subscriptionId,
    requestId: row.requestId,
    latencyMs: row.latencyMs,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}
