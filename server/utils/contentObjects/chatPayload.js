const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  FileStorageProvider,
} = require("../../providers/storage/fileStorageProvider");
const { DataAccessCenter } = require("../dataAccess");
const { compactAgentEvents } = require("../agents/toolResultStore");
const {
  contentObjectError,
  contentObjectLimits,
  contentObjectMode,
  contentObjectWritesEnabled,
  referencePayloadEnabled,
  sha256,
  validateAttachmentBatch,
} = require("./policy");

function safeName(value = "attachment") {
  return path.basename(String(value || "attachment")).slice(0, 255);
}

function safeMime(value = "application/octet-stream") {
  return String(value || "application/octet-stream")
    .trim()
    .slice(0, 160);
}

function truncateUtf8(value, maxBytes) {
  const source = Buffer.from(String(value || ""), "utf8");
  if (source.length <= maxBytes) return source.toString("utf8");
  let end = maxBytes;
  while (end > 0) {
    const candidate = source.subarray(0, end);
    const decoded = candidate.toString("utf8");
    if (Buffer.from(decoded, "utf8").equals(candidate)) return decoded;
    end -= 1;
  }
  return "";
}

function contentUrl(workspaceSlug, attachmentId, kind = "chat-attachments") {
  return `/api/workspace/${encodeURIComponent(workspaceSlug)}/${kind}/${encodeURIComponent(attachmentId)}/content`;
}

function attachmentDescriptor({ refId, object, attachment, workspaceSlug }) {
  return {
    attachmentId: refId,
    name: safeName(attachment.name),
    mime: safeMime(attachment.mime || object.mimeType),
    byteSize: Number(object.plaintextSize),
    sha256: object.plaintextSha256,
    contentUrl: contentUrl(workspaceSlug, refId),
    payloadVersion: 2,
  };
}

async function objectFromCompletedUpload({ attachment, scope }) {
  const uploadId = String(
    attachment.uploadId || attachment.attachmentUploadId || ""
  ).trim();
  const contentObjectId = String(attachment.contentObjectId || "").trim();
  if (!uploadId && !contentObjectId) return null;

  if (uploadId) {
    const object = await DataAccessCenter.contentObject.resolveCompletedUpload({
      uploadId,
      scope,
    });
    if (!object) throw contentObjectError("chat_attachment_upload_not_ready");
    return object;
  }

  const object = await DataAccessCenter.contentObject.resolveCompletedUpload({
    contentObjectId,
    scope,
  });
  if (!object) throw contentObjectError("chat_attachment_upload_not_ready");
  return object;
}

async function prepareChatPayload({ response = {}, scope, workspaceSlug }) {
  if (!contentObjectWritesEnabled()) {
    return {
      response,
      payloadVersion: 1,
      attachments: [],
      contentRefs: [],
    };
  }

  const sourceAttachments = Array.isArray(response?.attachments)
    ? response.attachments
    : [];
  const { decoded } = validateAttachmentBatch(sourceAttachments);
  const preparedAttachments = [];
  const descriptors = [];
  let totalAttachmentBytes = 0;

  for (let ordinal = 0; ordinal < decoded.length; ordinal += 1) {
    const { attachment, decoded: content } = decoded[ordinal];
    let object = await objectFromCompletedUpload({ attachment, scope });
    if (!object && content) {
      object = await DataAccessCenter.contentObject.stageBuffer({
        ownerType: "workspace",
        ownerId: scope.workspaceId,
        domain: "chat-attachment",
        buffer: content.buffer,
        mimeType: safeMime(attachment.mime || content.dataUrlMime),
      });
    }
    if (!object) {
      throw contentObjectError("chat_attachment_content_missing", { ordinal });
    }
    if (Number(object.plaintextSize) > contentObjectLimits().maxFileBytes)
      throw contentObjectError("chat_attachment_too_large", {
        maxBytes: contentObjectLimits().maxFileBytes,
      });
    totalAttachmentBytes += Number(object.plaintextSize);
    if (totalAttachmentBytes > contentObjectLimits().maxTurnBytes)
      throw contentObjectError("chat_attachment_turn_too_large", {
        maxBytes: contentObjectLimits().maxTurnBytes,
      });
    const refId = crypto.randomUUID();
    const descriptor = attachmentDescriptor({
      refId,
      object,
      attachment,
      workspaceSlug,
    });
    descriptors.push(descriptor);
    preparedAttachments.push({
      refId,
      contentObjectId: object.id,
      ordinal,
      name: descriptor.name,
      mime: descriptor.mime,
      byteSize: descriptor.byteSize,
      metadata: {
        wasDataUrl: Boolean(content?.wasDataUrl),
        source: content ? "inline" : "upload",
      },
    });
  }

  const contentRefs = [];
  let nextResponse = { ...(response || {}) };
  if (Array.isArray(nextResponse.agentEvents)) {
    nextResponse.agentEvents = compactAgentEvents(nextResponse.agentEvents);
  }
  const limits = contentObjectLimits();
  const responseText = String(nextResponse.text || "");
  if (Buffer.byteLength(responseText, "utf8") > limits.maxAssistantTextBytes) {
    const object = await DataAccessCenter.contentObject.stageBuffer({
      ownerType: "workspace",
      ownerId: scope.workspaceId,
      domain: "chat-text",
      buffer: Buffer.from(responseText, "utf8"),
      mimeType: "text/plain; charset=utf-8",
    });
    const refId = crypto.randomUUID();
    nextResponse = {
      ...nextResponse,
      text: truncateUtf8(
        responseText,
        Math.min(limits.assistantTextPreviewBytes, limits.maxAssistantTextBytes)
      ),
      truncated: true,
      textRef: {
        refId,
        byteSize: object.plaintextSize,
        sha256: object.plaintextSha256,
        contentUrl: contentUrl(workspaceSlug, refId, "chat-content"),
      },
    };
    contentRefs.push({
      refId,
      contentObjectId: object.id,
      role: "assistant-text",
      jsonPath: "$.text",
    });
  }

  if (referencePayloadEnabled()) {
    nextResponse.attachments = descriptors;
  } else if (contentObjectMode() === "shadow") {
    nextResponse.attachments = sourceAttachments;
  }

  return {
    response: nextResponse,
    payloadVersion: referencePayloadEnabled() ? 2 : 1,
    attachments: preparedAttachments,
    contentRefs,
  };
}

