# Build Brief: {{APP_NAME}} (a 10-game platform for Android + Web)

> **How to use:** create an empty repo, save this file as `docs/BUILD_BRIEF.md`, open Claude Code in the repo and say:
> *"Read docs/BUILD_BRIEF.md end to end. Follow section 0 exactly and start with Phase 0."*
> Replace `{{APP_NAME}}`, `{{ANDROID_PACKAGE}}` (e.g. `com.yourcompany.gamehub`), `{{SCHEME}}` (e.g. `gamehub`) and `{{WEB_DOMAIN}}` before you start.

---

## 0. How you (Claude Code) must work

- You are the tech lead and sole engineer on this repo. I'm a senior React Native developer: I know the New Architecture, TurboModules and JSI. Skip the basics and explain trade-offs.
- **Start in plan mode.** Before writing any code:
  1. Read this whole brief.
  2. Write `docs/ARCHITECTURE.md`, with a diagram and a decision log.
  3. Write `docs/OPEN_QUESTIONS.md`, listing every ambiguity together with the default you propose.
- **Your first reply must contain:**
  - your understanding of the brief, in 15 bullets or fewer;
  - your top 10 technical risks, each with a mitigation;
  - any questions that block Phase 0;
  - the Phase 0 plan.

  Then wait for my go-ahead.
- Build **one phase at a time** (§16). At the end of each phase:
  - Stop and run all tests.
  - Report what was built, how I can verify it on my phone and in a browser, the known gaps, and what comes next.
  - Don't start the next phase until I approve.
- Create and maintain `CLAUDE.md`, covering repo conventions, commands, and any gotchas you discover.
- Use strict TypeScript everywhere. No `any` in game logic. Make small commits per milestone, using conventional commit messages.
- Use the **latest stable** versions, and verify compatibility yourself rather than trusting your memory of version numbers. Once a combination works, pin exact versions.
- For anything you can't do yourself (creating Render, Neon, Google Cloud, Firebase or Expo accounts, or adding secrets):
  - write exact click-by-click steps in `docs/SETUP.md`;
  - ship `.env.example` files;
  - never commit secrets.
- If you think part of this brief is wrong, or you see a better approach, explain why **before** you deviate from it.

---

## 1. The product in one paragraph

One app, many games. A single Expo / React Native codebase ships as an **Android APK** and a **web app hosted on Render**, backed by **Neon Postgres**. The Home screen shows **10 games** on three shelves:

- **Play with Friends:** real-time multiplayer rooms.
- **Adventure:** solo games with heavy animation.
- **Relax:** no timers, no losing, satisfying animation and sound.

Any multiplayer game can be started as a **one-time match room**, shared by link, QR code or a 6-character code. Friends join from the app or the browser and play each other in real time across platforms. Each game limits the number of seats: **Cricket has exactly 2, the host and one joiner.** Every match, stat and piece of solo progress is saved to the player's account and synced across devices.

---

## 2. Locked decisions

| Area | Decision |
|---|---|
| Platforms | Android (sideloaded APK) and Web (browser, installable as a PWA), from one Expo codebase using react-native-web |
| App framework | Expo (latest stable SDK, New Architecture), Expo Router, TypeScript |
| Game rendering | `@shopify/react-native-skia` + Reanimated worklets + Gesture Handler for every game canvas. Menus and dashboards are plain RN views. |
| Physics | `planck.js` (a Box2D port). Carrom physics runs on the server; solo games run physics on the client. |
| Server | Node (current LTS) + Fastify + Socket.IO, in a **single process** |
| Database | Neon Postgres via Drizzle ORM |
| Hosting | Render: **1 free Web Service** (API + sockets) and **1 Static Site** (web app), both in the **Singapore** region. Neon in **aws-ap-southeast-1 (Singapore)**. |
| Auth | Guest-first, with an optional upgrade to a Google account |
| Groups | **One-time match rooms.** No persistent groups in v1. |
| v1 extras | Bots fill empty or abandoned seats · spectators + emoji reactions · push notifications |
| Languages | English first, with Tamil strings through i18n from day one |

---

## 3. Game catalog (v1)

| # | Game | Shelf | Seats | Modes | Bots | Offline |
|---|---|---|---|---|---|---|
| 1 | **Cricket** | Friends | **exactly 2** (host + 1 joiner) | Hand Cricket · Arcade Super Over | ✓ | vs bot |
| 2 | **Ludo** | Friends | 2–4 (host picks) | Classic; 2v2 teams at 4 seats | ✓ | vs bots |
| 3 | **Carrom** | Friends | 2 (singles) or 4 (doubles, partners sit opposite) | Classic | ✓ | vs bot |
| 4 | **Quiz Battle** | Friends | 2–8 | Quick (10 questions) · Category | ✓ | solo practice |
| 5 | **Monsoon Rooftop Runner** | Adventure | 1 | Endless · Daily Challenge | – | ✓ |
| 6 | **Lantern Quest** | Adventure | 1 | 15 levels | – | ✓ |
| 7 | **Kolam Studio** | Relax | 1 | Free draw · Trace | – | ✓ |
| 8 | **Koi Pond** | Relax | 1 | – | – | ✓ |
| 9 | **Color Sort Flow** | Relax | 1 | Levels | – | ✓ |
| 10 | **Zen Sand Garden** | Relax | 1 | – | – | ✓ |

All game concepts, names and art must be **original**. Do not imitate the characters, logos, names or level designs of existing commercial games.

---

## 4. Architecture

### 4.1 Monorepo (pnpm workspaces + Turborepo)

