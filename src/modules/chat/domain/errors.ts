import { AppError } from '../../../shared/errors/AppError.js';
import { ErrorCode } from '../../../shared/errors/errorCodes.js';

export interface QuotaExceededDetails {
  freeUsed: number;
  freeLimit: number;
  /** ISO-8601 instant when the free quota resets (1st of next month, 00:00 UTC). */
  resetsAt: string;
  /** Bundles that could still serve a message (always 0 when this error is raised). */
  activeBundles: number;
  /** Active bundles in their current period whose quota is used up. */
  exhaustedBundles: number;
}

export class QuotaExceededError extends AppError {
  override readonly name = 'QuotaExceededError';

  constructor(readonly quota: QuotaExceededDetails) {
    super(
      ErrorCode.QUOTA_EXCEEDED,
      'Monthly free quota is used up and no subscription bundle has remaining quota',
      { ...quota },
    );
  }
}

export class ChatMessageNotFoundError extends AppError {
  override readonly name = 'ChatMessageNotFoundError';

  constructor() {
    super(ErrorCode.NOT_FOUND, 'Chat message not found');
  }
}

export class LLMUnavailableError extends AppError {
  override readonly name = 'LLMUnavailableError';

  constructor(cause: unknown) {
    super(
      ErrorCode.LLM_UNAVAILABLE,
      'The AI provider did not respond in time; your quota was not charged',
      {},
      { cause },
    );
  }
}

export class ChatAccessDeniedError extends AppError {
  override readonly name = 'ChatAccessDeniedError';

  constructor() {
    super(ErrorCode.FORBIDDEN, 'Insufficient permissions');
  }
}