async function hydrateIncomingAttachments({ attachments = [], scope }) {
  const hydrated = [];
  for (const attachment of attachments) {
    if (attachment?.contentString) {
      hydrated.push(attachment);
      continue;
    }
    const object = await objectFromCompletedUpload({ attachment, scope });
    if (!object) throw contentObjectError("chat_attachment_upload_not_ready");
    const plaintext = await DataAccessCenter.contentObject.readWhole(object);
    const mime = safeMime(attachment.mime || object.mimeType);
    hydrated.push({
      ...attachment,
      name: safeName(attachment.name),
      mime,
      contentObjectId: object.id,
      contentString: `data:${mime};base64,${plaintext.toString("base64")}`,
    });
  }
  return hydrated;
}

async function hydrateChatPayload(chat, { attachmentMode = "inline" } = {}) {
  if (!chat || Number(chat.payloadVersion || 1) < 2) return chat;
  let response;
  try {
    response = JSON.parse(chat.response);
  } catch {
    return chat;
  }
  const { refs, objects } =
    await DataAccessCenter.contentObject.payloadReferences(chat.id);
  const byId = new Map(objects.map((object) => [object.id, object]));
  const current = Array.isArray(response.attachments)
    ? response.attachments
    : [];
  const attachments = [];
  for (let ordinal = 0; ordinal < refs.length; ordinal += 1) {
    const ref = refs[ordinal];
    const object = byId.get(ref.contentObjectId);
    if (!object) continue;
    const metadata = ref.metadataJson ? JSON.parse(ref.metadataJson) : {};
    const descriptor = {
      ...(current[ordinal] || {}),
      attachmentId: ref.id,
      name: ref.displayName,
      mime: ref.mimeType,
      byteSize: ref.byteSize,
    };
    if (attachmentMode === "inline") {
      const plaintext = await DataAccessCenter.contentObject.readWhole(object);
      const encoded = plaintext.toString("base64");
      descriptor.contentString = metadata.wasDataUrl
        ? `data:${ref.mimeType};base64,${encoded}`
        : encoded;
    }
    attachments.push(descriptor);
  }
  response.attachments = attachments;

  if (response.truncated && response.textRef && attachmentMode === "inline") {
    const resolved =
      await DataAccessCenter.contentObject.contentReferenceObject(
        response.textRef.refId
      );
    if (resolved?.object) {
      response.text = (
        await DataAccessCenter.contentObject.readWhole(resolved.object)
      ).toString("utf8");
    }
  }
  return { ...chat, response: JSON.stringify(response) };
}

async function hydrateChatPayloads(chats = [], options = {}) {
  const output = [];
  for (const chat of chats)
    output.push(await hydrateChatPayload(chat, options));
  return output;
}

function uploadDirectory(uploadId) {
  return FileStorageProvider.resolvePath(
    path.join("uploads", "chat-attachments", String(uploadId))
  );
}

function uploadPartPath(uploadId, partNumber, digest) {
  return path.join(
    uploadDirectory(uploadId),
    `${Number(partNumber)}.${String(digest)}.part`
  );
}

async function persistUploadPart({ uploadId, partNumber, digest, buffer }) {
  const target = uploadPartPath(uploadId, partNumber, digest);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.promises.writeFile(target, buffer, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await fs.promises.readFile(target);
    if (sha256(existing) !== digest)
      throw contentObjectError("chat_attachment_part_collision");
  }
  return target;
}

