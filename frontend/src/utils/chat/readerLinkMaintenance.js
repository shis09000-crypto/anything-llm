export const GLOBAL_READER_RESOURCE_SEGMENT = "__global_reader__";
export const READER_DOCUMENT_RESOURCE_TYPE = "reader_document";

export function readerDocumentIdFromUrl(url = "") {
  const match = String(url || "").match(
    /\/reader-documents\/([0-9a-f-]{36})(?:\/|$)/i
  );
  return match?.[1] || null;
}

export function readerWorkspaceSlugFromOwnerScope(ownerScope = "") {
  const match = String(ownerScope || "").match(/^workspace:(.+):reader$/);
  return match?.[1] || null;
}

export function parseReaderDocumentUrl(url = "") {
  const text = String(url || "");
  const workspaceMatch = text.match(
    /(?:\/api)?\/workspace\/([^/?#]+)\/reader-documents\/([0-9a-f-]{36})(?:\/|$)/i
  );
  if (workspaceMatch) {
    return {
      readerDocumentId: workspaceMatch[2],
      workspaceSlug: decodeURIComponent(workspaceMatch[1]),
      namespace: "workspace",
    };
  }
  const readerDocumentId = readerDocumentIdFromUrl(text);
  if (!readerDocumentId) return null;
  return {
    readerDocumentId,
    workspaceSlug: null,
    namespace: "standalone",
  };
}

function readerApiPrefix(workspaceSlug = null) {
  return workspaceSlug
    ? `/api/workspace/${encodeURIComponent(workspaceSlug)}/reader-documents`
    : "/api/reader-documents";
}

function canonicalReaderUrls(readerDocumentId, workspaceSlug = null) {
  if (!readerDocumentId) return {};
  const prefix = readerApiPrefix(workspaceSlug);
  const base = `${prefix}/${readerDocumentId}`;
  return {
    apiPrefix: prefix,
    originalUrl: `${base}/original`,
    pagePreviewUrl: `${base}/page-preview?page=1`,
    previewPdfUrl: `${base}/preview-pdf`,
    thumbnailUrl: `${base}/thumbnail`,
  };
}

function workspaceSlugFromDocument(documentData = {}) {
  const metadata =
    documentData?.metadata && typeof documentData.metadata === "object"
      ? documentData.metadata
      : documentData || {};
  const session =
    documentData?.sensitiveSession || metadata?.sensitiveSession || null;
  const ownerWorkspaceSlug = readerWorkspaceSlugFromOwnerScope(
    session?.ownerScope || metadata?.ownerScope || documentData?.ownerScope
  );
  if (ownerWorkspaceSlug) return ownerWorkspaceSlug;
  if (
    (session?.ownerScope ||
      metadata?.ownerScope ||
      documentData?.ownerScope) === "reader:standalone"
  )
    return null;
  return (
    metadata.readerDocumentWorkspaceSlug ||
    documentData.readerDocumentWorkspaceSlug ||
    documentData.workspaceSlug ||
    parseReaderDocumentUrl(metadata.originalUrl)?.workspaceSlug ||
    parseReaderDocumentUrl(metadata.stream?.url)?.workspaceSlug ||
    parseReaderDocumentUrl(metadata.stream?.streamUrl)?.workspaceSlug ||
    null
  );
}

function readerDocumentIdFromDocument(documentData = {}, fallbackId = null) {
  const metadata =
    documentData?.metadata && typeof documentData.metadata === "object"
      ? documentData.metadata
      : documentData || {};
  return (
    fallbackId ||
    metadata.readerDocumentId ||
    documentData.readerDocumentId ||
    parseReaderDocumentUrl(metadata.originalUrl)?.readerDocumentId ||
    parseReaderDocumentUrl(metadata.stream?.url)?.readerDocumentId ||
    parseReaderDocumentUrl(metadata.stream?.streamUrl)?.readerDocumentId ||
    null
  );
}

export function readerAccessDescriptorForDocument(
  documentData = {},
  fallbackId = null
) {
  const metadata =
    documentData?.metadata && typeof documentData.metadata === "object"
      ? documentData.metadata
      : documentData || {};
  const session =
    documentData?.sensitiveSession || metadata?.sensitiveSession || null;
  const readerDocumentId = readerDocumentIdFromDocument(
    documentData,
    fallbackId
  );
  if (!readerDocumentId) return null;
  const workspaceSlug = workspaceSlugFromDocument(documentData);
  const urls = canonicalReaderUrls(readerDocumentId, workspaceSlug);
  const ownerScope =
    session?.ownerScope ||
    (workspaceSlug ? `workspace:${workspaceSlug}:reader` : "reader:standalone");
  const resourceId =
    session?.resourceId ||
    (workspaceSlug
      ? `${workspaceSlug}:${readerDocumentId}`
      : `${GLOBAL_READER_RESOURCE_SEGMENT}:${readerDocumentId}`);
  return {
    readerDocumentId,
    workspaceSlug,
    apiPrefix: urls.apiPrefix,
    originalUrl: urls.originalUrl,
    pagePreviewUrl: urls.pagePreviewUrl,
    previewPdfUrl: urls.previewPdfUrl,
    thumbnailUrl: urls.thumbnailUrl,
    stream: {
      ...(metadata.stream || {}),
      url: urls.originalUrl,
      streamUrl: urls.originalUrl,
    },
    ownerScope,
    resourceType: READER_DOCUMENT_RESOURCE_TYPE,
    resourceId,
  };
}

export function readerAccessDescriptorFromUrl(url = "") {
  const parsed = parseReaderDocumentUrl(url);
  if (!parsed?.readerDocumentId) return null;
  return readerAccessDescriptorForDocument({
    metadata: {
      readerDocumentId: parsed.readerDocumentId,
      readerDocumentWorkspaceSlug: parsed.workspaceSlug || null,
      originalUrl: url,
    },
  });
}

export function readerSessionMatchesDescriptor(
  session = null,
  descriptor = null
) {
  if (!session?.token || !descriptor?.readerDocumentId) return false;
  if (
    session.resourceType &&
    session.resourceType !== READER_DOCUMENT_RESOURCE_TYPE
  )
    return false;
  if (session.ownerScope && session.ownerScope !== descriptor.ownerScope)
    return false;
  if (session.resourceId && session.resourceId !== descriptor.resourceId) {
    const workspaceResourceForSameDocument =
      descriptor.workspaceSlug &&
      String(session.resourceId).endsWith(`:${descriptor.readerDocumentId}`);
    if (!workspaceResourceForSameDocument) return false;
  }
  return true;
}

export function normalizeReaderDocumentLinks(documentData = {}, options = {}) {
  if (!documentData || typeof documentData !== "object") return documentData;
  const metadata =
    documentData.metadata && typeof documentData.metadata === "object"
      ? documentData.metadata
      : {};
  const descriptor = readerAccessDescriptorForDocument(
    {
      ...documentData,
      metadata: {
        ...metadata,
        readerDocumentId:
          metadata.readerDocumentId ||
          documentData.readerDocumentId ||
          options.readerDocumentId,
        readerDocumentWorkspaceSlug:
          metadata.readerDocumentWorkspaceSlug ||
          documentData.readerDocumentWorkspaceSlug ||
          options.workspaceSlug ||
          null,
      },
    },
    options.readerDocumentId
  );
  if (!descriptor) return documentData;
  const nextMetadata = {
    ...metadata,
    readerDocumentId: descriptor.readerDocumentId,
    readerDocumentWorkspaceSlug: descriptor.workspaceSlug || null,
    originalUrl: descriptor.originalUrl,
    pagePreviewUrl: descriptor.pagePreviewUrl,
    previewPdfUrl: descriptor.previewPdfUrl,
    thumbnailUrl: descriptor.thumbnailUrl,
    stream: descriptor.stream,
  };
  return {
    ...documentData,
    readerDocumentId:
      documentData.readerDocumentId || descriptor.readerDocumentId,
    readerDocumentWorkspaceSlug: descriptor.workspaceSlug || null,
    metadata: nextMetadata,
  };
}

export function normalizeReaderStorageItemLinks(
  item = {},
  workspaceSlug = null
) {
  void workspaceSlug;
  if (!item || typeof item !== "object") return item;
  const readerDocumentId = item.readerDocumentId || item.backupReaderDocumentId;
  if (!readerDocumentId) return item;
  const knownWorkspaceSlug =
    item.readerDocumentWorkspaceSlug ||
    item.workspaceSlug ||
    item.metadata?.readerDocumentWorkspaceSlug ||
    null;
  const normalized = normalizeReaderDocumentLinks(
    {
      ...item,
      metadata: {
        ...(item.metadata || {}),
        readerDocumentId,
        readerDocumentWorkspaceSlug: knownWorkspaceSlug,
      },
    },
    { readerDocumentId, workspaceSlug: knownWorkspaceSlug }
  );
  return {
    ...item,
    readerDocumentWorkspaceSlug: normalized.readerDocumentWorkspaceSlug || null,
    metadata: normalized.metadata,
    thumbnailUrl:
      item.thumbnailUrl || normalized.metadata?.thumbnailUrl || null,
  };
}
