# Spike (a) + (d): results (draft, local parts)

Phase 0, P0-M1. Throwaway code in `spikes/render-stress`. Measured on 2026-10-05/06 on the owner's corporate Mac.

**Read this first.** These numbers are from an Apple M4 laptop, a headless Chrome on swiftshader and an Android
**emulator**. None of them stand in for a ~4 GB mid-range phone. They answer "does it work?" (yes/no questions) with
confidence. They only bound "is it fast enough?". The phone run in §8 is what closes P0-M1.

## 0. Verdicts at a glance

| Question                                                               | Verdict                                                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Skia Atlas + RSXform filled in a `useFrameCallback` worklet, on SDK 57 | **Works** on Android release (Hermes) and web.                                                               |
| Animated SkSL `RuntimeEffect`                                          | **Works** on both platforms (seen on web; no compile error logged on Android).                               |
| Particle stress 500 / 1000 / 2000                                      | **60 fps UI-thread cadence on the emulator** up to 4000; presented-frame data inconclusive → phone run.      |
| Tamil with Skia `Paragraph` + bundled Noto Sans Tamil                  | **Correct** on Android and web (web needs `pushStyle`, see §6).                                              |
| CanvasKit under strict CSP (`'wasm-unsafe-eval'`, no `'unsafe-eval'`)  | **Works**, zero violations.                                                                                  |
| ARCH §6.5 loader via Emscripten `instantiateWasm`                      | **Not possible** with canvaskit-wasm 0.41.0. CDN+SRI works another way, but needs `blob:` in `connect-src`.  |
| 16 KB page size (Android 15+ requirement)                              | **Passes**: loads and runs on a 16 KB image; every 64-bit `.so` is 16 KB aligned; `zipalign -P 16` passes.   |
| APK size vs the 60 MB budget                                           | Universal APK **123.3 MB (fails)**; arm64-only ≈ 40 MB (estimate) → ship AAB / ABI splits.                   |
| planck carrom shot, Node (server)                                      | **1.8 ms/shot**, ~52 steps. Fine for Render's 0.1 CPU even at 10×.                                           |
| planck carrom shot, Hermes (in app)                                    | **19-20 ms/shot** on the emulator (M4 host). Expect ~40-80 ms on a mid-range phone: fits the 300 ms wind-up. |
| OQ I8 (SDK 57 or 58)                                                   | SDK 57 is good for everything tested. The SDK 58 comparison was not run (follow-up).                         |

## 1. Setup

| Item         | Value                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| App          | `create-expo-app@5.0.0 --template blank-typescript@sdk-57`, New Architecture, Hermes, release build                  |
| Client stack | expo 57.0.26, react-native 0.86.3, react 19.2.3, Skia 2.6.2, Reanimated 4.5.1, worklets 0.10.1, RN-web 0.21.3        |
| CanvasKit    | canvaskit-wasm **0.41.0**, derived from the installed Skia by `scripts/prepare-canvaskit.mjs`; Skia loads `bin/full` |
| Android tool | Gradle 9.3.1 (wrapper), AGP 8.12.0, NDK 27.1.12297006, JDK Zulu 17.0.20.1, minSdk 24, targetSdk 36                   |
| Hermes       | `250829098.0.17 Release` (from `HermesInternal.getRuntimeProperties()`)                                              |
| Host         | Apple M4 (10 cores), macOS 26 (Darwin 25.6), Node 24.21.0                                                            |
| Emulator     | `emulator-5554`, Pixel 9 Pro XL, `sdk_gphone16k_arm64`, API 37, **PAGE_SIZE 16384**, 4 GB RAM, 60 Hz, 1344×2992 @3×  |
| Emulator GPU | "Android Emulator OpenGL ES Translator (Apple M4), OpenGL ES 3.0 (4.1 Metal)"                                        |
| Browser      | Google Chrome 149.0.7827.201 headless via Playwright 1.63.0 (`channel: 'chrome'`), swiftshader, 412×915 @2×          |

## 2. Method

**App** (`App.tsx`, `src/`). `App.tsx` loads Skia first (on web, CanvasKit through `src/loadSkia.web.ts`). It then
lazy-imports the spike. Auto mode runs these steps in order:

