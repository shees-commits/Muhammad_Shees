import { Router } from 'express';
import { actorOf } from '../../../shared/http/locals.js';
import { validate } from '../../../shared/http/validate.js';
import { toSubscriptionDto } from '../../subscriptions/controllers/subscription.controller.js';
import {
  AdminSubscriptionQuery,
  EmptyQuery,
  NoBody,
} from '../../subscriptions/controllers/subscription.schemas.js';
import type { RenewalService } from '../../subscriptions/domain/services/RenewalService.js';
import type { SubscriptionService } from '../../subscriptions/domain/services/SubscriptionService.js';

export interface AdminRouteDeps {
  subscriptions: SubscriptionService;
  renewals: RenewalService;
}

/**
 * System-wide admin endpoints. Mounted behind authenticate → replay
 * protection → requireRole('ADMIN'); the services re-check admin rights
 * through their domain policies (D-07).
 */
export function adminRoutes(deps: AdminRouteDeps): Router {
  const router = Router();

  const listSubscriptions = validate({ query: AdminSubscriptionQuery });
  router.get('/subscriptions', listSubscriptions, async (_req, res) => {
    const { query } = listSubscriptions.data(res);
    const { limit, offset, ...filter } = query;
    const page = await deps.subscriptions.listAll(actorOf(res), filter, { limit, offset });
    res.json({
      items: page.items.map(toSubscriptionDto),
      page: { limit, offset, total: page.total },
    });
  });

  const runRenewals = validate({ body: NoBody, query: EmptyQuery });
  router.post('/billing/run-renewals', runRenewals, async (_req, res) => {
    const result = await deps.renewals.runAs(actorOf(res));
    res.json({
      startedAt: result.startedAt.toISOString(),
      renewed: result.renewed,
      paymentFailed: result.paymentFailed,
      expired: result.expired,
      errors: result.errors,
      outcomes: result.outcomes.map((o) =>
        o.outcome === 'RENEWED' ? { ...o, newEndDate: o.newEndDate.toISOString() } : o,
      ),
    });
  });

  return router;
}