```
/
├─ apps/
│  ├─ client/            # Expo app → Android APK + web export (one codebase)
│  └─ server/            # Fastify + Socket.IO game server + REST API
├─ packages/
│  ├─ game-sdk/          # GameModule contract, seeded RNG, contract test harness
│  ├─ protocol/          # zod schemas for every socket event + REST DTO, PROTOCOL_VERSION
│  ├─ db/                # Drizzle schema, migrations, seed scripts (quiz bank)
│  ├─ sync/              # offline-first progress store + merge rules (client & server)
│  ├─ ui/                # design tokens, themed components, animated primitives
│  └─ games/
│     ├─ cricket/        # logic/ (pure TS) · bot/ · ui/ (Skia) · assets/
│     ├─ ludo/  carrom/  quiz/
│     ├─ runner/  lantern-quest/
│     └─ kolam/  koi-pond/  color-sort/  zen-garden/
├─ docs/                 # ARCHITECTURE, SETUP, RELEASE, RUNBOOK, ASSETS, OPEN_QUESTIONS
├─ render.yaml
└─ .github/workflows/    # ci.yml, keep-alive.yml
```

Each game package exports:

- **`logic`**: pure TypeScript with no React or React Native imports, so the server can run it.
- **`ui`**: client-only code.

Enforce this split with a lint rule (ESLint import restrictions or dependency-cruiser).

### 4.2 Stack

- **Client**
  - Expo Router for navigation.
  - Zustand for UI state and TanStack Query for REST calls.
  - `socket.io-client` with `transports: ['websocket']`.
  - One storage interface, backed by `react-native-mmkv` on Android and IndexedDB on web.
  - `expo-secure-store` for tokens.
  - `expo-notifications`, `expo-audio`, `expo-haptics`.
  - `i18next` for translations.
- **Server**
  - Fastify, Socket.IO, zod.
  - `drizzle-orm` + `pg`, connected to the pooled Neon URL.
  - `jose` for JWTs and `google-auth-library` to verify Google ID tokens.
  - `expo-server-sdk` for push, `pino` for logging, `@fastify/rate-limit`.

### 4.3 Non-negotiable rules

1. **The server is the only authority in multiplayer.** Clients send *intents*. The server validates them with the game's reducer and broadcasts the result. Clients may predict ahead to make the game feel responsive, but they must always reconcile to the server's state.
2. **Game logic is pure and deterministic** for a given `(state, action, rng)`. The same code runs:
   - on the server, for multiplayer;
   - on the client, for offline games against bots and for solo games;
   - in tests.
3. **Hidden information never leaves the server.** Every broadcast passes through `viewFor(viewer)`.
4. **60 fps discipline:**
   - Game loops run in Reanimated worklets (`useFrameCallback`) and write to shared values that Skia reads directly.
   - **No React state updates per frame.**
   - No allocations in hot loops; pool particles and other short-lived objects.

---

## 5. The Game SDK (plug-in architecture)

To add a game, create a new package and add one line to the registry. Write this contract first and get it right before building any game.

```ts
export type Seat = number;
export type Viewer = { kind: 'seat'; seat: Seat } | { kind: 'spectator' };
export type BotLevel = 'easy' | 'medium' | 'hard';

export interface ModeManifest {
  id: string;                              // 'hand-cricket'
  name: I18nKey;
  seats: { min: number; max: number; allowed?: number[] }; // cricket {2,2}; carrom allowed [2,4]
  teams?: 'none' | 'pairs';
  turnTimerSec?: number;
  supportsBots: boolean;
  supportsSpectators: boolean;
}

export interface GameManifest {
  id: string;                              // 'cricket'
  name: I18nKey;
  shelf: 'friends' | 'adventure' | 'relax';
  modes: ModeManifest[];
  offlineCapable: boolean;
  minAppVersion: string;
}

export interface GameModule<S, A, C> {
  manifest: GameManifest;
  configSchema: ZodType<C>;
  actionSchema: ZodType<A>;
  init(ctx: { config: C; seats: SeatInfo[]; rng: Rng; now: number }): S;
  legalActions?(state: S, seat: Seat): A[];                // for bots + tests
  validate(state: S, action: A, seat: Seat): { ok: true } | { ok: false; reason: string };
  reduce(state: S, action: A, seat: Seat, ctx: { rng: Rng; now: number }): { state: S; events: GameEvent[] };
  tick?(state: S, ctx: { rng: Rng; now: number }): { state: S; events: GameEvent[] }; // timers, simultaneous reveals
  onTimeout(state: S, seat: Seat, rng: Rng): A;            // auto-move when a turn timer expires
  result(state: S): MatchResult | null;                     // non-null = match over
  viewFor(state: S, viewer: Viewer): unknown;               // redacts hidden info
  bot: { choose(view: unknown, seat: Seat, level: BotLevel, rng: Rng): A };
}
```

- **Solo games** implement a lighter `SoloGameModule`, which has a manifest, a save-data schema, per-field merge rules (§8) and a screen.
- **Client registry:** `registerGame({ module, Screen, LobbyOptions?, TilePreview, loadAssets })`.
  - Every game is **lazy-imported**, so the web build is code-split per game.
- **Remote catalog:** the server's `games` table decides which games are enabled, featured or ordered first. This acts as a kill-switch that needs no app update.
- **Seeded RNG:** use a fast seeded PRNG (xoshiro or mulberry32). The server generates each match seed with `crypto`. Storing the seed and the action log is enough to **replay any match**.

### Contract test harness (`packages/game-sdk/testing`). Run it on every GameModule in CI.

1. **Simulation:** run 1,000 seeded bot-vs-bot matches per mode. Every match must:
   - end within a maximum number of actions;
   - throw no exceptions;
   - produce a valid result.
2. **Property tests** (fast-check):
   - random sequences of legal actions never break the game's invariants;
   - illegal actions are always rejected.
3. **Redaction:** snapshot tests confirm that `viewFor(spectator)` and `viewFor(another seat)` never contain hidden fields.
4. **Determinism:** the same seed with the same actions always produces an identical final state, so replays work.

---

## 6. Rooms & real-time multiplayer

### 6.1 Lifecycle

```
LOBBY ──start──▶ IN_PROGRESS ──end──▶ FINISHED ──rematch──▶ IN_PROGRESS (new match, same room)
  │                                        │
  └─ 30 min idle ─▶ CLOSED                 └─ 10 min after last rematch prompt ─▶ CLOSED
```

### 6.2 Create → share → join

