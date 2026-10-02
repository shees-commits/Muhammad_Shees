import type { RequestHandler } from 'express';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import { httpStatusFor, requestIdOf, toErrorBody } from './errorHandler.js';

/**
 * Global request deadline. When it fires, the client gets 503 REQUEST_TIMEOUT
 * and `res.locals.abortSignal` is aborted so in-flight work (e.g. the LLM call)
 * can stop and compensate. Anything the handler tries to send afterwards is
 * dropped by the error handler, so there is never a double response.
 */
export function requestTimeout(timeoutMs: number): RequestHandler {
  return (req, res, next) => {
    const controller = new AbortController();
    res.locals.abortSignal = controller.signal;

    const timer = setTimeout(() => {
      const error = new AppError(ErrorCode.REQUEST_TIMEOUT, 'Request timed out');
      controller.abort(error);
      if (!res.headersSent) {
        res.status(httpStatusFor(error.code)).json(toErrorBody(error, requestIdOf(req)));
      }
    }, timeoutMs);

    const clear = (): void => {
      clearTimeout(timer);
    };
    res.once('finish', clear);
    res.once('close', clear);
    next();
  };
}
