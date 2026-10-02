/**
 * Demo data for local exploration (`npm run db:seed`). Idempotent: seeded users
 * are identified by `seed|…` subjects and their data is rebuilt on every run.
 * Subscriptions are built through the domain aggregate so prices, quotas and
 * dates always match the tier catalogue.
 *
 * Seeded users cannot log in (their subjects do not exist at Auth0); they make
 * /metrics and the admin endpoints interesting. Real users are provisioned
 * just-in-time on their first authenticated request.
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import { periodOf } from '../src/modules/chat/domain/entities/QuotaPeriod.js';
import { Subscription } from '../src/modules/subscriptions/domain/entities/Subscription.js';

const prisma = new PrismaClient();
const DAY = 24 * 3600_000;

function subscriptionRow(sub: Subscription): Prisma.SubscriptionUncheckedCreateInput {
  const { version: _version, ...s } = sub.snapshot;
  return s;
}

async function main(): Promise<void> {
  const now = new Date();
  const seedUsers = await prisma.user.findMany({ where: { authSub: { startsWith: 'seed|' } } });
  const ids = seedUsers.map((u) => u.id);
  await prisma.chatMessage.deleteMany({ where: { userId: { in: ids } } });
  await prisma.paymentAttempt.deleteMany({ where: { subscription: { userId: { in: ids } } } });
  await prisma.subscription.deleteMany({ where: { userId: { in: ids } } });
  await prisma.monthlyFreeUsage.deleteMany({ where: { userId: { in: ids } } });

  const upsertUser = (authSub: string, email: string, role: 'USER' | 'ADMIN') =>
    prisma.user.upsert({
      where: { authSub },
      create: { authSub, email, role },
      update: { email, role },
    });
  const alice = await upsertUser('seed|alice', 'alice@example.com', 'USER');
  const bob = await upsertUser('seed|bob', 'bob@example.com', 'USER');
  await upsertUser('seed|admin', 'admin@example.com', 'ADMIN');

  // Alice: active auto-renewing BASIC (4 used) + a cancelled PRO still active until its end date.
  const basic = Subscription.create({
    userId: alice.id,
    tier: 'BASIC',
    billingCycle: 'MONTHLY',
    autoRenew: true,
    now: new Date(now.getTime() - 5 * DAY),
  });
  const pro = Subscription.create({
    userId: alice.id,
    tier: 'PRO',
    billingCycle: 'MONTHLY',
    autoRenew: true,
    now: new Date(now.getTime() - 2 * DAY),
  });
  pro.cancel(new Date(now.getTime() - DAY));

  // Bob: yearly ENTERPRISE, plus a declined PRO kept for history.
  const enterprise = Subscription.create({
    userId: bob.id,
    tier: 'ENTERPRISE',
    billingCycle: 'YEARLY',
    autoRenew: false,
    now: new Date(now.getTime() - 10 * DAY),
  });
  const declined = Subscription.create({
    userId: bob.id,
    tier: 'PRO',
    billingCycle: 'MONTHLY',
    autoRenew: true,
    now: new Date(now.getTime() - 3 * DAY),
  });
  declined.failInitialPayment(new Date(now.getTime() - 3 * DAY));

  for (const sub of [basic, pro, enterprise, declined]) {
    await prisma.subscription.create({ data: subscriptionRow(sub) });
    const s = sub.snapshot;
    await prisma.paymentAttempt.create({
      data: {
        subscriptionId: s.id,
        amountCents: s.priceCents,
        kind: 'INITIAL',
        status: s.inactiveReason === 'PAYMENT_FAILED' ? 'FAILED' : 'SUCCEEDED',
        failureReason: s.inactiveReason === 'PAYMENT_FAILED' ? 'card_declined (simulated)' : null,
        createdAt: s.createdAt,
      },
    });
  }

  // Chat history: Alice used her 3 free messages and 4 BASIC messages; Bob 2 free messages.
  const period = periodOf(now);
  await prisma.monthlyFreeUsage.createMany({
    data: [
      { userId: alice.id, period, used: 3 },
      { userId: bob.id, period, used: 2 },
    ],
  });
  await prisma.subscription.update({ where: { id: basic.id }, data: { usedMessages: 4 } });

  const message = (userId: string, i: number, subscriptionId: string | null) => {
    const question = `Demo question #${i}: how does quota deduction work?`;
    const answer = `Demo answer #${i} (seeded mock completion).`;
    const promptTokens = Math.ceil(question.length / 4);
    const completionTokens = Math.ceil(answer.length / 4);
    return {
      userId,
      question,
      answer,
      status: 'COMPLETED' as const,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      model: 'gpt-4o-mini (mock)',
      quotaSource: subscriptionId ? ('SUBSCRIPTION' as const) : ('FREE' as const),
      subscriptionId,
      requestId: crypto.randomUUID(),
      latencyMs: 300 + i * 50,
      createdAt: new Date(now.getTime() - (10 - i) * 3600_000),
      completedAt: new Date(now.getTime() - (10 - i) * 3600_000 + 500),
    };
  };
  await prisma.chatMessage.createMany({
    data: [
      ...[0, 1, 2].map((i) => message(alice.id, i, null)),
      ...[3, 4, 5, 6].map((i) => message(alice.id, i, basic.id)),
      ...[7, 8].map((i) => message(bob.id, i, null)),
    ],
  });

  process.stdout.write(
    'Seeded demo users seed|alice, seed|bob, seed|admin with subscriptions and chats.\n',
  );
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`Seeding failed: ${String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
