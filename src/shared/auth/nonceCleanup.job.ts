import cron, { type ScheduledTask } from 'node-cron';
import type { Clock } from '../kernel/Clock.js';
import type { Logger } from '../logging/logger.js';
import type { NonceStore } from './NonceStore.js';

/** Periodically purges replay-protection nonces whose timestamp window has passed. */
export function scheduleNonceCleanup(
  schedule: string,
  store: NonceStore,
  clock: Clock,
  logger: Logger,
): ScheduledTask {
  return cron.schedule(schedule, async () => {
    try {
      const removed = await store.purgeExpired(clock.now());
      if (removed > 0) logger.debug({ removed }, 'Purged expired replay nonces');
    } catch (error) {
      logger.error({ err: error }, 'Nonce cleanup failed');
    }
  });
}
