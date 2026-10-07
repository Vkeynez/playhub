// ARCHITECTURE §3.4: seeded content generators must give identical output on Hermes and V8, so the
// logic may only use integer arithmetic and basic + − × ÷. This scans the source for anything else.
import { describe, expect, it } from 'vitest';

declare global {
  interface ImportMeta {
    glob(
      pattern: string[],
      options: { query: '?raw'; import: 'default'; eager: true },
    ): Record<string, string>;
  }
}

const sources = import.meta.glob(['../*.ts', '../../content/*.ts', '../../manifest.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Math functions whose results may differ between engines, plus anything non-deterministic. */
const FORBIDDEN =
  /\bMath\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|pow|exp|expm1|log|log1p|log2|log10|sqrt|cbrt|hypot|random|fround)\b|\*\*|\bDate\b|\bperformance\b|\bsetTimeout\b|\bsetInterval\b|toFixed|toPrecision|toLocaleString|localeCompare|Intl\./;

describe('cross-engine safety', () => {
  it('finds the logic sources', () => {
    const names = Object.keys(sources);
    expect(names.some((n) => n.endsWith('/generator.ts'))).toBe(true);
    expect(names.some((n) => n.endsWith('/solver.ts'))).toBe(true);
    expect(names.some((n) => n.endsWith('/palette.ts'))).toBe(true);
  });

  it('the scan catches the forbidden forms', () => {
    for (const bad of ['Math.sin(x)', 'Math.random()', 'a ** 2', 'Date.now()', 'x.toFixed(2)']) {
      expect(FORBIDDEN.test(bad), bad).toBe(true);
    }
    for (const ok of ['Math.imul(a, b)', 'Math.min(a, b)', '(a / 3) | 0', 'a * b + c']) {
      expect(FORBIDDEN.test(ok), ok).toBe(false);
    }
  });

  it.each(Object.entries(sources))('%s uses no engine-dependent or impure APIs', (_name, text) => {
    const hits = text
      .split('\n')
      .map((line, i) => ({ line: line.replace(/\/\/.*$/, ''), n: i + 1 }))
      .filter(({ line }) => !/^\s*(\*|\/\*)/.test(line) && FORBIDDEN.test(line))
      .map(({ line, n }) => `${n}: ${line.trim()}`);
    expect(hits).toEqual([]);
  });
});
