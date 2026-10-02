import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from './shared/config/env.js';
import { createPrismaClient, pingDatabase } from './shared/db/prisma.js';
import type { AppDeps } from './shared/http/app.js';
import { createLogger, type Logger } from './shared/logging/logger.js';

/**
 * Composition root: the only place that knows concrete implementations.
 * Everything else depends on ports/interfaces and receives its collaborators.
 */
export interface Container {
  config: AppConfig;
  logger: Logger;
  prisma: PrismaClient;
  appDeps: AppDeps;
  shutdown: () => Promise<void>;
}

export function createContainer(config: AppConfig): Container {
  const logger = createLogger({
    level: config.logLevel,
    pretty: config.nodeEnv === 'development',
  });
  const prisma = createPrismaClient(config.databaseUrl);

  return {
    config,
    logger,
    prisma,
    appDeps: {
      config,
      logger,
      checkDatabase: () => pingDatabase(prisma),
    },
    shutdown: async () => {
      await prisma.$disconnect();
    },
  };
}
