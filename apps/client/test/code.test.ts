import { describe, expect, it } from 'vitest';

import { isCompleteCode, roomIsFull, sanitizeCodeInput } from '../src/lobby/code';

describe('sanitizeCodeInput', () => {
  it('upper-cases and keeps only the code alphabet', () => {
    expect(sanitizeCodeInput('k7p2qx')).toBe('K7P2QX');
    expect(sanitizeCodeInput(' k7p-2qx ')).toBe('K7P2QX');
  });

  it('drops the confusable characters 0, O, 1, I and L', () => {
    expect(sanitizeCodeInput('O0I1LK7')).toBe('K7');
  });

  it('caps the input at 6 characters', () => {
    expect(sanitizeCodeInput('ABCDEFGH')).toBe('ABCDEF');
  });

  it('pulls the code out of a pasted invite link or message', () => {
    expect(sanitizeCodeInput('https://playhub-web.onrender.com/join/k7p2qx')).toBe('K7P2QX');
    expect(
      sanitizeCodeInput('Play with me! Code K7P2QX: https://playhub-web.onrender.com/join/K7P2QX'),
    ).toBe('K7P2QX');
  });

  it('accepts only complete canonical codes', () => {
    expect(isCompleteCode('K7P2QX')).toBe(true);
    expect(isCompleteCode('K7P2Q')).toBe(false);
    expect(isCompleteCode('k7p2qx')).toBe(false);
    expect(isCompleteCode('K7P2Q0')).toBe(false);
  });
});

describe('roomIsFull', () => {
  const base = {
    roomId: '7b0f3c2e-8a51-4c1e-9d6b-2f4a1e0c9b11',
    code: 'K7P2QX',
    gameId: 'cricket',
    mode: 'hand-cricket',
    phase: 'LOBBY' as const,
    seatCount: 2,
    seatsTaken: 1,
    youAreSeated: false,
  };
  it('is open while a lobby seat is free', () => expect(roomIsFull(base)).toBe(false));
  it('is full when every seat is taken', () =>
    expect(roomIsFull({ ...base, seatsTaken: 2 })).toBe(true));
  it('is full once the match started', () =>
    expect(roomIsFull({ ...base, phase: 'IN_PROGRESS' })).toBe(true));
  it('never blocks someone already seated (rejoin)', () =>
    expect(roomIsFull({ ...base, phase: 'IN_PROGRESS', seatsTaken: 2, youAreSeated: true })).toBe(
      false,
    ));
});
