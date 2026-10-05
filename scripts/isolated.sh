#!/usr/bin/env bash
# Runs a command without this corporate machine's global configs or exported tokens.
# Every git / pnpm / npx / expo / gradle / turbo / brew command in this repo goes through here.
#
#   scripts/isolated.sh <command> [args...]
#
# - Inherited tokens are unset, so no tool can pick up a work credential from the shell profile.
# - Global/system git config is ignored: no corporate signing key, hooks or keychain helper.
# - The user/global npmrc is ignored, and XDG config (pnpm rc, gh) is redirected into .isolated/.
# - Gradle and Expo get their own home directories, away from ~/.gradle and ~/.expo.
# - The Node version comes from .nvmrc (installed with nvm).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_VERSION="$(tr -d '[:space:]v' < "$REPO/.nvmrc")"
NODE_BIN="$HOME/.nvm/versions/node/v${NODE_VERSION}/bin"
if [ ! -x "$NODE_BIN/node" ]; then
  echo "isolated.sh: Node $NODE_VERSION is not installed (nvm install $NODE_VERSION)" >&2
  exit 1
fi
mkdir -p "$REPO/.isolated/config" "$REPO/.isolated/expo-home" "$REPO/.isolated/gh"

exec env \
  -u EXPO_TOKEN -u GITHUB_TOKEN -u GH_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN \
  -u NPM_TOKEN -u NODE_AUTH_TOKEN -u YARN_NPM_AUTH_TOKEN -u COREPACK_NPM_TOKEN -u COREPACK_NPM_PASSWORD \
  -u TURBO_TOKEN -u TURBO_TEAM -u TURBO_API -u VERCEL_TOKEN -u HOMEBREW_GITHUB_API_TOKEN \
  -u SENTRY_AUTH_TOKEN -u GOOGLE_APPLICATION_CREDENTIALS -u CLOUDSDK_CONFIG -u SSH_AUTH_SOCK \
  PATH="$NODE_BIN:$PATH" \
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 \
  NPM_CONFIG_USERCONFIG=/dev/null NPM_CONFIG_GLOBALCONFIG=/dev/null \
  XDG_CONFIG_HOME="$REPO/.isolated/config" GH_CONFIG_DIR="$REPO/.isolated/gh" \
  __UNSAFE_EXPO_HOME_DIRECTORY="$REPO/.isolated/expo-home" EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 \
  GRADLE_USER_HOME="$HOME/.gradle-playhub" \
  TURBO_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 HOMEBREW_NO_ANALYTICS=1 \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  "$@"
