import test from "node:test";
import assert from "node:assert/strict";
import {
  GLOBAL_READER_RESOURCE_SEGMENT,
  normalizeReaderDocumentLinks,
  normalizeReaderStorageItemLinks,
  readerAccessDescriptorForDocument,
  readerAccessDescriptorFromUrl,
  readerSessionMatchesDescriptor,
} from "./readerLinkMaintenance.js";

const DOCUMENT_ID = "89fff05b-c405-44ab-b4d7-97eb3ecd1c34";
const WORKSPACE_SLUG = "f57f6abb-56e7-4ec7-a423-1d844271cea4";

test("old global reader URL with workspace slug normalizes to workspace URL", () => {
  const normalized = normalizeReaderDocumentLinks({
    success: true,
    readerDocumentId: DOCUMENT_ID,
    metadata: {
      readerDocumentId: DOCUMENT_ID,
      readerDocumentWorkspaceSlug: WORKSPACE_SLUG,
      originalName: "艾略特波浪理论：市场行为的关键.pdf",
      originalUrl: `/api/reader-documents/${DOCUMENT_ID}/original`,
      stream: {
        url: `/api/reader-documents/${DOCUMENT_ID}/original`,
      },
    },
  });

  assert.equal(
    normalized.metadata.originalUrl,
    `/api/workspace/${WORKSPACE_SLUG}/reader-documents/${DOCUMENT_ID}/original`
  );
  assert.equal(
    normalized.metadata.stream.url,
    `/api/workspace/${WORKSPACE_SLUG}/reader-documents/${DOCUMENT_ID}/original`
  );
  assert.equal(
    normalized.metadata.thumbnailUrl,
    `/api/workspace/${WORKSPACE_SLUG}/reader-documents/${DOCUMENT_ID}/thumbnail.jpg`
  );
  assert.equal(
    normalized.metadata.previewPdfUrl,
    `/api/workspace/${WORKSPACE_SLUG}/reader-documents/${DOCUMENT_ID}/preview.pdf`
  );
  assert.equal(normalized.readerDocumentWorkspaceSlug, WORKSPACE_SLUG);
});

test("standalone/global reader document remains on global URL namespace", () => {
  const normalized = normalizeReaderDocumentLinks({
    success: true,
    readerDocumentId: DOCUMENT_ID,
    metadata: {
      readerDocumentId: DOCUMENT_ID,
      originalName: "Standalone.pdf",
      originalUrl: `/api/reader-documents/${DOCUMENT_ID}/original`,
    },
  });

  assert.equal(
    normalized.metadata.originalUrl,
    `/api/reader-documents/${DOCUMENT_ID}/original`
  );
  assert.equal(
    normalized.metadata.stream.url,
    `/api/reader-documents/${DOCUMENT_ID}/original`
  );
  assert.equal(normalized.readerDocumentWorkspaceSlug, null);
});

test("storage item only normalizes to workspace URL when workspace evidence exists", () => {
  const normalizedWorkspaceItem = normalizeReaderStorageItemLinks({
    title: "Workspace Book",
    readerDocumentId: DOCUMENT_ID,
    readerDocumentWorkspaceSlug: WORKSPACE_SLUG,
    metadata: {
      originalUrl: `/api/reader-documents/${DOCUMENT_ID}/original`,
    },
  });

  assert.equal(
    normalizedWorkspaceItem.metadata.originalUrl,
    `/api/workspace/${WORKSPACE_SLUG}/reader-documents/${DOCUMENT_ID}/original`
  );

  const normalizedStandaloneItem = normalizeReaderStorageItemLinks(
    {
      title: "Standalone Book",
      readerDocumentId: DOCUMENT_ID,
      metadata: {
        originalUrl: `/api/reader-documents/${DOCUMENT_ID}/original`,
      },
    },
    WORKSPACE_SLUG
  );

  assert.equal(
    normalizedStandaloneItem.metadata.originalUrl,
    `/api/reader-documents/${DOCUMENT_ID}/original`
  );
});

test("reader access descriptor matches sensitive session namespace exactly", () => {
  const workspaceDescriptor = readerAccessDescriptorForDocument({
    metadata: {
      readerDocumentId: DOCUMENT_ID,
      readerDocumentWorkspaceSlug: WORKSPACE_SLUG,
    },
  });
  const globalDescriptor = readerAccessDescriptorFromUrl(
    `/api/reader-documents/${DOCUMENT_ID}/original`
  );

  assert.equal(
    workspaceDescriptor.resourceId,
    `${WORKSPACE_SLUG}:${DOCUMENT_ID}`
  );
  assert.equal(
    workspaceDescriptor.ownerScope,
    `workspace:${WORKSPACE_SLUG}:reader`
  );
  assert.equal(
    globalDescriptor.resourceId,
    `${GLOBAL_READER_RESOURCE_SEGMENT}:${DOCUMENT_ID}`
  );
  assert.equal(globalDescriptor.ownerScope, "reader:standalone");

  const workspaceSession = {
    token: "secret",
    resourceType: "reader_document",
    resourceId: `${WORKSPACE_SLUG}:${DOCUMENT_ID}`,
    ownerScope: `workspace:${WORKSPACE_SLUG}:reader`,
  };
  const globalSession = {
    token: "secret",
    resourceType: "reader_document",
    resourceId: `${GLOBAL_READER_RESOURCE_SEGMENT}:${DOCUMENT_ID}`,
    ownerScope: "reader:standalone",
  };

  assert.equal(
    readerSessionMatchesDescriptor(workspaceSession, workspaceDescriptor),
    true
  );
  assert.equal(
    readerSessionMatchesDescriptor(workspaceSession, globalDescriptor),
    false
  );
  assert.equal(
    readerSessionMatchesDescriptor(globalSession, workspaceDescriptor),
    false
  );
  assert.equal(
    readerSessionMatchesDescriptor(globalSession, globalDescriptor),
    true
  );
});
