import type { z } from 'zod';
import {
  GoogleAuthRequestSchema,
  GoogleAuthResponseSchema,
  GuestAuthRequestSchema,
  GuestAuthResponseSchema,
  MeSchema,
  RefreshRequestSchema,
  RefreshResponseSchema,
} from './auth';
import {
  AppVersionQuerySchema,
  AppVersionResponseSchema,
  CatalogResponseSchema,
  HealthResponseSchema,
} from './catalog';
import { OkResponseSchema } from './errors';
import {
  InviteRequestSchema,
  InviteResponseSchema,
  MatchDetailResponseSchema,
  MatchParamsSchema,
  ProfileResponseSchema,
  UpdateProfileRequestSchema,
} from './profile';
import {
  CreateRoomRequestSchema,
  CreateRoomResponseSchema,
  ResolveRoomParamsSchema,
  ResolveRoomResponseSchema,
} from './rooms';
import { SyncPushRequestSchema, SyncPushResponseSchema } from './sync';

type RouteSpec = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Fastify-style path; `:name` segments are described by `params`. */
  path: string;
  /** Requires a Bearer access token. */
  auth: boolean;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  response: z.ZodType;
};

/**
 * Every REST endpoint with its schemas, so the server validates and the client parses from one
 * table. Errors use `ApiErrorSchema`.
 */
export const restRoutes = {
  health: { method: 'GET', path: '/health', auth: false, response: HealthResponseSchema },
  authGuest: {
    method: 'POST',
    path: '/auth/guest',
    auth: false,
    body: GuestAuthRequestSchema,
    response: GuestAuthResponseSchema,
  },
  authRefresh: {
    method: 'POST',
    path: '/auth/refresh',
    auth: false,
    body: RefreshRequestSchema,
    response: RefreshResponseSchema,
  },
  authGoogle: {
    method: 'POST',
    path: '/auth/google',
    auth: false,
    body: GoogleAuthRequestSchema,
    response: GoogleAuthResponseSchema,
  },
  me: { method: 'GET', path: '/me', auth: true, response: MeSchema },
  deleteMe: { method: 'DELETE', path: '/me', auth: true, response: OkResponseSchema },
  catalog: { method: 'GET', path: '/catalog', auth: false, response: CatalogResponseSchema },
  appVersion: {
    method: 'GET',
    path: '/app/version',
    auth: false,
    query: AppVersionQuerySchema,
    response: AppVersionResponseSchema,
  },
  createRoom: {
    method: 'POST',
    path: '/rooms',
    auth: true,
    body: CreateRoomRequestSchema,
    response: CreateRoomResponseSchema,
  },
  resolveRoom: {
    method: 'GET',
    path: '/rooms/:code',
    auth: true,
    params: ResolveRoomParamsSchema,
    response: ResolveRoomResponseSchema,
  },
  profile: { method: 'GET', path: '/profile', auth: true, response: ProfileResponseSchema },
  updateProfile: {
    method: 'PATCH',
    path: '/profile',
    auth: true,
    body: UpdateProfileRequestSchema,
    response: MeSchema,
  },
  match: {
    method: 'GET',
    path: '/matches/:id',
    auth: true,
    params: MatchParamsSchema,
    response: MatchDetailResponseSchema,
  },
  syncPush: {
    method: 'POST',
    path: '/sync/push',
    auth: true,
    body: SyncPushRequestSchema,
    response: SyncPushResponseSchema,
  },
  invite: {
    method: 'POST',
    path: '/invites',
    auth: true,
    body: InviteRequestSchema,
    response: InviteResponseSchema,
  },
} as const satisfies Record<string, RouteSpec>;

export type RestRouteName = keyof typeof restRoutes;
export type RestResponse<R extends RestRouteName> = z.output<(typeof restRoutes)[R]['response']>;
