import type { ChatMessage, TokenUsage } from '../entities/ChatMessage.js';
import type { QuotaSource } from '../entities/QuotaSource.js';

export interface Page {
  limit: number;
  offset: number;
}

export interface PageResult<T> {
  items: T[];
  total: number;
}

export interface CompletionRecord {
  answer: string;
  model: string;
  usage: TokenUsage;
  latencyMs: number;
  completedAt: Date;
}

export interface ChatUsageStats {
  messagesBySource: Record<QuotaSource, number>;
  failedMessages: number;
  tokens: TokenUsage;
}

export interface ChatRepository {
  /** Transaction 2 (finalize): PENDING → COMPLETED. */
  complete(messageId: string, record: CompletionRecord): Promise<ChatMessage>;
  findById(id: string): Promise<ChatMessage | null>;
  listByUser(userId: string, page: Page): Promise<PageResult<ChatMessage>>;
  /** Completed-message statistics since a moment (for admin metrics). */
  statsSince(since: Date): Promise<ChatUsageStats>;
}
