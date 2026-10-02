export type PaymentKind = 'INITIAL' | 'RENEWAL';

export interface PaymentRequest {
  subscriptionId: string;
  userId: string;
  amountCents: number;
  currency: string;
  kind: PaymentKind;
  /** A real provider de-duplicates charges on this key (safe retries). */
  idempotencyKey: string;
}

export type PaymentResult =
  { status: 'SUCCEEDED'; reference: string } | { status: 'FAILED'; reason: string };

export interface PaymentGateway {
  charge(request: PaymentRequest): Promise<PaymentResult>;
}
