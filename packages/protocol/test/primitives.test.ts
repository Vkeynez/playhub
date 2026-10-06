import { fc, test as propTest } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import {
  checkProtocol,
  generateRoomCode,
  isRoomCode,
  normalizeRoomCode,
  PROTOCOL_MIN_SUPPORTED,
  PROTOCOL_VERSION,
  REACTION_EMOJI,
  ReactionEmojiSchema,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  RoomCodeInputSchema,
  RoomCodeSchema,
  VersionSchema,
} from '../src';

describe('room code alphabet', () => {
  it('has the 31 unambiguous characters from BUILD_BRIEF §6.2', () => {
    expect(ROOM_CODE_ALPHABET).toBe('23456789ABCDEFGHJKMNPQRSTUVWXYZ');
    expect(ROOM_CODE_ALPHABET).toHaveLength(31);
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(31);
    expect(ROOM_CODE_LENGTH).toBe(6);
  });

  it('leaves out 0, O, 1, I and L', () => {
    for (const confusable of ['0', 'O', '1', 'I', 'L']) {
      expect(ROOM_CODE_ALPHABET).not.toContain(confusable);
    }
  });

  it('accepts canonical codes and rejects everything else', () => {
    expect(RoomCodeSchema.safeParse('ABC234').success).toBe(true);
    expect(RoomCodeSchema.safeParse('ZZZZZZ').success).toBe(true);

    const invalid = [
      'ABC23',
      'ABC2345',
      'abc234',
      'ABC 23',
      'ABCD0E',
      'ABCDOE',
      'ABCD1E',
      'ABCDIE',
      'ABCDLE',
      '',
    ];
    for (const code of invalid) {
      expect(RoomCodeSchema.safeParse(code).success, code).toBe(false);
      expect(isRoomCode(code), code).toBe(false);
    }
  });

  it('normalizes what people type: case, spaces and dashes', () => {
    expect(normalizeRoomCode('abc234')).toBe('ABC234');
    expect(normalizeRoomCode(' abc 234 ')).toBe('ABC234');
    expect(normalizeRoomCode('ABC-234')).toBe('ABC234');
    expect(RoomCodeInputSchema.parse('xyz789')).toBe('XYZ789');
    expect(normalizeRoomCode('abc23')).toBeNull();
    expect(normalizeRoomCode('ABCD0E')).toBeNull();
  });

  propTest.prop([fc.array(fc.nat({ max: 30 }), { minLength: 6, maxLength: 6 })])(
    'generateRoomCode always yields a valid code',
    (indices) => {
      let i = 0;
      const code = generateRoomCode(() => indices[i++] ?? 0);
      expect(isRoomCode(code)).toBe(true);
    },
  );

  it('generateRoomCode rejects a broken random source', () => {
    expect(() => generateRoomCode(() => 31)).toThrow(RangeError);
    expect(() => generateRoomCode(() => -1)).toThrow(RangeError);
    expect(() => generateRoomCode(() => 1.5)).toThrow(RangeError);
  });
});

describe('versions', () => {
  it('accepts non-negative safe integers up to 2^53 - 1', () => {
    expect(VersionSchema.safeParse(0).success).toBe(true);
    // epoch 7, step 12: 7 × 2^32 + 12
    expect(VersionSchema.safeParse(7 * 2 ** 32 + 12).success).toBe(true);
    expect(VersionSchema.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
  });

  it('rejects values that are not exact', () => {
    for (const value of [2 ** 53, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5']) {
      expect(VersionSchema.safeParse(value).success, String(value)).toBe(false);
    }
  });
});

describe('protocol compatibility', () => {
  it('exposes protocol version 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(PROTOCOL_MIN_SUPPORTED).toBeLessThanOrEqual(PROTOCOL_VERSION);
  });

  it('classifies too-old and too-new clients', () => {
    expect(checkProtocol(PROTOCOL_VERSION)).toEqual({ ok: true });
    expect(checkProtocol(1, { min: 2, max: 3 })).toEqual({ ok: false, reason: 'CLIENT_TOO_OLD' });
    expect(checkProtocol(4, { min: 2, max: 3 })).toEqual({ ok: false, reason: 'SERVER_TOO_OLD' });
  });
});

describe('reactions', () => {
  it('is the fixed set of 8 emoji from OPEN_QUESTIONS C7', () => {
    expect(REACTION_EMOJI).toEqual(['👏', '🔥', '😂', '😮', '😭', '🎉', '🙏', '😎']);
    for (const emoji of REACTION_EMOJI)
      expect(ReactionEmojiSchema.safeParse(emoji).success).toBe(true);
    for (const other of ['👍', 'hello', '', '👏👏']) {
      expect(ReactionEmojiSchema.safeParse(other).success, other).toBe(false);
    }
  });
});
