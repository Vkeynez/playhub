#!/usr/bin/env bash
# Spike (a) Android run: install the release APK, launch the auto run, and collect the app's SPIKE lines plus per-step
# HWUI stats (gfxinfo is reset when a step reports and dumped when the next one does, so each window covers one stress
# screen: 2 s warm-up + 10 s measured). Keep the screen on and don't touch the phone for ~90 s.
#   SERIAL=<adb serial> LABEL=phone scripts/android-run.sh        (adb is not wrapped: it uses no account)
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADB="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb -s ${SERIAL:?set SERIAL to the adb serial}"
LABEL="${LABEL:-phone}"
OUT="$ROOT/results"; mkdir -p "$OUT"
PKG=dev.spike.renderstress
$ADB install -r "$ROOT/android/app/build/outputs/apk/release/app-release.apk" | tail -1
$ADB shell am force-stop $PKG
$ADB shell am start -W -n $PKG/.MainActivity | grep -E 'TotalTime'
PID=$($ADB shell pidof $PKG); echo "pid $PID"
prev=""; : > $OUT/android-$LABEL-gfx.txt
for i in $(seq 1 400); do
  $ADB logcat -d --pid=$PID 2>/dev/null | grep -a ' SPIKE ' | sed 's/.* SPIKE /SPIKE /' > $OUT/android-$LABEL.log
  last=$(grep -oE '^SPIKE (tamil|stress-[0-9a-z-]+|bench|done|appstate)' $OUT/android-$LABEL.log | tail -1)
  if [ "$last" != "$prev" ]; then
    if [[ "$prev" == "SPIKE tamil" || "$prev" == SPIKE\ stress-* ]] && [[ "$last" == SPIKE\ stress-* || "$last" == "SPIKE bench" ]]; then
      { echo "=== window after '$prev' until '$last'"; $ADB shell dumpsys gfxinfo $PKG | grep -E 'Total frames|Janky frames:|percentile|Frame deadline|Slow issue|Slow UI'; } >> $OUT/android-$LABEL-gfx.txt
    fi
    $ADB shell dumpsys gfxinfo $PKG reset >/dev/null
    prev="$last"
  fi
  grep -qE 'SPIKE (done|render-error)|appstate "(background|inactive)"' $OUT/android-$LABEL.log && break
  sleep 0.5
done
echo "pause events for $PKG during the run (anything after launch with userLeaving=true invalidates it):"
$ADB logcat -d -b events 2>/dev/null | grep wm_pause_activity | grep $PKG | tail -2 | cut -c1-120
$ADB shell getprop ro.product.model; $ADB shell getconf PAGE_SIZE
$ADB shell dumpsys display | grep -m1 -oE 'renderFrameRate [0-9.]+'
echo "results: $OUT/android-$LABEL.log  $OUT/android-$LABEL-gfx.txt"