1. Tamil sample.
2. Stress at 500, 1000, 2000 and 4000 particles, then **500 again**.
3. The planck bench.

Every result leaves the app as one `SPIKE <kind> <json>` console line (Android logcat) and `window.__spike` (web).
`AppState` changes are logged too, so a run that lost the foreground is visible in its own log. The toolbar runs any
step by hand. In manual mode the Tamil screen stays up.

**Stress screen** (`src/screens/StressScreen.tsx`):

- N sprites from a procedural 4-dot sheet are drawn with **one `<Atlas>`**.
- Each frame a `useFrameCallback` worklet:
  1. runs a fixed 1/60 s step over a `Float32Array` (positions, velocities, spin) held in a shared value;
  2. interpolates (`alpha = acc / STEP`) into a preallocated `RSXform` array, mutated in place with
     `.set()`, then calls one `modify(undefined, true)`.
- Behind the sprites, a full-screen animated SkSL plasma `RuntimeEffect` is driven by a time uniform.
- This follows ARCH §6.4: dt is clamped to 100 ms, a null dt counts as 0, there is no React state per frame, and the HUD
  gets a throttled `scheduleOnRN` twice a second.

**Frame stats** (`src/frameStats.ts`):

- **What is recorded.** The worklet records `timeSincePreviousFrame` into a 0.25 ms-bin histogram (`Float64Array`, no
  allocation). Each step has 2 s of warm-up, then 10 s measured. Percentiles are bin upper edges, so `16.75` means a
  16.67 ms frame.
- **"work"** is the time spent inside the worklet (sim step + RSXform fill, without the Skia draw), timed with
  `performance.now()`.
- **What it actually measures.** This is **UI-thread vsync cadence** (Choreographer on Android, rAF on web). It is not
  presentation, so on Android I also took HWUI's view with `dumpsys gfxinfo` per step. `scripts/android-run.sh` resets
  gfxinfo when a step reports and dumps it when the next step does. Each window is one stress screen (12 s).

**Web harness:**

- `npx expo export --platform web`, served by `scripts/serve.mjs` with an **enforced** CSP:
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://cdn.jsdelivr.net blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
  plus COOP `same-origin-allow-popups`, Permissions-Policy and the ARCH §6.5 cache rules.
- Violations are counted twice: by a `securitypolicyviolation` listener in the page, and on the server's `report-uri`.
- `scripts/web-measure.mjs` runs, in order:
  1. a cold full auto run;
  2. a warm reload;
  3. `WebAssembly.compile` alone, 3×;
  4. each loader mode in a fresh context (`?ck=cdn`, `cdn-badsri`, `cdn-timeout`);
  5. the CDN mode against a CSP **without** `blob:`.

**Android harness:**

- `expo prebuild` → `gradlew assembleRelease` (all 4 ABIs), installed with `adb install -r`, launched with `am start`.
- Per-step stats come from `scripts/android-run.sh` (runs 4 and 5).
- APK checks:
  - `zipalign -c -P 16`;
  - `llvm-readelf -l` on every `.so` (`LOAD` alignment);
  - `unzip -lv` for per-ABI sizes.

**planck bench** (`src/carrom/carromBench.ts`, the same file on Node, Hermes and V8):

- **Units and board.** Units are decimetres, so planck's default slop and speed limits fit. The board is a 74 cm square
  with 4 static wall boxes (restitution 0.6).
- **Pieces.** 19 coins (Ø 3.18 cm, 5.5 g) in the standard rosette, plus a striker (Ø 4.13 cm, 15 g). Restitution 0.8,
  friction 0.15, `linearDamping` 0.3, `angularDamping` 2.
- **Board friction.** Coulomb-style, μ = 0.18, applied as a velocity cut after each step.
- **Pockets.** 4 pockets (Ø 4.45 cm) remove a body when its centre enters.
- **Each shot** starts from a fresh world. The striker is flicked from the baseline toward the centre at 3-7 m/s.
  The world is stepped at 60 Hz (8/3 iterations) until every body is below 1 mm/s, capped at 8 s (480 steps).
- **Seeding.** Seeded mulberry32. Two configurations: every body a bullet (CCD everywhere), and only the striker a bullet.
- **Runs.** Node runs 20 warm-up + 200 timed shots (`scripts/bench-node.mjs`). The app runs 10 warm-up + 100 timed shots.

