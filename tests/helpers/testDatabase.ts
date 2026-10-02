import type { PrismaClient } from '@prisma/client';
import { createPrismaClient } from '../../src/shared/db/prisma.js';

/** Matches the `db-test` service in docker-compose.yml; CI overrides via TEST_DATABASE_URL. */
export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://ggi:ggi_test_password@localhost:5441/ggi_test?schema=public';

let shared: PrismaClient | undefined;

/** One Prisma client per test file (pool sized for the concurrency tests). */
export function testPrisma(): PrismaClient {
  shared ??= createPrismaClient(
    `${TEST_DATABASE_URL}${TEST_DATABASE_URL.includes('?') ? '&' : '?'}connection_limit=25`,
  );
  return shared;
}

/** Empties every table. Integration files run serially, so this is safe between files/tests. */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRaw`TRUNCATE "ChatMessage", "PaymentAttempt", "Subscription", "MonthlyFreeUsage", "UsedNonce", "User" CASCADE`;
}
