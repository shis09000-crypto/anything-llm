# Sync V2 implementation and rollout

Sync V2 is a control plane over the existing domain tables. It does not replace REST, chat SSE, Agent WebSocket, APNs, thread ETags, or domain-specific caches.

## Active implementation

- SQLite `sync_nodes`, `sync_outbox`, and `sync_client_cursors`, plus extended mutation receipts.
- Transactional version and Outbox writes for profile, security policies, entitlement state, notification capability, user preferences, workspaces, workspace membership, documents and embedding status, threads, thread message append/edit/delete events, registered client devices, and long-term memory writes.
- Manifest, compact manifest-Hash comparison, eager/lazy hydration, batch node reads, event replay, SSE replay, cursor ACK, single-node mutation, and batch mutation endpoints under `/api/sync/v2`.
- A single-process Outbox dispatcher using the existing Broadcast Center. The dispatcher boundary can later be backed by Redis Streams or NATS without changing the client protocol.
- Web manifest bootstrap, descriptor envelopes, an owner-partitioned AES-GCM node archive, reliable WebSocket application before ACK, sampled Hash repair, and an encrypted IndexedDB mutation queue. Descriptor availability and payload availability are tracked separately: a mutation receipt may advance the former, but the next event/reconcile must fetch the latter before the cursor advances. When the Broadcast WebSocket is unavailable, Web automatically consumes the same Outbox sequence over Sync V2 SSE; an SSE replay larger than its bounded inline page finishes through paged `/events` before the stream is treated as current.
- The first Web mutation adopters are profile edits, user-state preferences, projected workspace metadata, and projected thread metadata. They use `baseVersion` plus server-derived changed paths, retain the legacy REST path behind the feature flag, and surface same-field conflicts or terminal queue failures in a minimal resolution center instead of silently overwriting either side.
- Workspace and thread mutation routing is deliberately field-scoped. Only fields represented by their Sync V2 projections use the offline queue; prompt bodies, non-projected settings, archive/delete operations, permissions, and other domain actions continue through their existing APIs.
- iOS/iPadOS manifest bootstrap, protected node envelopes, a secure cursor, a protected mutation queue, periodic sampled Hash verification, and the same reliable-apply-before-ACK rule. Workspace/thread rename and model changes are the first native projected writes: they use Sync V2 when a stable server ID and descriptor are available, otherwise retain the existing REST path. Queue uploads are bounded to 50 mutations per batch while preserving per-node ordering; non-retryable 4xx results are retained as terminal failures instead of being replayed indefinitely.
- iOS/iPadOS consumes validated Sync V2 payloads directly for profile metadata, the workspace index, thread indexes, workspace/thread metadata, and `ios.drawer.pins`. These projections update the existing domain centers and their existing protected caches instead of issuing a second REST read for data already returned by `nodes:batchGet`; malformed or incomplete projections fall back to the legacy authoritative read. Dual-delivery events report whether their node payload was actually applied before the legacy handler runs, so only a successfully applied projection may suppress the corresponding legacy domain read. Security clients, passkeys, policies, entitlements, and other authorization-bearing nodes remain invalidation signals and still re-read their authenticated domain APIs before becoming effective. `NativeSyncV2Diagnostics.directPayloadApplications` and `suppressedLegacyDomainReads` measure this optimized path without exposing payload content.
- APNs background notifications contain only a wake reason and Outbox checkpoint.
- Security client-device nodes use a stable projection that excludes `lastSeenAt`, public keys, capability payloads, and other volatile or sensitive fields. Web and iOS treat the node as an invalidation signal and then re-read the existing authenticated device API.
- Passkey nodes contain only display metadata. Because passkeys live in the shared auth database, passkey writes cannot be atomic with the environment database Outbox; the auth write is authoritative and triggers immediate projection reconciliation, with manifest/Hash repair as the recovery side chain.
- Memory candidate nodes use an event cursor. Structured memory and persona nodes use version plus Hash; sensitive memory content and encrypted payloads are excluded, and clients refresh through the existing authenticated memory APIs after invalidation.
- Workspace cognition, meetings, and Agent invocations use event-cursor nodes. Their projections contain only latest IDs, revisions, statuses, and timestamps; cognition text, meeting snapshots, audit request/result bodies, and Agent prompts remain in their domain tables and APIs.
- Workspace document nodes use version plus Hash over sanitized metadata and processing state. Raw document content, filesystem paths, vector data, and Blob payloads remain outside the tree.
- Manifest responses expose only the descriptor fields clients need. Clients send the cached `manifestHash`; an unchanged authorized tree returns no descriptors and only the new checkpoint. High-volume and screen-specific nodes are marked `hydration: lazy`, so first synchronization does not fetch every thread cursor, document set, memory projection, or activity log.
- The node registry also records server-internal `hydrationTier`, `payloadMode`, and `costClass` policies. These policies are intentionally not copied into every manifest descriptor: they guide materialization, client-adapter work, and performance audits without inflating the cold-start envelope. Manifest-time materialization is limited to non-lazy nodes; lazy nodes are created by their owning domain write, shadow materialization, or an explicit route-level read.
- Workspace member and permission projections are route-lazy. Current Web and iOS clients do not use their payloads as authorization authority; every privileged API remains server-verified, so eagerly transferring the full membership projection would only duplicate data and create a misleading cache boundary. Workspace thread-index events are aggregate-only (`changedPaths: ["threads"]`) because the index projection is filtered per requesting user; private thread IDs and slugs stay in the authorized thread node and domain API.
- Preference hydration is namespace-aware. Only bounded startup settings (`preferences.appearance`, `recent.navigation`, `workspace.order`, and `ios.drawer.pins`) are eager. Reader library/progress, drafts, workspace layout, Crypto UI, and unknown extensible namespaces are route-lazy; their existing domain API and event-triggered node fetch remain available, so a large page cache cannot silently become boot-critical state.