## 3. Spike (a): web

### 3.1 CanvasKit under strict CSP

- **CanvasKit initialises under the enforced CSP with zero violations.** That covers the full auto run, warm reload and
  every loader mode: 0 in the page listener and 0 on the server's report endpoint.
- `'wasm-unsafe-eval'` is enough. The 0.41.0 glue (`bin/full/canvaskit.js`, 123,600 B) contains no `eval(` or
  `new Function`.
- Expo's exported `index.html` has no inline script, so `script-src 'self'` holds.

### 3.2 Version and size (`scripts/prepare-canvaskit.mjs`)

| Build Skia 2.6.2 loads                                      | Raw             | gzip -9         | brotli -11      |
| ----------------------------------------------------------- | --------------- | --------------- | --------------- |
| `canvaskit-wasm@0.41.0/bin/full/canvaskit.wasm`             | **8,076,553 B** | **3,268,890 B** | **2,512,035 B** |
| jsDelivr's response for that file (as served, compressed)   | —               | 3,252,066 B     | —               |
| (for reference: `bin/canvaskit.wasm`, the non-`full` build) | 7,155,822 B     | —               | —               |

SRI: `sha384-jtjO/LLhv1uxHy8aHcmn84PPmewsddPVZB0MvjDTunHvvOrXWUREw74EZkgSK0TJ`. The ARCH §6.5 reference figure
("7.2 MB raw / 2.9 MB gz") matches the non-`full` build. Skia needs `full` (Paragraph), so the real figure is
**8.08 MB raw / 3.27 MB gz / 2.51 MB br**.

### 3.3 CanvasKit fetch + compile time (headless Chrome 149, M4, two runs)

| Path                                                   | Result                                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Self-hosted, cold (loopback)                           | `LoadSkiaWeb` 38-42 ms in total (wasm request 26 ms); ready ~120 ms after navigation start                             |
| Self-hosted, warm reload                               | 33-40 ms                                                                                                               |
| `WebAssembly.compile` of the 8 MB module alone         | 5.7-7.0 ms (V8 compiles lazily with Liftoff; tier-up comes later)                                                      |
| CDN: jsDelivr fetch with SRI, then blob → `locateFile` | prefetch **0.98-1.40 s** over this office network (3.25 MB on the wire), then 23-24 ms init                            |
| CDN, wrong SRI hash                                    | integrity error → falls back to self-hosted; total 0.97-1.06 s (the whole file downloads before the check)             |
| CDN, timeout (forced to 1 ms)                          | `AbortError` → falls back to self-hosted; total 42-45 ms                                                               |
| CDN, CSP **without** `blob:` in `connect-src`          | **Fails with no fallback**: CSP blocks the blob fetch, then `Aborted(both async and sync fetching of the wasm failed)` |

On loopback the transfer costs nothing, so on a real network the transfer time dominates: 3.27 MB gz / 2.51 MB br. The
device's Chrome numbers (cold, and SW-warm per PERF.md) come from the phone run.

**Why the loader works differently from ARCH §6.5.** ARCH planned to pass an Emscripten `instantiateWasm` hook through
`LoadSkiaWeb(opts)`. The 0.41.0 glue has **no `instantiateWasm` and no `wasmBinary`** (0 occurrences), only
`locateFile` + `instantiateStreaming`. The working design (`src/loadSkia.web.ts`) is:

1. `fetch(cdnUrl, { integrity, signal })` with an 8 s abort;
2. wrap the verified bytes in a `blob:` URL and pass it to the glue through `locateFile`;
3. on any error, use `locateFile` → `/canvaskit/<ver>/canvaskit.wasm` (self-hosted).

This needs **`blob:` in `connect-src`**, which the ARCH CSP doesn't have. A second trap: `LoadSkiaWeb` memoises its init
promise (`ckSharedPromise ??= CanvasKitInit(opts)`). If init ever fails, it can't be retried in the same page, so the
fallback has to happen **before** `LoadSkiaWeb` (as here), or the loader must call `CanvasKitInit` itself.

### 3.4 Frame stats on web (swiftshader: CPU rasteriser, indicative only)

