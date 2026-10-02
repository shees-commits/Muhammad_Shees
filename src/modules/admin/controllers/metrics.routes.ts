import { Router } from 'express';
import { actorOf } from '../../../shared/http/locals.js';
import { validate } from '../../../shared/http/validate.js';
import type { Clock } from '../../../shared/kernel/Clock.js';
import { periodOf } from '../../chat/domain/entities/QuotaPeriod.js';
import type { ChatService } from '../../chat/domain/services/ChatService.js';
import { EmptyQuery } from '../../subscriptions/controllers/subscription.schemas.js';
import type { SubscriptionService } from '../../subscriptions/domain/services/SubscriptionService.js';

export interface MetricsRouteDeps {
  chat: ChatService;
  subscriptions: SubscriptionService;
  clock: Clock;
}

const rate = (succeeded: number, failed: number): number | null =>
  succeeded + failed === 0 ? null : Number((succeeded / (succeeded + failed)).toFixed(4));

/**
 * GET /metrics — admin-only usage and billing analytics for the current UTC month.
 * Composes the chat and subscription services; each re-checks admin rights
 * through its own domain policy.
 */
export function metricsRoutes(deps: MetricsRouteDeps): Router {
  const router = Router();
  const schema = validate({ query: EmptyQuery });

  router.get('/', schema, async (_req, res) => {
    const actor = actorOf(res);
    const now = deps.clock.now();
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [chat, subs] = await Promise.all([
      deps.chat.systemStats(actor, since),
      deps.subscriptions.systemStats(actor, since),
    ]);
    const { INITIAL: initial, RENEWAL: renewal } = subs.payments;
    const succeeded = initial.succeeded + renewal.succeeded;
    const failed = initial.failed + renewal.failed;

    res.json({
      generatedAt: now.toISOString(),
      period: periodOf(now),
      since: since.toISOString(),
      chat: {
        messagesThisMonth: {
          total: chat.messagesBySource.FREE + chat.messagesBySource.SUBSCRIPTION,
          bySource: chat.messagesBySource,
        },
        failedMessagesThisMonth: chat.failedMessages,
        tokensThisMonth: chat.tokens,
      },
      subscriptions: {
        activeTotal: Object.values(subs.activeByTier).reduce((a, b) => a + b, 0),
        activeByTier: subs.activeByTier,
        cancelledButActive: subs.cancelledButActive,
        inactiveByReason: subs.inactiveByReason,
      },
      payments: {
        thisMonth: {
          succeeded,
          failed,
          successRate: rate(succeeded, failed),
          revenueCents: initial.revenueCents + renewal.revenueCents,
        },
        initial,
        renewal,
      },
      renewals: {
        succeeded: renewal.succeeded,
        failed: renewal.failed,
        successRate: rate(renewal.succeeded, renewal.failed),
      },
    });
  });

  return router;
}
