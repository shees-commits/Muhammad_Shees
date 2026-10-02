export const BillingCycle = {
  MONTHLY: 'MONTHLY',
  YEARLY: 'YEARLY',
} as const;

export type BillingCycle = (typeof BillingCycle)[keyof typeof BillingCycle];

/**
 * Adds whole calendar months in UTC, clamping to the last day of the target
 * month (Jan 31 + 1 month = Feb 28/29) instead of overflowing into March.
 */
export function addMonthsUtc(from: Date, months: number): Date {
  const target = new Date(from);
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(from.getUTCDate(), lastDay));
  return target;
}

/** End of one billing cycle starting at `from`. */
export function addCycle(from: Date, cycle: BillingCycle): Date {
  return addMonthsUtc(from, cycle === BillingCycle.MONTHLY ? 1 : 12);
}
