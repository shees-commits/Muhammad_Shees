export const QuotaSource = {
  FREE: 'FREE',
  SUBSCRIPTION: 'SUBSCRIPTION',
} as const;

export type QuotaSource = (typeof QuotaSource)[keyof typeof QuotaSource];
