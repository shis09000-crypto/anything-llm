# Document Reader MVP Report

## Scope

- Implemented a reader-only document flow that is isolated from workspace RAG ingestion.
- Local files open directly in the browser first. They are uploaded to the server only when the user clicks the server backup action.
- Server backups are stored in the reader namespace, not in workspace documents.
- Document source chips are rendered separately from existing RAG citations and do not write to `response.sources` or `turn.sources`.

## Dependency Gate

Checked before install:

| Package | Version | License | Peer dependency notes | Usage |
| --- | --- | --- | --- | --- |
| `react-pdf-highlighter` | `6.0.0` | MIT | React/React DOM `>=18` | PDF selection and best-effort page/textHash highlight flow |
| `mammoth` | `1.12.0` | BSD-2-Clause | No blocking React peer dependency | DOCX semantic body extraction |
| `xlsx` | `0.18.5` | Apache-2.0 | No React peer dependency | XLSX workbook parsing |
| `@cyntler/react-doc-viewer` | `1.17.1` | Apache License 2.0 | React/React DOM `>=17` | Installed only as preview fallback candidate, not as the core reader |

Install warnings observed:

- `@cyntler/react-doc-viewer` brings `react-pdf/pdfjs-dist/canvas` transitive warnings during install.
- Existing workspace peer warnings around other packages remain unrelated to the reader change.

## Storage And Security

- Server reader root:
  - development: `server/storage/reader-documents`
  - production-style storage: `${STORAGE_DIR}/reader-documents`
- Persisted server shape:
  - `{safeWorkspaceSlug}/{readerDocumentId}/original.{normalizedExt}`
  - `{safeWorkspaceSlug}/{readerDocumentId}/content.json`
  - `{safeWorkspaceSlug}/{readerDocumentId}/metadata.json`
- `readerDocumentId` is generated with `crypto.randomUUID()`.
- `workspaceSlug`, `readerDocumentId`, and filenames are validated before path use.
- Final paths are built through `path.resolve` and checked to remain inside the reader root.
- Original filenames are stored only in `metadata.json`.
- `content.json` and `metadata.json` both include `schemaVersion`.

## Upload And Type Limits

- MVP allowed extensions: `.md`, `.markdown`, `.pdf`, `.docx`, `.xlsx`.
- Server upload limit: 50MB.
- Local preview limit: 50MB.
- Unsupported extensions, unknown MIME types, executable/compressed files, and risky extension/MIME mismatches are rejected.
- Reader upload does not call `upload-and-embed`, does not write workspace documents, and does not trigger embedding/vector-store/RAG ingestion.

## Frontend Behavior

- LocalStorage keys:
  - `anythingllm_document_reader:v1:${workspaceSlug}:${threadSlug || "default"}`
  - `anythingllm_document_reader_sources:v1:${workspaceSlug}:${threadSlug || "default"}`
- Source types are distinct:
  - `local`
  - `reader_upload`
  - `workspace_parsed`
- Local documents are opened from `File`/`Blob` immediately and are not uploaded automatically.
- A server backup action uploads the current local file to the reader namespace.
- If a local document cannot be restored after refresh, the UI attempts to open the saved `readerDocumentId` backup. If no backup exists, it shows a toast and opens the document drawer.
- Workspace documents open as parsed-only content and show the `解析文本预览` label plus the original-format limitation notice.

## Format MVP

- Markdown: dedicated `ReaderMarkdownRenderer` with stable block IDs, selection quote support, jump, and temporary flash.
- PDF: uses `page + selectedText + textHash` locator semantics. Highlight placement is best-effort; failed jump/highlight shows a toast and does not block chat.
- XLSX: SheetJS workbook parsing, sheet tabs, read-only tables, cell/range selection, Markdown table quote, and `sheetName + range` locator.
- DOCX: Mammoth conversion to semantic body blocks. This is structured reading, not full Word layout reproduction.
- Fallback viewer is not promoted to the core reader path.

## Chat Association

- A `clientGeneratedTurnId` is created before sending.
- Pending document selections are associated to that generated turn ID.
- When a stable `chatId` is available after the assistant turn completes, the local source map is updated with the stable ID.
- Timestamp fallback remains only for last-resort local recovery.

## Validation

- Passed: `cd frontend && yarn lint:check`
- Passed: `cd frontend && NODE_OPTIONS=--max-old-space-size=4096 yarn build`
- Passed: `cd server && npx eslint endpoints/workspaceReaderDocuments.js endpoints/workspaces.js`
- Passed: `cd server && npx jest __tests__/endpoints/workspaceReaderDocuments.test.js --runInBand`
- Passed: `git diff --check`
- Passed: browser smoke test on `http://localhost:3000`; the reader floating button rendered and opened the document drawer.
- Not completed: full `cd server && yarn lint:check`; it produced no output for more than six minutes and was stopped. Focused lint for the new server endpoint passed.

Browser smoke note:

- A runtime `Maximum update depth exceeded` warning was found during the first browser pass. It came from same-route outlet reference churn in `MotionRouteOutlet`, so a narrow `type/key` guard was added. After reload, no fresh update-depth warning was emitted.

## MVP Limitations

- Reader state is localStorage-backed and intentionally MVP-only. Cross-device reader sessions should move to a backend reader session table later.
- Existing workspace documents use parsed-only content; the MVP does not reconstruct missing original PDF/DOCX/XLSX files or pretend to preserve original layout.
- PDF highlight geometry is not guaranteed to be exact in the first version.
- DOCX layout fidelity is intentionally limited to readable structured body content.
- XLSX formula editing, complex styling, and perfect merged-cell reproduction are outside this MVP.
- Source chips are independent from RAG citations; opening a chip assumes the relevant reader document can be restored or reopened.
