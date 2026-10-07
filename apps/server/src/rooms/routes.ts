// POST /rooms (write-through create) and GET /rooms/:code (the join screen's summary), §6.2.

import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  CreateRoomRequestSchema,
  ResolveRoomParamsSchema,
  type ApiErrorCode,
  type CreateRoomResponse,
} from '@gp/protocol';
import { authenticate } from '../auth/routes';
import type { TokenService } from '../auth/tokens';
import type { Limiters } from '../rate-limit';
import type { RoomManager } from './manager';

export interface RoomRoutesContext {
  manager: RoomManager;
  tokens: TokenService;
  limiters: Limiters;
  /** Origin of the web app; the share link is `<webBase>/join/<CODE>`. */
  webBase: string;
}

function fail(reply: FastifyReply, status: number, error: ApiErrorCode) {
  return reply.code(status).send({ error });
}

export function registerRoomRoutes(app: FastifyInstance, ctx: RoomRoutesContext): void {
  const { manager, tokens, limiters, webBase } = ctx;

  app.post('/rooms', async (request, reply) => {
    const userId = await authenticate(tokens, request);
    if (userId === null) return fail(reply, 401, 'unauthorized');
    const body = CreateRoomRequestSchema.safeParse(request.body);
    if (!body.success) return fail(reply, 400, 'bad_request');
    if (!limiters.createRoomPerUser.take(userId)) return fail(reply, 429, 'rate_limited');
    const created = await manager.create(userId, body.data);
    if (!created.ok) return fail(reply, created.status, created.error);
    const response: CreateRoomResponse = {
      roomId: created.roomId,
      code: created.code,
      joinUrl: `${webBase}/join/${created.code}`,
    };
    return response;
  });

  app.get('/rooms/:code', async (request, reply) => {
    const userId = await authenticate(tokens, request);
    if (userId === null) return fail(reply, 401, 'unauthorized');
    const params = ResolveRoomParamsSchema.safeParse(request.params);
    if (!params.success) return fail(reply, 404, 'not_found');
    const summary = await manager.summary(params.data.code, userId);
    if (summary === 'not_found') return fail(reply, 404, 'not_found');
    if (summary === 'closed') return fail(reply, 410, 'room_closed');
    return summary;
  });
}
