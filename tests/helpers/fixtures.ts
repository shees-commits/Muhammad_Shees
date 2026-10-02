import type { PrismaClient, Tier } from '@prisma/client';
import type { TestApp } from './testApp.js';

/** Provisions a user through the real auth flow and returns its internal ID. */
export async function provisionUser(
  t: TestApp,
  sub: string,
  roles: string[] = [],
): Promise<string> {
  const res = await t.as({ sub, roles }).get('/auth/me');
  if (res.status !== 200) throw new Error(`provisioning ${sub} failed: ${res.status}`);
  return (res.body as { id: string }).id;
}

const LIMITS: Record<Tier, number | null> = { BASIC: 10, PRO: 100, ENTERPRISE: null };
const PRICES: Record<Tier, number> = { BASIC: 999, PRO: 2999, ENTERPRISE: 9999 };

/** Inserts an ACTIVE monthly bundle directly (test arrangement only). */
export async function insertBundle(
  prisma: PrismaClient,
  userId: string,
  options: { tier?: Tier; startDate?: Date; endDate?: Date; usedMessages?: number } = {},
) {
  const tier = options.tier ?? 'BASIC';
  const startDate = options.startDate ?? new Date(Date.now() - 24 * 3600_000);
  return prisma.subscription.create({
    data: {
      userId,
      tier,
      billingCycle: 'MONTHLY',
      maxMessages: LIMITS[tier],
      usedMessages: options.usedMessages ?? 0,
      priceCents: PRICES[tier],
      startDate,
      endDate: options.endDate ?? new Date(startDate.getTime() + 30 * 24 * 3600_000),
      renewalDate: null,
      autoRenew: false,
      status: 'ACTIVE',
    },
  });
}
