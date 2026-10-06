// Web: load CanvasKit on demand (only GameHost calls this, so Home never downloads the 8 MB wasm).
// The wasm is self-hosted at /canvaskit/<version>/ (copied at build from the canvaskit-wasm that the
// installed Skia resolves; see scripts/prepare-canvaskit.mjs). The CDN + SRI loader proven in
// spikes/render-stress can replace locateFile later; LoadSkiaWeb memoises a failed init, so any
// CDN fallback must be decided before this call.
import { CANVASKIT_VERSION } from '../generated/canvaskit';

export async function loadSkiaPlatform(): Promise<void> {
  const { LoadSkiaWeb } = await import('@shopify/react-native-skia/lib/module/web');
  const wasmUrl = `/canvaskit/${CANVASKIT_VERSION}/canvaskit.wasm`;
  await LoadSkiaWeb({ locateFile: () => wasmUrl });
}