async function createUpload({
  workspaceId,
  userId,
  name,
  mime,
  size,
  sha256: digest,
}) {
  const limits = contentObjectLimits();
  const expectedSize = size == null ? null : Number(size);
  if (expectedSize != null && expectedSize > limits.maxFileBytes)
    throw contentObjectError("chat_attachment_too_large", {
      maxBytes: limits.maxFileBytes,
    });
  const id = crypto.randomUUID();
  await fs.promises.mkdir(uploadDirectory(id), { recursive: true });
  return DataAccessCenter.contentObject.createUpload({
    id,
    workspaceId: Number(workspaceId),
    userId: userId == null ? null : Number(userId),
    displayName: safeName(name),
    mimeType: safeMime(mime),
    expectedSize,
    expectedSha256: digest ? String(digest).toLowerCase() : null,
    expiresAt: new Date(Date.now() + limits.uploadTtlMs),
  });
}

async function putUploadPart({
  uploadId,
  workspaceId,
  userId,
  partNumber,
  body,
}) {
  const upload = await DataAccessCenter.contentObject.pendingUpload({
    uploadId,
    workspaceId,
    userId,
  });
  if (!upload) throw contentObjectError("chat_attachment_upload_not_found");
  const part = Number(partNumber);
  if (!Number.isInteger(part) || part < 1 || part > 10_000)
    throw contentObjectError("chat_attachment_part_invalid");
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || "");
  if (!buffer.length || buffer.length > contentObjectLimits().uploadPartBytes)
    throw contentObjectError("chat_attachment_part_too_large", {
      maxBytes: contentObjectLimits().uploadPartBytes,
    });
  const digest = sha256(buffer);
  await persistUploadPart({
    uploadId: upload.id,
    partNumber: part,
    digest,
    buffer,
  });
  const { receivedBytes } =
    await DataAccessCenter.contentObject.recordUploadPart({
      uploadId: upload.id,
      partNumber: part,
      byteSize: buffer.length,
      digest,
      maxBytes: contentObjectLimits().maxFileBytes,
    });
  return { partNumber: part, bytes: buffer.length, receivedBytes };
}

async function completeUpload({ uploadId, workspaceId, userId }) {
  const upload = await DataAccessCenter.contentObject.completableUpload({
    uploadId,
    workspaceId,
    userId,
  });
  if (!upload) throw contentObjectError("chat_attachment_upload_not_found");
  if (upload.status === "completed") return upload;
  const storedParts = await DataAccessCenter.contentObject.uploadParts(
    upload.id
  );
  const parts = storedParts.length
    ? storedParts.map((entry) => ({
        partNumber: entry.partNumber,
        bytes: entry.byteSize,
        sha256: entry.sha256,
      }))
    : JSON.parse(upload.partsJson || "[]").sort(
        (a, b) => a.partNumber - b.partNumber
      );
  if (
    !parts.length ||
    parts.some((entry, index) => entry.partNumber !== index + 1)
  )
    throw contentObjectError("chat_attachment_parts_incomplete");
  const filePaths = [];
  const combinedHash = crypto.createHash("sha256");
  let receivedBytes = 0;
  for (const entry of parts) {
    const filePath = uploadPartPath(upload.id, entry.partNumber, entry.sha256);
    const partHash = crypto.createHash("sha256");
    let partBytes = 0;
    for await (const value of fs.createReadStream(filePath)) {
      const chunk = Buffer.from(value);
      partHash.update(chunk);
      combinedHash.update(chunk);
      partBytes += chunk.length;
      receivedBytes += chunk.length;
    }
    if (partHash.digest("hex") !== entry.sha256 || partBytes !== entry.bytes)
      throw contentObjectError("chat_attachment_part_checksum_mismatch");
    filePaths.push(filePath);
  }
  const plaintextSha256 = combinedHash.digest("hex");
  if (upload.expectedSize != null && upload.expectedSize !== receivedBytes)
    throw contentObjectError("chat_attachment_size_mismatch");
  if (upload.expectedSha256 && upload.expectedSha256 !== plaintextSha256)
    throw contentObjectError("chat_attachment_checksum_mismatch");
  const object = await DataAccessCenter.contentObject.stageFileParts({
    ownerType: "workspace",
    ownerId: upload.workspaceId,
    domain: "chat-attachment",
    filePaths,
    plaintextSize: receivedBytes,
    plaintextSha256,
    mimeType: upload.mimeType,
  });
  const completed = await DataAccessCenter.contentObject.markUploadCompleted(
    upload.id,
    {
      contentObjectId: object.id,
      receivedBytes,
    }
  );
  await fs.promises.rm(uploadDirectory(upload.id), {
    recursive: true,
    force: true,
  });
  return completed;
}

module.exports = {
  completeUpload,
  contentUrl,
  createUpload,
  hydrateChatPayload,
  hydrateChatPayloads,
  hydrateIncomingAttachments,
  prepareChatPayload,
  putUploadPart,
  truncateUtf8,
};
