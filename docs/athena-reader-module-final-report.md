# Athena Reader Module Final Report

## Conclusion

Reader has been modularized into a backend Reader module with a thin HTTP
adapter, focused runtime groups, and explicit integration points for the unified
centers. The old monolithic endpoint body has been removed from the route
surface, and the old Reader `_private` compatibility export has been retired.

The remaining large files are no longer architectural bottlenecks; they are
focused implementation modules:

- `postprocessPipeline.js`: Reader task orchestration and postprocess execution.
- `pdfMedia.js`: PDF media, thumbnails, manifest, and page preview generation.
- `classificationCore.js`: classification prompt/result rules and fallback
  policy.
- `documentCatalog.js`: list shaping, duplicate detection, and catalog scanning.

They can be split further later, but Reader's ownership boundary and execution
links are already separated.

## Current Architecture

```text
HTTP
  server/endpoints/workspaceReaderDocuments.js
    -> server/modules/reader/httpAdapter.js
      -> server/modules/reader/implementation.js
        -> server/modules/reader/httpRoutes.js
          -> httpUtilityHandlers
          -> httpIngestHandlers
          -> httpDocumentHandlers
          -> httpPostprocessHandlers
          -> httpContentHandlers
          -> thumbnailMaintenance

Runtime
  server/modules/reader/index.js
    -> server/modules/reader/runtime.js
      -> ReaderRuntime.documents
      -> ReaderRuntime.access
      -> ReaderRuntime.preview
      -> ReaderRuntime.postprocess
      -> ReaderRuntime.media
      -> ReaderRuntime.classification
      -> ReaderRuntime.ocr
      -> ReaderRuntime.epub

Internal Consumers
  server/utils/readerDocumentRuntime/index.js
  server/providers/readerDocumentStorageProvider.js
  server/utils/devControl/readerCommands.js
  server/utils/readerWorker/runtime.js
    -> server/modules/reader

Frontend
  WorkspaceChat ChatContainer / PromptInput / ChatHistory
    -> frontend/src/modules/reader
      -> DocumentReader UI components
      -> ReaderDocument / ReaderLibrary models
      -> reader persistence, link maintenance, open failure, PDF target,
         progress helpers
```

## Module Responsibilities

- `httpAdapter`: preserves the old endpoint import path.
- `httpRoutes`: owns Express route registration only.
- `httpContentHandlers`: serves `original`, `preview.pdf`, `page-preview`,
  and `thumbnail`.
- `httpDocumentHandlers`: opens metadata and performs soft delete.
- `httpIngestHandlers`: upload, local path open, and workspace import.
- `httpPostprocessHandlers`: enqueue/status and local-path reopen.
- `httpUtilityHandlers`: list, classification endpoint, OCR config/screenshot.
- `documentsCore`: ids, path safety, document roots, metadata JSON, tombstones.
- `documentCatalog`: listing, duplicate detection, standalone auth metadata,
  and thumbnail maintenance queue decisions.
- `readerLinks`: canonical URLs and safe public metadata response shaping.
- `accessGate`: Sensitive Session and Dev Control debug-grant gate.
- `previewPipeline`: DOCX/MD preview engine detection and `preview.pdf`
  generation.
- `postprocessPipeline`: preview, thumbnail, PDF manifest, classification task
  execution, durable worker fallback, and Reader broadcast publication.
- `postprocessCore`: postprocess status file shape and task patching.
- `pdfMedia`: thumbnail, PDF manifest, page preview, media prewarm.
- `pdfMediaCore`: pure PDF manifest/page-window helpers.
- `classificationPipeline`: extraction and DeepSeek classification execution.
- `classificationCore`: sampling, prompt/result validation, JSON parsing,
  fallback rules.
- `ocr`: OCR config and screenshot recognition.
- `formatReaders`: EPUB and archive-format helpers.
- `thumbnailMaintenance`: low-priority thumbnail patrol.
- `frontend/src/modules/reader`: frontend Reader module entrypoint for UI
  provider/panel/source chips, Reader models, and Reader helper utilities.

## Data And Access Flow

Opening a Reader document:

```text
Frontend ReaderDocument
  -> Communication Center / TaskScheduler request metadata
  -> HTTP endpoint thin adapter
  -> httpRoutes
  -> httpDocumentHandlers.metadataGet
  -> documentCatalog / documentsCore / readerLinks
  -> accessGate issues Sensitive Session descriptor when needed
  -> frontend content request includes sensitive header
  -> httpContentHandlers
  -> accessGate validates session or Dev Control debug grant
  -> originalStream / pdfMedia / previewPipeline
```

Uploading or importing:

```text
Frontend upload intent
  -> TaskScheduler foreground task
  -> httpIngestHandlers
  -> ingestCore writes original/content/metadata skeleton
  -> postprocessPipeline enqueue preview/thumbnail/classification
  -> Reader Data Authority tracks library membership
  -> Broadcast sends small status events
```