Headless Chrome with `--use-angle=swiftshader` renders WebGL on the CPU. These numbers say nothing about a phone GPU.
`work` times are below Chrome's 100 µs `performance.now()` clamp (no cross-origin isolation), so they are not meaningful.

| Particles   | mean fps | p50 ms | p95 ms | p99 ms | > 20 ms | > 33 ms |
| ----------- | -------- | ------ | ------ | ------ | ------- | ------- |
| 500         | 59.5     | 16.75  | 17.0   | 17.5   | 0.2 %   | 0.2 %   |
| 1000        | 59.6     | 16.75  | 17.25  | 17.75  | 0.2 %   | 0.2 %   |
| 2000        | 58.9     | 16.75  | 17.25  | 17.75  | 0.3 %   | 0.3 %   |
| 4000        | 49.9     | 16.75  | 33.5   | 34.0   | 19.0 %  | 5.6 %   |
| 500 (again) | 59.6     | 16.75  | 17.0   | 17.5   | 0.2 %   | 0.2 %   |

The first run (same build without the repeat step) agreed within 0.4 fps at every count. At 4000 it showed 50.2 fps and
7.2 % > 33 ms.

## 4. Spike (a): Android (release APK on the emulator)

### 4.1 16 KB pages: passes

- The emulator image runs **16 KB pages** (`getconf PAGE_SIZE` = 16384). The release app loads and runs: Hermes,
  `librnskia.so`, Reanimated and worklets all load straight from `base.apk!/lib/arm64-v8a/`, since
  `expo.useLegacyPackaging=false` keeps them uncompressed.
- `zipalign -c -P 16 -v 4 app-release.apk` → `Verification successful`.
- `llvm-readelf -l`: every `.so` for **arm64-v8a and x86_64** has 16 KB (`0x4000`) `LOAD` alignment (17 libs per ABI).
  The armeabi-v7a libs are 4 KB aligned, which is irrelevant because the 16 KB rule only applies to 64-bit.

### 4.2 APK size (`assembleRelease`, all 4 ABIs, no R8/minify, `.so` stored uncompressed)

| Item                                                        | Size                                                                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Universal APK                                               | **123.3 MB** (123,320,728 B)                                                                                                                                 |
| `lib/arm64-v8a` (17 `.so`)                                  | **27.90 MB**                                                                                                                                                 |
| `lib/x86_64` / `lib/x86` / `lib/armeabi-v7a`                | 28.71 / 29.39 / 19.03 MB                                                                                                                                     |
| Everything else                                             | 11.91 MB stored (2 dex: 3.5 + 3.5 MB compressed; Hermes bundle 2.6 MB; font; resources)                                                                      |
| Largest arm64 libs                                          | `librnskia` 10.78, `libreactnative` 6.66, `libhermesvm` 2.36, `libreanimated` 1.43, `libexpo-modules-core` 1.43, `libc++_shared` 1.23, `libworklets` 1.05 MB |
| Fresco gif/webp libs (on by default in `gradle.properties`) | ~1.3 MB per ABI (`libgifimage`, `libstatic-webp`, `libnative-imagetranscoder`, …)                                                                            |

The universal APK fails the §12 60 MB budget. An arm64-only APK, or an AAB install, is ≈ 27.9 + 11.9 ≈ **40 MB**
(estimated, not built). For the APK we host ourselves:

- build per-ABI APKs (or arm64-only);
- turn off `expo.gif.enabled` / `expo.webp.enabled` unless we use them;
- try R8 (`android.enableMinifyInReleaseBuilds`).

Build time: 15 min 20 s cold (4 ABIs, empty Gradle home), then 12-23 s incremental (JS only).

### 4.3 Tamil: correct

The screenshot (`results/android-run2-tamil.png`, local only) shows:

- **Skia `Paragraph`** with the bundled Noto Sans Tamil shapes every test string correctly: the two-part vowel signs
  கொ / கோ / கௌ reordered around the consonant, the ஸ்ரீ ligature, the க்ஷ conjunct, and an ordinary sentence with
  pulli.
- **Skia `Text`** with the same font breaks them, as expected (detached vowel-sign parts, no conjuncts). This confirms the
  CLAUDE.md gotcha.
