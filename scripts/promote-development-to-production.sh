#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_BRANCH="${DEV_BRANCH:-development}"
REMOTE="${REMOTE:-shis09000-crypto}"

cd "$ROOT_DIR"

log() {
  printf '[promote-development-to-production] %s\n' "$*"
}

require_clean_worktree() {
  if ! git diff --quiet || ! git diff --cached --quiet; then
    log "refusing to promote: working tree has uncommitted changes"
    git status --short
    exit 1
  fi
}

require_branch() {
  local current_branch
  current_branch="$(git branch --show-current)"
  if [[ "$current_branch" != "$DEV_BRANCH" ]]; then
    log "refusing to promote: checkout $DEV_BRANCH first"
    log "current branch: ${current_branch:-detached}"
    exit 1
  fi
}

require_remote() {
  if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
    log "refusing to promote: remote '$REMOTE' was not found"
    exit 1
  fi
}

run_checks() {
  log "running git diff --check"
  git diff --check

  log "running server lint"
  (cd "$ROOT_DIR/server" && yarn lint:check)

  log "running frontend lint"
  (cd "$ROOT_DIR/frontend" && yarn lint:check)

  log "running frontend build"
  (cd "$ROOT_DIR/frontend" && yarn build)
}

promote_refs() {
  local target_commit
  target_commit="$(git rev-parse "$DEV_BRANCH")"

  log "promoting dev/production/stable to $target_commit"
  git branch -f dev "$target_commit"
  git branch -f production "$target_commit"
  git branch -f stable "$target_commit"

  log "pushing development/dev/production/stable to $REMOTE"
  git push "$REMOTE" development dev production stable

  log "remote refs after push"
  git ls-remote "$REMOTE" \
    refs/heads/development \
    refs/heads/dev \
    refs/heads/production \
    refs/heads/stable
}

require_clean_worktree
require_branch
require_remote
run_checks
promote_refs

log "done. Git code was promoted only; storage and .env files were not copied."
