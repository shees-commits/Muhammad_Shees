import { z } from 'zod';
import { sanitizeText } from '../../../shared/http/sanitize.js';

export const MAX_QUESTION_LENGTH = 2000;

/** Only `question` is accepted; userId, quota source, tokens etc. are derived server-side. */
export const AskQuestionBody = z.strictObject({
  question: z
    .string()
    .transform(sanitizeText)
    .pipe(
      z
        .string()
        .min(1, 'question must contain text')
        .max(MAX_QUESTION_LENGTH, `question must be at most ${MAX_QUESTION_LENGTH} characters`),
    ),
});

export const MessageIdParams = z.strictObject({ id: z.uuid() });

export const PaginationQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export const EmptyQuery = z.strictObject({});
