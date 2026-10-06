import { z } from 'zod';
import {
  GameIdSchema,
  ModeIdSchema,
  RoomIdSchema,
  RoomPhaseSchema,
  SeatCountSchema,
} from '../primitives';
import { RoomCodeInputSchema, RoomCodeSchema } from '../room-code';

/* Rooms over REST (BUILD_BRIEF §6.2). Joining and everything after it happens on the socket. */

// POST /rooms (write-through: the code is returned only after the row commits)
export const CreateRoomRequestSchema = z.object({
  gameId: GameIdSchema,
  mode: ModeIdSchema,
  seatCount: SeatCountSchema,
  /** Game-specific lobby options; validated by the game's `configSchema`. */
  options: z.unknown(),
});
export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>;

export const CreateRoomResponseSchema = z.object({
  roomId: RoomIdSchema,
  code: RoomCodeSchema,
  /** `https://<web domain>/join/<CODE>` */
  joinUrl: z.url(),
});
export type CreateRoomResponse = z.infer<typeof CreateRoomResponseSchema>;

// GET /rooms/:code (resolve a code from a link or the "Enter code" box)
export const ResolveRoomParamsSchema = z.object({ code: RoomCodeInputSchema });
export type ResolveRoomParams = z.infer<typeof ResolveRoomParamsSchema>;

/** Closed or expired rooms answer 404 `not_found` or 410 `room_closed` instead. */
export const ResolveRoomResponseSchema = z.object({
  roomId: RoomIdSchema,
  code: RoomCodeSchema,
  gameId: GameIdSchema,
  mode: ModeIdSchema,
  phase: RoomPhaseSchema,
  seatCount: SeatCountSchema,
  seatsTaken: z.int().min(0).max(8),
  /** The caller already holds a seat here, so joining rejoins it. */
  youAreSeated: z.boolean(),
});
export type ResolveRoomResponse = z.infer<typeof ResolveRoomResponseSchema>;