- **Create:** the host picks a game, then a mode, then a seat count. Seat count can only be chosen where the mode allows a range; **Cricket is locked at 2**. Then the host sets options (overs, bot difficulty, quiz category, language).
- **Code:** 6 characters drawn from `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, which leaves out the easily confused 0, O, 1, I and L. A code is unique while its room is open and is not reused for 24 h.
- **Link:** `https://{{WEB_DOMAIN}}/join/<CODE>`, shared through:
  - the native share sheet (put WhatsApp first);
  - copy link;
  - a **QR code**;
  - an **"Enter code"** box on Home.
- **One link, every situation:**
  - App installed → an Android App Link opens the app **straight into the lobby**.
  - App not installed → the web lobby opens, with a "Get the Android app" banner.
  - User already seated in the room → they rejoin their seat.

### 6.3 Lobby & seats

- **Seat cards** show the avatar, name, platform badge (Android / Web), ready state and a connection dot.
- **The host can:**
  - change options until the match starts;
  - kick a player;
  - **fill a seat with a bot**;
  - start the match once every seat is filled and ready.
- If the host leaves the lobby, hosting passes to the next seat.
- **The server enforces seating:**
  - a user holds at most one seat per room;
  - joining is idempotent;
  - a race for the last seat is settled **atomically**: one player wins it, and the other is offered spectating.
- If the room is full, show **"Room full: watch live?"** and offer to join as a spectator.

### 6.4 Reconnect & takeover

- A player who drops keeps their seat for a **60 s grace window**, and the other players see a countdown. Turn timers keep running, and any turn that times out is auto-moved via `onTimeout`.
- **When the grace window expires:**
  - a **bot takes over the seat**, labelled "Bot playing for <name>";
  - the player can **reclaim the seat** at any time by opening the link again;
  - three consecutive timeouts trigger the same takeover.
- **On reconnect:**
  - the client sends `{ roomId, lastStateVersion }`;
  - the server replies with a full `viewFor` snapshot. This is simple and robust; move to deltas only if measurements show a need.
- **Handle backgrounding explicitly:** Android `AppState` changes and web `visibilitychange` events.

### 6.5 Bots

- Bots are **always labelled as bots** and are never disguised as humans.
- **Bots are used in three ways:**
  1. Filling an empty seat: after 60 s with no joiner, prompt the host with "Friend not here? Start with a bot".
  2. Taking over a disconnected seat.
  3. Offline and solo practice.
- **Difficulty:** easy, medium and hard. Add a small "thinking" delay so bots play at a human pace.
- **CPU budget:** the free server has **0.1 CPU**.
  - No deep search.
  - Each bot move must take **under 5 ms**.
  - Carrom is the one exception (see §7.3).

### 6.6 Spectators & reactions

- **Spectators:**
  - up to 20 per room;
  - the spectator view never reveals hidden information (Hand Cricket picks before the reveal, quiz answers before the reveal);
  - players can see how many people are watching.
- **Reactions:**
  - a fixed set of 8 emoji, with **no free-text chat in v1**, so there is nothing to moderate;
  - rate-limited to 1 every 2 s per person;
  - rendered as floating Skia particles;
  - players can mute them.

### 6.7 Timers & clock sync

- The server owns every timer.
- Clients estimate their offset from server time with a ping/pong handshake (median of 5 samples, refreshed every 30 s).
- Clients render countdowns from **server deadlines**, never from local counters.

### 6.8 Protocol

- Every event in both directions has a **zod schema** in `packages/protocol`.
- **Handshake:** sends `protocolVersion` and `appVersion`. Incompatible clients get a clear **"Update required"** screen.
- **Actions:** each one carries a `clientActionId`, so retries are idempotent, and the server acks it.
- **State messages:** each carries a `version` that only ever increases.
- **Bandwidth:** keep messages small and turn off `perMessageDeflate`, because compression costs CPU on a 0.1-CPU box.

### 6.9 Push notifications

- **Channel:** Expo Notifications (FCM underneath) on Android.
- **Notify when:**
  - someone joins your room;
  - all seats are filled;
  - **it's your turn** while the app is in the background;
  - a rematch is requested;
  - a recent opponent sends a **"Play again?"** invite. This comes from a *Recent Players* list, which makes one-time rooms feel social without needing a friends system.
- **Permission:** ask in context, never on first launch. For example, when a user creates their first room: *"Get notified when your friend joins?"* Handle the Android 13+ runtime permission.
- **Web push:** optional, in Phase 5.

---

## 7. Game specifications

> Every game must feel *premium*: animated transitions, particle feedback, sound, haptics. "Heavy animation" means shaders, particles, parallax and camera motion, **not** large sprite sheets (see §13).

### 7.1 Cricket (2 seats; two modes under one tile)

**Hand Cricket**, the classic school game:

- **Toss:** one player calls odd or even, both show 1–6, and the sum decides. The winner chooses to bat or bowl.
- **Each ball:**
  - both players secretly pick 1–6 within 5 s; a timeout picks randomly;
  - the server reveals both picks **together**;
  - if the numbers match, the batter is **OUT**; otherwise the batter scores their own number.
- **Innings and match:** an innings ends on wickets (1–3) or overs (1, 2 or 5), as the host chooses. The second innings is a chase.
- **Animation:** Skia-drawn hands flicking finger counts, a "thunk" on the reveal, a ticking scoreboard, and a stumps-flying wicket animation with screen shake.
- **Hard bot:** tracks the human's pick frequencies and sequences (people are predictable) and exploits them.

**Arcade Super Over:**

- **Bowler:** chooses pace or spin, picks line and length on a pitch map, and picks a variation.
- **Batter:** swipes for the shot direction and taps to time the shot.
- **Server timing model:**
  - on `deliver`, the server schedules the ball's release at server time T+600 ms, with seeded variance;
  - the batter's tap is sent as an estimated **server time**;
  - the server grades the timing (perfect, good, early, late or miss), with the tolerance widened by RTT/2, capped;
  - the outcome comes from timing quality × the shot vs line/length matrix × seeded RNG: 0/1/2/3/4/6, caught, bowled, or a simplified LBW;
  - both clients animate the **same server-chosen trajectory**.
