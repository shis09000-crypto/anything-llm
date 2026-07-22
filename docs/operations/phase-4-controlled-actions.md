# Phase 4: Controlled Operations Actions

Athena's Operations Plane can now propose and run a deliberately small set of
recoverable actions. This is not an autonomous production executor. The policy
engine is default-deny, every proposal performs a read-only preflight, and every
execution requires a separate signed administrator approval.

## Safety contract

The control path is fixed:

1. Catalog validation and parameter sanitization.
2. Read-only dry-run/preflight.
3. Persisted `awaiting_approval` state.
4. Explicit administrator approval.
5. Single-target canary.
6. Canary validation.
7. Bounded execution.
8. Final validation.
9. Automatic rollback on canary or final validation failure.
10. Metadata-only Semantic Event v1 and durable security-ledger records for
    every stage.
11. Expired execution leases enter `reconciliation_required`; they never
    resume automatically and require an explicit signed administrator
    reconciliation request, which performs the catalog rollback.

Shadow Operations Agents can create proposals through the internal
orchestrator, but cannot approve or execute them. The public API is guarded by
the existing authenticated administrator middleware and high-risk request
signature verification.

The executor does not accept shell commands, SQL, URLs, script paths, Docker or
Kubernetes targets, arbitrary worker names, or user-provided callbacks. Run
records contain stable IDs and bounded result metadata only; they never contain
tokens, prompts, chat or document text, signing material, or request bodies.

## Initial Action Catalog

| Action ID | Canary | Validation | Rollback |
| --- | --- | --- | --- |
| `sync.failed_tasks.requeue` | One selected outbox sequence | Selected rows are no longer dead letters | Undispatched rows return to their prior dead-letter metadata |
| `security.auth_cache.refresh` | One session or authoritative DB probe | DB remains the authority | Cache repopulates from the authority on the next read |
| `runtime.stateless_worker.restart` | Restart one allowlisted in-process worker | Worker reports running and healthy | Ensure the worker is running |
| `knowledge.workspace_index.rebuild` | Reindex one document | Vector metadata exists for the canary | Reindex affected documents from their authoritative source files |

The worker allowlist is limited to `sync-v2-outbox` and
`workspace-cognition`. Knowledge rebuilds are limited to one workspace and are
processed in batches of 20 after a one-document canary. Workspaces with missing
or unreadable source documents are blocked during preflight.

## API

All routes require an authenticated administrator. Every `POST` route also
requires the existing Athena high-risk request signature.

- `GET /api/operations/actions/catalog`
- `GET /api/operations/actions/runs`
- `GET /api/operations/actions/runs/:runId`
- `POST /api/operations/actions/runs`
- `POST /api/operations/actions/runs/:runId/approve`
- `POST /api/operations/actions/runs/:runId/reject`
- `POST /api/operations/actions/runs/:runId/execute`
- `POST /api/operations/actions/runs/:runId/reconcile`

Creating a run never starts execution. `execute` returns `202` after the
persisted approval is checked and the process-local runtime accepts the run.
The run endpoint is the authority for stage and rollback status.

Example proposal body:

```json
{
  "actionId": "sync.failed_tasks.requeue",
  "sourceActionId": "operator-incident-20260722-01",
  "parameters": { "seqs": [1201, 1202] }
}
```

## Deployment

Apply both Prisma migrations before enabling the API. The standard server
default is disabled:

```env
ATHENA_OPERATIONS_ACTIONS_ENABLED=false
```

The dedicated `docker-compose.ai-operations.yml` overlay enables the catalog.
Set the value back to `false` to stop new proposals immediately. Existing runs
remain in the database for audit and reconciliation, but no scheduled component
automatically resumes or executes them.

## Metrics

- `athena_operations_action_stages_total`
- `athena_operations_action_duration_seconds`
- `athena_operations_action_rollbacks_total`

Metric labels are bounded to catalog action IDs, lifecycle stages, and outcomes.
