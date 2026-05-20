# Document Index Status Implementation Report

## Final Architecture Overview

AnythingLLM now has a workspace-scoped document indexing status layer that complements the existing document and vector tables without replacing them.

- `workspace_documents` remains the canonical record of documents attached to a workspace.
- `document_vectors` remains the mapping from `docId` to provider vector IDs.
- `embedding_batch_jobs` remains the async batch job tracker.
- `DocumentIndexStatus` is the shared per-workspace indexing lifecycle record.

A document is considered successfully indexed for a workspace when its `DocumentIndexStatus.indexStatus` is `indexed`. The stored `fileHash` is the SHA256 of the stored document JSON at the time of the most recent successful indexing operation.

## Files Created Or Modified

Created:

- `server/models/documentIndexStatus.js`
- `server/__tests__/utils/agents/documentIndexStatusTool.test.js`
- `server/utils/agents/aibitat/plugins/document-index-status-tool.js`
- `server/prisma/migrations/20260519000000_add_document_index_status/migration.sql`
- `DOCUMENT_INDEX_STATUS_IMPLEMENTATION_REPORT.md`

Modified:

- `server/prisma/schema.prisma`
- `server/models/documents.js`
- `server/models/embeddingBatchJob.js`
- `server/models/scheduledJob.js`
- `server/jobs/embedding-worker.js`
- `server/jobs/sync-watched-documents.js`
- `server/utils/DocumentEmbeddingBatch/index.js`
- `server/utils/agents/aibitat/plugins/index.js`
- `server/utils/agents/defaults.js`
- `server/utils/files/index.js`
- `server/endpoints/document.js`
- `server/endpoints/api/document/index.js`
- `frontend/src/pages/Admin/Agents/skills.jsx`
- `frontend/src/components/Modals/ManageWorkspace/Documents/WorkspaceDirectory/WorkspaceFileRow/index.jsx`

## Database Schema And Migration Details

Migration:

- `server/prisma/migrations/20260519000000_add_document_index_status/migration.sql`

Prisma model:

- `DocumentIndexStatus`

Fields:

- `workspaceId`: workspace namespace scope.
- `docId`: document ID used by vector DB providers.
- `filePath`: stored document path under `server/storage/documents`.
- `fileHash`: SHA256 of the stored JSON document at successful indexing time.
- `indexStatus`: one of `pending`, `indexing`, `indexed`, `outdated`, `failed`, `deleted`.
- `indexedAt`: most recent successful indexing timestamp. It is not cleared by later `outdated`, `failed`, or `deleted` states.
- `errorMessage`: latest status error or outdated hash explanation.
- `chunkCount`: chunk count recorded at successful indexing.
- `embeddingCount`: embedding/vector count recorded at successful indexing.
- `createdAt`, `updatedAt`: lifecycle timestamps.

Indexes:

- Unique: `[workspaceId, filePath]`
- Indexed: `workspaceId`, `docId`, `filePath`, `fileHash`, `indexStatus`

The migration only creates the new table and indexes. It does not mutate existing `workspace_documents`, `document_vectors`, source documents, or vector DB data.

## API Endpoints Added

Session-authenticated UI endpoints:

- `GET /document/index-status?workspaceSlug=&workspaceId=&filePath=&docId=`
- `PATCH /document/index-status`

API-key endpoints:

- `GET /v1/document/index-status?workspaceSlug=&workspaceId=&filePath=&docId=`
- `PATCH /v1/document/index-status`

Responses return `DocumentIndexStatus` rows with all status fields. Patch endpoints use `DocumentIndexStatus.manualUpdate()` and validate status values.

## Agent Tool: `document_index_status_tool`

A read-only built-in agent tool now exposes document index status directly to AI agents.

Architecture:

- `server/utils/agents/aibitat/plugins/document-index-status-tool.js` resolves the workspace by slug, reads `workspace_documents`, reads `DocumentIndexStatus`, and uses `document_vectors` counts through `DocumentIndexStatus.embeddingCountForDoc()` where a status row has no stored embedding count.
- The tool never writes to the database, never triggers indexing, and never modifies vector DB data.
- Documents in `workspace_documents` that do not yet have a status row are synthesized from legacy state. If `workspace_documents.embeddingStatus` is `completed` and `document_vectors` has rows for the `docId`, the tool reports `indexed`; if legacy status is `failed`, the tool reports `failed`; otherwise it reports `pending` with `errorMessage: "missing_status_row"`.

Registration points:

- Exported from `server/utils/agents/aibitat/plugins/index.js`.
- Enabled by default in `server/utils/agents/defaults.js`.
- Listed in scheduled job available tools through `server/models/scheduledJob.js`.
- Visible in Admin > Agents skills through `frontend/src/pages/Admin/Agents/skills.jsx`.

Supported actions:

- `list_unindexed`: returns current workspace documents with `pending`, `outdated`, `failed`, or unresolved missing status rows.
- `list_indexed`: returns current workspace documents with `indexed` status.
- `get_status`: returns one document status by `filePath` or `docId`.
- `get_summary`: returns counts for `indexed`, `unindexed`, `indexing`, `outdated`, `failed`, `deleted`, plus `pending` and `missingStatus`.

Example calls:

```json
{"action":"list_unindexed","workspaceSlug":"demo"}
{"action":"list_indexed","workspaceSlug":"demo"}
{"action":"get_status","workspaceSlug":"demo","filePath":"custom-documents/a.json"}
{"action":"get_summary","workspaceSlug":"demo"}
```

