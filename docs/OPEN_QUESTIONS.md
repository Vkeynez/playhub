# Open questions

Every ambiguity in `BUILD_BRIEF.md`, with the default I'll use. Revised 2026-10-05 after an adversarial review.

**How to read this:**

- **Section A** needs your answers. Each answer is needed only by the tier shown.
- **Everything else** has a default that **applies unless you object**.
- **Blocks** shows the milestone whose work builds the default in, so objecting before then costs nothing:
  - **P0-Mn**: Phase 0 milestone *n* (see the Phase 0 plan);
  - **P0-APK**: the first APK that leaves your phone;
  - **P1…P5**: that phase.
- **Status:** `Open`, or `Resolved <date>: <answer>`. The decision is then copied into the ARCHITECTURE §14 decision log.

---

## A. Needs your answer

### Tier 1: to start Phase 0 (M0–M1)

**A0. Who owns this app, you personally or your employer?**

- **What it decides:**
  - which GitHub, Google, Expo, Render and Neon accounts we use;
  - the package namespace;
  - whose identity registers the package and signing key under Android developer verification (§G1). That binding is effectively permanent;
  - where the keystore backup lives.
- **If it's personal:** employment agreements sometimes cover work done on company hardware. That's your call; I'll proceed either way.
- **Default:** none, this needs an answer. · **Blocks:** P0-M0 · **Status:** Open

**A1. Git identity and tool isolation**

1. **Git identity:** the name and email to set **repo-locally**. The machine's global identity is never used.
2. **`scripts/isolated.sh`:** every git, pnpm, npx, expo, gradle, turbo and brew command runs through it.
   - **Inherited tokens are unset:** `EXPO_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN`, `NODE_AUTH_TOKEN`, `TURBO_TOKEN/TEAM`, `COREPACK_NPM_TOKEN`, `HOMEBREW_GITHUB_API_TOKEN`, and similar.
   - **Global configs are bypassed:**
     - `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1`: no corporate signing key, hooks or keychain credential helper;
     - `NPM_CONFIG_USERCONFIG`/`NPM_CONFIG_GLOBALCONFIG=/dev/null` and a project-local `XDG_CONFIG_HOME`: no `~/.npmrc` tokens and no pnpm global rc;
     - `GRADLE_USER_HOME=~/.gradle-<app>`: no corporate init scripts or proxy credentials. The cost is a one-time Gradle download;
     - `EXPO_NO_TELEMETRY=1`, plus `EXPO_OFFLINE=1` until A5 is settled;
     - Turbo's remote cache is off.
   - **Verification:** `pnpm config list` must show only project keys. No credential file is ever read.
   - **Caveat:** this also bypasses any corporate-mandated git hooks or proxy settings. If downloads then fail behind a proxy, I'll ask before using its config.
- **Default:** the wrapper is on; the identity needs an answer. · **Blocks:** P0-M0 · **Status:** Open

**A2. This machine**

1. **Node:** install the latest Node 24.x via nvm (user-space)? The current 24.3.0 is exactly Expo's minimum. *Default: yes.*
2. **Local Postgres:** `embedded-postgres` downloads real Postgres 17 binaries from public npm for local integration tests, with no Docker and no Homebrew. *Default: yes.*
3. **Homebrew installs** (Maestro, k6): *Default: ask each time.*
4. **USB debugging** from this Mac to your phone: is it allowed under MDM? *Default: try `adb`; fall back to the installed emulator plus a download link.*
5. **Registry:** a project `.npmrc` pinned to `registry.npmjs.org`. The wrapper ensures no user `.npmrc` is read. *Default: yes.*

- **Blocks:** P0-M0/M1 · **Status:** Open

### Tier 2: before the deploy and App Link spikes (M2)

**A3. GitHub: account (per A0), visibility, who pushes**

| | **Public repo** | **Private repo** |
|---|---|---|
| Keep-alive | The brief's GitHub Actions cron, free | An external pinger (cron-job.org), because the cron alone would use ~4,464 of the 2,000 free minutes |
| APK downloads | GitHub Releases, downloadable by anyone | A separate public `…-releases` repo. Never Render: 5 GB/month is only ~90 downloads. |
| CI minutes | Unlimited | Kept lean |
| Quiz bank | Must stay **out of git**, or the answers are public (I12) | Can live in git |