Postprocess:

```text
TaskScheduler / Reader Worker
  -> readerWorker runtime
  -> ReaderRuntime.postprocess
  -> postprocessPipeline
  -> previewPipeline / pdfMedia / classificationPipeline
  -> postprocessCore status write
  -> Broadcast event: reader.postprocess / reader.thumbnail / reader.classification
```

## Unified Center Integration

### TaskScheduler

Reader does not own scheduling. User-visible work such as open, upload,
manual classification, preview generation, and first thumbnail is dispatched by
TaskScheduler. Reader module functions execute the work once called.

### ServerStateCache

Reader module returns authoritative API results. ServerStateCache may cache
metadata/list/status responses, but it does not decide library membership,
delete state, or sensitive access.

### Reader Data Authority / Data Access Center

Reader Data Authority is the DB authority for bookshelf membership, category,
ordering, hidden state, tombstone, and availability. Reader module handles files
and metadata around `reader-documents`; it does not let directory scans or local
cache decide what belongs in a user's shelf.

### Sensitive Session Center

Content resources are gated in `accessGate`:

- `original`
- `preview.pdf`
- `page-preview`

Metadata and list remain normal authenticated reads. Content requires a valid
Sensitive Session or a short-lived Dev Control debug grant. Tokens are never
returned through snapshots, cache, logs, or module public facades.

### Developer Control Center

Dev Control uses `ReaderRuntime` plus `ReaderDocumentStorageProvider`. It can
inspect Reader status, retry preview/postprocess/thumbnail/classification,
cancel Reader tasks, soft-delete/restore visibility, and issue temporary debug
grants. It does not use endpoint internals and does not receive document
content, absolute paths, tokens, or secrets.

### Broadcast Center

Reader publishes small status events only. It does not broadcast document
content or large payloads. Other clients receive invalidation/status signals and
fetch real data through API + ServerStateCache.

### Recovery Center

Reader failures are categorized by the existing recovery layer. Sensitive
session failure is permission/retryable via metadata refresh; postprocess or
preview failure is background/retryable; user navigation abort/stale results are
silent.

### Navigation Lifecycle Center

Reader exit is treated as a scope leave. Heavy cleanup and stale Reader tasks
are demoted or cancelled by TaskScheduler; Sensitive Session revocation happens
without blocking the target chat UI.

## Security Boundary

- No Reader `_private` export remains.
- HTTP endpoint is a thin adapter.
- Runtime path does not import HTTP route registration.
- Reader Worker, Dev Control, and Storage Provider use `ReaderRuntime`.
- WorkspaceChat external callers use `frontend/src/modules/reader` instead of
  importing `DocumentReader/*` paths directly.
- Sensitive content routes are protected by `accessGate`.
- Dev Control debug bypass is scoped, short-lived, audited, and redacted.
- `originalUrl`, absolute paths, tokens, API keys, cookies, and document body
  content are not exposed through module snapshots or dev-control summaries.

## Verification

The current Reader module state is verified by:

```bash
yarn build:reader-module
cd server && npx jest __tests__/endpoints/workspaceReaderDocuments.test.js __tests__/providers/readerDocumentStorageProvider.test.js __tests__/utils/readerWorkerRuntime.test.js __tests__/utils/readerWorkerContract.test.js __tests__/utils/readerDebugAccess.test.js __tests__/services/readerLibraryService.test.js __tests__/utils/readerModuleBoundary.test.js --runInBand
yarn check:modules
git diff --check
cd frontend && npx eslint src/modules/reader src/components/WorkspaceChat/ChatContainer/index.jsx src/components/WorkspaceChat/ChatContainer/PromptInput/index.jsx src/components/WorkspaceChat/ChatContainer/ChatHistory/HistoricalMessage/index.jsx src/components/WorkspaceChat/ChatContainer/ChatHistory/AssistantTurn/index.jsx --no-warn-ignored
```

Observed result:

- Reader module build/lint passed.
- Reader regression suite passed: 7 suites, 59 tests.
- Module boundary audit passed: 0 errors, 0 warnings.
- Whitespace diff check passed.
- Frontend Reader module and updated WorkspaceChat imports passed targeted
  eslint.

## Remaining Optional Refinement

The module boundary is complete. Optional future cleanup should be value-driven:

- Split `postprocessPipeline` only if worker-specific code grows again.
- Split `pdfMedia` only if thumbnail, manifest, and page-preview need separate
  release cadence.
- Split `classificationCore` only if classification policies become shared
  outside Reader.
- Move frontend `DocumentReader` UI into `frontend/src/modules/reader` only
  when the frontend module boundary needs independent release or ownership; the
  current external import boundary already goes through `frontend/src/modules/reader`.

None of these are required for the current Reader backend modularization goal.
