# Athena iOS Native App Contract

This document defines the server-side contract used by the pure SwiftUI Athena
iOS app. The contract does not issue a token or replace the existing web login,
Client Identity, request-signing, or resource-authorization flows.

## Bootstrap

The native app should start with:

```http
GET /api/native-app/bootstrap
```

The endpoint is public and returns non-secret metadata only. It sets
`Cache-Control: no-store` because clients should always see the current
transport, feature, readiness, and version policy.

Representative response:

```json
{
  "success": true,
  "protocolVersion": "ios-native-v1",
  "generatedAt": "2026-07-08T00:00:00.000Z",
  "app": {
    "name": "Athena",
    "platform": "ios",
    "platforms": ["ios", "ipad"],
    "minimumOSVersion": "26.0",
    "deploymentVersion": "2.2.4",
    "versionPolicy": {
      "minSupportedAppVersion": null,
      "recommendedAppVersion": null
    },
    "liquidGlass": {
      "nativeRequired": true,
      "swiftUIAvailability": "iOS 26+",
      "fallbackPromised": false
    }
  },
  "transport": {
    "apiBasePath": "/api",
    "httpsRequired": true,
    "webSocketSecureRequired": true,
    "publicAppUrl": "https://athena.example.com",
    "sseSupported": true,
    "webSocketSupported": true
  },
  "endpoints": {
    "bootstrapPath": "/api/native-app/bootstrap",
    "preflightPath": "/api/native-app/preflight",
    "syncReplayPath": "/api/sync/events/replay",
    "threadFingerprintsPath": "/api/sync/thread-fingerprints",
    "nativePushTokenPath": "/api/native-app/push-token",
    "appleAppSiteAssociationPath": "/.well-known/apple-app-site-association"
  }
}
```

The response also includes auth, security, feature, and endpoint maps for the
native adapter. These values are informational and must not be treated as a
substitute for server-side auth, role checks, resource ownership checks, Client
Identity, request signing, or Sensitive Session validation.

Bootstrap also includes a `readiness` section. Server-side P0 items can be
reported as `ready`; work that must happen inside the SwiftUI app is reported as
`requires_native_client`; cloud or Apple capability work that requires env or
external account configuration is reported as `requires_*` or `not_implemented`.

## Preflight

Native clients should call preflight before login and after app upgrades:

```http
GET /api/native-app/preflight?platform=ios&appVersion=1.0.0&osVersion=26.0
```

The endpoint is public and returns no secrets. It evaluates:

- Supported platform: `ios` or `ipad`.
- Minimum OS: iOS `26.0`.
- Optional app version policy:
  `ATHENA_IOS_MIN_SUPPORTED_APP_VERSION` and
  `ATHENA_IOS_RECOMMENDED_APP_VERSION`.

Representative response:

```json
{
  "success": true,
  "protocolVersion": "ios-native-v1",
  "platform": "ios",
  "compatible": true,
  "blocked": false,
  "updateRecommended": false,
  "reasons": [],
  "warnings": []
}
```

If the app is below the minimum supported app version, `blocked` is `true` and
`reasons` includes `app_version_blocked`. If the app is below the recommended
version but still allowed, `updateRecommended` is `true`.

## Startup Order

Future SwiftUI clients should use this order:

1. Fetch `/api/native-app/bootstrap`.
2. Fetch `/api/native-app/preflight`.
3. Resolve the API base and confirm HTTPS/WSS transport.
4. Create or restore the iOS Client Identity from Keychain.
5. Register Client Identity headers/query values on the login request so the
   issued session is bound to this native client.
6. Log in through `/api/request-token` or a supported passkey flow.
7. Register Client Identity headers/query values on every HTTP, SSE, and WS
   request.
8. Bind the device P-256 key and fetch the signing secret through
   `/api/client-identity/signing-secret`.
9. Validate any restored token before reading authenticated metadata or local
   workspace caches.