- **Formats:** Super Over (6 balls, 2 wickets), 2 overs, 5 overs. A no-ball earns a free hit.
- **Animation:** 3/4-view pitch, ball trail, bat swing, camera shake on a six, crowd roar, fielders running.

**Stats** (kept per mode): W/L, runs, highest score, sixes, ducks, best economy.

### 7.2 Ludo (2–4 seats)

- **Rules:** classic Indian rules, each a host toggle:
  - a 6 is needed to open a token;
  - three 6s in a row cancel the turn;
  - a capture earns a bonus roll;
  - safe star squares;
  - **2v2 teams** at 4 seats.
- **Dice:** the server rolls them, seeded with `crypto`. The dice animation always lands on the server's value.
- **Turns:** 20 s timer. A timeout plays the best legal move as chosen by the bot.
- **Animation:** tokens hop square by square, and a capture plays a knock-back animation.
- **Accessibility:** tokens differ by **shape and colour**, so the game is colour-blind safe.
- **Bot:** prefers moves in this order: capture, then reach safety, then enter home, then advance the furthest token. Easy bots add randomness.

### 7.3 Carrom (2 singles / 4 doubles)

- **Rules:** a simplified ICF style:
  - white and black coins;
  - the queen must be covered;
  - pocketing the striker is a foul and costs a penalty (a "due");
  - a side wins by pocketing all of its coins.
- **Controls:** place the striker on the baseline, drag to aim, pull back to set power.
- **Physics is server-authoritative:**
  - The client sends `{ strikerX, angle, power }`.
  - The server runs `planck.js` at a fixed 60 Hz until everything stops, capped at 8 s.
  - The server returns a **sampled trajectory** (positions of the moving bodies at 30 Hz, quantised) plus the final state, and clients **play that back**.
  - **Don't rely on floating-point results matching across JS engines** (Hermes and V8 `Math.*` can differ). Clients never re-simulate.
  - Hide the round trip behind a 300 ms striker wind-up animation.
- **CPU budget:** one shot simulation must take ≤ 30 ms on a dev laptop. Expect it to run about 10× slower on a 0.1-CPU free instance; benchmark this in Phase 0.
- **Bot:**
  - geometric aiming (the ghost-coin method) over a few candidate coin and pocket pairs;
  - noise added according to difficulty;
  - **at most 3 simulations** to choose a shot, never a brute-force search.
- **Offline vs bot:** the local simulation is the authority.

### 7.4 Quiz Battle (2–8 seats)

- **Format:** rounds of 10 questions, 15 s each, and everyone answers at the same time.
- **Scoring:** correct answer × (base points + speed bonus), plus a streak multiplier.
- **Answer secrecy:** the server sends each question **without its answer**. The answer is revealed once everyone has answered or time runs out, along with a chart showing what % picked each option.
- **Categories:** Cricket, Indian Cinema, Science, Tech, General Knowledge, Tamil Nadu.
- **Question bank:**
  - Seed **≥ 300 original English questions**, each with a `source` note.
  - Avoid facts that go stale ("current captain…", "latest…").
  - Tamil translations are marked `needs_review` until a native speaker approves them.
  - The bank lives in Postgres, so new packs ship without an app update.
  - Avoid repeating a question for the same player within 7 days.
- **Bot:** accuracy and response-time distributions vary by difficulty.

### 7.5 Monsoon Rooftop Runner (solo, adventure)

- **Core:** a side-scrolling endless runner across rain-soaked city rooftops at dusk.
  - Moves: jump, slide, double-jump.
  - Power-ups: umbrella glide, magnet, shield.
  - Coins: collect **chai cups**.
- **Visuals:**
  - 4+ parallax layers;
  - an **SkSL rain shader**;
  - lightning flashes that briefly reveal the gaps ahead;
  - puddle splashes and wet-reflection highlights;
  - a dusk-to-night progression during a run.
- **Daily Challenge:** a course seeded by the date, so everyone plays the same run that day, with a shareable score-card image.
- **Progress saved:** high score, total distance, a coin ledger, unlocks (characters, umbrellas), and 3 daily missions.

### 7.6 Lantern Quest (solo, adventure)

- **Core:** a platformer in which a lantern spirit crosses a dark forest. **The lantern's glow is the only light**, drawn with an SkSL radial light and soft shadows.
- **Levels:** 15 levels across 3 biomes. Levels are **JSON tilemaps in the repo**, as data rather than code, so they can be edited without touching game logic.
- **Mechanics:**
  - moving platforms;
  - fireflies that extend the light radius;
  - shadow creatures that flee the light;
  - a boss on level 15.
- **Checkpoints and stars:** checkpoints, plus a 3-star rating (finish the level, collect every firefly, no deaths).
- **Controls:** customisable on-screen buttons on Android; keyboard and the **Gamepad API** on web.
- **Progress saved:** per-level stars, best time, checkpoint, collectibles.

### 7.7 Kolam Studio (solo, relax)

- **Canvas:** a dot (pulli) grid from 5×5 up to 15×15. Draw smoothed curves around the dots.
- **Symmetry:** none, 2-fold, 4-fold or 8-fold, with strokes mirrored **live**.
- **Feedback:** each closed loop glows and fills in softly.
- **Modes:**
  - **Trace:** follow classic patterns.
  - **Free:** draw anything.
- **Saving and sharing:**
  - save to a gallery as **compact vector data** (simplified, quantised paths), not images;
  - export a PNG to the share sheet (WhatsApp).
- **Audio:** an ambient loop, either CC0 or synthesised.

### 7.8 Koi Pond (solo, relax)

- **Water and fish:** a water-ripple shader reacts to touch. Koi school using boids, and tapping feeds them so they gather.
- **Return loop:** a lotus blooms over **real days**. The pond grows the more days you visit, and absence is **never** punished.
- **Ambience:** day and night follow the device's local time, with occasional rain.
- **No score and no fail state.**
- **Progress saved:** the fish collection and pond decorations.

