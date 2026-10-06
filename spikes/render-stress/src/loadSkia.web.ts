// Web: load CanvasKit before any module that touches Skia is evaluated.
//
// canvaskit-wasm 0.41.0's Emscripten glue only honours `locateFile` (no `instantiateWasm`, no
// `wasmBinary`), so the ARCH §6.5 "CDN with SRI + timeout, then self-hosted" loader is tested here
// as: fetch the CDN bytes ourselves with `integrity` + an 8 s abort, hand them to the glue as a
// `blob:` URL through locateFile, and fall back to the self-hosted copy on any failure.
//
// Query params: ?ck=self (default) | cdn | cdn-badsri | cdn-timeout
import { LoadSkiaWeb } from '@shopify/react-native-skia/lib/module/web';

import {
  CANVASKIT_VERSION,
  CANVASKIT_WASM_BYTES,
  CANVASKIT_WASM_SHA384,
} from './generated/canvaskitInfo';

export interface SkiaLoadInfo {
  platform: string;
  source: string;
  mode: string;
  version: string;
  wasmBytes: number;
  /** performance.now() when loading started (navigation-relative). */
  startedAt: number;
  /** CDN fetch + SRI check, when a CDN mode is used. */
  prefetchMs?: number;
  /** LoadSkiaWeb(): wasm fetch (unless prefetched) + compile + instantiate + JS init. */
  initMs: number;
  totalMs: number;
  /** Resource timing of the wasm request, if the browser exposes it. */
  wasmResource?: { durationMs: number; transferSize: number; encodedBodySize: number };
  fallbackReason?: string;
}

const CDN_BASE = 'https://cdn.jsdelivr.net/npm/canvaskit-wasm@';

async function fetchVerified(url: string, integrity: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      integrity,
      signal: controller.signal,
      mode: 'cors',
      credentials: 'omit',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    return URL.createObjectURL(new Blob([bytes], { type: 'application/wasm' }));
  } finally {
    clearTimeout(timer);
  }
}

export async function loadSkia(): Promise<SkiaLoadInfo> {
  const mode = new URLSearchParams(window.location.search).get('ck') ?? 'self';
  const selfUrl = `/canvaskit/${CANVASKIT_VERSION}/canvaskit.wasm`;
  const startedAt = performance.now();
  let wasmUrl = selfUrl;
  let source = 'self';
  let prefetchMs: number | undefined;
  let fallbackReason: string | undefined;

  if (mode.startsWith('cdn')) {
    const cdnUrl = `${CDN_BASE}${CANVASKIT_VERSION}/bin/full/canvaskit.wasm`;
    const integrity =
      mode === 'cdn-badsri'
        ? 'sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
        : CANVASKIT_WASM_SHA384;
    const timeoutMs = mode === 'cdn-timeout' ? 1 : 8000;
    const t = performance.now();
    try {
      wasmUrl = await fetchVerified(cdnUrl, integrity, timeoutMs);
      source = 'cdn';
    } catch (e) {
      source = 'self-fallback';
      fallbackReason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
    prefetchMs = performance.now() - t;
  }

  const t0 = performance.now();
  await LoadSkiaWeb({ locateFile: () => wasmUrl });
  const t1 = performance.now();

  const entry = performance
    .getEntriesByType('resource')
    .find((e) => e.name.includes('canvaskit.wasm')) as PerformanceResourceTiming | undefined;

  return {
    platform: 'web',
    source,
    mode,
    version: CANVASKIT_VERSION,
    wasmBytes: CANVASKIT_WASM_BYTES,
    startedAt,
    prefetchMs,
    initMs: t1 - t0,
    totalMs: t1 - startedAt,
    wasmResource: entry
      ? {
          durationMs: entry.duration,
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
        }
      : undefined,
    fallbackReason,
  };
}
