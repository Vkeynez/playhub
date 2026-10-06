// The contract between GameHost and a game's UI module (ARCHITECTURE §3.7, §6.3).
// A game UI never knows whether it talks to an in-process engine (LocalRoom) or the server (RemoteRoom).
//
// Kept in the client until packages/game-sdk grows its React-only `client/` entry point; game UI
// packages should mirror these types structurally (no import from @gp/client).

import type {
  AnyGameModule,
  BotLevel,
  GameEvent,
  GameManifest,
  MatchResult,
  Seat,
} from '@gp/game-sdk/core';
import type { EngineMeta } from '@gp/game-sdk/engine';
import type { ComponentType } from 'react';

export type SubmitResult = { ok: true; version: number } | { ok: false; reason: string };

/** One published state of a room, as seen by this client's seat. */
export interface RoomState<V = unknown, E extends GameEvent = GameEvent> {
  version: number;
  view: V;
  /** Events of the step that produced this state (already redacted for this viewer). */
  events: readonly E[];
  meta: EngineMeta;
  result: MatchResult | null;
}

export interface RoomTransport<V = unknown, A = unknown, E extends GameEvent = GameEvent> {
  subscribe(fn: (state: RoomState<V, E>) => void): () => void;
  getState(): RoomState<V, E>;
  submit(action: A): Promise<SubmitResult>;
  /** null = spectator / replay. */
  readonly seat: Seat | null;
  /** RemoteRoom: performance.now() + offset. LocalRoom: a pausable monotonic clock. Same unit as meta deadlines. */
  serverNow(): number;
}

/** Props every game Screen receives from GameHost. */
export interface GameScreenProps<V = unknown, A = unknown, E extends GameEvent = GameEvent> {
  view: V;
  events: readonly E[];
  version: number;
  meta: EngineMeta;
  seat: Seat | null;
  submit(action: A): Promise<SubmitResult>;
  serverNow(): number;
  mode: string;
  config: unknown;
  botLevel: BotLevel;
}

/** What a game's lazily loaded `ui` entry provides. */
export interface GameUiModule {
  Screen: ComponentType<GameScreenProps<never, never, never>>;
  /** Fonts, sounds: resolved before the match starts. */
  loadAssets?(): Promise<void>;
}

/** A registry entry: the manifest is eager (drives Home offline); logic and UI are lazy chunks. */
export interface GameRegistration {
  manifest: GameManifest;
  logic(): Promise<AnyGameModule>;
  load(): Promise<GameUiModule>;
  /** The UI creates Skia objects: on web, CanvasKit must be loaded before `load()` runs. */
  usesSkia: boolean;
  /**
   * Lets the player pick their seat before a vs-bot match, e.g. X or O. `labels[i]` names seat i;
   * seat 0 moves first.
   */
  seatChoice?: { labels: readonly string[] };
}
