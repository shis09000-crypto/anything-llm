# Athena Browser Egress

`browser-egress` is the control plane for browser-only overseas egress. It is
not a public VPN and never changes the operating system's global route.

## Runtime boundary

- Browser Plane owns sessions, Profiles, user authorization, and UI actions.
- Browser Egress owns grants, device-scoped sealed configuration, gateway
  desired state, and route health.
- Key Custody owns wrapped VLESS credentials. Browser Plane and the database
  never receive plaintext credentials.
- The desktop main process owns the local sing-box process and applies the
  route only to the selected Electron partition with `session.setProxy()`.
- Managed Chrome uses an isolated Athena Chrome profile and a short-lived
  loopback CONNECT bridge. The bridge forwards through the same authenticated
  local sing-box process and is removed when the route or app closes.
- Browser bytes and image frames do not pass through Scheduler, NATS, AICP, or
  Operations.

## Route semantics

| Route | Behavior |
| --- | --- |
| `direct` | The managed Browser Profile connects directly. |
| `system` | The managed Browser Profile inherits the OS proxy. |
| `athena_egress` | The managed Browser Profile uses the signed local core and Athena gateway. Failure is closed; it never falls back to direct. |

Profile switches and foreground enrollment are P0 tasks. Grant renewal is P3.
Cleanup and aggregate accounting are P4. These priorities preserve the
existing Task Center semantics; the participants are micro-modules rather than
single-process functions.

## Security invariants

- Public APIs are restricted to active owner/admin accounts.
- One active grant is scoped to user, Profile, and registered desktop node.
- The desktop envelope key is RSA-OAEP-3072 and is never sent as a private key.
- Persistent client configuration is protected by macOS Keychain or Windows
  Credential Manager through Electron `safeStorage`.
- The sing-box binary is pinned by official archive SHA-256, binary SHA-256,
  ML-DSA-65 signature, and a package-fixed public-key fingerprint.
- The gateway rejects loopback, private, link-local, metadata, documentation,
  multicast, and reserved destination ranges after server-side DNS resolution.
- Operations receives only low-cardinality grant outcome, health, latency,
  connection/byte buckets, and error codes. It never receives URLs, DNS names,
  page content, cookies, credentials, or form fields.

## Production activation

The control module can be deployed disabled. Activation requires all of the
following:

1. `browser-egress.athenallm.online` resolves to the approved overseas host.
2. TCP 8443 is allowed by the cloud security group and host firewall.
3. A dedicated Reality private key and short ID exist under the Browser Egress
   secret directory with owner-only permissions.
4. The independent gateway image passes `sing-box check`, isolated listen
   probe, and atomic activation.
5. Browser Egress readiness observes a fresh gateway status file.
6. A signed desktop candidate has the platform core assets and its device node
   is online.
7. The Profile receives a grant, performs a real remote SOCKS probe, and writes
   successful end-to-end route health before the UI shows connected.

Do not reuse ASG user identities, ASG credentials, or the existing global
proxy configuration. Do not enable the feature by substituting an unreviewed
hostname or silently falling back to local direct access.

Google Search and anonymous YouTube are functional probes. Google sign-in is a
manual compatibility acceptance in managed real Chrome; credentials and 2FA
must never be entered by automated tests.

The latest verified Tencent production rollout evidence and the reusable
single-module release chain are recorded in
[`docs/operations/tencent-production-update-success-chain.md`](../operations/tencent-production-update-success-chain.md).
