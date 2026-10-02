import type { Actor } from '../../../../shared/auth/Actor.js';
import type { ChatMessage } from '../entities/ChatMessage.js';
import { ChatAccessDeniedError, ChatMessageNotFoundError, LLMUnavailableError } from '../errors.js';
import { ChatPolicy } from '../policies/ChatPolicy.js';
import type { ChatRepository, ChatUsageStats, Page, PageResult } from '../ports/ChatRepository.js';
import type { Clock } from '../ports/Clock.js';
import type { LLMCompletion, LLMProvider } from '../ports/LLMProvider.js';
import type { QuotaService, UsageSummary } from './QuotaService.js';

export interface ChatServiceDeps {
  quota: QuotaService;
  chats: ChatRepository;
  llm: LLMProvider;
  clock: Clock;
  llmTimeoutMs: number;
}

export interface AskInput {
  question: string;
  requestId: string;
  /** Aborted when the HTTP request times out. */
  signal?: AbortSignal;
}

/**
 * Orchestrates reserve → generate → finalize (D-02). Database locks are held
 * only inside the short reserve and finalize transactions, never while the
 * LLM is thinking. If generation fails, times out or is aborted, the exact
 * reserved unit is refunded.
 */
export class ChatService {
  constructor(private readonly deps: ChatServiceDeps) {}

  async ask(actor: Actor, input: AskInput): Promise<ChatMessage> {
    if (!ChatPolicy.canAsk(actor)) throw new ChatAccessDeniedError();
    const { quota, chats, clock } = this.deps;

    const { message, reservation } = await quota.reserve({
      userId: actor.userId,
      question: input.question,
      requestId: input.requestId,
      now: clock.now(),
    });

    const startedAt = performance.now();
    let completion: LLMCompletion;
    try {
      completion = await this.generate(input.question, input.signal);
    } catch (error) {
      await quota.release(reservation, clock.now());
      throw new LLMUnavailableError(error);
    }

    try {
      return await chats.complete(message.id, {
        answer: completion.answer,
        model: completion.model,
        usage: completion.usage,
        latencyMs: Math.round(performance.now() - startedAt),
        completedAt: clock.now(),
      });
    } catch (error) {
      // Never leave a charged message stuck in PENDING.
      await quota.release(reservation, clock.now());
      throw error;
    }
  }

  async getMessage(actor: Actor, id: string): Promise<ChatMessage> {
    const message = await this.deps.chats.findById(id);
    // D-08: someone else's message is indistinguishable from a missing one.
    if (!message || !ChatPolicy.canView(actor, message)) throw new ChatMessageNotFoundError();
    return message;
  }

  async listOwnMessages(actor: Actor, page: Page): Promise<PageResult<ChatMessage>> {
    return this.deps.chats.listByUser(actor.userId, page);
  }

  async listMessagesOf(actor: Actor, userId: string, page: Page): Promise<PageResult<ChatMessage>> {
    if (!ChatPolicy.canViewHistoryOf(actor, userId)) throw new ChatAccessDeniedError();
    return this.deps.chats.listByUser(userId, page);
  }

  async usage(actor: Actor): Promise<UsageSummary> {
    return this.deps.quota.usage(actor.userId, this.deps.clock.now());
  }

  async systemStats(actor: Actor, since: Date): Promise<ChatUsageStats> {
    if (!ChatPolicy.canViewSystemMetrics(actor)) throw new ChatAccessDeniedError();
    return this.deps.chats.statsSince(since);
  }

  /** Calls the LLM with a hard deadline, also honouring the request's abort signal. */
  private async generate(question: string, requestSignal?: AbortSignal): Promise<LLMCompletion> {
    const controller = new AbortController();
    const abort = (reason: unknown) => {
      controller.abort(reason);
    };
    const timer = setTimeout(() => {
      abort(new Error(`LLM timed out after ${this.deps.llmTimeoutMs} ms`));
    }, this.deps.llmTimeoutMs);
    const onRequestAbort = () => {
      abort(requestSignal?.reason);
    };
    requestSignal?.addEventListener('abort', onRequestAbort, { once: true });

    // Even a provider that ignores the signal cannot outlive the deadline.
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          const reason: unknown = controller.signal.reason;
          reject(reason instanceof Error ? reason : new Error('LLM call aborted'));
        },
        { once: true },
      );
    });

    try {
      if (requestSignal?.aborted) throw requestSignal.reason;
      return await Promise.race([
        this.deps.llm.complete(question, { signal: controller.signal }),
        aborted,
      ]);
    } finally {
      clearTimeout(timer);
      requestSignal?.removeEventListener('abort', onRequestAbort);
    }
  }
}
