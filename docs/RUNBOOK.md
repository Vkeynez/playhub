# Runbook

How to keep the deployed app healthy on free tiers: quotas and alarms, deploys, restarts, Neon idling, upgrades and incidents. Background: ARCHITECTURE §5.3, §5.6, §10.

| | |
|---|---|
| **Status** | Draft for Phase 0, 2026-10-05. Hostnames are the expected ones until SETUP step 3 confirms them. |
| **UI labels** | Dashboards change. *(label may differ)* marks labels I couldn't confirm. |

## 1. What runs where

| Piece | Where | Plan | Notes |
|---|---|---|---|
| API (`playhub-api`) | Render web service, Singapore | Free: 0.1 CPU, 512 MB, one instance | `https://playhub-api.onrender.com`. Auto-deploys from `main` after CI passes (`checksPass`). |
| Web (`playhub-web`) | Render static site, global CDN | Free | `https://playhub-web.onrender.com`. Deployed by its deploy hook (`autoDeployTrigger: off`). |
| Database | Neon, `aws-ap-southeast-1`, Postgres 17 | Free, compute capped at 0.25 CU | Pooled URL for the app, direct URL for migrations. |
| Keep-alive | GitHub Actions `keep-alive.yml` | Free on a public repo | Every 10 min, requires `"ok":true` from `/health`. |
| CI | GitHub Actions `ci.yml` | Free on a public repo | Lint, typecheck, tests, build. It's also Render's deploy gate. |
| APKs | GitHub Releases on `Vkeynez/playhub` | Free | **Never** on Render (bandwidth). |
| Android builds, OTA | EAS cloud | Free | Release keystore lives only on EAS. |

## 2. Monthly quotas and alarms

All of these reset on the 1st of the month. Check them **every Monday** (5 minutes) and after any traffic spike.

| Quota | Limit | Alarm at | Hard guard | Where to look |
|---|---|---|---|---|
| **Neon compute** | 100 CU-h per project | **60 CU-h** | The server's governor refuses new rooms and new guest rows above **80 CU-h projected** (ARCHITECTURE §5.3 rule 7) | Neon Console → project → **Monitoring** / **Usage** *(label may differ)*; the server logs its awake-minutes estimate |
| Neon egress | 5 GB per project | 3.5 GB | Write-mostly design, in-memory caches | Neon Console → Usage *(label may differ)* |
| Neon storage | Plan for 0.5 GB (BUILD_BRIEF §9). Neon's plans page now says 1 GB on Free (checked 2026-10-05). | 0.4 GB | Lazy pruning (ARCHITECTURE §5.2) | Neon Console → project dashboard |
| **Render bandwidth** | 5 GB per workspace, then $0.15/GB | **3.5 GB** | APK never on Render, CanvasKit from jsDelivr, shell-only precache, spectators ≤ 1 snapshot/s | Render → **Billing → Included usage** *(label may differ)* |
| **Render pipeline minutes** | 500 per month | **300** (the OQ I7 trigger for prebuilt deploy branches) | $0 build spend limit: builds stop instead of billing | Render → Billing → Included usage |
| Render instance hours | 750 per workspace | 744 is normal for one always-on service | Exactly one free web service; no previews | Render → Billing |
| GitHub Actions | Unlimited on a public repo | — | If the repo goes private: move keep-alive to cron-job.org (SETUP step 8) | Repo → Insights → Actions usage |
| EAS | Free-plan build allowance | — | Builds at milestone cadence only; free accounts can't incur overages | expo.dev → Billing / Usage |

**When an alarm trips:**

- **Neon ≥ 60 CU-h:** find what's waking it (§6). Typical culprits: something on a timer hitting a DB-backed endpoint, a monitor pointed at `/health/deep`, someone browsing tables in the Neon console. At 80 projected the governor already blocks new rooms and guests; at 100 Neon suspends the compute until the 1st and **the whole app is down** for multiplayer and sign-in.
- **Render bandwidth ≥ 3.5 GB:** check that no APK or large asset is served from Render, that CanvasKit loads from jsDelivr (the client reports which source it used), and the per-room bytes-out counter on `/health`. Above 5 GB Render bills $0.15/GB, so decide: accept a few dollars, or cut traffic.
- **Pipeline minutes ≥ 300:** stop merging to `main` except at milestones; check that `buildFilter` skips doc-only commits; then consider prebuilt deploy branches (OPEN_QUESTIONS I7).

**Rough budget arithmetic (ARCHITECTURE §1):** one isolated Neon wake keeps the compute up ≥ 5 min, i.e. ≈ 0.021 CU-h at 0.25 CU. 100 CU-h ≈ 4,800 isolated wakes a month.

