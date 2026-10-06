import { z } from 'zod';
import {
  AvatarSeedSchema,
  DeviceIdSchema,
  DisplayNameSchema,
  GameIdSchema,
  LocaleSchema,
  PlatformSchema,
  UserIdSchema,
  WallTimeMsSchema,
} from '../primitives';

/* Identity & auth DTOs (ARCHITECTURE §7). */

/**
 * The local identity's key: at least 128 random bits, encoded as base64url (22+ chars) or hex.
 * `POST /auth/guest` is idempotent on it for 10 minutes.
 */
export const GuestKeySchema = z
  .string()
  .min(22)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'Expected a base64url or hex guest key');

export const USER_KINDS = ['guest', 'google'] as const;
export const UserKindSchema = z.enum(USER_KINDS);
export type UserKind = z.infer<typeof UserKindSchema>;

/** The signed-in user, as returned to themselves. */
export const MeSchema = z.object({
  userId: UserIdSchema,
  kind: UserKindSchema,
  name: DisplayNameSchema,
  avatarSeed: AvatarSeedSchema,
  locale: LocaleSchema,
  muteInvites: z.boolean(),
  /** Present only for Google accounts. */
  email: z.email().nullable(),
});
export type Me = z.infer<typeof MeSchema>;

/**
 * Tokens issued by every auth endpoint. In cookie transport mode (`AUTH_TRANSPORT=cookie`) the
 * refresh token travels in an httpOnly cookie instead, so `refreshToken` is omitted.
 */
export const AuthSessionSchema = z.object({
  accessToken: z.string().min(1).max(4096),
  /** Wall time when the 15-minute access JWT expires. */
  accessTokenExpiresAt: WallTimeMsSchema,
  refreshToken: z.string().min(1).max(512).optional(),
  user: MeSchema,
});
export type AuthSession = z.infer<typeof AuthSessionSchema>;

// POST /auth/guest
export const GuestAuthRequestSchema = z.object({
  guestKey: GuestKeySchema,
  name: DisplayNameSchema,
  avatarSeed: AvatarSeedSchema,
  locale: LocaleSchema.optional(),
  platform: PlatformSchema.optional(),
  deviceId: DeviceIdSchema.optional(),
});
export type GuestAuthRequest = z.infer<typeof GuestAuthRequestSchema>;
export const GuestAuthResponseSchema = AuthSessionSchema;

// POST /auth/refresh
export const RefreshRequestSchema = z.object({
  /** Bearer transport only; cookie transport reads the cookie. */
  refreshToken: z.string().min(1).max(512).optional(),
});
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;
export const RefreshResponseSchema = AuthSessionSchema;

// POST /auth/google (Bearer: the current access token, guest or Google)
export const GoogleAuthRequestSchema = z.object({
  idToken: z.string().min(1).max(8192),
  deviceId: DeviceIdSchema.optional(),
});
export type GoogleAuthRequest = z.infer<typeof GoogleAuthRequestSchema>;

/**
 * - `linked`: the guest became a Google account.
 * - `merged`: the guest was merged into an existing Google account.
 * - `switched`: the caller was already a Google user; now signed in as the other account.
 * - `signed_in`: no caller session; plain sign-in.
 */
export const GOOGLE_AUTH_OUTCOMES = ['linked', 'merged', 'switched', 'signed_in'] as const;

/** Drives "Merged 12 matches + Lantern Quest progress". */
export const MergeSummarySchema = z.object({
  matches: z.int().min(0),
  progressGameIds: z.array(GameIdSchema).max(64),
});

export const GoogleAuthResponseSchema = AuthSessionSchema.extend({
  outcome: z.enum(GOOGLE_AUTH_OUTCOMES),
  merged: MergeSummarySchema.nullable(),
});
export type GoogleAuthResponse = z.infer<typeof GoogleAuthResponseSchema>;
