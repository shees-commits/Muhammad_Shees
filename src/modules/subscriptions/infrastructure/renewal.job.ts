import cron, { type ScheduledTask } from 'node-cron';
import type { Logger } from '../../../shared/logging/logger.js';
import type { RenewalService } from '../domain/services/RenewalService.js';

/**
 * Cron-driven renewal runner. Overlapping runs inside one process are skipped;
 * across processes, FOR UPDATE SKIP LOCKED keeps runs from double-charging (D-06).
 */
export function scheduleRenewals(
  schedule: string,
  renewals: RenewalService,
  logger: Logger,
): ScheduledTask {
  let running = false;
  return cron.schedule(schedule, async () => {
    if (running) {
      logger.warn('Previous renewal run still in progress; skipping this tick');
      return;
    }
    running = true;
    try {
      const result = await renewals.runOnce();
      for (const outcome of result.outcomes) {
        const level = outcome.outcome === 'ERROR' ? 'error' : 'info';
        logger[level]({ renewal: outcome }, 'Subscription billing outcome');
      }
      if (result.outcomes.length > 0) {
        logger.info(
          {
            renewed: result.renewed,
            paymentFailed: result.paymentFailed,
            expired: result.expired,
            errors: result.errors,
          },
          'Renewal run finished',
        );
      }
    } catch (error) {
      logger.error({ err: error }, 'Renewal run failed');
    } finally {
      running = false;
    }
  });
}
