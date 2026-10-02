import { Router } from 'express';
import { actorOf } from '../../../shared/http/locals.js';
import { validate } from '../../../shared/http/validate.js';
import type { SubscriptionService } from '../domain/services/SubscriptionService.js';
import { toSubscriptionDto } from './subscription.controller.js';
import {
  AutoRenewBody,
  CreateSubscriptionBody,
  EmptyQuery,
  NoBody,
  SubscriptionIdParams,
} from './subscription.schemas.js';

/** Mounted under /subscriptions behind authenticate → replay protection → per-user rate limit. */
export function subscriptionRoutes(subscriptions: SubscriptionService): Router {
  const router = Router();

  const create = validate({ body: CreateSubscriptionBody, query: EmptyQuery });
  router.post('/', create, async (_req, res) => {
    const { body } = create.data(res);
    // Explicit DTO → command mapping; nothing else from the request reaches the domain.
    const subscription = await subscriptions.create(actorOf(res), {
      tier: body.tier,
      billingCycle: body.billingCycle,
      autoRenew: body.autoRenew,
    });
    res.status(201).json(toSubscriptionDto(subscription));
  });

  const list = validate({ query: EmptyQuery });
  router.get('/', list, async (_req, res) => {
    const items = await subscriptions.listOwn(actorOf(res));
    res.json({ items: items.map(toSubscriptionDto) });
  });

  const getOne = validate({ params: SubscriptionIdParams, query: EmptyQuery });
  router.get('/:id', getOne, async (_req, res) => {
    const { params } = getOne.data(res);
    res.json(toSubscriptionDto(await subscriptions.get(actorOf(res), params.id)));
  });

  const autoRenew = validate({
    params: SubscriptionIdParams,
    body: AutoRenewBody,
    query: EmptyQuery,
  });
  router.patch('/:id/auto-renew', autoRenew, async (_req, res) => {
    const { params, body } = autoRenew.data(res);
    const subscription = await subscriptions.setAutoRenew(actorOf(res), params.id, body.autoRenew);
    res.json(toSubscriptionDto(subscription));
  });

  const cancel = validate({ params: SubscriptionIdParams, body: NoBody, query: EmptyQuery });
  router.post('/:id/cancel', cancel, async (_req, res) => {
    const { params } = cancel.data(res);
    res.json(toSubscriptionDto(await subscriptions.cancel(actorOf(res), params.id)));
  });

  return router;
}
