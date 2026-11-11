#!/usr/bin/env bash
# Records the Polishot Android demo (about 30 s) from a real device or an emulator with `adb shell screenrecord`.
#
# The flow, all driven over adb:
#   home screen -> share the made-up billing screenshot to "Beautify with Polishot" (stands in for a capture)
#   -> the editor opens already auto-balanced -> tap "N found" (auto-redact) -> tap "Copy text" (OCR)
#   -> tap Save (export) -> pull the video.
#
# It enters through the share sheet on purpose: a MediaProjection capture needs the system consent dialog, whose
# wording and buttons differ on every Android image. Everything after the editor opens is the real app.
#
# Usage:
#   ./android-demo.sh --check                       # preflight + a 5 s test recording, installs nothing
#   ./android-demo.sh                               # device or emulator already connected
#   ./android-demo.sh --boot-avd                    # boots (and, if needed, creates) the AVD named in android-profile.json
#   ./android-demo.sh --apk /path/Polishot.apk --serial emulator-5554 --pace 1.2
#   ./android-demo.sh --attach                      # you open the editor by hand; the script records from there
#
# Needs: bash, adb (Android platform-tools), node (reads the JSON profile and the screen's UI tree).
# Optional: emulator + avdmanager (for --boot-avd), ffprobe (prints the video length).
# On Windows run it from Git Bash or WSL. Output (gitignored): tools/demo/out/android/polishot-android-demo.mp4

set -Eeuo pipefail
# Git Bash would rewrite /sdcard/... into a Windows path; host-side paths go through host_path() instead.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
PROFILE="${PROFILE:-$HERE/android-profile.json}"

APK=""
IMAGE=""
SERIAL="${ANDROID_SERIAL:-}"
OUT_DIR="$HERE/out/android"
PACE="1"
BOOT_AVD=0
ATTACH=0
CHECK=0
DRY_RUN=0
REINSTALL=0
NO_INSTALL=0
NO_DEMO_MODE=0
KEEP_EMULATOR=0
UNINSTALL_AFTER=0

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; exit "${1:-0}"; }
log()  { printf '[android-demo] %s\n' "$*"; }
warn() { printf '[android-demo] warning: %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --apk)            APK="${2:?--apk needs a file}"; shift 2 ;;
    --image)          IMAGE="${2:?--image needs a PNG}"; shift 2 ;;
    --serial)         SERIAL="${2:?--serial needs a device serial (see: adb devices)}"; shift 2 ;;
    --out)            OUT_DIR="${2:?--out needs a folder}"; shift 2 ;;
    --pace)           PACE="${2:?--pace needs a number}"; shift 2 ;;
    --profile)        PROFILE="${2:?--profile needs a JSON file}"; shift 2 ;;
    --boot-avd)       BOOT_AVD=1; shift ;;
    --keep-emulator)  KEEP_EMULATOR=1; shift ;;
    --attach)         ATTACH=1; shift ;;
    --reinstall)      REINSTALL=1; shift ;;
    --no-install)     NO_INSTALL=1; shift ;;
    --no-demo-mode)   NO_DEMO_MODE=1; shift ;;
    --uninstall-after) UNINSTALL_AFTER=1; shift ;;
    --check)          CHECK=1; shift ;;
    --dry-run)        DRY_RUN=1; shift ;;
    -h|--help)        usage 0 ;;
    *)                die "Unknown option: $1 (try --help)" ;;
  esac
done

case "$PACE" in
  ''|*[!0-9.]*) die "--pace must be a number such as 1 or 1.25 (got '$PACE')." ;;
esac

# ------------------------------------------------------------------------------------------------ helpers

# Host paths for native programs (adb.exe, node.exe) when running under Git Bash/MSYS.
host_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

# Reads a value from the JSON profile: cfg <dot.path> [default]. Arrays and objects come back as JSON.
cfg() {
  node -e '
    const fs = require("fs");
    let v = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const k of process.argv[2].split(".")) { if (v === undefined || v === null) break; v = v[k]; }
    if (v === undefined || v === null) {
      if (process.argv.length > 3) { console.log(process.argv[3]); process.exit(0); }
      process.exit(3);
    }
    console.log(typeof v === "object" ? JSON.stringify(v) : String(v));
  ' "$(host_path "$PROFILE")" "$@"
}