### 7.9 Color Sort Flow (solo, relax)

- **Core:** pour coloured liquids between tubes until each tube holds a single colour.
- **Level generation:**
  - levels are procedural and **always solvable**: generate each one by applying random legal reverse-moves from a solved state;
  - a difficulty curve controls how levels ramp up.
- **Helpers:** unlimited undo, plus a hint from a BFS solver (practical because the states are small).
- **Animation:** the tube tilts and the liquid pours as a stream drawn with a path and a shader.
- **Accessibility:** a **colour-blind mode** with a pattern or symbol for every colour.

### 7.10 Zen Sand Garden (solo, relax)

- **Raking:** rake the sand with a finger. Grooves are drawn with a **normal-map shader**, so the light catches the ridges.
- **Tools:**
  - several rake widths;
  - stones and moss to place and move;
  - a sweep gesture that smooths the sand back to flat.
- **Sound:** generative ambient audio, with pentatonic notes triggered by stroke speed and direction over a drone.
- **Saving:** gardens go to the gallery as vector strokes.

---

## 8. Accounts, progress & sync

### 8.1 Identity

- **Guest-first:** the first launch, or the first time someone opens a link, silently creates a guest account with:
  - a fun generated name ("Swift Mango 42");
  - a **procedural avatar** generated from a seed on the client. No image uploads, because the free server has no persistent disk.

  Names are editable and pass through a profanity filter.
- **Google upgrade:** **"Save my progress"** starts Google sign-in.
  - Android uses the native sign-in; web uses Google Identity Services.
  - The server verifies the ID token and links the Google account to the guest.
  - If that Google account already exists (the person played on another device), **merge** the guest into it using the rules in §8.3, then show a summary such as *"Merged 12 matches + Lantern Quest progress"*.
- **Sessions:** a 15-minute access JWT plus a rotating refresh token, stored hashed in the database and revocable.
- **Token storage on Android:** `expo-secure-store`.
- **Token storage on web:**
  - Prefer a custom domain (`play.<domain>` and `api.<domain>`) so the refresh token can be an httpOnly `SameSite=Lax` cookie. Browsers treat separate `*.onrender.com` apps as different sites, so cookies don't work well there.
  - Until a custom domain exists, use bearer tokens and keep the refresh token in IndexedDB.
  - Switching between the two must be a config change only.
- **Account deletion:** in-app. Play Store requires it later, and it's good hygiene now.

### 8.2 What "every activity and progress is maintained" means

- **Every multiplayer match** creates a match record, participant rows, and updates per-user, per-game, per-mode stats.
- **Every solo session** updates a save slot and stats.
- **An Activity timeline** on the profile (match played, level cleared, kolam saved…).
- **Match replays** for the last 30 days, rebuilt from the seed and action log by re-running the reducer.
- **"Continue" row on Home:** resumes the last solo game at the exact point the player left it.

### 8.3 Offline-first sync (`packages/sync`)

Write to the local store first. Progress events go into an **outbox**, each with an idempotency key (UUIDv7), and are flushed when the device is online. The server applies **per-field merge rules** and returns the canonical state:

| Rule | Used for |
|---|---|
| `max` | high scores, best times, stars |
| `set-union` | unlocks, gallery items (by id) |
| `ledger` | coins: store earn and spend events and derive the balance; the server validates spends |
| `last-write-wins` (server time) | settings, current checkpoint |

**Never let a client overwrite a whole save blob.**

---

## 9. Data model (Drizzle; refine names as you see fit)

```
users(id, kind[guest|google], display_name, avatar_seed, locale, created_at, last_seen_at, deleted_at)
auth_identities(user_id, provider, provider_sub UNIQUE, email)
refresh_tokens(id, user_id, token_hash, device_id, expires_at, revoked_at)
devices(id, user_id, platform, app_version, push_token, last_seen_at)
games(id, shelf, enabled, featured, sort, min_app_version, config jsonb)            -- remote catalog
rooms(id, code, game_id, mode, host_user_id, seat_count, options jsonb, status,
      created_at, started_at, closed_at, expires_at)
room_seats(room_id, seat, user_id NULL, bot_level NULL, team NULL, joined_at, left_at)
matches(id, room_id, game_id, mode, seed, snapshot jsonb, snapshot_version, result jsonb,
        started_at, ended_at)
match_actions(match_id, seq, seat, action jsonb, server_ts)                          -- pruned after 30 days
match_participants(match_id, user_id, seat, team, outcome, score, stats jsonb)
user_game_stats(user_id, game_id, mode, played, won, lost, drawn, streak, best jsonb)
save_slots(user_id, game_id, data jsonb, version, updated_at)
progress_events(id uuid PK, user_id, game_id, type, payload jsonb, client_ts, applied_at) -- idempotency
activity(user_id, type, game_id, ref_id, created_at)                                 -- capped per user
quiz_questions(id, category, lang, prompt, options jsonb, answer_idx, difficulty, source, status)
recent_players(user_id, other_user_id, last_played_at)
app_releases(version, platform, apk_url, min_supported, notes, created_at)
```

**Storage budget:** Neon free gives 0.5 GB per project.

- Prune `match_actions` after 30 days.
- Prune `progress_events` 7 days after they're applied.
- Cap `activity` at 500 rows per user.
- Keep snapshots compact.

---

## 10. Hosting: Render + Neon on the free tier, engineered around its limits

### 10.1 Facts (verified Oct 2026; re-check the pricing pages before launch)