10. Replay the authenticated sync cursor and reconcile thread fingerprints.
11. Hydrate `/api/system/user/state`.
12. Connect `/api/realtime/broadcast` and resume from the persisted cursor.
13. Register the APNs token when native push is configured.
14. Start user workflows: workspace/thread, chat SSE, Reader, and Agent WS.

Except for bootstrap, preflight, auth-mode discovery, and login, native API
requests must require a validated Bearer session. Signing out, session expiry,
client revocation, or an unrecoverable signature failure must clear all in-memory
workspace state and the authenticated user's local metadata snapshot before the
login screen is shown.

## iOS 26 and Liquid Glass

The first native Athena app target is iOS 26+. The SwiftUI app should use native
Liquid Glass APIs such as `glassEffect`, `GlassEffectContainer`, and glass
button styles. Athena web CSS glass tokens may inform visual tone, but they are
not the implementation layer for the iOS app.

Because iOS 26 is the minimum target for this contract, the bootstrap does not
promise an older iOS visual fallback.

## Version Policy

These optional environment variables are surfaced as metadata only:

```env
ATHENA_IOS_MIN_SUPPORTED_APP_VERSION=
ATHENA_IOS_RECOMMENDED_APP_VERSION=
```

When unset, bootstrap returns `null` for both values and does not block clients.

Preflight enforces the version policy for native clients. Bootstrap reports the
same policy as metadata.

## Associated Domains and Universal Links

Athena serves the Apple App Site Association file at:

```http
GET /.well-known/apple-app-site-association
GET /apple-app-site-association
```

The file is returned only when the iOS associated domain identifiers are
configured:

```env
ATHENA_IOS_BUNDLE_ID=com.example.athena
ATHENA_IOS_TEAM_ID=TEAM123456
ATHENA_IOS_APP_ID_PREFIX=TEAM123456
ATHENA_IOS_UNIVERSAL_LINK_PATHS=/,/workspace/*,/reader/*,/agent/*
```

`ATHENA_IOS_APP_ID_PREFIX` is optional when it is the same as
`ATHENA_IOS_TEAM_ID`. If these values are missing, the association endpoint
returns `404` rather than serving an invalid Apple association file.

## Push and P1 Feature Status

Bootstrap exposes APNs configuration readiness without exposing private key
material:

```env
ATHENA_IOS_APNS_ENABLED=false
ATHENA_IOS_APNS_ENVIRONMENT=development
ATHENA_IOS_BUNDLE_ID=com.example.athena
ATHENA_IOS_TEAM_ID=TEAM123456
ATHENA_IOS_APNS_KEY_ID=
ATHENA_IOS_APNS_KEY_PATH=
```

When these values are complete, bootstrap reports native push as available. The
server uses token-based APNs authentication and accepts device tokens only on
the authenticated, Client Identity-bound, signed `/api/native-app/push-token`
route. Silent payloads contain only a sync hint and event cursor; they never
contain chat text, prompts, tokens, or signing material.

Reliable native synchronization uses:

```http
GET /api/sync/events/replay?afterEventId=<event-id>&limit=100
POST /api/sync/thread-fingerprints
```

Both routes require an authenticated session, a non-legacy Client Identity and
a valid request signature. Event rows are user-scoped and retained for seven
days. Chat events mark a thread dirty; the client compares the server-owned
history fingerprint and refreshes the authoritative latest-20 window only when
it changed.

The event cursor is durable in the database even when live fanout uses the
single-instance in-memory transport. A multi-instance realtime transport is
still required before horizontally scaled production fanout can be considered
complete.

## Out of Scope

The bootstrap contract does not include:

- Apple Sign in.
- Native background upload or download implementation.
- Full offline mode.
- Complete Admin, Crypto, local model, or high-risk sensitive file editing.
- A WebView dependency.

Legacy `/api/mobile/*` endpoints remain available for the existing device flow,
but they are not the foundation for the SwiftUI iOS app.
