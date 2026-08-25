#!/usr/bin/env bash
set -euo pipefail

runtime_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$runtime_root/../.." && pwd)"
version="${ATHENA_RUNTIME_VERSION:-0.1.0}"
build_number="${ATHENA_RUNTIME_BUILD_NUMBER:-1}"
output_dir="${ATHENA_RUNTIME_OUTPUT_DIR:-$runtime_root/dist}"
app="$output_dir/Athena Runtime.app"
codex_binary="${ATHENA_CODEX_BINARY:-$(command -v codex || true)}"

if [[ -z "$codex_binary" || ! -x "$codex_binary" ]]; then
  echo "ATHENA_CODEX_BINARY must point to the pinned Codex executable" >&2
  exit 2
fi

swift build --package-path "$runtime_root" -c release
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$runtime_root/.build/release/AthenaRuntime" "$app/Contents/MacOS/AthenaRuntime"
cp "$codex_binary" "$app/Contents/Resources/codex"
cp "$repo_root/local-runtime/codex-fork/LICENSE" "$app/Contents/Resources/CODEX-LICENSE"
cp "$repo_root/local-runtime/codex-fork/NOTICE" "$app/Contents/Resources/CODEX-NOTICE"
cp "$runtime_root/Resources/Info.plist" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $version" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $build_number" "$app/Contents/Info.plist"

if [[ -n "${ATHENA_APPLE_CODESIGN_IDENTITY:-}" ]]; then
  codesign --force --options runtime --timestamp \
    --entitlements "$runtime_root/Resources/AthenaRuntime.entitlements" \
    --sign "$ATHENA_APPLE_CODESIGN_IDENTITY" "$app/Contents/Resources/codex"
  codesign --force --deep --options runtime --timestamp \
    --entitlements "$runtime_root/Resources/AthenaRuntime.entitlements" \
    --sign "$ATHENA_APPLE_CODESIGN_IDENTITY" "$app"
  codesign --verify --deep --strict --verbose=2 "$app"
else
  echo "Built unsigned development app; set ATHENA_APPLE_CODESIGN_IDENTITY for release signing." >&2
fi

archive="$output_dir/AthenaRuntime-$version.zip"
ditto -c -k --keepParent "$app" "$archive"

if [[ -n "${ATHENA_NOTARYTOOL_PROFILE:-}" ]]; then
  [[ -n "${ATHENA_APPLE_CODESIGN_IDENTITY:-}" ]] || {
    echo "Notarization requires ATHENA_APPLE_CODESIGN_IDENTITY" >&2
    exit 2
  }
  xcrun notarytool submit "$archive" --keychain-profile "$ATHENA_NOTARYTOOL_PROFILE" --wait
  xcrun stapler staple "$app"
  ditto -c -k --keepParent "$app" "$archive"
fi

shasum -a 256 "$archive" > "$archive.sha256"
printf '{"success":true,"app":"%s","archive":"%s"}\n' "$app" "$archive"