Sample outputs:

```json
{
  "workspaceSlug": "demo",
  "count": 1,
  "documents": [
    {
      "filePath": "custom-documents/a.json",
      "docId": "doc-123",
      "indexStatus": "indexed",
      "indexedAt": "2026-05-19T10:00:00.000Z",
      "errorMessage": null,
      "chunkCount": 4,
      "embeddingCount": 4
    }
  ]
}
```

```json
{
  "workspaceSlug": "demo",
  "summary": {
    "indexed": 8,
    "unindexed": 2,
    "indexing": 1,
    "outdated": 1,
    "failed": 1,
    "deleted": 0,
    "pending": 0,
    "missingStatus": 0,
    "totalCurrentDocuments": 11
  }
}
```

MCP compatibility note:

- The current AnythingLLM MCP compatibility layer imports external MCP servers into the agent runtime. There is no separate reverse registry that exposes built-in AnythingLLM tools as an MCP server, so no additional MCP registration is applicable for this read-only built-in tool.

## Frontend UI Changes

The workspace document picker now reads the new status data through the existing document listing flow. It prefers `DocumentIndexStatus` rows and falls back to legacy `workspace_documents.embeddingStatus` for older documents that do not yet have status rows.

Displayed indicators:

- `⏳` pending
- `🔄` indexing
- `✅` indexed
- `⚠️` outdated
- `❌` failed

Tooltips include available error, indexed timestamp, embedding count, and batch job ID.

## Status Lifecycle And State Transitions

- Accepted document: `pending`
- Vector write begins: `indexing`
- Vector write succeeds: `indexed`
  - Updates `fileHash`.
  - Sets `indexedAt` to the current time.
  - Clears `errorMessage`.
  - Records `chunkCount` and `embeddingCount`.
- Stored JSON hash changes after a successful index: `outdated`
  - Preserves `indexedAt`.
  - Records hash mismatch details in `errorMessage`.
- Indexing fails: `failed`
  - Preserves previous `indexedAt`.
  - Records `errorMessage`.
- Document is removed from a workspace: `deleted`
  - Preserves previous `indexedAt`.
- Re-index after `outdated`, `failed`, or `deleted`: `indexing -> indexed`
  - Refreshes `indexedAt` only on success.

## Ingestion Path Coverage

Covered through shared model integration:

- UI workspace document embedding via `Document.addDocuments()`
- API workspace embedding via `Document.addDocuments()`
- API upload, raw text, link import, and browser extension embed when they call `Document.addDocuments()`
- Parsed-file embed via `WorkspaceParsedFiles.moveToDocumentsAndEmbed()`
- `document-ingest-agent` local path and workspace document ingest through `Document.addDocuments()`
- Native embedding worker via `server/jobs/embedding-worker.js`
- Batch embedding via `server/utils/DocumentEmbeddingBatch/index.js`
- Batch retry/failure via `server/models/embeddingBatchJob.js`
- Watched document sync via `server/jobs/sync-watched-documents.js`
- Workspace document removal via `Document.removeDocuments()`

## Test Results And Validation Steps

Completed:

- `cd server && npx prisma generate`
- `cd server && npx prisma migrate deploy`
- `cd server && yarn lint:check`
- `cd frontend && yarn lint:check`
- `cd frontend && yarn build`
- `document_index_status_tool` registration was added to the built-in agent plugin export, default agent skills, scheduled job tool list, and Admin Agent Skills UI.

Database validation:

- Before migration: `workspace_documents=14`, `document_vectors=31`
- After migration: `workspace_documents=14`, `document_vectors=31`, `DocumentIndexStatus=0`
- Verified `DocumentIndexStatus` table columns and indexes in SQLite.

Lifecycle smoke validation:

- Created a temporary document JSON under `server/storage/documents/custom-documents`.
- Ran `pending -> indexing -> indexed`.
- Modified the file and verified automatic `outdated`.
- Verified `indexedAt` stayed unchanged after `outdated`.
- Ran `failed` and `deleted` transitions and verified `indexedAt` stayed unchanged.
- Deleted the temporary status row and temporary document file after the smoke test.

Frontend build validation:

- Vite production build completed successfully.
- Existing Vite warnings remain dependency/chunk-size warnings unrelated to this change.

## Assumptions, Limitations, And Future Improvements

Assumptions:

- Indexing status is workspace-scoped because AnythingLLM stores vectors in workspace namespaces.
- `indexedAt` means last successful indexing time, not last lifecycle update time.
- Legacy `workspace_documents.embeddingStatus` remains for backward compatibility.

Limitations:

- Existing historical documents are not backfilled into `DocumentIndexStatus` by the migration because SHA256 hashing requires reading runtime storage files. The frontend still falls back to legacy status for those rows.
- Swagger JSON was not regenerated because the current swagger scanner misidentified helper code as a route during local generation.
- `chunkCount` and `embeddingCount` are based on vector records written for the doc. Existing provider behavior is preserved.

Future improvements:

- Add a safe admin-only backfill job to create `DocumentIndexStatus` rows for existing workspace documents.
- Add richer frontend filtering by `outdated` and `failed`.
- Add a retry/re-index action from the status indicator.
- Add OpenAPI documentation after the swagger scanner can safely handle helper functions near route declarations.
