import { z } from 'zod';

const TierSchema = z.enum(['BASIC', 'PRO', 'ENTERPRISE']);
const BillingCycleSchema = z.enum(['MONTHLY', 'YEARLY']);

/**
 * The only client-controlled inputs. Price, maxMessages, status, dates and
 * userId are derived from the tier catalogue and the authenticated actor, so
 * any attempt to send them is rejected as an unknown field (mass assignment).
 */
export const CreateSubscriptionBody = z.strictObject({
  tier: TierSchema,
  billingCycle: BillingCycleSchema,
  autoRenew: z.boolean(),
});

export const AutoRenewBody = z.strictObject({ autoRenew: z.boolean() });

export const NoBody = z.strictObject({}).optional();

export const SubscriptionIdParams = z.strictObject({ id: z.uuid() });

export const EmptyQuery = z.strictObject({});

export const AdminSubscriptionQuery = z.strictObject({
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  tier: TierSchema.optional(),
  userId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