# Seconds, scaled by --pace.
nap() { sleep "$(awk -v s="$1" -v p="$PACE" 'BEGIN { printf "%.2f", s * p }')"; }

ADB_BIN=""
ADB_ARGS=()
a() { "$ADB_BIN" ${ADB_ARGS[@]+"${ADB_ARGS[@]}"} "$@"; }
sh_() { a shell "$@" | tr -d '\r'; }   # adb shell, without Windows line endings

find_adb() {
  if [ -n "${ADB:-}" ] && [ -x "$ADB" ]; then ADB_BIN="$ADB"; return; fi
  if command -v adb >/dev/null 2>&1; then ADB_BIN="$(command -v adb)"; return; fi
  local root
  for root in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Android/Sdk" "$HOME/Library/Android/sdk" "${LOCALAPPDATA:-/nonexistent}/Android/Sdk"; do
    [ -n "$root" ] || continue
    for f in "$root/platform-tools/adb" "$root/platform-tools/adb.exe"; do
      if [ -x "$f" ]; then ADB_BIN="$f"; return; fi
    done
  done
  die "adb was not found.
  Install the Android platform-tools (Android Studio > SDK Manager > SDK Tools, or
  https://developer.android.com/tools/releases/platform-tools), then either add the folder to PATH or set
  ANDROID_HOME to the SDK folder. You can also point to it directly: ADB=/path/to/adb ./android-demo.sh"
}

need_node() {
  command -v node >/dev/null 2>&1 || die "node was not found. It reads the JSON profile and the screen's UI tree; install Node 22 or newer (this repository uses Node 24)."
}

# ------------------------------------------------------------------------------------------------ device

EMULATOR_PID=""
STARTED_EMULATOR=0

emulator_bin() {
  local root f
  if command -v emulator >/dev/null 2>&1; then command -v emulator; return 0; fi
  for root in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Android/Sdk" "$HOME/Library/Android/sdk" "${LOCALAPPDATA:-/nonexistent}/Android/Sdk"; do
    [ -n "$root" ] || continue
    for f in "$root/emulator/emulator" "$root/emulator/emulator.exe"; do [ -x "$f" ] && { printf '%s' "$f"; return 0; }; done
  done
  return 1
}

tool_bin() { # tool_bin avdmanager
  local root f
  if command -v "$1" >/dev/null 2>&1; then command -v "$1"; return 0; fi
  for root in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Android/Sdk" "$HOME/Library/Android/sdk" "${LOCALAPPDATA:-/nonexistent}/Android/Sdk"; do
    [ -n "$root" ] || continue
    for f in "$root/cmdline-tools/latest/bin/$1" "$root/cmdline-tools/latest/bin/$1.bat" "$root/tools/bin/$1"; do [ -x "$f" ] && { printf '%s' "$f"; return 0; }; done
  done
  return 1
}

boot_avd() {
  local name emu mgr image device timeout line
  local -a args
  name="$(cfg avd.name)"; image="$(cfg avd.systemImage)"; device="$(cfg avd.device)"; timeout="$(cfg avd.bootTimeoutSeconds 300)"
  emu="$(emulator_bin)" || die "--boot-avd needs the Android emulator, which was not found.
  In Android Studio: SDK Manager > SDK Tools > 'Android Emulator'. Or:  sdkmanager 'emulator' '$image'
  Then set ANDROID_HOME to the SDK folder (or put emulator on PATH)."
  if ! "$emu" -list-avds | tr -d '\r' | grep -x "$name" >/dev/null; then
    mgr="$(tool_bin avdmanager)" || die "The AVD '$name' does not exist and avdmanager was not found to create it.
  Create it in Android Studio (Device Manager > Create device > $device, $image), name it '$name', and run again."
    log "creating the AVD '$name' ($device, $image)"
    echo no | "$mgr" create avd -n "$name" -k "$image" -d "$device" --force >/dev/null \
      || die "avdmanager could not create the AVD. Install the image first:  sdkmanager '$image'"
  fi
  log "booting the emulator '$name' (this takes a minute or two)"
  mkdir -p "$OUT_DIR"
  args=()
  while IFS= read -r line; do [ -n "$line" ] && args+=("$line"); done < <(node -e 'for (const a of JSON.parse(process.argv[1])) console.log(a)' "$(cfg avd.emulatorArgs '[]')")
  "$emu" -avd "$name" ${args[@]+"${args[@]}"} >"$OUT_DIR/emulator.log" 2>&1 &
  EMULATOR_PID=$!
  STARTED_EMULATOR=1
  local waited=0
  until [ "$(sh_ getprop sys.boot_completed 2>/dev/null || true)" = "1" ]; do
    if ! kill -0 "$EMULATOR_PID" 2>/dev/null; then die "The emulator exited while starting. See $OUT_DIR/emulator.log"; fi
    sleep 3; waited=$((waited + 3))
    [ "$waited" -lt "$timeout" ] || die "The emulator did not finish booting within ${timeout}s. See $OUT_DIR/emulator.log"
  done
}

select_device() {
  local devices count
  devices="$("$ADB_BIN" devices | tr -d '\r' | awk 'NR > 1 && $2 == "device" { print $1 }')"
  if [ -n "$SERIAL" ]; then
    printf '%s\n' "$devices" | grep -x "$SERIAL" >/dev/null || die "No ready device with serial '$SERIAL'. 'adb devices' shows:
$("$ADB_BIN" devices | tr -d '\r' | tail -n +2)"
    ADB_ARGS=(-s "$SERIAL")
    return
  fi
  count="$(printf '%s\n' "$devices" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [ "$count" -eq 0 ]; then
    local state
    state="$("$ADB_BIN" devices | tr -d '\r' | tail -n +2 | sed '/^$/d')"
    die "No Android device or emulator is connected and ready.${state:+
  adb sees:
$state
  ('unauthorized' means: accept the 'Allow USB debugging?' prompt on the phone; 'offline': unplug and replug, or run 'adb kill-server'.)}
  Plug in a phone with USB debugging on, start an emulator, or let this script boot one:  ./android-demo.sh --boot-avd"
  elif [ "$count" -gt 1 ]; then
    die "More than one device is connected. Choose one with --serial:
$(printf '%s\n' "$devices" | sed 's/^/    /')"
  fi
  SERIAL="$(printf '%s\n' "$devices" | sed -n '1p')"
  ADB_ARGS=(-s "$SERIAL")
}