- **Default:** a public repo on the account chosen by A0. You push; I never use `gh` or this machine's credential helpers. · **Blocks:** P0-M2 · **Status:** Open

**A4. Create Neon and Render per `SETUP.md`**

SETUP.md is the first deliverable of M0, with steps in dependency order:

1. Neon.
2. Push the repo.
3. Render Blueprint and secrets, plus a $0 build spend limit.
4. Deploy the privacy page.
5. Google Cloud.
6. EAS keystore, then its SHA-1/SHA-256, the release OAuth client and `assetlinks.json`.
7. Firebase.
8. Keep-alive.
9. Custom domain, if wanted now.

- **Default:** you do these steps when SETUP.md lands. · **Blocks:** P0-M2 · **Status:** Open

**A5. Expo account for EAS (per A0)**

- **Release builds** (the preview APK and the production AAB) run **only on EAS cloud**, so the release keystore never touches this corporate machine.
- You run the account steps (`eas init`, `eas credentials`, the first build), or you approve `eas login` here, under the wrapper. The global `eas-cli` may already hold a work login; I won't touch it.
- Local dev builds need no account. Free EAS accounts can't incur overages.
- **Default:** you run the EAS account steps. · **Blocks:** P0-M2 · **Status:** Open

**A6. Google account (per A0) for the Cloud console and Firebase**

- Use a separate browser profile.
- The consent screen must be **published to Production** (basic scopes `openid email profile`, no verification needed). Otherwise only listed test users can sign in.
- I never run the gcloud or firebase CLIs.
- **Default:** follows A0. · **Blocks:** P0-M2 (Google upgrade), P1 (push) · **Status:** Open

### Tier 3: before any APK leaves your phone

**A7. Identifiers: `{{APP_NAME}}`, `{{ANDROID_PACKAGE}}` (plus a `.dev` variant), `{{SCHEME}}`**

- A sideloaded update must keep the same package *and* key, and verification binds both to the owner's identity.
- **Default:** placeholders (`gamehub`, `com.yourcompany.gamehub`) until you choose. Ideas: *Thinnai* (திண்ணை; note thinnai.com is an existing Tamil webzine), *Kalam* (களம்), *Aattam*. Please check for name clashes.
- **Blocks:** P0-APK · **Status:** Open

**A8. Custom domain: now, or later?**

- **Why it matters:** the App Link host is baked into the APK, and Android ≤ 11 verifies hosts all-or-nothing. Cookie-mode auth also needs one registrable domain, and `*.onrender.com` is on the Public Suffix List.
- **Default:** start on `*.onrender.com` with bearer tokens. If you intend to buy a domain, do it before the first shared APK.
- **Blocks:** P0-APK · **Status:** Open

---

## B. Identity & accounts

