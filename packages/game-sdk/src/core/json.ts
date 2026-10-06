// JSON helpers shared by the engine, the harness and persistence.
// Snapshots are stored as jsonb, so everything the engine keeps must survive JSON.stringify/parse
// exactly (ARCHITECTURE §3.3): no Map, Set, undefined, bigint, NaN/Infinity, functions or class instances.

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Deep copy through JSON, i.e. exactly what a jsonb round trip gives back. `undefined` becomes null. */
export function jsonClone<T>(value: T): T {
  if (value === undefined) return null as T;
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Freezes `value` and everything reachable from it; returns it. Used to prove reducers don't mutate input. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Lists the reasons `value` would not survive a JSON round trip unchanged.
 * An empty array means the value is JSON-safe.
 */
export function jsonSafetyIssues(value: unknown, path = '$'): string[] {
  const issues: string[] = [];
  collectJsonIssues(value, path, issues, new Set());
  return issues;
}

function collectJsonIssues(
  value: unknown,
  path: string,
  issues: string[],
  seen: Set<object>,
): void {
  if (value === null) return;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return;
    case 'number':
      if (!Number.isFinite(value)) issues.push(`${path}: non-finite number ${String(value)}`);
      else if (Object.is(value, -0)) issues.push(`${path}: -0 becomes 0 in JSON`);
      return;
    case 'undefined':
      issues.push(`${path}: undefined`);
      return;
    case 'bigint':
    case 'symbol':
    case 'function':
      issues.push(`${path}: ${typeof value}`);
      return;
    default:
      break;
  }
  const obj = value as object;
  if (seen.has(obj)) {
    issues.push(`${path}: circular reference`);
    return;
  }
  seen.add(obj);
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (!(i in obj)) issues.push(`${path}[${i}]: array hole`);
      else collectJsonIssues(obj[i], `${path}[${i}]`, issues, seen);
    }
  } else {
    const proto: unknown = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      const name = (obj as { constructor?: { name?: string } }).constructor?.name ?? 'unknown';
      issues.push(`${path}: non-plain object (${name})`);
    } else {
      for (const [key, child] of Object.entries(obj))
        collectJsonIssues(child, `${path}.${key}`, issues, seen);
    }
  }
  seen.delete(obj);
}

/** JSON with object keys sorted, so equal values always produce equal strings. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) out[key] = sortKeys(child);
  }
  return out;
}

/** 64-bit FNV-1a over the UTF-16 code units of `text`, as 16 hex characters. Integer math only. */
export function hashString(text: string): string {
  // Two independent 32-bit FNV-1a lanes with different offset bases.
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (a >>> 15);
  }
  return hex32(a) + hex32(b);
}

/** Stable hash of a JSON value; the harness compares state hashes across replays. */
export function hashJson(value: unknown): string {
  return hashString(stableStringify(value));
}

function hex32(n: number): string {
  return (n >>> 0).toString(16).padStart(8, '0');
}
