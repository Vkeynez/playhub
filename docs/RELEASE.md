# Release

How a new Android build or a JS-only fix reaches players. Background: BUILD_BRIEF §11, ARCHITECTURE §10.6 and §11.

| | |
|---|---|
| **Status** | Draft for Phase 0, 2026-10-05. The CI automation for builds and updates comes with the client milestones; until then the owner runs the EAS steps (OPEN_QUESTIONS A5). |
| **Repo** | `Vkeynez/playhub` (public), so APKs go to its GitHub Releases. |
| **Placeholders** | `{{APP_NAME}}`, `{{ANDROID_PACKAGE}}`, `{{WEB_DOMAIN}}` until A7/A8 are answered. |

## 1. Rules

- **Release builds run only on EAS cloud.** The release keystore never touches this Mac. No `eas build --local` for `preview` or `production` unless you explicitly accept it (CLAUDE.md, OPEN_QUESTIONS G4).
- **APKs are never hosted on Render.** 5 GB of bandwidth is only ~90 downloads. GitHub Releases only (OPEN_QUESTIONS G3).
- **Every EAS command runs through `scripts/isolated.sh`**, so the global `eas-cli` login (possibly a work account) is never used.
- **One runtime, one fingerprint.** `runtimeVersion` uses the `fingerprint` policy: an OTA update reaches only APKs whose native fingerprint matches it.

## 2. Build profiles

| Profile | Output | Signed with | Who gets it |
|---|---|---|---|
| `development` | Dev-client APK, package `{{ANDROID_PACKAGE}}.dev`, name "… (Dev)" | Project-unique debug key (local, outside git) | Only you, for development |
| `preview` | **Release APK**: the file we hand out | EAS-managed release key | Friends, via the `/download` page |
| `production` | AAB, kept ready for the Play Store | EAS-managed release key | Later (Play App Signing reuses the same key, G6) |

Each profile has its own EAS Update channel (`development`, `preview`, `production`).

## 3. Decide: OTA update or new APK?

From `apps/client`, compare the current code with the runtime of the latest released APK:

```bash
../../scripts/isolated.sh npx --yes eas-cli@<pinned> fingerprint:compare
```

- **Fingerprint unchanged** (JS, assets, strings only) → **OTA update**, §6. No reinstall.
- **Fingerprint changed** (a native module, an Expo SDK bump, app config that affects native code, `google-services.json`) → **new APK**, §4–§5, and then OTA for any older runtime that still needs the fix.

## 4. Build a release APK

### 4.1 Pre-flight checklist

- [ ] CI is green on the commit you're releasing (`main`).
- [ ] The API is deployed and `/health` shows that commit's `buildSha` (deploy order: API first, ARCHITECTURE §10.6).
- [ ] The web site is deployed from the same commit.
- [ ] **First release, or the signing key or package changed:** `assetlinks.json` is live and verified (§7) **before** anyone installs the APK.
- [ ] The app version is bumped (`version` in the app config; EAS manages `versionCode`).
- [ ] Release notes drafted (what changed, in plain words; English and Tamil if you can).

### 4.2 Build on EAS cloud

```bash
cd apps/client
../../scripts/isolated.sh npx --yes eas-cli@<pinned> build -p android --profile preview
```

