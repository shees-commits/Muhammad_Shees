/** Every user gets this many free messages per UTC calendar month (A-03). */
export const FREE_MESSAGES_PER_MONTH = 3;

/** The UTC calendar month a moment belongs to, as `YYYY-MM`. */
export function periodOf(at: Date): string {
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');
  return `${at.getUTCFullYear()}-${month}`;
}

/** 00:00:00.000 UTC on the 1st of the following month: when the free quota resets. */
export function nextPeriodStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}