- RN `<Text>` (system font) is correct.
- Numeric signal: the shaped/unshaped width ratio is 0.979 / 0.916 / 1.002 for the Tamil rows against 0.998 for the
  Latin control. There are 0 missing glyphs.

**Font:**

| Field   | Value                                                                                                                 |
| ------- | --------------------------------------------------------------------------------------------------------------------- |
| Font    | Noto Sans Tamil **2.004**, variable (`wdth`, `wght`), 340,668 B                                                       |
| Source  | byte-identical to `github.com/google/fonts/blob/main/ofl/notosanstamil/NotoSansTamil[wdth,wght].ttf`                  |
| sha256  | `aa3a9b321f4b0bb2c40203ffbde9af89713227866e0e13f76e5b9eeea727cf88`                                                    |
| Licence | **SIL OFL 1.1**, © 2022 The Noto Project Authors (github.com/notofonts/tamil); `assets/fonts/OFL.txt` ships beside it |

It needs a `docs/ASSETS.md` entry when it moves into the app.

### 4.4 Frame stats on the emulator (not representative of a phone)

**The emulator was shared and in active use by someone else during this session.**

- Runs 1 and 2 were interrupted:
  - Home was pressed 28 s and 8 s after launch (`wm_pause_activity … userLeaving=true`);
  - the `com.dwtc.hub` dev client was launched;
  - the notification shade was opened.
- Runs 1 and 2 are **discarded**. They also showed that a backgrounded app keeps getting vsync callbacks, so it reports a
  perfect 601 frames at 60.000 fps while presenting nothing, and its JS timers pause.
- Runs 3 and 4 completed in the foreground: `AppState` stayed `active`, and there was no user pause event.
- Run 5 was degraded by the emulator itself: 356 MB free out of 4 GB, 1.9 GB of swap in use, and
  `com.google.android.nfc` crash-looping every 3 s. Everything, including the planck bench, ran ~5× slower, so run 5 is
  shown only as a warning.
- I never touched or launched another app. Our own app was force-stopped at the end to give memory back.

**Run 4: the reference run.** Worklet cadence and work, plus HWUI per step:

| Particles | worklet fps | p95 ms | p99 ms | > 33 ms | worklet work (mean) | HWUI frames / 12 s | HWUI janky | HWUI p50 / p99 | slow issue-draw |
| --------- | ----------- | ------ | ------ | ------- | ------------------- | ------------------ | ---------- | -------------- | --------------- |
| 500       | 59.9        | 16.75  | 16.75  | 0 %     | 0.36 ms             | 366 (~30/s)        | 79.8 %     | 17 / 34 ms     | 279             |
| 1000      | 60.0        | 16.75  | 16.75  | 0 %     | 0.61 ms             | 389 (~32/s)        | 73.8 %     | 17 / 28 ms     | 272             |
| 2000      | 60.0        | 16.75  | 16.75  | 0 %     | 1.05 ms             | 725 (~60/s)        | 0.14 %     | 21 / 26 ms     | 1               |
| 4000      | 60.0        | 16.75  | 16.75  | 0 %     | 1.87 ms             | 707 (~59/s)        | 0 %        | 23 / 29 ms     | 0               |

Run 3 (no per-step gfxinfo) agrees on the worklet side: 1000/2000/4000 at 60.0 fps with 0 % > 33 ms. Its first stress
screen (500) was the worst, at 50.4 fps with 18.6 % > 20 ms. Process-wide gfxinfo for run 3: 2,487 frames, 11.8 % janky,
p50 22 ms, p99 34 ms.

Run 5 (degraded emulator, for scale only):

- worklet fps 41 / 56 / 56 / 39 for 500-4000;
- work 2.2 / 4.1 / 8.2 / 15.5 ms;
- HWUI 13-29 frames/s, 78-99 % janky;
- 500 again: 59.3 fps on the worklet, still ~29 HWUI frames/s.

What this does and doesn't show:

- **The game-loop pattern is cheap.** The worklet's sim + RSXform fill scales linearly at ≈ 0.43 µs per particle on an
  M4-class core (1.87 ms at 4000). A mid-range phone core is ~3-4× slower, so 2000 particles ≈ 3-4 ms of the 16.7 ms
  budget. That still leaves room, but it says to keep particle counts in the low thousands.