Wait for the build on expo.dev, then download the `.apk` from the build page. (Downloading the **APK** is fine; it's the signed output, not the keystore.)

### 4.3 Check the APK before sharing

- [ ] **Size ≤ 60 MB** (OPEN_QUESTIONS G2). If over, ship arm64-v8a as the main APK and armeabi-v7a separately.
- [ ] **Permissions** match the allowlist (OPEN_QUESTIONS G5): only `POST_NOTIFICATIONS` at runtime; no storage, location, camera, microphone, phone state or overlay permissions. CI checks the merged manifest; spot-check with `apkanalyzer manifest permissions <file>.apk`.
- [ ] Install on your phone: `adb install -r <file>.apk` (or open the file on the phone).
- [ ] **App Links verified:** `adb shell pm get-app-links {{ANDROID_PACKAGE}}` shows `verified` for the web host.
- [ ] Smoke test: open the app → Home shows all tiles → create a room → open the link from WhatsApp on another phone or a laptop browser → play to the end → the match shows on both profiles.

## 5. Publish the APK

### 5.1 Upload to GitHub Releases

1. GitHub → `Vkeynez/playhub` → **Releases → Draft a new release**.
2. **Tag:** `app-v<version>` (for example `app-v0.1.0`), on the released commit. Keep these tags: they're how you rebuild an OTA fix for an older runtime (§6.2).
3. **Title:** `<App name> <version>`. **Description:** the release notes plus the runtime fingerprint.
4. Attach the APK, named `<app>-<version>.apk` (one file per ABI if split).
5. **Publish release.** The download URL is `https://github.com/Vkeynez/playhub/releases/download/app-v<version>/<app>-<version>.apk`.

If the repo is ever private, publish APKs to a separate **public** releases repo instead (OPEN_QUESTIONS A3).

### 5.2 Record the release (`app_releases`)

The server reads releases into memory at boot, so `/app/version` needs a new row **and** a reload.

1. Insert the row. Until an `/ops` endpoint for releases exists, use the Neon SQL Editor (this wakes Neon once; that's fine). Columns as in `packages/db/src/schema/catalog.ts` (draft, 2026-10-05; re-check before use). The primary key is `(platform, version)`:

   ```sql
   INSERT INTO app_releases (platform, version, runtime_version, apk_url, min_supported, notes)
   VALUES (
     'android',
     '0.1.0',
     '<runtime fingerprint>',
     'https://github.com/Vkeynez/playhub/releases/download/app-v0.1.0/<app>-0.1.0.apk',
     '0.1.0', -- the oldest app version still supported once this release ships
     'First release'
   );
   ```

   Raise `min_supported` only when older versions really must update (for example a protocol change their OTA can't fix): it forces those players to the new APK.
2. Reload the in-memory caches (the `ADMIN_TOKEN` is under playhub-api → Environment; don't paste it into chats or scripts that get committed):

   ```bash
   curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://playhub-api.onrender.com/ops/reload
   ```

3. Check: `curl -s https://playhub-api.onrender.com/app/version` lists the new version.

### 5.3 Share

- Send the **`/download` page** link (`https://playhub-web.onrender.com/download`), not the raw APK URL. It has a QR code and "install from unknown sources" help, and it's hidden inside WhatsApp's in-app browser, which can't install APKs (it shows "Open in Chrome" instead).
- Installed APKs see the new version through `/app/version` and show "New version available".

## 6. OTA updates (JS-only fixes)

### 6.1 Current runtime

```bash
cd apps/client
../../scripts/isolated.sh npx --yes eas-cli@<pinned> update --channel preview --message "<what changed>"
```

The update reaches every installed APK whose fingerprint matches the code you published from. Players get it on the next launch (or immediately when the server answers `CLIENT_TOO_OLD`: the app tries `checkForUpdateAsync` → `fetchUpdateAsync` → `reloadAsync` first, and only then links to the APK).

### 6.2 Every runtime still in use

A fix must reach **every runtime that players still have** (ARCHITECTURE §11):

1. List the runtimes still in use: the `runtime_version` values in `app_releases` that you haven't retired.
2. For each older runtime, check out its tag (`app-v<version>`) on a maintenance branch, cherry-pick the fix, and run `eas-cli fingerprint:compare` to confirm the fingerprint still matches that runtime.
3. Publish from there with the same `eas update --channel preview` command.
4. **Retire a runtime** when it's no longer worth patching: raise the minimum supported version so `/app/version` tells those players "this APK no longer receives fixes" and links to the newest APK.

### 6.3 Roll back an OTA update

Republish the previous update group for that runtime (`eas-cli update:republish`, or the rollback command of the pinned CLI version), or publish a revert commit as a new update.

### 6.4 Deploy order

API first, then web and OTA (ARCHITECTURE §10.6): CI polls `/health` until the new `buildSha` shows, then triggers the web deploy hook and `eas update`. Protocol changes are expand/contract, so a brief misordering shows "Server updating…", not a broken app.

## 7. App Links (`assetlinks.json`)

Android verifies App Links **at install time**. If the file is missing or wrong then, links keep opening the browser until the app is reinstalled. Order (ARCHITECTURE §11):

1. The keystore exists (EAS, SETUP step 6c), so its SHA-256 is known.
2. `apps/client/public/.well-known/assetlinks.json` lists `{{ANDROID_PACKAGE}}` with the **release** SHA-256 and `{{ANDROID_PACKAGE}}.dev` with the **debug-key** SHA-256. (Later, with Play App Signing, add Play's SHA-256 too.)
3. Deploy the web site.
4. Verify:

   ```bash
   curl -sI https://playhub-web.onrender.com/.well-known/assetlinks.json
   # expect: HTTP 200, content-type: application/json, and no "location:" header (no redirect)
   ```

   Then Google's Statement List tester: <https://developers.google.com/digital-asset-links/tools/generator>.
5. **Only then** build and install the APK.
6. Gate: `adb shell pm get-app-links {{ANDROID_PACKAGE}}` → `verified`.

**Fallbacks** if a link still opens the browser: the "Open in app" button (`intent://…;S.browser_fallback_url=…`), the custom scheme `{{SCHEME}}://join/<CODE>`, and the in-app settings button that opens "Open by default".

## 8. Play Store later (production AAB)

- `eas build -p android --profile production` produces the AAB.
- On Play Console, choose **Play App Signing → use existing key** and upload the EAS key (OPEN_QUESTIONS G6), so the signing identity never changes and sideloaded users can update.
- Add Play's app-signing SHA-256 to `assetlinks.json` (§7) before the first Play install.

## 9. Android developer verification

Sideloading isn't affected yet. Before global enforcement in 2027, register `{{ANDROID_PACKAGE}}` and the release SHA-256 under the owner's identity (OPEN_QUESTIONS A0, G1).

## Release log

| Date | Version | Runtime (fingerprint) | APK URL | OTA-only? | Notes |
|---|---|---|---|---|---|