# ------------------------------------------------------------------------------------------------ UI driving

SCREEN_W=0
SCREEN_H=0
UI_XML=""

screen_size() {
  local size
  size="$(sh_ wm size | grep -Eo '[0-9]+x[0-9]+' | tail -n 1)"
  [ -n "$size" ] || die "Could not read the screen size (adb shell wm size)."
  SCREEN_W="${size%x*}"; SCREEN_H="${size#*x}"
}

ui_dump() {
  # uiautomator writes the tree to a file; reading it back is more reliable than --compressed or /dev/tty.
  a shell uiautomator dump /sdcard/polishot-demo-ui.xml >/dev/null 2>&1 || return 1
  UI_XML="$(a exec-out cat /sdcard/polishot-demo-ui.xml 2>/dev/null | tr -d '\r')"
  [ -n "$UI_XML" ]
}

# Prints "x y" for the first node whose text or content-description matches the regular expression.
ui_find() {
  printf '%s' "$UI_XML" | node -e '
    const re = new RegExp(process.argv[1], "i");
    const xml = require("fs").readFileSync(0, "utf8");
    const dec = (s) => s.replace(/&quot;/g, "\"").replace(/&apos;/g, "\x27").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#10;/g, " ").replace(/&amp;/g, "&");
    for (const m of xml.matchAll(/<node\b[^>]*>/g)) {
      const t = m[0];
      const text = dec((/\btext="([^"]*)"/.exec(t) || [, ""])[1]);
      const desc = dec((/\bcontent-desc="([^"]*)"/.exec(t) || [, ""])[1]);
      const b = /\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(t);
      if (!b || !(re.test(text) || re.test(desc))) continue;
      const [l, tp, r, bt] = b.slice(1).map(Number);
      if (r <= l || bt <= tp) continue;
      console.log(Math.round((l + r) / 2) + " " + Math.round((tp + bt) / 2));
      process.exit(0);
    }
    process.exit(1);
  ' "$1"
}