- **Worklet cadence alone over-reports smoothness.** It sees UI-thread-bound jank (run 5 shows it). It cannot see
  GPU/compositor-bound jank: in run 4, HWUI reported 74-80 % janky frames at 500/1000 while the worklet saw a perfect
  60 Hz.
  - That matters for the ARCH §6.4 **quality governor**, which as written watches frame deltas only.
  - It also matters for PERF.md, which already pairs the histogram with `gfxinfo` and Perfetto. Keep that pairing
    mandatory.
- **The 500/1000-slow, 2000/4000-fast pattern** in the HWUI column is not a particle-count effect. Run 3's first screen
  and run 5's repeat point to warm-up after launch and emulator noise; the emulator's GL-ES-over-Metal translator shows
  up as "slow issue draw commands". I can't separate the two on this emulator, and the phone run will show whether it's
  real. That's why the auto run now repeats 500 at the end.

## 5. Spike (d): planck 1.5.0 carrom shot benchmark

| Engine (where)                                           | Config                | ms/shot mean          | p50       | p95       | max     | steps/shot mean (p50, max) | µs/step |
| -------------------------------------------------------- | --------------------- | --------------------- | --------- | --------- | ------- | -------------------------- | ------- |
| **Node 24.21, M4, idle** (2 runs × 200)                  | all bullets, μ 0.18   | **1.76-1.77**         | 1.73-1.75 | 2.28      | 3.4-4.8 | 51.7 (50, 75)              | 34      |
|                                                          | striker bullet only   | **1.18-1.20**         | 1.11      | 1.47-1.50 | 3.8-8.3 | 64.3 (65, 90)              | 18.5    |
|                                                          | all bullets, μ 0.10   | 1.93-1.97             | 1.90-1.96 | 2.44-2.53 | 3.1-3.4 | 75.2 (74, 102)             | 26      |
| **Hermes, release app, emulator** (runs 3, 4; 100 shots) | all bullets, μ 0.18   | **19.0-20.1**         | 19.9      | 23.9-24.5 | 31.6    | 51.05 (50, 75)             | 372-394 |
|                                                          | striker bullet only   | **14.8-16.7**         | 16.5      | 18.4-20.5 | 22.7    | 64.65 (65, 93)             | 229-259 |
| V8 in Chrome 149 (web export; 0.1 ms timer)              | all bullets / striker | 2.08-2.12 / 1.91-1.98 | —         | 2.8 / 2.9 | —       | 51.05 / 64.65              | —       |

- No shot hit the 8 s cap. Pocketed in total: 59 and 41 coins per 100 shots on Hermes and V8.
- **Hermes is ~11× slower than Node's JIT** for this workload (all-bullets 19-20 ms against 1.76 ms).
  - The emulator's arm64 vCPU runs at near-native M4 speed, so a mid-range phone should land around **40-80 ms per
    shot** on Hermes.
  - That fits ARCH §6.4's "offline on the JS thread during the 300 ms wind-up".
  - It is still a single JS-thread block of up to ~80 ms, so step it in chunks (e.g. 10-20 steps per frame) or accept the
    stall during the wind-up. The render loop is on the UI thread and won't drop frames, but touch handling on JS will
    wait.
- **Server:** at 1.8 ms on an M4 core, ARCH §5.4's 10× allowance for Render's 0.1 CPU gives ≈ 18-20 ms per shot. The
  physics worker stays optional. (The research probe's 2.1 ms / ~100 steps used lighter friction; per step we're at
  34 µs with CCD on every body, 18.5 µs with the striker only.)
- **Bullets.** Making only the striker a bullet saves ~33 % of the time on Node and ~20 % on Hermes, but changes
  outcomes: different step counts, pocketed totals 96 vs 131 over 200 Node shots. Choose for physics fidelity, not
  speed.
- **Determinism hint.** Hermes and V8 ran the same seeded 100 shots and agreed exactly on steps (mean, p50, max) and on
  pocketed totals in both configurations. These are summary statistics, not state hashes, so it is only a hint; the
  golden-hash cross-engine test (ARCH §12) is still needed.

