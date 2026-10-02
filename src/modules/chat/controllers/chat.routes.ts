import { Router } from 'express';
import { requestIdOf } from '../../../shared/http/errorHandler.js';
import { actorOf } from '../../../shared/http/locals.js';
import { validate } from '../../../shared/http/validate.js';
import type { ChatService } from '../domain/services/ChatService.js';
import { toMessageDto, toPageDto, toUsageDto } from './chat.controller.js';
import { AskQuestionBody, EmptyQuery, MessageIdParams, PaginationQuery } from './chat.schemas.js';

/** Mounted under /chat behind authenticate → replay protection → per-user rate limit. */
export function chatRoutes(chat: ChatService): Router {
  const router = Router();

  const ask = validate({ body: AskQuestionBody, query: EmptyQuery });
  router.post('/messages', ask, async (req, res) => {
    const { body } = ask.data(res);
    const message = await chat.ask(actorOf(res), {
      question: body.question,
      requestId: requestIdOf(req),
      ...(res.locals.abortSignal ? { signal: res.locals.abortSignal } : {}),
    });
    res.status(201).json(toMessageDto(message));
  });

  const list = validate({ query: PaginationQuery });
  router.get('/messages', list, async (_req, res) => {
    const { query } = list.data(res);
    const page = await chat.listOwnMessages(actorOf(res), query);
    res.json(toPageDto(page, query.limit, query.offset));
  });

  const getOne = validate({ params: MessageIdParams, query: EmptyQuery });
  router.get('/messages/:id', getOne, async (_req, res) => {
    const { params } = getOne.data(res);
    res.json(toMessageDto(await chat.getMessage(actorOf(res), params.id)));
  });

  const usage = validate({ query: EmptyQuery });
  router.get('/usage', usage, async (_req, res) => {
    res.json(toUsageDto(await chat.usage(actorOf(res))));
  });

  return router;
}