| Item | Limit | Impact |
|---|---|---|
| Render free web service | 0.1 CPU, 512 MB RAM, single instance | Keep bots and physics cheap; no horizontal scaling |
| | Spins down after **15 min** with no inbound HTTP request or WebSocket message; cold start takes **~1 min** | Needs a keep-alive (§10.4) and a "waking up" screen |
| | May be **restarted at any time**; local filesystem is wiped | Room state must survive restarts (rule 4) |
| | **750 instance-hours** per workspace per month | A 31-day month is 744 h, so **exactly one** free service can stay always-on |
| | **Pre-deploy command is paid-only** | Run migrations at start-up (rule 6) |
| Render free Key Value | 25 MB, in-memory only, **lost on any restart** | **Don't use it** |
| Render static site | Free; doesn't use instance hours | Host the web app here |
| Render Starter (upgrade path) | 0.5 CPU, 512 MB, always on, $7/month | — |
| Neon free | **100 CU-hours** per project per month | When used up, compute is **suspended until next month** and the whole app is down |
| | Scales to zero after **5 min** idle, and this can't be disabled | Brief cold start on the first query |
| | **0.5 GB** storage per project | Pruning rules in §9 |
| | Pooled endpoint: `-pooler` host, PgBouncer in **transaction mode** | Use it for app traffic (rule 5) |
| Regions | Neither Render nor Neon has an India region; Singapore is the closest to Chennai | Use **Render Singapore + Neon aws-ap-southeast-1**. Neither can be changed later. |

### 10.2 Rules that follow from these facts

1. **Run exactly ONE free web service** (API, Socket.IO and push sender in one process) and **ONE static site**.
   - Disable PR preview environments for the free service, because they'd eat into the 750 h.
   - Auto-deploy from `main` only.
2. **`/health` checks process liveness only and must never touch Postgres.**
   - Why: the keep-alive pings every 10 min, and Neon stays awake for 5 min after its last query. If each ping woke Neon, it would be up about half the month. That's about 93 of the 100 CU-hours gone before anyone plays, and then the app goes down.
   - `/health/deep`, which does check the database, is for manual use only.
   - Render's `healthCheckPath` must be `/health`.
   - **Add a test that fails if `/health` runs a query.**
3. **Write to the database only at state transitions:**
   - room created;
   - match started;
   - snapshot on turn change, or every N actions;
   - match ended;
   - progress flush.

   Batch writes, and never write per frame or per tick. No timer-driven jobs or polling that touch the database; run pruning lazily (at most once an hour, triggered on match end). This lets Neon **sleep when nobody is playing**. In Neon's settings, cap autoscaling at **0.25–0.5 CU**, because a bigger compute burns CU-hours faster.
4. **Room state lives in process memory.** There's a single instance, so no Redis adapter is needed. Snapshot rooms to Neon on every transition. On boot, **restore `IN_PROGRESS` rooms from Neon**; clients reconnect automatically and resume. Restarts and deploys must not kill matches.
5. **Database URLs:**
   - `DATABASE_URL` is the pooled URL, for all app traffic.
   - `DATABASE_URL_DIRECT` is for migrations only.
   - Don't use session features over the pooler: no `SET`, `LISTEN`/`NOTIFY`, session advisory locks or SQL `PREPARE`. Driver-level prepared statements are fine.
6. **Migrations:** pre-deploy is paid-only, so run `migrate` (using the direct URL) **in the start command, before `listen`**. Make it safe if two boots overlap, and make a failure crash the process loudly.
7. **Cold-start UX:** if the first request takes longer than 2 s, show an animated *"Waking up the game server…"* screen with an automatic retry, in case the keep-alive missed a ping.
8. **Upgrade path:** moving from free to Starter is a plan change in `render.yaml` with **zero code changes**. Document this in `RUNBOOK.md` along with when to do it: the first real launch, more than 20 concurrent rooms, or sustained CPU above 70%.

### 10.3 `render.yaml` (a sketch; validate it against Render's Blueprint spec)

- `api`:
  - `type: web`, `runtime: node`, `region: singapore`, `plan: free`
  - `healthCheckPath: /health`
  - env vars set to `sync: false`: `DATABASE_URL`, `DATABASE_URL_DIRECT`, `JWT_SECRET`, `REFRESH_SECRET`, `GOOGLE_CLIENT_IDS`, `EXPO_ACCESS_TOKEN`, `CORS_ORIGINS`, `MIN_PROTOCOL_VERSION`
- `web`:
  - `type: web`, `runtime: static`
  - build: `expo export -p web`, `staticPublishPath: apps/client/dist`
  - rewrite `/*` → `/index.html`
  - serve `/.well-known/assetlinks.json` with header `Content-Type: application/json`
  - long cache on hashed assets and `no-cache` on `index.html`

### 10.4 `.github/workflows/keep-alive.yml` (use this version)

```yaml
name: Keep API warm
# Render's free web service spins down after 15 min without inbound HTTP or WebSocket
# traffic; the next request then waits ~1 min for a cold start.
#
# Budget: 750 free instance-hours per workspace per month. A 31-day month is 744 h, so
# exactly ONE always-on free service fits. A second free service, or PR previews, breaks this.
#
# Actions minutes: free on PUBLIC repos. On a PRIVATE repo (GitHub Free = 2,000 min/month),
# every run bills at least 1 full minute: 6/h x 744 h = ~4,464 min -> over quota, which also
# blocks CI. For a private repo, use cron-job.org or UptimeRobot (free) every 10 min instead,
# and delete the `schedule:` block below (keep workflow_dispatch for manual pings).
#
# /health must NOT touch Postgres, or every ping wakes Neon and burns its 100 CU-hours.
#
# GitHub disables scheduled workflows in public repos after 60 days with no activity.
# If the project goes quiet, re-enable it here or rely on the external pinger.
#
# Setup: Settings -> Secrets and variables -> Actions -> Variables -> new variable
#        API_URL = https://your-service.onrender.com

on:
  schedule:
    # :03, :13, :23 ... avoids the top-of-hour rush, when GitHub is most likely to
    # delay or drop scheduled runs. 10 min leaves margin inside the 15-min idle window.
    - cron: '3-59/10 * * * *'
  workflow_dispatch:

concurrency:
  group: keep-alive
  cancel-in-progress: false

jobs:
  ping:
    runs-on: ubuntu-latest
    timeout-minutes: 4
    steps:
      - name: Ping /health
        env:
          API_URL: ${{ vars.API_URL }}
        run: |
          if [ -z "$API_URL" ]; then
            echo "::error::Set a repository variable named API_URL (Settings -> Secrets and variables -> Actions -> Variables)."
            exit 1
          fi
          url="${API_URL%/}/health"
          for attempt in 1 2; do
            # Generous timeout: if the service HAS spun down, this request pays the cold start.
            code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 90 "$url" || true)
            echo "attempt $attempt: GET $url -> $code"
            [ "$code" = "200" ] && exit 0
            sleep 15
          done
          echo "::error::Health check failed twice"
          exit 1
```