## 3. Deploys

### 3.1 How a change reaches production

1. A commit lands on `main` (CLAUDE.md: merges at milestone cadence).
2. **CI** runs (`ci.yml`). Render watches the commit's GitHub checks.
3. When **every** check on the commit has passed, Render builds and deploys `playhub-api` (`autoDeployTrigger: checksPass`). The build skips commits whose files are all outside `buildFilter`; changes to `render.yaml` always sync.
4. Boot (ARCHITECTURE §5.5): parse env → migrate over the direct URL under an advisory lock → bump the fencing epoch → warm caches → `listen()` → one sweep at +120 s.
5. After the API reports the new `buildSha` on `/health`, the web site is deployed through its deploy hook and OTA updates go out (ARCHITECTURE §10.6). Until that post-deploy workflow exists, deploy the web by hand: **playhub-web → Manual Deploy → Deploy latest commit**.

### 3.2 The deploy overlap (expect it on every deploy and restart)

Render runs the old and new API instances side by side (ARCHITECTURE §5.6):

1. The new instance boots while the old one serves.
2. Once `/health` passes, **new** connections go to the new instance; existing WebSockets stay on the old one.
3. 60 s later the old instance gets `SIGTERM`; after `maxShutdownDelaySeconds` (30 s) it's killed.

So there are **60–90 s** when two processes are alive. That's safe because every DB write is fenced by the epoch:

- players who reconnect land on the new instance, which claims their room; seats of players still on the old instance show "reconnecting" (no grace countdown, no bot takeover);
- the old instance notices at its next write or at `SIGTERM`, drains, and sends its clients `server:moving`; they reconnect after 0.5–3 s;
- pending deadlines get at least 15 s after a resume.

What players see: a short "reconnecting" moment, never a lost turn or a replayed reveal. At most the last ≤ 250 ms of hidden picks are lost and simply made again.

### 3.3 Checks after every deploy

Run from any terminal (public reads):

```bash
API=https://playhub-api.onrender.com
WEB=https://playhub-web.onrender.com

# API is up and running the new commit (compare buildSha with the commit on main).
curl -s "$API/health"

# SPA shell must not be cached; a rewritten /join/* must get the same headers.
curl -sI "$WEB/" | grep -i -E '^(cache-control|content-security-policy-report-only|cross-origin-opener-policy)'
curl -sI "$WEB/join/TEST" | grep -i -E '^(cache-control|x-robots-tag)'

# Hashed assets must be immutable, with ONE cache-control value (not no-cache as well).
# Take a real file name from the page source under /_expo/static/.
curl -sI "$WEB/_expo/static/js/web/<entry>.js" | grep -i '^cache-control'

# App Links file: 200, application/json, no redirect.
curl -sI "$WEB/.well-known/assetlinks.json" | grep -i -E '^(HTTP|content-type|location)'
```

**First deploy only:** `render.yaml` sets `Cache-Control: no-cache` on `/*` and `immutable` on `/_expo/static/*`, `/assets/*` and `/canvaskit/*`. Render doesn't document which rule wins when two paths match the same header. If a hashed asset comes back with `no-cache` (or both values), replace the `/*` rule with explicit HTML paths (`/`, `/index.html`, `/join/*`, `/download`, …) and tell the lead.

### 3.4 Deploy-gate pitfalls

- **Never add a job to `ci.yml` that waits for the deploy** (for example "poll `/health` until `buildSha` matches"). Render waits for all checks, so that job would wait for itself until it times out, fail, and block the deploy. Post-deploy steps go in a separate workflow.
- **Zero checks → no deploy.** If CI didn't run (for example Actions disabled), Render won't deploy. Use **Manual Deploy → Deploy latest commit**.
- **Any failed check blocks the deploy.** That may include a scheduled keep-alive run that failed on the same head commit (to be confirmed in spike (b)). Re-run the failed workflow, or deploy manually.
- **A build filter skip isn't a failure.** Manual deploys ignore build filters.
- **New secrets:** `sync: false` variables are only prompted for when the Blueprint is created. A secret added to `render.yaml` later must also be added by hand under **Environment**.

### 3.5 Failed deploy

