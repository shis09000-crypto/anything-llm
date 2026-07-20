#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRATE="$ROOT/Native/AthenaOpaqueCore"
OUTPUT="$ROOT/Frameworks/AthenaOpaqueCore.xcframework"
BUILD="$CRATE/target/athena-xcframework"
export CARGO_TARGET_DIR="$CRATE/target/cargo"

rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios

cargo build --manifest-path "$CRATE/Cargo.toml" --release --lib --target aarch64-apple-ios
cargo build --manifest-path "$CRATE/Cargo.toml" --release --lib --target aarch64-apple-ios-sim
cargo build --manifest-path "$CRATE/Cargo.toml" --release --lib --target x86_64-apple-ios

mkdir -p "$BUILD/device" "$BUILD/simulator" "$ROOT/Frameworks"
cp "$CARGO_TARGET_DIR/aarch64-apple-ios/release/libAthenaOpaqueCore.a" \
  "$BUILD/device/libAthenaOpaqueCore.a"
lipo -create \
  "$CARGO_TARGET_DIR/aarch64-apple-ios-sim/release/libAthenaOpaqueCore.a" \
  "$CARGO_TARGET_DIR/x86_64-apple-ios/release/libAthenaOpaqueCore.a" \
  -output "$BUILD/simulator/libAthenaOpaqueCore.a"

if [[ -e "$OUTPUT" ]]; then
  timestamp="$(date +%Y%m%d%H%M%S)"
  mv "$OUTPUT" "$BUILD/AthenaOpaqueCore.xcframework.previous-$timestamp"
fi

xcodebuild -create-xcframework \
  -library "$BUILD/device/libAthenaOpaqueCore.a" \
  -headers "$CRATE/include" \
  -library "$BUILD/simulator/libAthenaOpaqueCore.a" \
  -headers "$CRATE/include" \
  -output "$OUTPUT"

(
  cd "$ROOT/Frameworks"
  find AthenaOpaqueCore.xcframework -type f -print0 \
    | sort -z \
    | xargs -0 shasum -a 256
) > "$ROOT/Frameworks/AthenaOpaqueCore.sha256"