Registered but intentionally non-materialized domains include user integrations, tasks/workflows, and thread read state/drafts/attachments. Registration defines stable keys and consistency models; it does not claim a nonexistent domain authority. Security sessions now use the enumerable shared Auth DB `auth_sessions` authority added by Session V2: `security/sessions` remains a lazy, security-revalidate event-cursor node and never grants access from cached payload. Auth DB changes publish a sanitized source revision into the main Sync V2 Outbox; an hourly paged reconciliation repairs cross-database notification gaps. The notification node currently describes Web Push capability, not a durable notification inbox. Task and workflow nodes are not materialized until durable workspace-owned authorities exist.

## Main and recovery paths

1. WebSocket is the primary low-latency notification path.
2. SSE consumes the same Outbox sequence and supports `Last-Event-ID`.
3. APNs wakes native clients with a checkpoint only.
4. Startup manifest comparison and `/events?after=` repair missed notifications.
5. Periodic sampled SHA-256 verification repairs silent drift.
6. Existing REST polling, ETag history reads, chat generation SSE, Agent WebSocket, and legacy sync events remain available as recovery or compatibility paths.

Transport delivery is not consistency acknowledgement. A client advances and uploads `lastAppliedSeq` only after the referenced node has been read, applied, and persisted.

Event replay advances an exhausted client to the global Outbox checkpoint even when intervening events are outside that user's authorization scope. This prevents invisible global sequence gaps from causing permanent replay loops or false cursor lag; node visibility is still re-evaluated for every returned event, and manifest reconciliation remains the authority when access is later granted.

Automatic rebase is allowed only when the server still retains a complete Outbox path from `baseVersion + 1` through the current node version and the changed paths do not overlap. Missing version history is a hard conflict with `requiresFullSync: true`; absence of an event is never interpreted as proof that no conflicting write occurred.

Clients may send `changedPaths` as an optimization hint, but conflict authority is server-derived from the validated mutation operation and payload. A client cannot claim unrelated paths to bypass a version conflict.

Each mutation ID is bound to a server-computed canonical request Hash over `nodeKey`, `baseVersion`, `operation`, and `payload`. A completed receipt returns the original result for an exact replay; reusing the same ID for different semantics returns `409 sync_v2_idempotency_key_reused`. A conflict retry therefore receives a new mutation ID and preserves the old record for audit until replacement. Receipt completion is recoverable from the transactional Outbox if the process stops after the domain commit.

Preference rebases read the latest preference row inside the same transaction after version-history validation and only then apply JSON Merge Patch or set operations. Shared Auth replication failures are compensated back from the shared authority; the compensation Outbox event references the original mutation ID in its payload hint, and an idempotent replay returns `state_version_conflict` with `mutation_compensated` instead of reporting the reverted write as successful.

If an identical mutation is already executing and has not produced its transactional Outbox row yet, concurrent duplicates receive retryable `425 sync_v2_mutation_in_progress` rather than entering the domain write twice. A pending reservation older than 30 seconds may be taken over so a process failure cannot strand the idempotency key for the full retention period.

