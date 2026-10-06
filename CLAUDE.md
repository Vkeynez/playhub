# CLAUDE.md

Read these before changing anything:

- `docs/BUILD_BRIEF.md`: the spec, and the source of truth for scope.
- `docs/ARCHITECTURE.md`: how we're building it, including the decision log.
- `docs/OPEN_QUESTIONS.md`: unresolved decisions and the defaults we're using.

## Working agreement (brief §0)

- **Work in phases (§16).** At the end of each phase:
  1. Run all tests.
  2. Report what was built, how to verify it on a phone and in a browser, the known gaps, and what comes next.
  3. Stop until the owner approves.
- **Deviations:** if the brief looks wrong, explain why before deviating. Record each decision in the ARCHITECTURE.md decision log.
- **Code:** strict TypeScript, with no `any` in game logic. Make small conventional commits, one per milestone.
- **Versions:** use the latest stable versions and check them against live sources, never memory. Once a combination works, pin exact versions.

## Corporate machine: account rules (standing instruction from the owner)

This Mac is a corporate machine. **Ask before using any account or credential that is configured on it.**

- **git:** never commit with the global identity. The repo uses a repo-local `user.name`/`user.email` agreed with the owner. Never push unless asked.
- **No machine-logged-in tools** unless the owner approves that specific use:
  - `gh`;
  - `eas` (a global eas-cli is installed and may be logged into a work account), `expo login`;
  - gcloud, firebase, render and neonctl CLIs;
  - npm registry auth;
  - claude.ai connectors and artifact publishing.
- **Credentials:** never read credential files (`~/.npmrc`, `~/.gitconfig`, `~/.expo`, the keychain). Secrets live only in service dashboards and env vars. Commit `.env.example` files only.
- **Allowed without asking:** local builds and tests, and public reads (docs, and the public npm registry via curl).
- **Isolation wrapper:** run every git, pnpm, npx, expo, gradle, turbo and brew command through `scripts/isolated.sh`. The script is created in Phase 0 M0, after the owner approves it (OPEN_QUESTIONS A1). It:
  - unsets inherited tokens: `EXPO_TOKEN`, `GITHUB_TOKEN`/`GH_TOKEN`, `NPM_TOKEN`, `NODE_AUTH_TOKEN`, `TURBO_TOKEN`/`TURBO_TEAM`, `COREPACK_NPM_TOKEN`, `HOMEBREW_GITHUB_API_TOKEN` and similar;
  - sets `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1` (no corporate signing key, hooks or keychain helper);
  - sets `NPM_CONFIG_USERCONFIG`/`NPM_CONFIG_GLOBALCONFIG=/dev/null` and a project-local `XDG_CONFIG_HOME`;
  - sets `GRADLE_USER_HOME=~/.gradle-<app>`;
  - sets `EXPO_NO_TELEMETRY=1`, plus `EXPO_OFFLINE=1` until the Expo account question is settled;
  - relies on Turborepo's remote cache being disabled in `turbo.json`.

  Check it with `pnpm config list`, which should show project keys only.

- **Release keystore:** it never touches this machine. Release-signed builds run on EAS cloud only. Local and dev builds use a project-unique debug keystore (kept outside git), never the public template debug key.

## Repo conventions

- **Pure logic:** `packages/games/*/src/logic` (and `bot/`) is pure TypeScript. It must not import:
  - react, react-native, expo or skia;
  - DOM APIs;
  - `node:*`.

  Lint enforces this.

- **Validation:** every socket event and REST body has a zod schema in `packages/protocol`.
- **Hidden information** leaves the server only through `viewFor` / `eventsFor`.
- **Neon must be able to sleep:**
  - `/health` never touches Postgres, and a test enforces it;
  - no timer-driven or polling DB access;
  - DB writes happen only at state transitions.
- **Game loops:**
  - Reanimated worklets plus shared values;
  - no React state updates per frame;
  - no allocations in hot loops.
- **Strings:** every user-facing string goes through an i18next key (en + ta).
- **Assets:** procedural first. Log every external asset in `docs/ASSETS.md` with its source and licence.

## Commands

Always go through the wrapper. `pnpm` comes from Corepack (pnpm 12.8.1, pinned in `packageManager`).

| Task                   | Command                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Install                | `scripts/isolated.sh corepack pnpm install` (new build scripts go in `allowBuilds` in `pnpm-workspace.yaml`)          |
| Full check             | `scripts/isolated.sh corepack pnpm check`, which runs lint + depcruise + typecheck + test                             |
| One package            | `scripts/isolated.sh corepack pnpm --filter @gp/protocol --filter @gp/db test`                                        |
| Generate DB migrations | `scripts/isolated.sh corepack pnpm --filter @gp/db exec drizzle-kit generate`                                         |
| Git                    | `scripts/isolated.sh git …` (repo-local identity; the credential helper reads `~/.gamehub-secrets/github-token` only) |

Tests that need Postgres use `startTestDb()` from `@gp/db/testing`, which runs an embedded Postgres 17 (no Docker).

## Gotchas

Append these as you discover them.

- **Render Blueprint:** `plan` defaults to the **paid** `0.5c-512mb` and `region` to `oregon`, so always set `plan: free` and `region: singapore`. Omit `previews` (that disables PR previews).
- **Render quotas:** a Hobby workspace includes only **5 GB of bandwidth** and **500 build minutes** a month. Never host the APK on Render.
- **Render deploys:** the old and new instances overlap for 60–90 s on every deploy or restart. That's why every DB write is fenced (ARCHITECTURE §5.6).
- **Render builds:** never `corepack enable`, because Render's `/usr/bin` is read-only (EROFS). Call `corepack pnpm …` directly. Free services also reject `maxShutdownDelaySeconds`.
- **Render spin-up:** while a free service is waking, Render answers with an HTML loading page with status 200. Never treat a 200 as JSON without checking the content-type.
- **Neon:** each isolated wake costs ≥ 5 min × 0.25 CU. Anything on a timer, client or server, that hits a DB-backed endpoint burns the 100 CU-h budget (ARCHITECTURE §5.3).
- **node-postgres:** always attach `pool.on('error')`. Neon drops idle connections when it suspends, and an unhandled pool `'error'` crashes Node.
- **CanvasKit:** the wasm must match the canvaskit JS glue of the _installed_ Skia. Derive the version at build time; never hard-code it.
- **Skia text:** Skia `Text` doesn't shape Tamil. Use RN `<Text>` overlays or Skia `Paragraph` with a bundled font. On web, `ParagraphStyle.textStyle` is ignored, so use `pushStyle`. `SkFont.measureText` doesn't exist on web.
- **CanvasKit loading:** there's no `instantiateWasm` hook. Hand the SRI-verified bytes over as a `blob:` URL (the CSP needs `blob:` in `connect-src`). Skia's web loader caches a _failed_ init, so decide between CDN and fallback before calling `LoadSkiaWeb()`.
- **Frame stats:** a steady `useFrameCallback` cadence doesn't prove smooth frames; check `adb shell dumpsys gfxinfo` too. A backgrounded app reports a perfect 60 fps.
- **The Android emulator on this Mac is shared** with the owner's work. Never launch or screenshot other apps; uninstall only our own packages.
- **Google Sign-In:** the legacy Android APIs were removed (play-services-auth 22.0.0, Aug 2026). Use Credential Manager via `react-native-nitro-google-signin`.
- **TypeScript:** stay on 6.0.x until typescript-eslint supports TS 7.
- **Drizzle:** 1.0 is still beta; use 0.45.x.
