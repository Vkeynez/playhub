import { secretPick } from '@gp/game-dev-secret-pick/logic';
import type { SecretPickView } from '@gp/game-dev-secret-pick/logic';
import { ticTacToe } from '@gp/game-dev-tictactoe/logic';
import type { TicTacToeView } from '@gp/game-dev-tictactoe/logic';
import { describe, expect, it } from 'vitest';

import { createPausableClock } from '../src/room/clock';
import type { TimerApi } from '../src/room/clock';
import { LocalRoom } from '../src/room/LocalRoom';

/** Manual time: a source for the pausable clock plus a timer queue that `advance()` drains in order. */
function manualTime() {
  let now = 1_000;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const api: TimerApi = {
    setTimeout(fn, ms) {
      id += 1;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };
  function advance(ms: number) {
    const target = now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of timers) if (!next || entry[1].at < next[1].at) next = entry;
      if (!next || next[1].at > target) break;
      timers.delete(next[0]);
      now = Math.max(now, next[1].at);
      next[1].fn();
    }
    now = target;
  }
  return { source: () => now, api, advance, pending: () => timers.size };
}

const SEED = [1, 2, 3, 4] as const;

describe('LocalRoom', () => {
  it('plays a full tic-tac-toe match against the bot', async () => {
    const time = manualTime();
    const room = new LocalRoom(ticTacToe, {
      mode: 'classic',
      config: {},
      botLevel: 'easy',
      seed: SEED,
      clock: createPausableClock(time.source),
      timers: time.api,
    });
    const seen: number[] = [];
    room.subscribe((s) => seen.push(s.version));
    for (let i = 0; i < 30 && !room.getState().result; i++) {
      const view = room.getState().view as TicTacToeView;
      if (view.turn === 0) {
        const cell = view.board.findIndex((c) => c === null);
        expect(await room.submit({ type: 'place', cell })).toMatchObject({ ok: true });
      } else {
        time.advance(2_000); // bot think time is 400–1600 ms
      }
    }
    expect(room.getState().result).not.toBeNull();
    expect(room.getState().meta.finished).toBe(true);
    expect(seen.length).toBeGreaterThan(3);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    room.dispose();
  });

  it('lets the human play O, so the bot (X) moves first', async () => {
    const time = manualTime();
    const room = new LocalRoom(ticTacToe, {
      mode: 'classic',
      config: {},
      botLevel: 'easy',
      humanSeat: 1,
      seed: SEED,
      clock: createPausableClock(time.source),
      timers: time.api,
    });
    expect(room.seat).toBe(1);
    const before = room.getState().view as TicTacToeView;
    expect(before.you).toBe(1);
    expect(before.turn).toBe(0);
    expect(await room.submit({ type: 'place', cell: 4 })).toMatchObject({ ok: false });
    time.advance(2_000); // bot think time is 400–1600 ms
    const after = room.getState().view as TicTacToeView;
    expect(after.board.filter((c) => c === 0)).toHaveLength(1);
    expect(after.turn).toBe(1);
    expect(await room.submit({ type: 'place', cell: after.board.indexOf(null) })).toMatchObject({
      ok: true,
    });
    room.dispose();
  });

  it('rejects a humanSeat outside the mode', () => {
    expect(
      () =>
        new LocalRoom(ticTacToe, { mode: 'classic', config: {}, botLevel: 'easy', humanSeat: 2 }),
    ).toThrow(/humanSeat 2/);
  });

  it('rejects an action out of turn', async () => {
    const time = manualTime();
    const room = new LocalRoom(ticTacToe, {
      mode: 'classic',
      config: {},
      botLevel: 'hard',
      seed: SEED,
      clock: createPausableClock(time.source),
      timers: time.api,
    });
    await room.submit({ type: 'place', cell: 4 });
    expect(await room.submit({ type: 'place', cell: 0 })).toEqual({
      ok: false,
      reason: 'NOT_YOUR_TURN',
    });
    room.dispose();
  });

  it('never auto-moves the human seat while paused', () => {
    const time = manualTime();
    const room = new LocalRoom(secretPick, {
      mode: 'best-of-5',
      config: { pickTimerSec: 3 },
      botLevel: 'medium',
      seed: SEED,
      clock: createPausableClock(time.source),
      timers: time.api,
    });
    time.advance(2_000); // the bot picks
    const before = room.getState().version;
    room.setActive(false);
    expect(room.getState().meta.paused).toBe(true);
    time.advance(60_000);
    expect(room.getState().version).toBe(before);
    expect((room.getState().view as SecretPickView).round).toBe(1);
    room.setActive(true);
    expect(room.getState().meta.paused).toBe(false);
    time.advance(500); // still inside the 3 s pick window
    expect((room.getState().view as SecretPickView).picks[0]).toBeNull();
    time.advance(3_000); // the human's deadline passes: the engine auto-picks and reveals
    expect((room.getState().view as SecretPickView).history).toHaveLength(1);
    room.dispose();
  });

  it('stops every timer on dispose', () => {
    const time = manualTime();
    const room = new LocalRoom(secretPick, {
      mode: 'best-of-5',
      config: {},
      botLevel: 'easy',
      seed: SEED,
      clock: createPausableClock(time.source),
      timers: time.api,
    });
    room.dispose();
    expect(time.pending()).toBe(0);
  });
});
