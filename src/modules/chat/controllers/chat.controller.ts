import type { ChatMessage } from '../domain/entities/ChatMessage.js';
import type { PageResult } from '../domain/ports/ChatRepository.js';
import type { UsageSummary } from '../domain/services/QuotaService.js';

/** Domain entity → response DTO (no persistence or internal fields leak). */
export function toMessageDto(message: ChatMessage) {
  return {
    id: message.id,
    userId: message.userId,
    question: message.question,
    answer: message.answer,
    status: message.status,
    quotaSource: message.quotaSource,
    subscriptionId: message.subscriptionId,
    model: message.model,
    usage: message.usage,
    latencyMs: message.latencyMs,
    requestId: message.requestId,
    createdAt: message.createdAt.toISOString(),
    completedAt: message.completedAt?.toISOString() ?? null,
  };
}

export function toPageDto(page: PageResult<ChatMessage>, limit: number, offset: number) {
  const nextOffset = offset + page.items.length;
  return {
    items: page.items.map(toMessageDto),
    page: {
      limit,
      offset,
      total: page.total,
      nextOffset: nextOffset < page.total ? nextOffset : null,
    },
  };
}

export function toUsageDto(usage: UsageSummary) {
  return {
    period: usage.period,
    free: { ...usage.free, resetsAt: usage.free.resetsAt.toISOString() },
    bundles: usage.bundles.map((b) => ({ ...b, endDate: b.endDate.toISOString() })),
    totalRemaining: usage.totalRemaining,
  };
}
