#!/usr/bin/env bash
set -euo pipefail

base_image="${1:-}"
target_image="${2:-}"

if [[ ! "$base_image" =~ ^[a-zA-Z0-9._/:@-]+$ ]] ||
  [[ ! "$target_image" =~ ^[a-zA-Z0-9._/:@-]+$ ]]; then
  echo "usage: $0 <verified-base-image> <target-image>" >&2
  exit 2
fi

docker image inspect "$base_image" >/dev/null

inputs=(
  server/package.json
  server/yarn.lock
  server/prisma/schema.prisma
  server/prisma/postgresql/schema.prisma
)

for input in "${inputs[@]}"; do
  if [[ ! -f "$input" ]]; then
    echo "runtime_source_input_missing:$input" >&2
    exit 2
  fi
  source_hash="$(sha256sum "$input" | awk '{print $1}')"
  image_hash="$(
    docker run --rm --entrypoint sha256sum "$base_image" "/app/$input" |
      awk '{print $1}'
  )"
  if [[ "$source_hash" != "$image_hash" ]]; then
    echo "runtime_source_full_rebuild_required:$input" >&2
    exit 1
  fi
done

docker build \
  --build-arg "ATHENA_BACKEND_BASE_IMAGE=$base_image" \
  --file docker/Dockerfile.backend-runtime-source \
  --progress=plain \
  --tag "$target_image" \
  .

source_entrypoint_hash="$(sha256sum docker/docker-entrypoint.sh | awk '{print $1}')"
image_entrypoint_hash="$(
  docker run --rm --entrypoint sha256sum "$target_image" \
    /usr/local/bin/docker-entrypoint.sh | awk '{print $1}'
)"
if [[ "$source_entrypoint_hash" != "$image_entrypoint_hash" ]]; then
  echo "runtime_source_entrypoint_mismatch:$target_image" >&2
  exit 1
fi

docker run --rm --entrypoint node "$target_image" -e \
  "require('/app/server/generated/postgresql-main'); require('/app/server/generated/postgresql-auth')"

echo "backend_runtime_source_image=$target_image dependency_inputs=verified prisma_clients=verified entrypoint=verified"
