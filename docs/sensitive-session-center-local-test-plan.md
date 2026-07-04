# Sensitive Session Center Local Test Plan

This checklist is for local-only validation of Sensitive Session Center traffic.
It verifies that sensitive session communication is routed through
TaskScheduler and never through normal server-state cache or ad-hoc network
paths.

## Setup

1. Start local Athena with the normal local stack, for example `yarn dev:all`.
2. Open a local app URL with observer enabled:
   `http://localhost:3000/...?...&athenaRuntimeObserver=1&athenaRuntimeObserverPanel=1`
3. In the browser console, keep these probes available:

```js
window.__athenaSensitiveSessionCenter?.snapshot?.()
window.__athenaTaskScheduler?.snapshot?.()
window.__athenaRecoveryCenter?.snapshot?.()
window.__athenaServerStateCache?.snapshot?.()
```

Network filters:

```text
/sensitive-sessions/
/api/reader-documents/*/original
/api/reader-documents/*/page-preview
/vault/
/api-key
```

Hard pass rule: every `/sensitive-sessions/*` request must appear as a
TaskScheduler task with `kind: "sensitive-session"`, `protected: true`, and
`communicationScene: "sensitive-session"`.

## Test 1: Normal Passage

- Open a reader document, Vault secret, API key reveal/generate, or memory
  reveal path that returns a `sensitiveSession`.
- Verify the sensitive center snapshot shows a session with redacted
  `sessionId`, no raw token, and `transport.schedulerOnly === true`.
- Verify reader blob/PDF requests include `X-Athena-Sensitive-Session`.
- Trigger or wait for heartbeat and verify:
  - Network has `POST /sensitive-sessions/heartbeat`.
  - Scheduler task is `P1`, protected, non-abortable, kind
    `sensitive-session`.
- Close or switch the viewer and verify revoke/revoke-scope removes the server
  session.

## Test 2: Abnormal Communication

- Send a request with an invalid or expired sensitive session token.
- Send a request with a valid token but wrong resource or owner scope.
- Simulate heartbeat network failure.

Expected:

- Reader/heartbeat rejects with 403 or failure result.
- Local sensitive session is cleared after failed heartbeat.
- No raw token appears in console logs, cache snapshot, or scheduler snapshot.
- ServerStateCache does not gain any `sensitive-session:*` key.

## Test 3: Mixed Center Calls

- Call sensitive center methods from a ServerStateCache refresh fetcher.
- Call sensitive center methods from an OptimisticAction serverCall.
- Call sensitive center methods from a Recovery retry callback.

Expected:

- Each real network request still goes through `apiClient.postJson` and
  TaskScheduler.
- Each request has kind `sensitive-session`.
- ServerStateCache rejects sensitive keys or meta with
  `SENSITIVE_SERVER_STATE_FORBIDDEN`.

## Test 4: Normal Flow Without Secret

- Access reader original/page-preview without `X-Athena-Sensitive-Session`.
- Call heartbeat/revoke/revoke-scope without request signing where production
  signing is required.
- Keep normal auth but remove the sensitive session locally.

Expected:

- No fake sensitive session is created.
- Protected content is not shown as authorized.
- Missing signing is rejected by the server boundary in production mode.
- Local snapshot remains empty or clears the affected session.

## Test 5: Pressure

- Open or simulate 20 sensitive viewers.
- Rapidly switch 10 reader documents.
- Trigger `blur`, `pagehide`, and `visibilitychange hidden`.
- Mix workspace/thread/reader/crypto background requests while sensitive
  heartbeat/revoke is active.

Expected:

- Exclusive viewer switches revoke old sessions for the same resource type.
- Global guard revoke is coalesced into one
  `POST /sensitive-sessions/revoke-scope`, not N revoke requests.
- Heartbeat timers return to zero after revoke or auth clear.
- No long-lived pending/running sensitive task leak remains.
- Current foreground P0 user intent is not starved by sensitive maintenance.

## Automated Coverage

Run:

```bash
cd frontend && node --test \
  src/utils/sensitive/sensitiveSessionCenter.node.test.mjs \
  src/utils/observability/athenaFourCenters.integration.node.test.mjs

npx jest server/__tests__/utils/sensitiveSessions.test.js --runInBand
```

These tests cover:

- scheduler-only sensitive transport metadata;
- redacted snapshots;
- missing secret skip behavior;
- heartbeat failure cleanup;
- revoke-all coalescing;
- mixed center calls;
- ServerStateCache sensitive-key rejection;
- server-side bind, expiry, request extraction, wrong resource, heartbeat, and
  exact revoke behavior.
