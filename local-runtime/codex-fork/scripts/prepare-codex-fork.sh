#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
FORK_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TARGET="$FORK_DIR/.upstream"
COMMIT="bb8cada846e4cb131c8ed62628930960504dab7b"

if [ ! -d "$TARGET/.git" ]; then
  git clone --filter=blob:none https://github.com/openai/codex.git "$TARGET"
fi
git -C "$TARGET" fetch --depth=1 origin "$COMMIT"
git -C "$TARGET" checkout --detach "$COMMIT"

for patch in "$FORK_DIR"/patches/*.patch; do
  [ -f "$patch" ] || continue
  git -C "$TARGET" apply --check "$patch"
  git -C "$TARGET" apply "$patch"
done

echo "Prepared Codex App Server source at $TARGET ($COMMIT)"
