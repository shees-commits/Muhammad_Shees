import type { PrismaClient } from '@prisma/client';
import type { JWTVerifyGetKey } from 'jose';
import type { ScheduledTask } from 'node-cron';
import type { LLMProvider } from './modules/chat/domain/ports/LLMProvider.js';
import { ChatService } from './modules/chat/domain/services/ChatService.js';
import { QuotaService } from './modules/chat/domain/services/QuotaService.js';
import { MockLLMProvider } from './modules/chat/infrastructure/MockLLMProvider.js';
import { PrismaChatRepository } from './modules/chat/repositories/PrismaChatRepository.js';
import { PrismaQuotaRepository } from './modules/chat/repositories/PrismaQuotaRepository.js';
import { createJwtVerifier, remoteJwks } from './shared/auth/jwtVerifier.js';
import { scheduleNonceCleanup } from './shared/auth/nonceCleanup.job.js';
import { PrismaNonceStore } from './shared/auth/PrismaNonceStore.js';
import { PrismaUserDirectory } from './shared/auth/PrismaUserDirectory.js';
import type { AppConfig } from './shared/config/env.js';
import { createPrismaClient, pingDatabase } from './shared/db/prisma.js';
import type { AppDeps } from './shared/http/app.js';
import { systemClock, type Clock } from './shared/kernel/Clock.js';
import { createLogger, type Logger } from './shared/logging/logger.js';

/**
 * Collaborators that tests (or other deployments) may substitute. Overrides
 * replace adapters at the composition root; no production code path checks
 * whether it is running under test.
 */
export interface ContainerOverrides {
  logger?: Logger;
  prisma?: PrismaClient;
  clock?: Clock;
  jwks?: JWTVerifyGetKey;
  llm?: LLMProvider;
}

/**
 * Composition root: the only place that knows concrete implementations.
 * Everything else depends on ports/interfaces and receives its collaborators.
 */
export interface Container {
  config: AppConfig;
  logger: Logger;
  prisma: PrismaClient;
  appDeps: AppDeps;
  /** Starts background jobs (cron). Not started by tests. */
  startJobs: () => void;
  shutdown: () => Promise<void>;
}

export function createContainer(config: AppConfig, overrides: ContainerOverrides = {}): Container {
  const logger =
    overrides.logger ??
    createLogger({ level: config.logLevel, pretty: config.nodeEnv === 'development' });
  const prisma = overrides.prisma ?? createPrismaClient(config.databaseUrl);
  const clock = overrides.clock ?? systemClock;

  const verifyToken = createJwtVerifier({
    issuer: config.auth.issuer,
    audience: config.auth.audience,
    rolesClaim: config.auth.rolesClaim,
    jwks: overrides.jwks ?? remoteJwks(config.auth.jwksUri),
    clock,
  });
  const users = new PrismaUserDirectory(prisma);
  const nonces = new PrismaNonceStore(prisma);

  const chat = new ChatService({
    quota: new QuotaService(new PrismaQuotaRepository(prisma)),
    chats: new PrismaChatRepository(prisma),
    llm:
      overrides.llm ??
      new MockLLMProvider({
        minLatencyMs: config.llm.minLatencyMs,
        maxLatencyMs: config.llm.maxLatencyMs,
      }),
    clock,
    llmTimeoutMs: config.llm.timeoutMs,
  });

  const jobs: ScheduledTask[] = [];

  return {
    config,
    logger,
    prisma,
    appDeps: {
      config,
      logger,
      clock,
      checkDatabase: () => pingDatabase(prisma),
      verifyToken,
      users,
      nonces,
      chat,
    },
    startJobs: () => {
      jobs.push(scheduleNonceCleanup(config.billing.nonceCleanupCron, nonces, clock, logger));
    },
    shutdown: async () => {
      await Promise.all(
        jobs.map(async (job) => {
          await job.stop();
        }),
      );
      await prisma.$disconnect();
    },
  };
}
