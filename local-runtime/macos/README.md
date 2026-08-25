# Athena Runtime for macOS

The menu-bar Runtime connects outbound to Athena over WSS. It has no listening
port and runs as the signed-in macOS user. Device signing keys are stored in the
Keychain. Desktop access uses Screen Recording and Accessibility permissions;
files and commands remain inside folders selected by the owner.

## Development

```sh
ATHENA_LOCAL_RUNTIME_URL=ws://localhost:3001/api/local-runtime/device/connect \
ATHENA_LOCAL_RUNTIME_PAIRING_TOKEN=lrp_... \
swift run AthenaRuntime
```

`codex app-server --listen stdio://` must be available on PATH. Production
packages must be signed, hardened, notarized and include the upstream Codex
Apache-2.0 license and Athena modification notice.

Commands are sent to App Server v2 `command/exec` with a `workspaceWrite`
sandbox, network disabled, and only the locally approved roots writable. A
release bundle embeds the pinned Codex executable:

```sh
ATHENA_CODEX_BINARY=/path/to/pinned/codex \
ATHENA_APPLE_CODESIGN_IDENTITY="Developer ID Application: ..." \
ATHENA_NOTARYTOOL_PROFILE=athena-runtime \
./scripts/build-release.sh
```

The emergency-stop menu action immediately cancels the connection and all input
injection. The Runtime never unlocks the Mac, types into Secure Input, invokes
`sudo`, exports credentials, or handles payment/transaction operations.
