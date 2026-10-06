import { z } from 'zod';

/**
 * Room codes (BUILD_BRIEF §6.2): 6 characters from an alphabet without the easily confused
 * 0, O, 1, I and L. A code is unique while its room is open (a partial unique index in
 * `packages/db`) and the server doesn't reuse a code for 24 h after its room closes.
 */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 6;

const ROOM_CODE_PATTERN = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

/** A canonical room code: exactly 6 upper-case characters from the alphabet. */
export const RoomCodeSchema = z
  .string()
  .regex(ROOM_CODE_PATTERN, 'Expected a 6-character room code');

/**
 * What a person may type or paste: case-insensitive, with surrounding spaces and `-` or
 * inner spaces ignored ("abc 234", "ABC-234"). Parses to the canonical code.
 */
export const RoomCodeInputSchema = z
  .string()
  .max(32)
  .transform((raw) => raw.replace(/[\s-]/g, '').toUpperCase())
  .pipe(RoomCodeSchema);

export function isRoomCode(value: string): boolean {
  return ROOM_CODE_PATTERN.test(value);
}

/** Returns the canonical code for user input, or `null` when it can't be a room code. */
export function normalizeRoomCode(input: string): string | null {
  const parsed = RoomCodeInputSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/**
 * Builds a code from an injected uniform random source, so this module stays pure.
 * The server passes `crypto.randomInt`; tests pass a seeded generator.
 *
 * @param randomInt returns an integer in `[0, maxExclusive)`.
 */
export function generateRoomCode(randomInt: (maxExclusive: number) => number): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    const index = randomInt(ROOM_CODE_ALPHABET.length);
    if (!Number.isInteger(index) || index < 0 || index >= ROOM_CODE_ALPHABET.length) {
      throw new RangeError(
        `randomInt returned ${index}, outside [0, ${ROOM_CODE_ALPHABET.length})`,
      );
    }
    code += ROOM_CODE_ALPHABET[index];
  }
  return code;
}