tap_xy() { a shell input tap "$1" "$2"; }

# tap_ui <profile ui key> [timeout seconds]: taps the element, or the fractional fallback position when the
# accessibility tree does not expose it. Returns 0 when the element was found in the tree, 1 on the fallback.
tap_ui() {
  local key="$1" timeout="${2:-6}" regex pos x y fx fy waited=0
  regex="$(cfg "ui.$key")"
  while [ "$waited" -lt "$timeout" ]; do
    if ui_dump && pos="$(ui_find "$regex")"; then
      x="${pos% *}"; y="${pos#* }"
      tap_xy "$x" "$y"
      log "tapped '$key' at $x,$y"
      return 0
    fi
    sleep 1; waited=$((waited + 1))
  done
  read -r fx fy < <(cfg "ui.fallback.$key" | node -e 'const p = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(p[0] + " " + p[1])')
  x="$(awk -v w="$SCREEN_W" -v f="$fx" 'BEGIN { printf "%d", w * f }')"
  y="$(awk -v h="$SCREEN_H" -v f="$fy" 'BEGIN { printf "%d", h * f }')"
  warn "'$key' is not in the accessibility tree (WebView content is not exposed on every image); tapping the fallback position $x,$y."
  tap_xy "$x" "$y"
  return 1
}

editor_in_front() {
  local klass
  local focus
  klass="$(cfg activities.editorClass)"
  focus="$(sh_ dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' || true)"
  case "$focus" in *"$klass"*) return 0 ;; *) return 1 ;; esac
}

wait_for_editor() {
  local waited=0 limit="${1:-25}"
  until editor_in_front; do
    sleep 1; waited=$((waited + 1))
    [ "$waited" -lt "$limit" ] || return 1
  done
}

# ------------------------------------------------------------------------------------------------ sample image

SAMPLE_REMOTE=""
SAMPLE_ID=""

media_rows() { # media_rows <where clause>
  a shell "content query --uri content://media/external/images/media --projection _id:_display_name:relative_path:date_added --where \"$1\"" 2>/dev/null | tr -d '\r'
}

push_sample() {
  local dir name
  dir="$(cfg sample.deviceDir)"; name="$(cfg sample.fileName)"
  SAMPLE_REMOTE="$dir/$name"
  a shell mkdir -p "$dir"
  a push "$(host_path "$IMAGE")" "$SAMPLE_REMOTE" >/dev/null
  # Make MediaStore notice the file (the share sheet hands out content:// URIs, never file paths).
  a shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d "file://$SAMPLE_REMOTE" >/dev/null 2>&1 || true
  a shell "content call --uri content://media/ --method scan_file --arg $SAMPLE_REMOTE" >/dev/null 2>&1 || true
  local tries=0 row
  while [ "$tries" -lt 20 ]; do
    row="$(media_rows "_display_name='$name'" | grep -E '_id=[0-9]+' | tail -n 1 || true)"
    SAMPLE_ID="$(printf '%s' "$row" | sed -n 's/.*_id=\([0-9][0-9]*\).*/\1/p')"
    [ -n "$SAMPLE_ID" ] && return 0
    sleep 1; tries=$((tries + 1))
  done
  die "MediaStore did not pick up $SAMPLE_REMOTE within 20 s, so there is no content:// URI to share.
  Open the Photos/Gallery app once so it indexes the picture, or use the manual route:
    ./android-demo.sh --attach     (share the picture to 'Beautify with Polishot' yourself; the script records from the editor)"
}

# ------------------------------------------------------------------------------------------------ recording

SR_PID=""
REMOTE_VIDEO="/sdcard/polishot-demo.mp4"

