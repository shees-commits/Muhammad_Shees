import { randomUUID } from 'node:crypto';
import type {
  PaymentGateway,
  PaymentRequest,
  PaymentResult,
} from '../domain/ports/PaymentGateway.js';

/**
 * Simulated payment processor: each charge fails with probability
 * `failureRate`. The random source is injected so tests are deterministic.
 */
export class MockPaymentGateway implements PaymentGateway {
  constructor(
    private readonly failureRate: number,
    private readonly random: () => number = Math.random,
  ) {}

  charge(_request: PaymentRequest): Promise<PaymentResult> {
    if (this.random() < this.failureRate) {
      return Promise.resolve({ status: 'FAILED', reason: 'card_declined (simulated)' });
    }
    return Promise.resolve({ status: 'SUCCEEDED', reference: `mockpay_${randomUUID()}` });
  }
}
