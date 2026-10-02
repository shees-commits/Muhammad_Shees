import { randomUUID } from 'node:crypto';
import type { BundleQuota } from '../../../src/modules/chat/domain/entities/BundleQuota.js';
import type { ChatMessage } from '../../../src/modules/chat/domain/entities/ChatMessage.js';
import type {
  ChatRepository,
  ChatUsageStats,
  CompletionRecord,
  Page,
  PageResult,
} from '../../../src/modules/chat/domain/ports/ChatRepository.js';
import type {
  LLMCompletion,
  LLMProvider,
} from '../../../src/modules/chat/domain/ports/LLMProvider.js';
import type {
  NewPendingMessage,
  QuotaRepository,
  QuotaTransaction,
  Reservation,
  UsageSnapshot,
} from '../../../src/modules/chat/domain/ports/QuotaRepository.js';

export type FakeBundle = BundleQuota & { userId: string };

/**
 * In-memory stand-in for both chat repositories. `runExclusiveForUser`
 * serializes work like the real row lock does. Candidate bundles are returned
 * unfiltered so the domain's own selection rules are what the tests exercise.
 */
export class InMemoryChatStore implements QuotaRepository, ChatRepository {
  readonly free = new Map<string, number>();
  readonly bundles: FakeBundle[] = [];
  readonly messages = new Map<string, ChatMessage>();
  private queue: Promise<unknown> = Promise.resolve();

  freeUsedOf(userId: string, period: string): number {
    return this.free.get(`${userId}:${period}`) ?? 0;
  }

  bundle(id: string): FakeBundle {
    const found = this.bundles.find((b) => b.id === id);
    if (!found) throw new Error(`no bundle ${id}`);
    return found;
  }

  runExclusiveForUser<T>(_userId: string, work: (tx: QuotaTransaction) => Promise<T>): Promise<T> {
    const tx: QuotaTransaction = {
      freeUsed: (u, period) => Promise.resolve(this.freeUsedOf(u, period)),
      incrementFreeUsage: (u, period) => {
        this.free.set(`${u}:${period}`, this.freeUsedOf(u, period) + 1);
        return Promise.resolve();
      },
      lockCandidateBundles: (u) =>
        Promise.resolve(this.bundles.filter((b) => b.userId === u).map((b) => ({ ...b }))),
      incrementBundleUsage: (id) => {
        this.bundle(id).usedMessages += 1;
        return Promise.resolve();
      },
      insertPendingMessage: (m: NewPendingMessage) => {
        const message: ChatMessage = {
          id: randomUUID(),
          ...m,
          answer: null,
          status: 'PENDING',
          usage: null,
          model: null,
          latencyMs: null,
          completedAt: null,
        };
        this.messages.set(message.id, message);
        return Promise.resolve({ ...message });
      },
    };
    const run = this.queue.then(() => work(tx));
    this.queue = run.catch(() => undefined);
    return run;
  }

  failAndRefund(r: Reservation, at: Date): Promise<void> {
    const message = this.messages.get(r.messageId);
    if (message?.status !== 'PENDING') return Promise.resolve();
    message.status = 'FAILED';
    message.completedAt = at;
    if (r.source === 'FREE') {
      const key = `${r.userId}:${r.period}`;
      this.free.set(key, Math.max(0, (this.free.get(key) ?? 0) - 1));
    } else if (r.subscriptionId) {
      const b = this.bundle(r.subscriptionId);
      b.usedMessages = Math.max(0, b.usedMessages - 1);
    }
    return Promise.resolve();
  }

  usageSnapshot(userId: string, period: string): Promise<UsageSnapshot> {
    return Promise.resolve({
      freeUsed: this.freeUsedOf(userId, period),
      bundles: this.bundles.filter((b) => b.userId === userId),
    });
  }

  complete(messageId: string, record: CompletionRecord): Promise<ChatMessage> {
    const message = this.messages.get(messageId);
    if (message?.status !== 'PENDING') throw new Error('not pending');
    Object.assign(message, {
      status: 'COMPLETED',
      answer: record.answer,
      model: record.model,
      usage: record.usage,
      latencyMs: record.latencyMs,
      completedAt: record.completedAt,
    });
    return Promise.resolve({ ...message });
  }

  findById(id: string): Promise<ChatMessage | null> {
    return Promise.resolve(this.messages.get(id) ?? null);
  }

  listByUser(userId: string, page: Page): Promise<PageResult<ChatMessage>> {
    const all = [...this.messages.values()].filter((m) => m.userId === userId);
    return Promise.resolve({
      items: all.slice(page.offset, page.offset + page.limit),
      total: all.length,
    });
  }

  findStalePending(before: Date, limit: number): Promise<ChatMessage[]> {
    return Promise.resolve(
      [...this.messages.values()]
        .filter((m) => m.status === 'PENDING' && m.createdAt < before)
        .slice(0, limit),
    );
  }

  statsSince(): Promise<ChatUsageStats> {
    throw new Error('not used in unit tests');
  }
}

export function bundle(overrides: Partial<FakeBundle> & { userId: string }): FakeBundle {
  return {
    id: randomUUID(),
    tier: 'BASIC',
    status: 'ACTIVE',
    startDate: new Date('2026-03-01T00:00:00Z'),
    endDate: new Date('2026-04-01T00:00:00Z'),
    maxMessages: 10,
    usedMessages: 0,
    createdAt: new Date('2026-03-01T00:00:00Z'),
    ...overrides,
  };
}

export const echoLLM: LLMProvider = {
  complete: (prompt): Promise<LLMCompletion> =>
    Promise.resolve({
      answer: `echo: ${prompt}`,
      model: 'fake',
      usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
    }),
};

export const failingLLM: LLMProvider = {
  complete: () => Promise.reject(new Error('provider down')),
};

export const hangingLLM: LLMProvider = {
  complete: () => new Promise<never>(() => undefined),
};