start_recording() {
  local rate limit
  rate="$(cfg recording.bitRate 10000000)"; limit="$(cfg recording.timeLimitSeconds 120)"
  a shell rm -f "$REMOTE_VIDEO" >/dev/null 2>&1 || true
  a shell screenrecord --bit-rate "$rate" --time-limit "$limit" "$REMOTE_VIDEO" >/dev/null 2>&1 &
  SR_PID=$!
  sleep 1.2
  kill -0 "$SR_PID" 2>/dev/null || die "screenrecord stopped right away. Some emulator images and a few phones block it; run 'adb shell screenrecord /sdcard/t.mp4' by hand to see the message."
}

stop_recording() {
  [ -n "$SR_PID" ] || return 0
  # SIGINT lets screenrecord finish the mp4 properly; killing it any other way leaves a broken file.
  a shell 'kill -2 $(pidof screenrecord)' >/dev/null 2>&1 || a shell pkill -2 screenrecord >/dev/null 2>&1 || true
  local waited=0
  while kill -0 "$SR_PID" 2>/dev/null && [ "$waited" -lt 15 ]; do sleep 1; waited=$((waited + 1)); done
  kill "$SR_PID" 2>/dev/null || true
  SR_PID=""
  sleep 1
}

pull_video() { # pull_video <local file>
  mkdir -p "$(dirname "$1")"
  a pull "$REMOTE_VIDEO" "$(host_path "$1")" >/dev/null 2>&1 || die "Could not pull $REMOTE_VIDEO from the device."
  a shell rm -f "$REMOTE_VIDEO" >/dev/null 2>&1 || true
  [ -s "$1" ] || die "The pulled video is empty."
}

video_seconds() {
  command -v ffprobe >/dev/null 2>&1 || return 0
  ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$(host_path "$1")" 2>/dev/null | awk '{ printf "%.1f", $1 }' || true
}

# ------------------------------------------------------------------------------------------------ device tidy-up

SAVED_SHOW_TOUCHES=""
SAVED_STAYON=""
DEMO_MODE_ON=0

prepare_device() {
  a shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
  a shell wm dismiss-keyguard >/dev/null 2>&1 || true
  SAVED_SHOW_TOUCHES="$(sh_ settings get system show_touches 2>/dev/null || true)"
  a shell settings put system show_touches 1 >/dev/null 2>&1 || true
  SAVED_STAYON="$(sh_ settings get global stay_on_while_plugged_in 2>/dev/null || true)"
  a shell settings put global stay_on_while_plugged_in 7 >/dev/null 2>&1 || true
  if [ "$NO_DEMO_MODE" -eq 0 ]; then
    # System UI demo mode: clean clock, full battery and signal in the recording.
    local bc="am broadcast -a com.android.systemui.demo -e command"
    a shell settings put global sysui_demo_allowed 1 >/dev/null 2>&1 || true
    if a shell "$bc enter" >/dev/null 2>&1; then
      DEMO_MODE_ON=1
      a shell "$bc clock -e hhmm 0941" >/dev/null 2>&1 || true
      a shell "$bc battery -e level 100 -e plugged false" >/dev/null 2>&1 || true
      a shell "$bc network -e wifi show -e level 4 -e fully true" >/dev/null 2>&1 || true
      a shell "$bc notifications -e visible false" >/dev/null 2>&1 || true
    fi
  fi
}

cleanup() {
  local code=$?
  set +e
  stop_recording
  if [ "${#ADB_ARGS[@]}" -gt 0 ] && [ -n "$ADB_BIN" ]; then
    [ "$DEMO_MODE_ON" -eq 1 ] && a shell "am broadcast -a com.android.systemui.demo -e command exit" >/dev/null 2>&1
    [ -n "$SAVED_SHOW_TOUCHES" ] && [ "$SAVED_SHOW_TOUCHES" != "null" ] && a shell settings put system show_touches "$SAVED_SHOW_TOUCHES" >/dev/null 2>&1
    [ -n "$SAVED_STAYON" ] && [ "$SAVED_STAYON" != "null" ] && a shell settings put global stay_on_while_plugged_in "$SAVED_STAYON" >/dev/null 2>&1
    if [ -n "$SAMPLE_REMOTE" ]; then
      a shell rm -f "$SAMPLE_REMOTE" >/dev/null 2>&1
      [ -n "$SAMPLE_ID" ] && a shell "content delete --uri content://media/external/images/media --where \"_id=$SAMPLE_ID\"" >/dev/null 2>&1
    fi
    a shell rm -f /sdcard/polishot-demo-ui.xml >/dev/null 2>&1
    [ "$UNINSTALL_AFTER" -eq 1 ] && a uninstall "$PKG" >/dev/null 2>&1
  fi
  if [ "$STARTED_EMULATOR" -eq 1 ] && [ "$KEEP_EMULATOR" -eq 0 ] && [ -n "$EMULATOR_PID" ]; then
    a emu kill >/dev/null 2>&1 || kill "$EMULATOR_PID" 2>/dev/null
  fi
  exit "$code"
}

