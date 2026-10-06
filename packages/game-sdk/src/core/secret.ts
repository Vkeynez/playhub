// Redaction model (ARCHITECTURE §3.5).
//
// 1. Secret fields in S are typed Secret<T>.
// 2. project(state, viewer) unwraps the viewer's own secrets and replaces the rest with { hidden: true }.
//    A game's viewFor is project() plus shaping.
// 3. View types are constrained to NoSecrets<V>, so a Secret can't be returned from viewFor by accident.
// 4. The contract harness proves non-interference over traces (game-sdk/testing).

import type { Seat, Viewer } from './types';

export interface Secret<T> {
  readonly __secret: true;
  /** The seat that may see the value, or 'server' for values no player sees until a reveal. */
  readonly owner: Seat | 'server';
  readonly value: T;
}

/** What a viewer sees in place of a secret they don't own. */
export interface Hidden {
  readonly hidden: true;
}

export function secret<T>(owner: Seat | 'server', value: T): Secret<T> {
  return { __secret: true, owner, value };
}

export function isSecret(value: unknown): value is Secret<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __secret?: unknown }).__secret === true &&
    'owner' in value &&
    'value' in value
  );
}

export function isHidden(value: unknown): value is Hidden {
  return (
    typeof value === 'object' && value !== null && (value as { hidden?: unknown }).hidden === true
  );
}

/** True if `viewer` may see the value of `s`. Only the owning seat can; 'server' secrets are seen by no one. */
export function canSee(s: Secret<unknown>, viewer: Viewer): boolean {
  return viewer.kind === 'seat' && s.owner === viewer.seat;
}

/** The type project() returns for T: secrets become their (projected) value or Hidden. */
export type Projected<T> =
  T extends Secret<infer U>
    ? Projected<U> | Hidden
    : T extends (...args: never[]) => unknown
      ? never
      : T extends object
        ? { -readonly [K in keyof T]: Projected<T[K]> }
        : T;

/** T with every Secret position mapped to `never`. */
export type NoSecrets<T> = T extends { readonly __secret: true }
  ? never
  : T extends object
    ? { [K in keyof T]: NoSecrets<T[K]> }
    : T;

/** `true` if a Secret can appear anywhere inside T, otherwise `false`. */
export type ContainsSecret<T> = true extends SecretFlags<T> ? true : false;

/** Union of per-position flags; `true` is in the union iff some position can hold a Secret. */
type SecretFlags<T> = T extends { readonly __secret: true }
  ? true
  : T extends (...args: never[]) => unknown
    ? false
    : T extends readonly (infer Item)[]
      ? SecretFlags<Item>
      : T extends object
        ? { [K in keyof T]-?: SecretFlags<T[K]> }[keyof T]
        : false;

/**
 * The compile-time check that view and event types carry no secrets (ARCHITECTURE §3.5 step 3).
 * Intersected into defineGame() and MatchEngine.create() parameters: it is `unknown` for a secret-free
 * type and an impossible object type otherwise, so passing a module whose V contains a Secret fails to
 * compile. (A direct `V extends NoSecrets<V>` constraint is circular, TS2313.)
 */
export type AssertNoSecrets<T> = [ContainsSecret<T>] extends [false]
  ? unknown
  : { 'error: this type contains a Secret<T>; project() it first': never };

/**
 * Unwraps the viewer's own secrets and replaces every other secret with { hidden: true }.
 * Returns a fresh structure and never mutates `value`, so it is safe on deep-frozen state.
 */
export function project<T>(value: T, viewer: Viewer): Projected<T> {
  return projectValue(value, viewer) as Projected<T>;
}

function projectValue(value: unknown, viewer: Viewer): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (isSecret(value))
    return canSee(value, viewer) ? projectValue(value.value, viewer) : { hidden: true };
  if (Array.isArray(value)) return value.map((item) => projectValue(item, viewer));
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) out[key] = projectValue(child, viewer);
  return out;
}

export type SecretPath = readonly (string | number)[];

/**
 * Returns a copy of `value` with each Secret replaced by `fn(secret, path)`. Non-secret parts are copied
 * unchanged. Used by redaction adapters to perturb hidden values.
 */
export function mapSecrets<T>(
  value: T,
  fn: (s: Secret<unknown>, path: SecretPath) => Secret<unknown>,
): T {
  return mapSecretsAt(value, [], fn) as T;
}

function mapSecretsAt(
  value: unknown,
  path: (string | number)[],
  fn: (s: Secret<unknown>, path: SecretPath) => Secret<unknown>,
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (isSecret(value)) return fn(value, path);
  if (Array.isArray(value)) return value.map((item, i) => mapSecretsAt(item, [...path, i], fn));
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value))
    out[key] = mapSecretsAt(child, [...path, key], fn);
  return out;
}

/** Every Secret inside `value`, with its path. */
export function findSecrets(value: unknown): { path: SecretPath; secret: Secret<unknown> }[] {
  const found: { path: SecretPath; secret: Secret<unknown> }[] = [];
  mapSecrets(value, (s, path) => {
    found.push({ path, secret: s });
    return s;
  });
  return found;
}
