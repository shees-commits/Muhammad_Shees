import cron, { type ScheduledTask } from 'node-cron';
import type { Logger } from '../../../shared/logging/logger.js';
import type { ChatService } from '../domain/services/ChatService.js';

/**
 * Periodically refunds messages left PENDING by a crash between the reserve
 * and finalize transactions. The cut-off is well past the request deadline,
 * so in-flight requests are never touched.
 */
export function scheduleStalePendingRecovery(
  schedule: string,
  chat: ChatService,
  staleAfterMs: number,
  logger: Logger,
): ScheduledTask {
  return cron.schedule(schedule, async () => {
    try {
      const recovered = await chat.recoverStalePending(staleAfterMs);
      if (recovered > 0) logger.warn({ recovered }, 'Refunded stale PENDING chat messages');
    } catch (error) {
      logger.error({ err: error }, 'Stale PENDING recovery failed');
    }
  });
}
