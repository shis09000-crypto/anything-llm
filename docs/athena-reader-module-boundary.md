# Athena Reader Module Boundary

## Current Shape

Reader is now a backend module with explicit boundaries:

```text
server/endpoints/workspaceReaderDocuments.js
  -> server/modules/reader/httpAdapter.js
    -> server/modules/reader/httpRoutes.js
      -> server/modules/reader/httpUtilityHandlers.js
      -> server/modules/reader/httpIngestHandlers.js
      -> server/modules/reader/httpDocumentHandlers.js
      -> server/modules/reader/httpPostprocessHandlers.js
      -> server/modules/reader/httpContentHandlers.js
      -> server/modules/reader/thumbnailMaintenance.js

server/utils/readerDocumentRuntime/index.js
server/providers/readerDocumentStorageProvider.js
server/utils/devControl/readerCommands.js
server/utils/readerWorker/runtime.js
  -> server/modules/reader/index.js
    -> server/modules/reader/runtime.js
      -> server/modules/reader/documents.js
        -> server/modules/reader/documentsCore.js
        -> server/modules/reader/documentCatalog.js
        -> server/modules/reader/readerLinks.js
        -> server/modules/reader/originalStream.js
      -> server/modules/reader/accessGate.js
      -> server/modules/reader/previewPipeline.js
      -> server/modules/reader/postprocessPipeline.js
        -> server/modules/reader/postprocessCore.js
        -> server/modules/reader/pdfMedia.js
        -> server/modules/reader/previewPipeline.js
        -> server/modules/reader/classificationPipeline.js
      -> server/modules/reader/pdfMedia.js
        -> server/modules/reader/pdfMediaCore.js
        -> server/modules/reader/formatReaders.js
        -> server/modules/reader/readerLinks.js
        -> server/modules/reader/ocr.js
      -> server/modules/reader/classificationPipeline.js
        -> server/modules/reader/classificationCore.js
      -> server/modules/reader/ocr.js
      -> server/modules/reader/formatReaders.js
```

Frontend Reader consumers now enter through `frontend/src/modules/reader`:

```text
frontend/src/components/WorkspaceChat/ChatContainer/index.jsx
frontend/src/components/WorkspaceChat/ChatContainer/PromptInput/index.jsx
frontend/src/components/WorkspaceChat/ChatContainer/ChatHistory/*
  -> frontend/src/modules/reader/*
    -> frontend/src/components/WorkspaceChat/ChatContainer/DocumentReader/*
    -> frontend/src/models/readerDocument.js
    -> frontend/src/models/readerLibrary.js
    -> frontend/src/utils/chat/reader*
```

The large UI implementation files remain in their existing component directory,
but external WorkspaceChat consumers use the Reader module entrypoints.

The endpoint is only a compatibility adapter. Worker, storage, and dev-control
code must use the Reader module facade, not endpoint internals.

The first body-level extractions are now real modules:

- `documentsCore`: path safety, document ids, metadata JSON, delete markers, visibility.
- `documentCatalog`: duplicate-book detection, standalone authorization metadata reads, Reader list response shaping, thumbnail maintenance queueing for visible lists.
- `ingestCore`: upload/local-path content skeletons, fingerprints, document type and initial metadata.
- `readerLinks`: canonical original/preview/page-preview/thumbnail URLs and public metadata response shaping.
- `accessGate`: Sensitive Session and Dev Control debug-grant content access.
- `httpContentHandlers`: content-serving route handlers for `original`, `preview.pdf`, `page-preview`, and `thumbnail` across standalone/workspace scopes.
- `httpDocumentHandlers`: metadata open and soft-delete HTTP handlers across standalone/workspace scopes.
- `httpIngestHandlers`: upload, local-path open, and workspace parsed-document import HTTP handlers across standalone/workspace scopes.
- `httpPostprocessHandlers`: postprocess enqueue/status and local-path reopen HTTP handlers across standalone/workspace scopes.
- `httpUtilityHandlers`: list, classification, and OCR HTTP handlers across standalone/workspace scopes.
- `thumbnailMaintenance`: low-priority thumbnail maintenance patrol startup and scanning.
- `originalStream`: original-file ETag, range/cache headers, and sendFile tracing.
- `previewPipeline`: DOCX/MD preview engine detection, preview requirement checks, conversion, and preview metadata updates.
- `classificationCore`: classification sampling, fallback rules, prompt/result validation, category/task sanitization, JSON parsing.
- `pdfMedia`: thumbnail generation and Reader media facade.
- `pdfMediaCore`: PDF manifest matching, page-preview names, page window/prebuild ordering.
- `postprocessPipeline`: postprocess queue ownership, durable worker enqueue/fallback, preview/thumbnail/PDF-manifest/classification task execution, and Reader broadcast events.
- `postprocessCore`: postprocess status file shape, status read/write, task patching, progress.
- `ocr`: Reader OCR configuration and screenshot recognition through the configured OCR provider.
- `formatReaders`: EPUB package/container parsing and shared zip entry helpers.

`httpRoutes.js` now registers Reader HTTP routes directly through focused
handler modules. The old `legacyCore.js`, `compatPrivate.js`, and `_private`
export have been retired; tests and internal callers use `ReaderRuntime`
groups directly. The major execution pipelines for classification, PDF media,
preview, postprocess, document catalog/listing, content-serving HTTP handlers,
document metadata/delete HTTP handlers, ingest/import HTTP handlers,
postprocess/local path HTTP handlers, list/classification/OCR HTTP handlers,
and thumbnail maintenance live in focused modules rather than endpoint internals.

## Stable Internal Facade

`ReaderRuntime` groups Reader capabilities by responsibility:

- `documents`: ids, roots, metadata, visibility, listing, original headers
- `access`: sensitive-session/debug-grant content gate and cache policy
- `preview`: DOCX/MD preview engine checks and preview requirements
- `postprocess`: status, enqueue, cancel, run, task sanitization
- `media`: thumbnail, PDF manifest, page preview, OCR screenshot
- `classification`: samples, prompt parsing, LLM classification validation
- `ocr` and `epub`: narrow format-specific helpers

## Compatibility Boundary

There is no Reader `_private` compatibility export. New and existing internal
code must use `ReaderRuntime` groups or the focused HTTP handler modules.

## Next Cleanup

`server/modules/reader/implementation.js` is now only a small composition layer.
`server/modules/reader/runtime.js` no longer imports the compatibility surface
and only exposes the stable `ReaderRuntime` groups. Future rounds should focus
on shrinking the largest focused implementation files (`postprocessPipeline`,
`pdfMedia`, `classificationCore`, and `documentCatalog`) only when a narrower
sub-boundary is useful.

The acceptance check is:

```bash
yarn build:reader-module
yarn check:modules
```
