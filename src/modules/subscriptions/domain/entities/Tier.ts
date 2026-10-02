import { BillingCycle } from './BillingCycle.js';

export const Tier = {
  BASIC: 'BASIC',
  PRO: 'PRO',
  ENTERPRISE: 'ENTERPRISE',
} as const;

export type Tier = (typeof Tier)[keyof typeof Tier];

interface TierTerms {
  /** Messages per monthly cycle; null = unlimited. */
  monthlyMessages: number | null;
  monthlyPriceCents: number;
  yearlyPriceCents: number;
}

/** Tier catalogue (prices are illustrative, A-09). Money is integer cents (D-11). */
export const TIER_CATALOGUE: Readonly<Record<Tier, TierTerms>> = {
  BASIC: { monthlyMessages: 10, monthlyPriceCents: 999, yearlyPriceCents: 9_990 },
  PRO: { monthlyMessages: 100, monthlyPriceCents: 2_999, yearlyPriceCents: 29_990 },
  ENTERPRISE: { monthlyMessages: null, monthlyPriceCents: 9_999, yearlyPriceCents: 99_990 },
};

export const CURRENCY = 'USD';

/** Quota per billing cycle (A-04): yearly bundles receive 12× the monthly allowance. */
export function maxMessagesFor(tier: Tier, cycle: BillingCycle): number | null {
  const monthly = TIER_CATALOGUE[tier].monthlyMessages;
  if (monthly === null) return null;
  return cycle === BillingCycle.YEARLY ? monthly * 12 : monthly;
}

export function priceCentsFor(tier: Tier, cycle: BillingCycle): number {
  const terms = TIER_CATALOGUE[tier];
  return cycle === BillingCycle.YEARLY ? terms.yearlyPriceCents : terms.monthlyPriceCents;
}