| ID | Question | Default | Blocks | Status |
|---|---|---|---|---|
| B1 | Can a guest sign out? | No, because that would orphan the account. Guests get "Reset this device" behind a warning. | P0-M5 | Open |
| B2 | Merging into an existing Google account: whose profile wins? | The Google account's. | P0-M5 | Open |
| B3 | Merging two accounts that played *each other* | The guest's participant row stays on the tombstone. The target's multiplayer stats are recomputed from `match_participants`, not summed. | P0-M5 | Open |
| B4 | Account deletion | Immediate. The user row becomes a tombstone (PII scrubbed, ID kept); live seats go to bots; saves, progress, identities, devices and tokens are deleted. Other players' history shows "Deleted player". | P1 | Open |
| B5 | Guest pruning | Guests with no matches or progress who haven't been seen for 30 days are pruned in lazy maintenance. | P2 | Open |
| B6 | Profanity filter | English plus a curated Tamil/Tanglish list, applied to display names. Generated names come from vetted words. | P1 | Open |
| B7 | Refresh-token rotation | 60 days, sliding. **Idempotent:** re-presenting a token within 60 s of its rotation (24 h for guests) returns the same successor, derived as HMAC. Later reuse revokes the family **only for Google accounts**; a guest family is never revoked. Refresh is single-flight, using Web Locks on web. | P0-M5 | Open |
| B8 | What can others see about me? | Name, avatar, platform badge and connection state. Stats and activity are visible only to you in v1. | P1 | Open |
| B9 | Privacy page / support email (Google's consent screen needs them) | I write the page; you supply the email. | P0-M2 | Open |
| B10 | Do guests survive a reinstall? | **No.** `android.allowBackup = false`, so guest progress is device-bound. Progress survives a reinstall or device switch **after Google login**, and the "Save my progress" prompt says so. Web: `navigator.storage.persist()`, a nudge after the first progress, and a one-time iOS Safari note. | P0-APK | Open |
| B11 | Phase 0 Google upgrade when that Google identity already has an account | Phase 0 implements the merge for the tables that exist then. Save-slot merging comes in Phase 2 with `packages/sync`. | P0-M5 | Open |
| B12 | When is the server-side guest created? (*deviation*) | **Locally first:** first launch creates `{guestKey, name, avatarSeed}` instantly and offline. The server row is created on the first action that needs the server (create or join a room, sync, Save my progress), idempotent on `guestKey`. To the user it's still a silent guest account, but crawlers, monitors and solo players never wake Neon. | P0-M5 | Open |

## C. Rooms & multiplayer

| ID | Question | Default | Blocks | Status |
|---|---|---|---|---|
| C1 | What gets restored after a restart | LOBBY, IN_PROGRESS and FINISHED rooms, activated lazily and fenced (ARCH §5.6), so a link already shared on WhatsApp survives a deploy. | P0-M5 | Open |
| C2 | Fairness after a restart | The game clock gives every pending deadline ≥ 15 s. Grace windows start only after the deploy overlap ends. | P0-M5 | Open |
| C3 | Kicks | Persisted (`kicked_user_ids`). A kicked user can't take a seat again in that room, but can spectate unless kicked from spectating too. | P0-M5 | Open |
| C4 | Opening the link after the match has started | You can spectate, or reclaim a seat you already hold. | P0-M5 | Open |
| C5 | No human connected | The clock freezes (no bot-vs-bot play, nothing journaled). After 5 min the match is abandoned in memory, with no W/L, and persisted lazily. | P0-M5 | Open |
| C6 | Rematch | Any seated human can request one. It starts when every seated human accepts. A human who doesn't accept within 60 s frees their seat (bot fill comes in Phase 1). Seats and teams stay the same; Cricket re-tosses. | P0-M5 | Open |
| C7 | The 8 reactions | 👏 🔥 😂 😮 😭 🎉 🙏 😎 | P1 | Open |
| C8 | Reaction limits | 1 per 2 s **per user**, players and spectators alike. Muting is client-side. | P1 | Open |
| C9 | Capacity caps | `MAX_ACTIVE_ROOMS` = 25, applied to **creation only**. One open lobby per host. A lobby with only the host closes after 10 min. | P0-M5 | Open |
| C10 | "It's your turn" push vs 5/15/20 s turns (*deviation*) | A push when you background the app mid-match: *"back within 60 s to keep your seat"*. Keep "your turn" only for turns of 20 s or more (Ludo). | P1 | Open |
| C11 | Reclaiming a seat from a bot | Immediate. Pending or async bot results are dropped as stale. | P1 | Open |
| C12 | Host leaves mid-match | The host role passes to the next connected human. | P0-M5 | Open |
| C13 | What the room's "language" option means | The quiz question language and bot names. Each user picks their own UI language. | P1 | Open |
| C14 | The "Friend not here? Start with a bot" prompt | Shown once per empty seat after 60 s. The host can also fill a seat with a bot at any time. | P1 | Open |
| C15 | Does a disconnect in the lobby count as leaving? | **No.** The seat is held until an explicit leave, a kick or the room closing, and the seat card shows "away". Hosting passes only on an explicit leave, or after more than 5 min disconnected while another human is connected. Otherwise the Phase 0 acceptance flow breaks: the host backgrounds the app to send the WhatsApp link. | P0-M5 | Open |
| C16 | Spectator update rate | At most 1 combined snapshot per second. Players stay real-time. | P1 | Open |

## D. Game rules

| ID | Game | Question | Default | Blocks | Status |
|---|---|---|---|---|---|
| D1 | Hand Cricket | Who calls odd/even at the toss? | The joiner | P1 | Open |
| D2 | Hand Cricket | Tie | A draw | P1 | Open |
| D3 | Hand Cricket | Can the batter show 0 or "defend"? | No, picks are 1–6 only | P1 | Open |
| D4 | Hand Cricket | Chase end; extras | The innings ends the moment the target is passed. Overs are 6 balls; no extras. | P1 | Open |
| D5 | Hand Cricket | A timed-out pick | Random (server RNG). It counts towards the 3-timeout rule, except during a grace window (D30). | P1 | Open |
| D6 | Super Over | No-ball | Overstepping on the run-up meter. The next ball is a free hit. | P3 | Open |
| D7 | Super Over | Wides, running | No wides; runs come only from the shot outcome. | P3 | Open |
| D8 | Super Over | Fair play | The bowler's choice is server-secret until release, and the trajectory is sent only then. Claimed tap times are bounded on both sides by arrival time minus the server-measured RTT/2 and a jitter cap. A modified client can still auto-time shots; accepted for v1. | P3 | Open |
| D9 | Ludo | Default toggles | All on:<br>• a 6 opens a token;<br>• three 6s cancel the turn;<br>• a capture earns a bonus roll;<br>• safe stars;<br>• reaching home earns a bonus roll;<br>• finishing needs the exact roll.<br>Teams sit opposite, and a player who has finished rolls for their partner. | P2 | Open |
| D10 | Ludo | Blockades | Off | P2 | Open |
| D11 | Carrom | Win; the queen | A single board. The queen must be covered before your last coin; pocketing your last coin first is a foul. | P3 | Open |
| D12 | Carrom | Break; colours | The host breaks and plays white. In doubles, seats 0 and 2 play white. | P3 | Open |
| D13 | Carrom | Fouls and dues | Pocketing the striker returns one of your coins to the centre. If you have none, you owe a due. | P3 | Open |
| D14 | Carrom | Striker placement | Anywhere on your own baseline between the circles. Drag to aim; no thumbing. | P3 | Open |
| D15 | Quiz | Scoring | A correct answer scores 1000, plus a speed bonus of up to 500 that falls linearly over 15 s. The streak multiplier rises ×0.1 per correct answer, capped at ×1.5. A wrong or missing answer scores 0 and resets the streak. | P1 | Open |
| D16 | Quiz | Tie-break | Lower total answer time | P1 | Open |
| D17 | Quiz | Modes | Quick mixes categories; in Category mode the host picks one. | P1 | Open |
| D18 | Quiz | Offline practice | A bundled pack of ~120 questions that never appear online | P1 | Open |
| D19 | Quiz | Tamil before review | Only approved translations are shown; otherwise English. | P1 | Open |
| D20 | Quiz | 7-day no-repeat | Pick questions unseen by every player for 7 days; otherwise the least recently seen. Each match's chosen questions are frozen into `matches.config`. | P1 | Open |
| D21 | Runner | Daily Challenge day | IST (Asia/Kolkata). The generator uses integer-only arithmetic, so the course is identical on Hermes and V8. | P4 | Open |
| D22 | Runner | Prices and unlocks | A remote price table. Purchases are atomic (spend plus unlock). | P4 | Open |
| D23 | Runner | What "Continue" means | The run-start screen. Lantern Quest resumes at its checkpoint; Color Sort at the exact board. | P4 | Open |
| D24 | Lantern Quest | Lives | Unlimited retries from the checkpoint. The 3rd star means no deaths. | P4 | Open |
| D25 | Lantern Quest | Level authoring | JSON tilemaps in our own schema | P4 | Open |
| D26 | Kolam | Trace patterns | Procedural plus my own designs in the traditional folk style. Integer-only generator. | P5 | Open |
| D27 | Koi Pond | Real days | The device's local date, with no penalties | P2 | Open |
| D28 | Color Sort | Levels | Seeded by level number, with an integer-only generator, so levels are identical on every device. | P2 | Open |
| D29 | Kolam / Zen | Gallery limits | 50 items per user, each at most 8 KB of vector data | P2 | Open |
| D30 | Hand Cricket / Arcade | Disconnect grace (*deviation*) | `pauseOnDisconnect`: the clock freezes during the 60 s grace window, and timeouts during grace don't count. Otherwise "reopen within 60 s, back on the same ball" (the Phase 1 acceptance test) can't pass with 5 s picks. Quiz and Ludo keep the brief's behaviour. | P1 | Open |
| D31 | Quiz | Size of the bank | ≥ 300 online questions (≥ 50 per category), plus 120 practice questions: ~420 to write. | P1 | Open |
| D32 | Quiz | Fact-checking | Every question gets a source URL checked with web access. No records or superlatives unless tagged `as_of`. You (or a reviewer you name) check 100% of Tamil Nadu and Indian Cinema and 20% of the rest. In-app "Report question": after 3 reports the question goes to `needs_review` automatically. | P1 | Open |

## E. Sync, progress & data

| ID | Question | Default | Blocks | Status |
|---|---|---|---|---|
| E1 | LWW ordering (*deviation*) | A hybrid logical clock (client-stamped, server-clamped to +2 min), not server time. Under server time, a phone offline for a week would roll your checkpoint back. | P2 | Open |
| E2 | Idempotency vs pruning `progress_events` | max, min, set-union and HLC-LWW are idempotent by nature. Counters and coins live in `progress_ledger`, keyed **permanently** by event ID. Merge rules apply only to newly inserted event IDs. | P2 | Open |
| E3 | Replays (*narrows the brief*) | Offered only when the match's `logicVersion` equals the current one. Otherwise the final result is shown. | P1 | Open |
| E4 | Ledger safety | Spends are checked under a per-user lock. There's a `min` rule for best times and economy. Purchases are atomic. | P2 | Open |
| E5 | Outbox flush timing | Immediately on sign-in, Save my progress, or entering multiplayer. Otherwise on background or session end, at most every 15 min; the governor may stretch this. Trade-off: up to the last 15 min of progress may not yet show on another device. | P2 | Open |

## F. Content, art, audio & i18n

| ID | Question | Default | Blocks | Status |
|---|---|---|---|---|
| F1 | Fonts vs CC0-only (*deviation*) | Allow SIL OFL 1.1 fonts (Noto Sans Tamil + Latin), logged in `ASSETS.md`. CanvasKit has no system fonts, and Tamil needs shaping, so localized text is never drawn with Skia `Text`. It goes through RN `<Text>` overlays or Skia `Paragraph`. | P1 | Open |
| F2 | Audio sources | SFX synthesised by our own scripts. Music only if CC0, logged. | P1 | Open |
| F3 | Tamil reviewer | Strings stay `needs_review` until you name a reviewer. | P5 | Open |
| F4 | Quiz fact-check | See D31 and D32. | P1 | Open |
| F5 | App icon | A generated vector icon, once A7 is decided | P0-APK | Open |

## G. Android distribution

| ID | Question | Default | Blocks | Status |
|---|---|---|---|---|
| G1 | Android developer verification | Enforcement began on 2026-09-30, but only for store installs in BR, ID, SG and TH. Sideloading is unaffected so far. **Global in 2027**; `adb` stays exempt; users get an opt-in advanced flow. Register the package and the EAS key's SHA-256 under the A0 owner's identity before 2027.<br>• **Limited distribution:** free, no ID, ≤ 20 opted-in devices.<br>• **Full distribution:** ID documents. | P0-APK | Open |
| G2 | ABIs vs 60 MB | A universal APK with arm64-v8a + armeabi-v7a. If it's over 60 MB, ship arm64 as the main APK plus a separate v7a APK. | P0-APK | Open |
| G3 | Where the APK is hosted | **Never on Render** (5 GB of bandwidth). GitHub Releases, or a public releases repo (A3). | P0-APK | Open |
| G4 | Keystore custody | EAS-managed, used only by **EAS cloud** builds. The backup goes to the A0 owner's storage, not this machine. | P0-APK | Open |
| G5 | Permissions (*deviation*) | No runtime permission except `POST_NOTIFICATIONS`. The normal install-time permissions FCM and connectivity need are allowed. Storage, location, camera, mic, phone state and overlays are blocked. CI checks the merged manifest. The brief's literal list would break push. | P0-APK | Open |
| G6 | Play App Signing later | Upload the existing EAS key, so the signing identity never changes. | P5 | Open |
| G7 | Dev builds | The `.dev` package variant, signed with a project-unique debug key (never the public template key). Registered for OAuth and assetlinks separately. | P0-M1 | Open |

## H. Web

| ID | Question | Default | Blocks | Status |
|---|---|---|---|---|
| H1 | Supported browsers | The latest 2 versions of Chrome, Edge, Firefox and Safari. Android Chrome is primary; iOS Safari is best effort. | P0-M6 | Open |
| H2 | Web push | Phase 5, and only if there's time | P5 | Open |
| H3 | PWA offline scope | The shell is precached. Game chunks, assets and CanvasKit are cached on first use, so solo games already played work offline. | P0-M6 | Open |
| H4 | Home tile animation on web | Separate `tile` chunks using CSS/Reanimated, with no Skia. A light parallax on hover. | P0-M6 | Open |
| H5 | Where CanvasKit comes from | jsDelivr, **version-matched** to the installed Skia, SRI-checked, with an 8 s timeout and a self-hosted fallback. jsDelivr is allowed only in CSP `connect-src`, never `script-src`. | P0-M1 | Open |
| H6 | Home render path (LCP < 2.5 s) | Decided in M6: Expo Router static output for Home, or an SPA with an HTML/CSS hero. The Home entry must be ≤ 250 KB brotli. | P0-M6 | Open |
| H7 | In-app browsers (WhatsApp's WebView) | Hide Google sign-in and the APK download. Show "Open in Chrome" plus the room code. Gameplay still works. | P0-M6 | Open |

## I. Tooling & process

| ID | Question | Default | Blocks | Status |
|---|---|---|---|---|
| I1 | Sentry (not in the brief's "I will provide" list) | The SDKs are wired behind an env DSN and do nothing until you create a project (Phase 5). | — | Open |
| I2 | Node | Node 24 LTS, pinned in `.nvmrc`, `engines` and `NODE_VERSION`. Revisit Node 26 after it becomes LTS on 2026-10-28. | P0-M0 | Open |
| I3 | Perf reference device | A mid-range phone with ~4 GB RAM (yours if it qualifies), recorded in `PERF.md` | P0-M1 | Open |
| I4 | The load test's "Starter-sized instance" | Temporarily upgrade for a day (prorated), or approximate locally. Decide in Phase 5. | P5 | Open |
| I5 | Dev-only games | Tic-Tac-Toe **plus** Secret Pick (simultaneous hidden picks, to prove redaction). `games.status = dev`, visible only to `DEV_USER_IDS`. Rooms are joinable by link, so the acceptance test runs on the real deployment. Set to `disabled` when Hand Cricket ships. | P0-M3 | Open |
| I6 | Game SDK refinements (ARCH §3.1–3.2) | Adopt them. They're additive to the brief's interface. | P0-M3 | Open |
| I7 | Render's 500 build minutes | Render-native filtered builds, merges per milestone, and a $0 spend limit (~150 min/month). Prebuilt deploy branches only if usage passes 300 min. | P0-M2 | Open |
| I8 | Expo SDK 57 or 58 | Spike (a) runs on both. Pin whichever is stable at the spike report (58 is expected mid-October). | P0-M1 | Open |
| I9 | Spend guard-rails | A $0 Render build spend limit; the Neon governor; RUNBOOK alarms (Neon 60 CU-h, Render bandwidth 3.5 GB). | P0-M2 | Open |
| I10 | Approve the Proposed decisions | ARCH §14: D-005, D-007, D-008, D-009, D-010, D-012, D-013, D-016, D-017, D-018, D-020, D-021, D-024–D-030, D-032, D-033, D-036–D-041 | P0-M0 | Open |
| I11 | Postgres major version | 17 on Neon, `embedded-postgres` 17.x locally, `postgres:17` in CI | P0-M2 | Open |
| I12 | Quiz bank in a public repo | Keep the online bank out of git: commit the schema, a 10-question sample and an importer. The bank lives in your storage and is loaded through an admin import endpoint. | P1 | Open |
| I13 | Commit granularity | Each milestone is a series of small conventional commits, tagged `p0-mN` at the end. | P0-M0 | Open |
