import { AppError } from '../../../shared/errors/AppError.js';
import { ErrorCode } from '../../../shared/errors/errorCodes.js';

export class SubscriptionNotFoundError extends AppError {
  override readonly name = 'SubscriptionNotFoundError';

  constructor() {
    super(ErrorCode.NOT_FOUND, 'Subscription not found');
  }
}

export class AlreadyCancelledError extends AppError {
  override readonly name = 'AlreadyCancelledError';

  constructor(subscriptionId: string) {
    super(ErrorCode.ALREADY_CANCELLED, 'Subscription is already cancelled', { subscriptionId });
  }
}

export class InvalidStateTransitionError extends AppError {
  override readonly name = 'InvalidStateTransitionError';

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(ErrorCode.INVALID_STATE_TRANSITION, message, details);
  }
}

/** Optimistic-concurrency conflict: the subscription changed since it was read. */
export class ConcurrentModificationError extends AppError {
  override readonly name = 'ConcurrentModificationError';

  constructor(subscriptionId: string) {
    super(
      ErrorCode.INVALID_STATE_TRANSITION,
      'Subscription was modified concurrently; reload and retry',
      { subscriptionId },
    );
  }
}

export class PaymentFailedError extends AppError {
  override readonly name = 'PaymentFailedError';

  constructor(subscriptionId: string, reason: string) {
    super(ErrorCode.PAYMENT_FAILED, 'Payment was declined; the subscription is inactive', {
      subscriptionId,
      reason,
    });
  }
}

export class SubscriptionAccessDeniedError extends AppError {
  override readonly name = 'SubscriptionAccessDeniedError';

  constructor() {
    super(ErrorCode.FORBIDDEN, 'Insufficient permissions');
  }
}