---

## 11. Android build & distribution

- **EAS Build profiles:**
  - `development`: a dev-client APK.
  - **`preview`: a release APK.** This is the "app file" we hand out.
  - `production`: an AAB, kept ready for the Play Store later.
- **APK size target ≤ 60 MB:**
  - Hermes;
  - R8 minify and resource shrinking;
  - ABIs limited to `arm64-v8a` + `armeabi-v7a` (drop x86 and x86_64);
  - Opus or AAC audio;
  - lazy-loaded game assets.
- **Signing:** use an EAS-managed keystore, and record its SHA-256 for `assetlinks.json` and its SHA-1 for the Google OAuth Android client. If we move to Play App Signing later, add Play's fingerprint too.
- **App Links:**
  - an `autoVerify` intent filter for `https://{{WEB_DOMAIN}}/join/*`;
  - a custom scheme `{{SCHEME}}://join/<CODE>` as a fallback.
- **Updates:**
  - **EAS Update** channels per profile with the `runtimeVersion: fingerprint` policy, so JS-only fixes reach installed APKs without a reinstall.
  - For native changes, the `/app/version` endpoint drives an in-app *"New version available"* prompt that links to the APK on **GitHub Releases**.
  - `min_supported` forces an update when the protocol changes.
- **Permissions:** `INTERNET`, `VIBRATE` and `POST_NOTIFICATIONS` only. Don't request storage; share images through the share sheet from the cache directory.
- **Build quota:** EAS's free plan caps builds per month, so use `eas build --local` while iterating.
- **`docs/RELEASE.md`:** document the release flow: build, upload to GitHub Releases, insert an `app_releases` row, share the link. Add a web `/download` page with a QR code and "install from unknown sources" help.
- **Keep the code iOS-safe.** Don't use Android-only APIs without a fallback, so that adding iOS later is cheap.

---

## 12. Web specifics

- **Build and hosting:** `expo export -p web` produces an SPA, served by the Render static rewrite. After deploy, verify `/.well-known/assetlinks.json` with `curl` and with Google's Statement List tester.
- **Load Skia only when needed.** Skia on web needs CanvasKit WASM, which is several MB.
  - Home and menus are plain RN views.
  - Load Skia with `WithSkiaWeb` / `LoadSkiaWeb` **only when a game opens**, behind an animated loader.
  - Cache it with the service worker.
- **PWA:** a manifest and a service worker make the app installable, let solo games play offline, and cache assets.
- **Input and layout:**
  - every game has keyboard controls;
  - layouts are responsive from 360 px phones up to desktop;
  - Carrom, Runner and Lantern Quest are landscape, and everything else is portrait (lock orientation per screen on Android).
- **Tab visibility:** on `visibilitychange`, pause solo games and mark the player as away in rooms.

---

## 13. UX, art direction, audio, accessibility, performance

- **Home:**
  - three shelves (Play with Friends / Adventure / Relax);
  - a **Continue** row;
  - a big **Join with code** button;
  - animated tile previews: lightweight loops on Android, and a static poster on web until hover.
- **Art direction: everything is procedural or vector:** Skia paths, gradients, **SkSL shaders**, particles and camera motion. This gives us heavy animation without depending on an artist. Any external asset must be **CC0** (e.g. Kenney) and logged in `docs/ASSETS.md` with its source and licence.
- **Look and feel:** a warm monsoon palette, design tokens in `packages/ui`, dark mode, and consistent motion curves.
- **Audio:**
  - SFX and music for every game;
  - master, music and SFX sliders;
  - duck the audio when notifications arrive;
  - sounds are CC0 or synthesised.
- **Haptics:** dice landing, wicket, pocket, level clear. Toggleable.
- **Motion settings:**
  - honour the OS reduce-motion setting;
  - a **"Lite effects"** toggle;
  - automatically reduce particles and shader quality if FPS stays below 50 for 3 s.
- **Accessibility:**
  - colour-blind-safe palettes plus shapes or patterns (Ludo, Color Sort, Carrom);
  - touch targets of at least 44 dp;
  - screen-reader labels in all menus;
  - scalable menu text.
- **i18n:** `i18next`. Every string is keyed. Ship English and Tamil, with Tamil flagged for native review.
- **Performance budgets** (mid-range Android, around 4 GB RAM):
  - **60 fps** in every game, or at least 50 on low-end devices with Lite effects on;
  - cold start to Home in under 3 s;
  - joining a room from a link in under 2 s when the server is warm;
  - a stable JS heap over a 30-minute session;
  - web Home LCP under 2.5 s on 4G.

  Measure these and record the numbers in `docs/PERF.md`.

---

## 14. Security & fair play

- **Input validation:** validate every socket event and REST body with zod, and drop unknown fields.
- **Rate limits:**
  - room creation: 5/min per user;
  - join attempts: 20/min per IP;
  - reactions: 1 every 2 s;
  - auth endpoints.
- **Server-side randomness:** dice, toss, quiz order and seeds all come from the server via `crypto`. Hidden information only ever leaves through `viewFor`.
- **Web hardening:** CORS restricted to the web origin, security headers, and JWT secrets supplied through env vars.
- **Logging and monitoring:** never log tokens or emails. Use Sentry (free tier) on client and server, with PII scrubbing.
- **Minimal data:** Google provides name and email only. No contacts, no location.

---

## 15. Testing & CI

- **Unit:** Vitest for every reducer, merge rule and bot.
- **Contract harness (§5):** runs on every GameModule and blocks CI on failure.
- **Server integration:** run against real Postgres in Docker. Don't use a Neon branch, because CI would burn CU-hours.
- **Multi-client socket tests:** 2–8 simulated clients play full matches. Cover:
  - disconnect and reconnect;
  - bot takeover and reclaim;
  - a race for the last seat;
  - redaction in the spectator view;
  - **a server restart mid-match that resumes from the Neon snapshot.**
