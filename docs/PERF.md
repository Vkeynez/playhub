# Performance

Budgets from BUILD_BRIEF §13, measured as described in ARCHITECTURE §12. Results go in the tables below; nothing has been measured yet.

| | |
|---|---|
| **Status** | Phase 0: method fixed, no results yet. |
| **Builds measured** | Release builds only: the `preview` APK, and the production web export. Never a dev build or the dev server. |

## Reference device (OPEN_QUESTIONS I3)

A mid-range Android phone with about 4 GB of RAM (the owner's, if it qualifies). Fill this in once and keep it fixed, so numbers stay comparable.

| Field | Value |
|---|---|
| Model | |
| Android version | |
| RAM | |
| SoC | |
| Display (resolution, refresh rate) | |
| Chrome version (for web and CanvasKit) | |
| Low-end device for the Lite-effects check (optional) | |
| Network for web tests | LHCI mobile preset (simulated 4G); real device on home Wi-Fi |

## Method and results

| Budget | Method | Pass | Build / date | Result | Pass? |
|---|---|---|---|---|---|
| Cold start to Home | Force-stop, then `adb shell am start -W` plus `reportFullyDrawn()` once Home is interactive; 10 runs | p90 < 3 s | | | |
| Join from a link | Maestro sends `am start -a android.intent.action.VIEW` with the `/join/` URL, timed until the lobby testID appears; server warm | p90 < 2 s | | | |
| JS heap stability | 30-min Maestro soak (Runner + vs-bot Ludo), sampling Hermes stats and `dumpsys meminfo` every minute | Slope after warm-up < 1 MB per 10 min | | | |
| FPS | Frame-delta histogram + `dumpsys gfxinfo <pkg> framestats` + one Perfetto trace per game | p95 ≤ 16.7 ms and < 1 % of frames over 33 ms; ≥ 50 fps with Lite effects on low-end devices | | | |
| Web Home LCP | LHCI mobile preset, run locally against the production export served with production headers (never against prod) | < 2.5 s | | | |
| CanvasKit load | Fetch + compile time, cold and service-worker-warm, in the reference device's Chrome | Recorded (no pass mark) | | | |

## FPS per game

One row per game once it exists. Phase 0 measures only the spike (a) game loop.

| Game | Effects | p50 frame (ms) | p95 frame (ms) | Frames > 33 ms (%) | Avg fps | Build / date | Pass? |
|---|---|---|---|---|---|---|---|
| Spike (a) loop | Full | | | | | | |
| Spike (a) loop (web) | Full | | | | | | |

## Size and bandwidth budgets

Checked in CI where possible (ARCHITECTURE §12); measured byte figures from ARCHITECTURE §10.5.

| Budget | How measured | Limit | Build / date | Result |
|---|---|---|---|---|
| APK size | `apkanalyzer apk file-size` on the preview APK | ≤ 60 MB | | |
| Home entry chunk | Brotli size of the Home entry in the web export | ≤ 250 KB | | |
| Bytes per first Home visit | Playwright response totals | Recorded | | |
| Bytes per first open of a game | Playwright response totals | Recorded | | |
| Bytes per returning visit after a deploy | Playwright response totals | Recorded | | |
| Socket bytes per match: Hand Cricket | Socket byte counters | Recorded | | |
| Socket bytes per match: 8-player Quiz + 20 spectators | Socket byte counters | Recorded | | |

## Server (Render free, 0.1 CPU)

| Measure | How | Target | Date | Result |
|---|---|---|---|---|
| Carrom shot simulation (spike d) | `/ops/bench/carrom` on Render, and on Hermes | ~20 ms per shot or less on 0.1 CPU (laptop probe: ≈ 2.1 ms) | | |
| Event-loop delay under load | `elu` and `monitorEventLoopDelay` on `/health` | Health checks always answer within 5 s | | |
| 50-room load test (Phase 5) | k6 or Artillery (OPEN_QUESTIONS I4) | Report CPU and memory | | |

## Notes

Record anything that affects comparability here: OS updates on the device, thermal throttling, Expo SDK changes.