## 6. Problems hit, and fixes

| #   | Problem                                                                                              | Fix / status                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | npm under the wrapper: `double-loading config "/dev/null" as "global"`                               | Fixed in `scripts/isolated.sh` (empty global rc) by the lead.                                     |
| 2   | `create-expo-app` waits on an interactive "skip git init?" prompt without stdin                      | Install had already finished; no nested repo was created.                                         |
| 3   | Playwright's Chromium download (storage.googleapis.com) is blocked on this network                   | Use installed Chrome via `channel: 'chrome'`, with a throwaway profile and `--use-mock-keychain`. |
| 4   | `SkFont.measureText` throws "Not implemented on React Native Web" (Skia 2.6.2)                       | `getTextWidth()` (implemented on both).                                                           |
| 5   | Expo web `require('font.ttf')` returns a URL string; Skia 2.6.2 `useFonts` rejects it                | Wrap it as `{ uri, width: 0, height: 0 }` on web.                                                 |
| 6   | **CanvasKit ignores `ParagraphStyle.textStyle`**: web drew black 14 px text, native drew white 24 px | `builder.pushStyle(style).addText(…).pop()`. Widths then match Android exactly (237.8 vs 237.8).  |
| 7   | canvaskit-wasm 0.41.0 has no `instantiateWasm` / `wasmBinary` hook (ARCH §6.5 assumption)            | CDN bytes fetched with SRI → `blob:` → `locateFile`; needs `blob:` in `connect-src`.              |
| 8   | `LoadSkiaWeb` memoises a rejected init, so there's no in-page retry                                  | Do the fallback before `LoadSkiaWeb`, or call `CanvasKitInit` directly in the real loader.        |
| 9   | Prebuild's template `debug.keystore` is the public Expo/RN key (CLAUDE.md forbids it)                | Replaced with a project-unique keystore (`keytool`) inside the gitignored `android/`.             |
| 10  | Shared emulator: someone pressed Home and launched another app mid-run                               | `AppState` logging + `wm_pause_activity` checks; interrupted runs discarded.                      |
| 11  | A backgrounded app reports a perfect 60 fps (vsync callbacks continue) and its JS timers stop        | The run is valid only if `appstate` stays `active`; the bench stalled in the background (run 1).  |
| 12  | Release builds swallow unhandled promise rejections (a bench failure would be silent)                | The bench catches and reports `error`.                                                            |
| 13  | Emulator degraded (memory pressure + NFC crash loop) → run 5 ~5× slower                              | Reported, not used. The owner may want to cold-boot the emulator.                                 |
| 14  | `SkPath.addRect()` is deprecated in Skia 2.6.2 (histogram overlay)                                   | Left in the spike; use `Skia.PathBuilder` / `Skia.Path.Rect` in real code.                        |
| 15  | RNSkia logs `SurfaceTexture is not attached` at mount                                                | Benign; RNSkia's own next line says it can be ignored.                                            |
| 16  | Chrome clamps `performance.now()` to 100 µs without cross-origin isolation                           | Web "work" times are below the clamp and not reported as data.                                    |
| 17  | Test layout: a wrapped Paragraph overlapped the next row                                             | Rows stacked by `getHeight()`.                                                                    |
| 18  | ARCH §6.5's 7.2 MB / 2.9 MB figure is the non-`full` wasm                                            | Corrected in §3.2.                                                                                |

## 7. Recommended exact pins (SDK 57 line, as tested)

```
expo 57.0.26                       react-native 0.86.3            react / react-dom 19.2.3
@shopify/react-native-skia 2.6.2   (canvaskit-wasm 0.41.0, derived at build time, never pinned by hand)
react-native-reanimated 4.5.1      react-native-worklets 0.10.1   react-native-web 0.21.3
@expo/metro-runtime 57.0.16        expo-font 57.0.4               expo-asset 57.0.18      expo-status-bar 57.0.1
planck 1.5.0                       typescript 6.0.3               playwright 1.63.0 (dev; Chrome channel)
Android: Gradle 9.3.1 · AGP 8.12.0 · NDK 27.1.12297006 · JDK 17 · minSdk 24 · targetSdk 36 · useLegacyPackaging=false
```