- **Web E2E:** Playwright with **two browser contexts**. Create a room, join by link, play Hand Cricket to the end, and confirm both players see the same result.
- **Android E2E:** Maestro flows. A deep link sent with `adb` opens the lobby; a Runner smoke test.
- **Load test:** k6 or Artillery with 50 concurrent rooms on a Starter-sized instance. Report CPU and memory.
- **CI (GitHub Actions):** lint, typecheck and tests with Turborepo caching. If the repo is private, keep CI lean, because minutes are shared.

---

## 16. Phases & acceptance criteria

**Phase 0: Foundations & risk spikes**

- **Base setup:**
  - the monorepo;
  - the Expo app running on an Android device and on web;
  - the server on Render free with Neon, both in Singapore;
  - `render.yaml`, the keep-alive workflow and CI;
  - guest auth plus the Google upgrade;
  - Home showing all 10 tiles, with "Coming soon" states driven by the remote catalog.
- **Spikes (report the results before going further):**
  - (a) A Skia + Reanimated game loop holds 60 fps on Android **and** web with the chosen Expo SDK. Check open issues in react-native-skia's web support for that React Native version, then pin a combination that works.
  - (b) Socket.IO on Render free stays connected for 30 min, survives a forced restart and resumes.
  - (c) An Android App Link sent through WhatsApp opens the app.
  - (d) Timing for a planck.js carrom shot simulation.
- **Room system end to end:** prove create, share, join from web while the host is on Android, play, save the result, and rematch. Use a **dev-only reference game** (Tic-Tac-Toe, hidden in production).
- ✅ **Accept when:** I install the APK and create a room. I send the link on WhatsApp. My friend joins from a laptop browser, we finish a game, and the match shows up on both of our profiles.

**Phase 1: Hand Cricket + Quiz Battle + the social layer**

- **Scope:**
  - Hand Cricket;
  - Quiz Battle with 300 seeded questions;
  - bots (filling seats and taking over);
  - the 60 s reconnect grace window;
  - spectators and reactions;
  - push notifications;
  - Recent Players and "Play again";
  - stats and the Activity timeline.
- ✅ **Accept when:**
  - Hand Cricket works between Android and web.
  - If I kill the app mid-innings and reopen it within 60 s, I'm back on the same ball.
  - If I stay away longer than 60 s, a bot plays my seat and I can reclaim it.
  - A 6-player quiz with 2 bots completes.
  - A third person who opens the cricket link is offered spectating.

**Phase 2: Ludo + Color Sort Flow + Koi Pond + offline-first sync**

- **Scope:**
  - Ludo with 2–4 seats and teams;
  - the Color Sort generator and solver;
  - Koi Pond;
  - `packages/sync` with its merge rules;
  - the guest-to-Google merge.
- ✅ **Accept when:**
  - I play Color Sort in airplane mode, go back online, log in with Google on web, and my progress is there.
  - A 4-seat Ludo game finishes with 1 human on web, 1 on Android and 2 bots.

**Phase 3: Arcade Super Over + Carrom**

- ✅ **Accept when:**
  - Arcade cricket feels fair at 150 ms RTT (test with throttling).
  - Carrom shots look identical on both screens.
  - Server CPU per shot stays within budget.

**Phase 4: Monsoon Rooftop Runner + Lantern Quest**

- ✅ **Accept when:**
  - Both games hold a steady 60 fps on a mid-range Android phone.
  - On the same date, the Daily Challenge course is identical on two devices.
  - All 15 levels can be completed.
  - A checkpoint resumes correctly after the app is killed.

**Phase 5: Kolam Studio + Zen Sand Garden + polish & release**

- **Scope:**
  - Tamil strings;
  - an accessibility pass;
  - Lite effects;
  - the PWA;
  - optional web push;
  - meeting the performance budgets;
  - `RELEASE.md` and `RUNBOOK.md`, including the free-to-Starter upgrade.
- ✅ **Accept when:**
  - every item in §18 is ticked;
  - the APK is on GitHub Releases;
  - the web app is live on Render.

---

## 17. Out of scope for v1 (backlog; design so these drop in later)

- persistent groups/crews with group leaderboards;
- XP, levels, achievements and global leaderboards;
- a friends list;
- text chat (needs moderation);
- Chess;
- *Sky Kite Duel* (kite-fighting with rope physics);
- *Cosmic Drift* (space shooter);
- a Play Store release (AAB, Play App Signing, Data safety form);
- iOS.

---

## 18. Definition of done

- [ ] All 10 games are playable. The 4 multiplayer games cross-play between Android and web.
- [ ] A Cricket room rejects a 3rd player and offers spectating. Seat limits are enforced server-side for every game.
- [ ] Killing or restarting the server mid-match resumes the match from the Neon snapshot.
- [ ] A test proves `/health` never queries Postgres. There are no DB writes on timers.
- [ ] Redaction tests prove no hidden information leaks to opponents or spectators.
- [ ] Progress survives offline play, reinstalling, and switching devices after Google login.
- [ ] The performance budgets are met and measured in `docs/PERF.md`.
- [ ] Docs are complete: `ARCHITECTURE`, `SETUP`, `RELEASE`, `RUNBOOK`, `ASSETS`, `PERF`, and `OPEN_QUESTIONS` with every question resolved.

---

### What I (the human) will provide; list exact steps for each in `docs/SETUP.md`

- a Render account (Singapore);
- a Neon project (aws-ap-southeast-1), with both the pooled and the direct connection strings;
- Google OAuth client IDs:
  - Android: package name + SHA-1;
  - Web: authorised origin;
- an Expo/EAS account;
- a Firebase project for FCM: `google-services.json`, plus an FCM v1 service-account key uploaded to EAS;
- a custom domain (optional, but recommended for cookies and App Links);
- whether the repo is public or private, which decides the keep-alive method in §10.4.