Successful mutation responses carry the authoritative post-write descriptor. Web and iOS persist that descriptor immediately so a rapid second write uses the new `stateVersion`; the later WebSocket/SSE event is still consumed idempotently as notification confirmation and recovery.

After at least one verified manifest has been cached for the current user, a transport outage may keep the V2 mutation coordinator enabled in offline mode. Replayable projected writes are then accepted into the local queue without treating the cache as fresh authority; `404` or protocol-disabled `503` still switches immediately to the legacy path.

## Feature flags

- `ATHENA_SYNC_V2_ENABLED=true` enables the server protocol and dispatcher.
- `ATHENA_SYNC_V2_DOMAINS=core` expands to profile, preferences, workspace, and chat. Staged domains `security`, `memory`, `cognition`, `agents`, `meetings`, `documents`, `tasks`, `workflows`, `notifications`, `entitlements`, and `integrations` can be enabled independently after their shadow audit is clean.
- `ATHENA_SYNC_V2_RETENTION_MS` controls event retention and defaults to 30 days.
- `VITE_SYNC_V2_ENABLED=false` is the Web kill switch.

The server flag defaults off. Roll out by enabling shadow materialization and dual delivery first, then Web cohorts, then iOS/TestFlight. Disabling V2 leaves metadata and Outbox rows intact and immediately returns clients to legacy reads.

## Operational checks

With non-production communication debugging enabled, `GET /api/debug/communication/sync-v2` reports active domains, node count, Outbox backlog and age, latest sequence, cursor lag, reconcile/conflict counters, and dispatcher status.

The Web communication panel combines that server snapshot with the current browser descriptor count, applied cursor, encrypted mutation queue depth, and conflict count. iOS exposes the equivalent `NativeSyncV2Diagnostics` snapshot from `NativeSyncCenter` without exposing queued payload content.

Outbox records and mutation receipts expire after the configured retention window and are pruned hourly. A cursor older than the retained minimum receives `requiresFullSync: true` and must reconcile from a fresh manifest checkpoint.

Canonical JSON behavior is fixed by `docs/sync-v2-canonical-json-vectors.json`. `updatedAt` is server-authored metadata, never conflict authority. `dirty` is removed from server preference payloads and remains client-local queue state.

Run `yarn sync-v2:audit` for a read-only projection and Hash audit, `yarn sync-v2:benchmark` for a read-only legacy/cold/warm transport comparison, `yarn sync-v2:materialize` to create missing shadow nodes, and `yarn sync-v2:repair` to clear invalid Hashes and reconcile drift through the normal versioned Outbox path. The audit explicitly detects cases where one shared node key would expose different authorized user projections.

## Consistency boundaries

- Profile, settings, workspace/thread metadata: state version with optional Hash and Merge Patch conflict handling.
- Workspace thread indexes: version-only because private-thread filtering creates a user-specific authorized projection under a shared workspace routing node.
- Membership, permissions, security, and entitlements: server verification before use; stale cache never grants authority.
- Client devices: version plus Hash over stable display/revocation metadata, with transactional Outbox writes. Volatile presence (`lastSeenAt`) does not churn the node version.
- Passkeys: version plus Hash over sanitized display metadata, projected from the shared auth authority. Cross-database reconciliation is intentionally a side chain, not a claim of atomic commit.
- Long-term memory candidates: event cursor. Structured memory and persona: version plus Hash over sanitized projections; sensitive plaintext, encrypted payloads, and reveal grants never enter the state tree.
- Chat: append/edit/delete Outbox events plus thread cursor/revision and existing incremental `afterChatId`/ETag reads. Event-cursor nodes intentionally omit object Hashes; the full message list is not a normal state object.
- Read position: monotonic cursor when migrated.
- Collaborative documents: event cursor or future OT/CRDT; document bodies and blobs do not enter the ordinary state tree.
- Task/Agent/meeting/cognition histories: append-only domain logs exposed by cursor rather than object replacement.
- Cognition and meetings: transactional Outbox events are emitted at user-visible mutations, candidate review, profile rebuild, packet/session changes, and meeting audit append boundaries. Background intermediate extraction rows remain domain-internal until they reach a stable boundary.
- Agent invocations: creation and close transitions emit cursor events; the existing Agent WebSocket remains the realtime main path and Sync V2 is the missed-event/reconciliation path.

Windows local-only SQLite remains device-local. Cross-device behavior requires the remote authoritative service mode; a local database is never presented as shared cloud state.
