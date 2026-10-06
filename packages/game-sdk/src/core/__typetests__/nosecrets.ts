// Compile-time checks only; tsc runs this file as part of typecheck.
import type { AssertNoSecrets, ContainsSecret, Secret } from '../secret';

type Expect<T extends true> = T;
export type T1 = Expect<
  [ContainsSecret<{ a: number; b: { c: string[] } }>] extends [false] ? true : false
>;
export type T2 = Expect<ContainsSecret<{ a: Secret<number> }>>;
export type T3 = Expect<ContainsSecret<{ a: { b: (Secret<number> | null)[] } }>>;
export type T4 = Expect<ContainsSecret<[Secret<number> | null, Secret<number> | null]>>;
export type T5 = Expect<[ContainsSecret<unknown>] extends [false] ? true : false>;

const ok: AssertNoSecrets<{ a: number }> = 1;
// @ts-expect-error a type containing a Secret must not satisfy the check
const bad: AssertNoSecrets<{ a: Secret<number> }> = {};
export { ok, bad };