- **Build failed:** the old instance keeps serving. Read the build log (Render → service → **Events**/**Deploys**). Common causes: lockfile out of date (`--frozen-lockfile`), an unapproved dependency build script (`ERR_PNPM_IGNORED_BUILDS`, fix `allowBuilds` in `pnpm-workspace.yaml`), out of pipeline minutes.
- **Boot failed** (zod env error, migration failure): the process exits with code 1 and Render keeps the old instance. Fix the env var or the migration, then redeploy. Migrations are expand/contract only, so the old code keeps working against the new schema.

### 3.6 Rollback

- **API:** Render → playhub-api → **Deploys** → pick the last good deploy → **Rollback** *(label may differ)*. Safe across one expand migration; never roll back past a *contract* migration.
- **Web:** same, on playhub-web.
- **OTA:** see RELEASE.md §6.

## 4. Restart

A restart is a deploy: it runs the same overlap as §3.2.

- **Restart (same commit, same env):** playhub-api → **Manual Deploy → Restart service**. Env var changes saved since the last deploy are **not** picked up by a restart.
- **Apply env changes:** saving an env var offers to redeploy *(label may differ)*; otherwise **Manual Deploy → Deploy latest commit**.
- Render may also restart a free instance at any time. Rooms survive (snapshot + action tail, fenced).
- Avoid restarts during a live acceptance test unless something is wrong; a restart is safe but players see "reconnecting".

## 5. Upgrade path (free → paid instance)

**Triggers** (BUILD_BRIEF §10.2 rule 8, ARCHITECTURE §10.4), any one of:

- the first real launch (people you don't know are using it);
- more than **20 concurrent rooms**;
- **sustained CPU above 70 %** (Render → playhub-api → **Metrics**).

**How (no code changes):**

1. In `render.yaml`, change the API's `plan: free` to `plan: 0.5c-512mb` (0.5 CPU / 512 MB, $7/month, prorated; the legacy name `starter` is also accepted).
2. Commit and push to `main`. The Blueprint sync applies the plan change and redeploys (overlap as usual).
3. A paid instance doesn't spin down: the keep-alive becomes optional, and the 750 free instance-hours stop mattering. The region stays Singapore.
4. Reconsider the Neon compute cap (0.25 CU) and the governor thresholds only if Neon becomes the bottleneck.

To downgrade, revert the line.

## 6. Is Neon idle? (the wake budget)

**Goal:** with nobody playing, Neon shows **Idle** ≥ 5 min after the last query. Spike (e) checks it after ≥ 20 min with the real app open, a background tab and an idle socket (ARCHITECTURE §5.3 rule 8).

**How to check without waking it:**

1. Neon Console → project → **Computes** (on the default branch) → status **Idle** or **Active**, and **Last active** *(label may differ)*.
2. Neon Console → **Monitoring** → compute graph: flat at zero when idle.
3. **Don't** open the SQL Editor or the Tables view to check: that wakes the compute (≥ 5 min × 0.25 CU each time).

**If it never goes idle:**

1. Note the times it wakes (Monitoring graph).
2. Match them against the API logs (Render → playhub-api → **Logs**) and the keep-alive schedule (:03, :13, :23, …).
3. Usual suspects:
   - `/health` touching the DB (a test forbids it; check the deployed `buildSha` has that test passing);
   - a monitor or bookmark on `/health/deep`;
   - a client refetching on focus or interval (TanStack queries must have `staleTime ≥ 10 min` and no refetch on focus);
   - token refresh on a timer instead of lazily;
   - a socket handler that queries on `hello`, `presence` or `clock:ping`;
   - something writing on a timer (forbidden: ARCHITECTURE §5.2).
4. Fix forward, or roll back to the last deploy that let Neon idle (§3.6). Meanwhile the governor caps the damage.

## 7. Incident checklist

Work top to bottom. Note the time and what you saw.

1. **Is it the API, the web, or Neon?**
   - `curl -s https://playhub-api.onrender.com/health` → JSON with `"ok":true`? An HTML "waking up" page means a cold start (wait ~1 min; check the keep-alive is green).
   - Web loads? If only the web is broken, check the last web deploy.
   - Neon Console → compute status. **Suspended** with the month's CU-h used up means Neon's quota is gone (see 4).
2. **Recent change?** Render → Deploys / Events: a deploy in the last hour is the first suspect. Roll back (§3.6) before debugging.
3. **Logs:** Render → playhub-api → **Logs**. Look for `exit(1)` at boot (env or migration), pool `error` events (Neon dropped idle connections; must be handled, never crash), out-of-memory (`--max-old-space-size=384`), event-loop delay on `/health` (`elu`).
4. **Quota exhausted?**
   - Neon CU-h at 100: compute suspended until the 1st. Options: wait; or move to Neon's paid Launch plan (pay-as-you-go) for the rest of the month. Solo games still work offline.
   - Render pipeline minutes gone: builds stop until the 1st; the running instance keeps serving. Raise the spend limit only if a fix must ship.
   - Render bandwidth over 5 GB: service keeps running, billed $0.15/GB.
5. **Keep-alive red but the API is fine:** check the `API_URL` repository variable and that `/health` still returns `"ok":true`.
6. **Communicate:** if multiplayer is down for more than a few minutes, tell players (WhatsApp group). Solo games keep working offline.
7. **Afterwards:** write two lines in this file under "Incident log" (below): what happened, what fixed it, what prevents a repeat.

### Secret leaked

| Secret | Do this | Side effects |
|---|---|---|
| Neon password (in either URL) | Neon → **Roles** → reset the password *(label may differ)*; copy both new URLs; update `DATABASE_URL` and `DATABASE_URL_DIRECT` in Render; redeploy | Brief outage during the redeploy |
| `ADMIN_TOKEN` | Render → Environment → regenerate/replace; redeploy | None |
| `JWT_SECRET` | Replace; redeploy | Every access token (15 min) becomes invalid; clients refresh silently |
| `REFRESH_SECRET` or `K_ROTATE` | Replace **only if actually compromised**; redeploy | **Every refresh token dies. Guests have no other credential, so every guest account is orphaned.** Google users just sign in again. |
| GitHub token | GitHub → fine-grained tokens → **Delete**; `rm ~/.gamehub-secrets/github-token`; make a new one if needed | None |
| Render deploy hook | playhub-web → Settings → **Regenerate Hook**; update the GitHub secret | None |
| Expo access token | expo.dev → Access tokens → revoke; create a new one; update Render | Push off until updated |
| FCM service-account key | Google Cloud → IAM → Service accounts → the key → delete; generate a new one; upload to EAS | Push off until updated |

## 8. Environment variables

The list and meaning of every server variable is in `.env.example`. Production values live only in the Render dashboard.

- Required: `DATABASE_URL`, `DATABASE_URL_DIRECT`, `JWT_SECRET`, `REFRESH_SECRET`, `K_ROTATE`, `CORS_ORIGINS`, `ADMIN_TOKEN`. Missing → the new instance exits at boot and the old one keeps serving.
- Optional: `GOOGLE_CLIENT_IDS`, `EXPO_ACCESS_TOKEN`, `SENTRY_DSN`, `DEV_USER_IDS`, `MIN_PROTOCOL_VERSION`. Blank = unset; the server logs the disabled feature.
- `render.yaml` generates `JWT_SECRET`, `REFRESH_SECRET`, `K_ROTATE` and `ADMIN_TOKEN` once, when the service is created.
- Never set `NODE_ENV=production` as a Render env var: env vars apply to the build too, and pnpm then skips the devDependencies the build needs.

## 9. Blueprint (`render.yaml`) maintenance

- Defaults that would cost money or latency: `plan` defaults to the paid `0.5c-512mb` and `region` to `oregon`. Both are set explicitly. A static site takes neither.
- `previews` is omitted on purpose (PR previews off).
- Header and route rules that exist in the dashboard but not in `render.yaml` are **kept** by a sync. Delete stale ones by hand.
- **Validate before pushing** a change. On 2026-10-05 the file was checked against Render's published schema (<https://render.com/schema/render.yaml.json>) with Ajv 8 (draft 2020-12) plus a few spot checks (free plan, Singapore, `/health`, `checksPass`, web deploy `off`, no previews, no `NODE_ENV`). To repeat it, use a throwaway folder outside the repo (never `pnpm add` in the workspace):

  ```bash
  mkdir -p /tmp/bp && cd /tmp/bp
  curl -s https://render.com/schema/render.yaml.json -o schema.json
  printf '{"private":true,"type":"module","packageManager":"pnpm@12.8.1"}\n' > package.json
  <repo>/scripts/isolated.sh corepack pnpm add ajv ajv-formats yaml
  # then load render.yaml with `yaml`, compile schema.json with ajv/dist/2020.js + ajv-formats, validate
  ```

## 10. Monthly calendar

| When | What |
|---|---|
| Every Monday | §2 quota check (5 min). Keep-alive green? |
| 1st of the month | Quotas reset (Neon CU-h, Render bandwidth, minutes, instance hours). Note last month's totals below. |
| Every release | RELEASE.md checklist; §3.3 checks |
| Every 60 days without commits | Re-enable the keep-alive schedule if GitHub disabled it |
| Before the token expires | Renew the GitHub fine-grained token (SETUP 2c) |

## Usage log

| Month | Neon CU-h | Neon egress | Render bandwidth | Pipeline min | Notes |
|---|---|---|---|---|---|

## Incident log

| Date | What happened | Fix | Prevention |
|---|---|---|---|