The spike's `package.json` still has `~` on some Expo packages (create-expo-app default); the real app should pin them
exactly. If SDK 58 turns stable and passes this same spike, re-pin to its set instead (OQ I8).

## 8. What the owner must run on his own phone

This closes P0-M1. It takes about 10 minutes and no accounts.

1. **Phone:** enable Developer options → USB debugging, plug in, then `adb devices` and note the serial. Set the display
   to its default refresh rate and note it (60/90/120 Hz).
2. **Build** (on this Mac; `android/` already exists):
   `cd spikes/render-stress/android && ../../../scripts/isolated.sh ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a`
   (≈ 40 MB APK).
   - If `android/` is gone, first run `../../scripts/isolated.sh npx expo prebuild --platform android --no-install`.
   - Then replace `android/app/debug.keystore` with a fresh one:
     `keytool -genkeypair -keystore android/app/debug.keystore -storepass android -alias androiddebugkey -keypass android -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=render-stress spike"`.
3. **Auto run:** `SERIAL=<serial> LABEL=phone spikes/render-stress/scripts/android-run.sh`. Leave the phone untouched
   with the screen on for ~90 s. The script prints the pause events: nothing with `userLeaving=true` may appear after
   launch.
4. **Send back:** `results/android-phone.log` and `results/android-phone-gfx.txt`, plus the model, RAM and refresh rate
   (the script prints the model and frame rate).
   - **Pass (PERF.md):** p95 ≤ 16.7 ms and < 1 % of frames > 33 ms at 2000 particles, in **both** the worklet stats and
     gfxinfo.
   - Also look for an "again" vs first-500 difference: that is the warm-up question from §4.4.
5. **Visual checks** (toolbar):
   - **Tamil:** the white Paragraph rows read correctly (கொ கோ கௌ ஸ்ரீ க்ஷ); the pink Skia `Text` rows are expected to
     be broken.
   - **2000:** the plasma background animates and the dots move smoothly. Note any stutter you can see but the HUD
     doesn't show.
6. **Web on the phone's Chrome:**
   1. `cd spikes/render-stress && ../../scripts/isolated.sh node scripts/serve.mjs dist 8787`
   2. `adb -s <serial> reverse tcp:8787 tcp:8787`
   3. On the phone open `http://localhost:8787/?ck=self&auto=0`. The menu shows `skia-load` (`initMs` = fetch + compile
      on the device): note the cold value, then the value after a reload.
   4. Repeat with `?ck=cdn&auto=0`: the CDN fetch goes over the phone's own network.
   5. Tap **Auto** for real-GPU web frame stats (read them on the done screen).

## 9. Follow-ups

- **SDK 58 comparison** (OQ I8): RN 0.88, Skia 2.13.1, Reanimated 4.7.0, worklets 0.13.0. Re-run this spike unchanged
  once SDK 58 is stable. Re-derive the CanvasKit version and size, and re-check §6 items 4-8 (several may be fixed
  upstream).
- **Proposed ARCH / docs edits** (for the lead):
  - §6.5 loader (no `instantiateWasm`; blob hand-off; `LoadSkiaWeb` memoisation; add `blob:` to `connect-src` in the CSP
    and `render.yaml`);
  - §6.5 wasm size (8.08 / 3.27 / 2.51 MB);
  - §6.4 governor: frame deltas miss GPU-bound jank, so add worklet work time and/or a presentation signal;
  - §5.4 planck numbers;
  - `docs/ASSETS.md`: Noto Sans Tamil entry;
  - CLAUDE.md gotchas: §6 items 4, 6, 8 and 11.
  - OQ H5 can close as "works as designed, with `blob:` in `connect-src`".
- **Template leftovers in this folder** (for the lead to drop before committing): `AGENTS.md` (tells agents to use EAS
  and bare `npx`, against the repo rules), `LICENSE` (Expo template MIT) and `.claude/settings.json` (enables an Expo
  Claude plugin).
- **Server side of spike (d):** run `scripts/bench-node.mjs` on a Render free instance (0.1 CPU).
- **Cross-engine determinism:** golden state hashes for planck under Node and the Hermes CLI (ARCH §12).
- **APK budget:** measure an arm64 split and an AAB with R8 and gif/webp off.