# ------------------------------------------------------------------------------------------------ main

need_node
[ -f "$PROFILE" ] || die "Profile not found: $PROFILE"
PKG="$(cfg package)"
find_adb
log "adb: $ADB_BIN"

resolve_apk() {
  local c
  if [ -n "$APK" ]; then
    [ -f "$APK" ] || die "--apk '$APK' does not exist."
    return
  fi
  while IFS= read -r c; do
    [ -n "$c" ] || continue
    if [ -f "$REPO/$c" ]; then APK="$REPO/$c"; return; fi
  done < <(node -e 'for (const a of JSON.parse(process.argv[1])) console.log(a)' "$(cfg apk.candidates)")
  die "No Polishot APK was found. Looked for:
$(node -e 'for (const a of JSON.parse(process.argv[1])) console.log("    " + a)' "$(cfg apk.candidates)")
  Get one of:
    CI:     the 'Android' workflow artifact, or the release asset Polishot.apk (put it in tools/demo/out/installer/)
    local:  cd apps/android && ./gradlew assembleDebug      (see apps/android/README.md)
  or pass it: ./android-demo.sh --apk /path/to/Polishot.apk"
}

resolve_image() {
  if [ -z "$IMAGE" ]; then IMAGE="$REPO/$(cfg sample.localPng)"; fi
  if [ ! -f "$IMAGE" ]; then
    log "rendering the sample screenshot (node tools/demo/web-flow-demo.mjs --sample-only)"
    node "$(host_path "$HERE/web-flow-demo.mjs")" --sample-only >/dev/null 2>&1 || true
  fi
  [ -f "$IMAGE" ] || die "The sample screenshot $IMAGE does not exist.
  Render it (needs 'pnpm install' once at the repository root):  node tools/demo/web-flow-demo.mjs --sample-only
  or pass any PNG with the same kind of text:  ./android-demo.sh --image /path/to/screenshot.png"
}

if [ "$DRY_RUN" -eq 1 ]; then
  [ "$CHECK" -eq 1 ] || { resolve_apk; resolve_image; }
  cat <<EOF

Plan (nothing is executed in a dry run):
  1. device      ${SERIAL:-the single connected device}$( [ "$BOOT_AVD" -eq 1 ] && printf ', booting the AVD %s first' "$(cfg avd.name)" )
  2. install     ${APK:-the APK from android-profile.json} (adb install -r -g)$( [ "$NO_INSTALL" -eq 1 ] && printf ' [skipped: --no-install]' )
  3. stage       demo-mode status bar, show touches, push ${IMAGE:-the sample} to the gallery
  4. record      adb shell screenrecord -> ${OUT_DIR}/polishot-android-demo.mp4
  5. flow        home -> share to 'Beautify with Polishot' -> editor opens styled -> tap 'N found' -> tap 'Copy text' -> tap Save
  6. report      run.json in ${OUT_DIR}
EOF
  exit 0
fi

trap cleanup EXIT
trap 'exit 130' INT TERM

if [ "$BOOT_AVD" -eq 1 ]; then
  "$ADB_BIN" start-server >/dev/null 2>&1 || true
  boot_avd
fi
select_device
log "device: $SERIAL"

