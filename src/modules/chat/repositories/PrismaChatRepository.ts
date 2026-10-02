import type { PrismaClient } from '@prisma/client';
import type { ChatMessage } from '../domain/entities/ChatMessage.js';
import type {
  ChatRepository,
  ChatUsageStats,
  CompletionRecord,
  Page,
  PageResult,
} from '../domain/ports/ChatRepository.js';
import { toChatMessage } from './mappers.js';

export class PrismaChatRepository implements ChatRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async complete(messageId: string, record: CompletionRecord): Promise<ChatMessage> {
    const { count } = await this.prisma.chatMessage.updateMany({
      where: { id: messageId, status: 'PENDING' },
      data: {
        status: 'COMPLETED',
        answer: record.answer,
        model: record.model,
        promptTokens: record.usage.promptTokens,
        completionTokens: record.usage.completionTokens,
        totalTokens: record.usage.totalTokens,
        latencyMs: record.latencyMs,
        completedAt: record.completedAt,
      },
    });
    if (count !== 1) throw new Error(`Chat message ${messageId} is no longer pending`);
    return toChatMessage(
      await this.prisma.chatMessage.findUniqueOrThrow({ where: { id: messageId } }),
    );
  }

  async findById(id: string): Promise<ChatMessage | null> {
    const row = await this.prisma.chatMessage.findUnique({ where: { id } });
    return row ? toChatMessage(row) : null;
  }

  async listByUser(userId: string, page: Page): Promise<PageResult<ChatMessage>> {
    const [rows, total] = await Promise.all([
      this.prisma.chatMessage.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: page.limit,
        skip: page.offset,
      }),
      this.prisma.chatMessage.count({ where: { userId } }),
    ]);
    return { items: rows.map(toChatMessage), total };
  }

  async statsSince(since: Date): Promise<ChatUsageStats> {
    const [bySource, failed] = await Promise.all([
      this.prisma.chatMessage.groupBy({
        by: ['quotaSource'],
        where: { status: 'COMPLETED', createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { promptTokens: true, completionTokens: true, totalTokens: true },
      }),
      this.prisma.chatMessage.count({ where: { status: 'FAILED', createdAt: { gte: since } } }),
    ]);

    const stats: ChatUsageStats = {
      messagesBySource: { FREE: 0, SUBSCRIPTION: 0 },
      failedMessages: failed,
      tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
    for (const group of bySource) {
      stats.messagesBySource[group.quotaSource] = group._count._all;
      stats.tokens.promptTokens += group._sum.promptTokens ?? 0;
      stats.tokens.completionTokens += group._sum.completionTokens ?? 0;
      stats.tokens.totalTokens += group._sum.totalTokens ?? 0;
    }
    return stats;
  }
}
