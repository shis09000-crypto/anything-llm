# Athena Codex runtime fork

- Upstream: `https://github.com/openai/codex`
- Pinned commit: `bb8cada846e4cb131c8ed62628930960504dab7b`
- License: Apache-2.0
- Integration boundary: Codex App Server v2 over local stdio only.

Athena does not expose Codex App Server on a network socket. The macOS Runtime
launches the pinned App Server as a child process and translates its local
events into `athena.local-runtime.v1` envelopes. Remote connectivity, device
identity, leases, capability assertions, retry and revocation are Athena code.

Run `scripts/prepare-codex-fork.sh` to materialize the pinned source into an
ignored build directory. Any Athena patches must stay under `patches/` and the
upstream LICENSE and NOTICE files must remain in release packages.