SDK="$(sh_ getprop ro.build.version.sdk)"
MODEL="$(sh_ getprop ro.product.model)"
MIN_SDK="$(cfg minSdk 29)"
[ -n "$SDK" ] || die "Could not read the Android version from the device."
[ "$SDK" -ge "$MIN_SDK" ] || die "This device runs API $SDK; Polishot needs API $MIN_SDK (Android 10) or newer."
a shell 'command -v screenrecord' >/dev/null 2>&1 || die "This device has no screenrecord command (needs Android 4.4+ and a device that ships it)."
screen_size
log "$MODEL, API $SDK, ${SCREEN_W}x${SCREEN_H}"

mkdir -p "$OUT_DIR"
OUT_VIDEO="$OUT_DIR/polishot-android-demo.mp4"
START_EPOCH="$(sh_ date +%s)"

if [ "$CHECK" -eq 1 ]; then
  log "check: 5 s test recording and a read of the screen's accessibility tree (nothing is installed or tapped)"
  prepare_device
  start_recording
  sleep 5
  stop_recording
  pull_video "$OUT_VIDEO"
  if ui_dump; then log "uiautomator works ($(printf '%s' "$UI_XML" | grep -o '<node ' | wc -l | tr -d ' ') nodes on screen)"; else warn "uiautomator dump failed; the script would fall back to fixed tap positions."; fi
  secs="$(video_seconds "$OUT_VIDEO")"
  log "test video: $OUT_VIDEO${secs:+ (${secs}s)}. Open it and check it shows the screen."
  exit 0
fi

resolve_apk
if [ "$ATTACH" -eq 0 ]; then resolve_image; fi

if [ "$NO_INSTALL" -eq 0 ]; then
  log "installing $(basename "$APK")"
  if [ "$REINSTALL" -eq 1 ]; then a uninstall "$PKG" >/dev/null 2>&1 || true; fi
  if ! install_out="$(a install -r -g "$(host_path "$APK")" 2>&1 | tr -d '\r')"; then
    case "$install_out" in
      *INSTALL_FAILED_UPDATE_INCOMPATIBLE*|*signatures*) die "A copy of $PKG signed with a different key is installed. Re-run with --reinstall (removes it first)." ;;
      *INSTALL_FAILED_OLDER_SDK*) die "This device is older than the app supports (API $MIN_SDK needed)." ;;
      *) die "adb install failed:
$install_out" ;;
    esac
  fi
  case "$install_out" in *Success*) ;; *) die "adb install did not report Success:
$install_out" ;; esac
fi
a shell pm path "$PKG" >/dev/null 2>&1 || die "$PKG is not installed on the device (drop --no-install, or install the APK first)."
a shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true

if [ "$ATTACH" -eq 0 ]; then
  log "putting the sample screenshot in the gallery"
  push_sample
fi

prepare_device
a shell am force-stop "$PKG" >/dev/null 2>&1 || true
a shell input keyevent KEYCODE_HOME
sleep 1

declare -a RESULTS=()
note() { RESULTS+=("$1|$2|$3"); if [ "$2" = "ok" ]; then log "ok   $1${3:+: $3}"; else log "FAIL $1${3:+: $3}"; fi; }

log "recording"
start_recording
REC_START="$(date +%s)"

nap 1.2
a shell am start -n "$(cfg activities.home)" >/dev/null
nap "$(cfg timing.afterHome 2.5)"

if [ "$ATTACH" -eq 1 ]; then
  log "waiting up to 90 s for you to open a screenshot in Polishot (share it to 'Beautify with Polishot')"
  wait_for_editor 90 || die "The editor did not come to the front within 90 s."
else
  URI="content://media/external/images/media/$SAMPLE_ID"
  a shell am start -a android.intent.action.SEND -t image/png -d "$URI" --eu android.intent.extra.STREAM "$URI" \
    --grant-read-uri-permission -n "$(cfg activities.share)" >/dev/null \
    || die "Could not start the share target. Is $PKG installed with the share alias? Try --attach."
  if wait_for_editor 25; then note "the editor opened from the share sheet" ok ""; else
    note "the editor opened from the share sheet" fail "the editor was not in front after 25 s (the share may have been refused: try --attach)"
  fi
