/**
 * The chat module's read model of a subscription bundle: only what quota
 * decisions need. The subscriptions module owns the full aggregate.
 */
export interface BundleQuota {
  id: string;
  tier: string;
  status: 'ACTIVE' | 'INACTIVE';
  startDate: Date;
  endDate: Date;
  /** null = unlimited (Enterprise). */
  maxMessages: number | null;
  usedMessages: number;
  createdAt: Date;
}

export function remainingOf(bundle: BundleQuota): number | null {
  return bundle.maxMessages === null ? null : Math.max(0, bundle.maxMessages - bundle.usedMessages);
}

/** Active, inside its current billing period, and not exhausted. */
export function isUsable(bundle: BundleQuota, now: Date): boolean {
  const remaining = remainingOf(bundle);
  return (
    bundle.status === 'ACTIVE' &&
    bundle.startDate.getTime() <= now.getTime() &&
    now.getTime() < bundle.endDate.getTime() &&
    (remaining === null || remaining > 0)
  );
}

/**
 * A-01: "deduct from the bundle with the latest remaining quota" = the newest
 * usable bundle (latest startDate, then latest createdAt).
 */
export function selectBundle(bundles: readonly BundleQuota[], now: Date): BundleQuota | undefined {
  return bundles
    .filter((bundle) => isUsable(bundle, now))
    .sort(
      (a, b) =>
        b.startDate.getTime() - a.startDate.getTime() ||
        b.createdAt.getTime() - a.createdAt.getTime(),
    )[0];
}
