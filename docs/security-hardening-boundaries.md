# Athena Security Hardening Boundaries

This document records the current security boundaries for Athena hardening work.

## Client Identity and Request Signing

- Client identity, trust level, request signing, nonce replay protection, revocation, and rotation are defense-in-depth controls.
- They do not replace authentication, role checks, reauth, or resource ownership checks.
- Web signing secrets are stored only in memory/sessionStorage, never localStorage, but they are still accessible to same-origin JavaScript. This V1 layer does not claim to resist an already-executing XSS payload.
- High-risk browser routes are signed automatically by the communication center. Ordinary chat, uploads, downloads, and regular reads are not globally signed.

## Developer API Key Boundary

- `/v1/*` Developer API routes use API keys as a separate trust root.
- They are not automatically covered by browser Client Signing.
- API-key routes should continue to enforce API-key scope, role, and resource scoping explicitly.
- Any `/v1/*` signing exemption must remain documented in `server/scripts/security-hardening-allowlist.json`.

## Reader Legacy Owner Metadata

- Standalone Reader documents created before owner metadata may be ownerless.
- Multi-user mode should fail closed for ownerless standalone Reader files.
- Single-user mode may continue to allow legacy ownerless files for compatibility.
- Rebinding ownerless Reader metadata should be an explicit admin/CLI action, not automatic.

## Collector and Document Logs

- Logs must not contain raw URLs with query strings, Authorization/Cookie headers, tokens, signing secrets, local absolute paths, original document titles, or original filenames.
- Use requestId, clientId, hashed resource identifiers, extension, counts, duration, and status for debugging.
- Persistent EventLogs metadata is sanitized centrally before write. Endpoint code should still avoid passing unnecessary secrets into EventLogs.
- Temporary raw logging is not a supported default. Any future opt-in raw-debug mode must be local-only, explicit, and never enabled in production.

## Security Scan Allowlist

- `server/scripts/audit-security-hardening.js` performs route discovery, frontend communication boundary checks, and sensitive log candidate checks.
- Allowlist entries live in `server/scripts/security-hardening-allowlist.json`.
- Each allowlist entry must include `type`, `pattern`, `reason`, and `owner`.
- Broad allowlist entries should only describe stable trust boundaries such as Developer API keys, webhooks, browser worker bridges, or reader asset loading.
- Do not use allowlist entries to hide unreviewed high-risk browser routes; either add Client Signing or document the independent trust boundary.

## Low-side-effect Release Checks

Run these before shipping security transport or communication hardening changes:

```bash
node server/scripts/audit-resource-communication-access.js
node server/scripts/audit-security-hardening.js
git diff --check
bash ./run-development --no-open
bash ./status --env development
curl -sS -i http://localhost:3002/api/ping
```