fi
nap "$(cfg timing.afterEditorOpens 3.6)"

# Auto-redact: one tap on "N found".
if tap_ui hide 8; then note "found the 'N found' chip in the screen tree" ok ""; else note "found the 'N found' chip in the screen tree" fail "used the fallback position"; fi
nap "$(cfg timing.afterHide 3.0)"

# Copy text (OCR).
if tap_ui copyText 6; then note "found the 'Copy text' chip in the screen tree" ok ""; else note "found the 'Copy text' chip in the screen tree" fail "used the fallback position"; fi
nap 0.8
CLIP="$(sh_ cmd clipboard get-text 2>/dev/null || true)"
EXPECT="$(cfg sample.expectedEmail)"
if [ -n "$CLIP" ]; then
  case "$CLIP" in *"$EXPECT"*) note "the recognised text is on the clipboard" ok "${#CLIP} characters" ;; *) note "the recognised text is on the clipboard" fail "the clipboard text does not contain $EXPECT" ;; esac
else
  warn "could not read the clipboard over adb (Android only lets the foreground app do that); not verified."
fi
nap "$(cfg timing.afterCopyText 2.6)"

# Export: Save to the gallery.
if tap_ui save 6; then note "found the Save button in the screen tree" ok ""; else note "found the Save button in the screen tree" fail "used the fallback position"; fi
SAVED_ROW=""
for _ in $(seq 1 12); do
  SAVED_ROW="$(media_rows "date_added>=$START_EPOCH" | grep -F "$(cfg saved.relativePath)" | tail -n 1 || true)"
  [ -n "$SAVED_ROW" ] && break
  sleep 1
done
if [ -n "$SAVED_ROW" ]; then note "the image was saved to the gallery" ok "$(printf '%s' "$SAVED_ROW" | sed -n 's/.*_display_name=\([^,]*\).*/\1/p')"; else note "the image was saved to the gallery" fail "nothing new under $(cfg saved.relativePath)"; fi
nap "$(cfg timing.afterSave 3.4)"
nap "$(cfg timing.tail 1.2)"

stop_recording
REC_END="$(date +%s)"
pull_video "$OUT_VIDEO"

SECONDS_OF_VIDEO="$(video_seconds "$OUT_VIDEO")"
{
  printf '{\n  "video": "%s",\n  "seconds": %s,\n  "device": "%s (API %s)",\n  "screen": "%sx%s",\n  "pace": %s,\n  "wallSeconds": %s,\n  "checks": [' \
    "$(host_path "$OUT_VIDEO")" "${SECONDS_OF_VIDEO:-null}" "$MODEL" "$SDK" "$SCREEN_W" "$SCREEN_H" "$PACE" "$((REC_END - REC_START))"
  first=1
  for r in "${RESULTS[@]}"; do
    IFS='|' read -r name state detail <<<"$r"
    [ "$first" -eq 1 ] || printf ','
    first=0
    printf '\n    {"name": "%s", "ok": %s, "detail": "%s"}' "${name//\"/\\\"}" "$([ "$state" = ok ] && echo true || echo false)" "${detail//\"/\\\"}"
  done
  printf '\n  ]\n}\n'
} >"$OUT_DIR/run.json"

log "video: $OUT_VIDEO${SECONDS_OF_VIDEO:+ (${SECONDS_OF_VIDEO}s)}"
if [ -n "$SECONDS_OF_VIDEO" ]; then
  awk -v s="$SECONDS_OF_VIDEO" 'BEGIN { if (s < 25) print "[android-demo] warning: under 25 s; use --pace 1.3 for a calmer cut."; if (s > 45) print "[android-demo] warning: over 45 s; use a smaller --pace." }'
fi

FAILS=0
for r in "${RESULTS[@]}"; do case "$r" in *"|fail|"*) FAILS=$((FAILS + 1)) ;; esac; done
if [ "$FAILS" -gt 0 ]; then
  printf '[android-demo] %s check(s) failed. Watch the video before you use it (details in %s/run.json).\n' "$FAILS" "$OUT_DIR" >&2
  exit 2   # the EXIT trap still tidies the device up
fi
