import { z } from 'zod';

/**
 * Error body for every non-2xx REST response: `{ error, message? }`. Codes are a closed enum
 * (ARCHITECTURE §5.7); `message` is for logs only, never shown to users (UI strings go through
 * i18n keys derived from `error`).
 */
export const API_ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'room_closed',
  'game_unavailable',
  'rate_limited',
  /** `MAX_ACTIVE_ROOMS` or the Neon wake governor (ARCHITECTURE §5.3 rule 7). */
  'server_busy',
  /** 503 when `GOOGLE_CLIENT_IDS` isn't set (ARCHITECTURE §5.5). */
  'google_not_configured',
  'invalid_google_token',
  'internal',
] as const;
export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  error: ApiErrorCodeSchema,
  message: z.string().max(500).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** `{ ok: true }` for endpoints that return nothing else. */
export const OkResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponseSchema>;
