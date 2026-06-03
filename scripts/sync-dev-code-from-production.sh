#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_BRANCH="${DEV_BRANCH:-development}"
PRODUCTION_REF="${PRODUCTION_REF:-}"
COMMIT_MESSAGE="${COMMIT_MESSAGE:-chore: sync development code from production}"

cd "$ROOT_DIR"

if [[ "$(git branch --show-current)" != "$DEV_BRANCH" ]]; then
  echo "Refusing to sync: checkout $DEV_BRANCH first." >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Refusing to sync: working tree has uncommitted changes." >&2
  exit 1
fi

if [[ -z "$PRODUCTION_REF" ]]; then
  if git rev-parse --verify --quiet production >/dev/null; then
    PRODUCTION_REF="production"
  elif git rev-parse --verify --quiet stable >/dev/null; then
    PRODUCTION_REF="stable"
  else
    echo "Refusing to sync: neither production nor stable exists." >&2
    exit 1
  fi
fi

git rev-parse --verify --quiet "$PRODUCTION_REF" >/dev/null || {
  echo "Refusing to sync: production ref '$PRODUCTION_REF' was not found." >&2
  exit 1
}

BASE_HEAD="$(git rev-parse HEAD)"

echo "Syncing code from $PRODUCTION_REF into $DEV_BRANCH..."
if ! git merge --no-ff --no-commit "$PRODUCTION_REF"; then
  echo "Merge stopped with conflicts. Resolve them manually; no storage or env files were copied intentionally." >&2
  exit 1
fi

# Keep local environment files and runtime storage exactly as they were before
# the merge. Production data/config must never be copied into development.
git restore --source="$BASE_HEAD" --staged --worktree -- \
  ':(glob)**/.env' \
  ':(glob)**/.env.*' \
  ':(glob)**/storage/**' \
  2>/dev/null || true

if git diff --cached --quiet && git diff --quiet; then
  git merge --abort >/dev/null 2>&1 || true
  echo "Already up to date. No code changes were applied."
  exit 0
fi

git commit -m "$COMMIT_MESSAGE"

echo "Done. Synced Git code only; .env* files and storage directories were preserved."
