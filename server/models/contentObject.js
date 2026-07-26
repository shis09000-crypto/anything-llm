const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const prisma = require("../utils/prisma");
const {
  contentObjectProvider,
} = require("../providers/storage/contentObjectProvider");
const {
  decryptContentRange,
  encryptContentBuffer,
  encryptContentFileParts,
  encryptedRangeForPlaintext,
  parseHeader,
} = require("../utils/contentObjects/crypto");
const {
  contentObjectLimits,
  contentStoreProvider,
  sha256,
} = require("../utils/contentObjects/policy");
const { resolveActiveKey } = require("../utils/security/keyCustody");
const {
  queueUserDomainWrap,
} = require("../utils/security/userDomainWrapService");
const { metrics } = require("../utils/observability/metrics");
const {
  FileStorageProvider,
} = require("../providers/storage/fileStorageProvider");

const OBJECT_DOMAIN = "chat-attachment";
const TEXT_DOMAIN = "chat-text";

function scopedIdentity({ ownerType, ownerId, domain }) {
  return `${ownerType}:${ownerId}:${domain}`;
}

function dedupeKeyFor({ ownerType, ownerId, domain, plaintextSha256 }) {
  const active = resolveActiveKey();
  if (!active?.material) {
    const error = new Error("content_object_key_unavailable");
    error.code = "CONTENT_OBJECT_KEY_UNAVAILABLE";
    throw error;
  }
  const scope = scopedIdentity({ ownerType, ownerId, domain });
  const derived = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      active.material,
      Buffer.from("athena-content-object-dedupe:v1", "utf8"),
      Buffer.from(scope, "utf8"),
      32
    )
  );
  return crypto
    .createHmac("sha256", derived)
    .update(plaintextSha256)
    .digest("hex");
}

function objectKeyFor({ domain, scopeHash, dedupeKey, objectId }) {
  return path.posix.join(
    "v1",
    domain,
    scopeHash,
    dedupeKey.slice(0, 2),
    `${objectId}.athobj`
  );
}

function parseMetadata(row) {
  try {
    return JSON.parse(row.encryptionMetadataJson);
  } catch {
    const error = new Error("content_object_metadata_invalid");
    error.code = "CONTENT_OBJECT_METADATA_INVALID";
    throw error;
  }
}

function uniqueWhere({ ownerType, ownerId, domain, dedupeKey }) {
  return {
    ownerType_ownerId_domain_dedupeKey: {
      ownerType,
      ownerId,
      domain,
      dedupeKey,
    },
  };
}

const ContentObject = {
  OBJECT_DOMAIN,
  TEXT_DOMAIN,

  async resolveCompletedUpload({
    uploadId = null,
    contentObjectId = null,
    scope,
  }) {
    const upload = await prisma.chat_attachment_uploads.findFirst({
      where: {
        ...(uploadId
          ? { id: String(uploadId) }
          : { contentObjectId: String(contentObjectId) }),
        workspaceId: Number(scope.workspaceId),
        userId: scope.userId == null ? null : Number(scope.userId),
        status: "completed",
      },
    });
    if (!upload?.contentObjectId) return null;
    return prisma.content_objects.findFirst({
      where: {
        id: upload.contentObjectId,
        ownerType: "workspace",
        ownerId: String(scope.workspaceId),
        domain: OBJECT_DOMAIN,
        state: { in: ["staging", "ready"] },
      },
    });
  },

  async payloadReferences(chatId) {
    const refs = await prisma.workspace_chat_attachment_refs.findMany({
      where: { chatId: Number(chatId) },
      orderBy: { ordinal: "asc" },
    });
    const objects = refs.length
      ? await prisma.content_objects.findMany({
          where: { id: { in: refs.map((ref) => ref.contentObjectId) } },
        })
      : [];
    return { refs, objects };
  },

  async contentReferenceObject(refId) {
    const ref = await prisma.workspace_chat_content_refs.findUnique({
      where: { id: String(refId) },
    });
    if (!ref) return null;
    const object = await prisma.content_objects.findUnique({
      where: { id: ref.contentObjectId },
    });
    return object ? { ref, object } : null;
  },

  async createUpload(data) {
    return prisma.chat_attachment_uploads.create({ data });
  },

  async pendingUpload({ uploadId, workspaceId, userId }) {
    return prisma.chat_attachment_uploads.findFirst({
      where: {
        id: String(uploadId),
        workspaceId: Number(workspaceId),
        userId: userId == null ? null : Number(userId),
        status: "pending",
        expiresAt: { gt: new Date() },
      },
    });
  },

  async recordUploadPart({ uploadId, partNumber, byteSize, digest, maxBytes }) {
    return prisma.$transaction(async (tx) => {
      await tx.chat_attachment_upload_parts.upsert({
        where: { uploadId_partNumber: { uploadId, partNumber } },
        create: {
          uploadId,
          partNumber,
          byteSize,
          sha256: digest,
        },
        update: { byteSize, sha256: digest, updatedAt: new Date() },
      });
      const parts = await tx.chat_attachment_upload_parts.findMany({
        where: { uploadId },
        orderBy: { partNumber: "asc" },
      });
      const receivedBytes = parts.reduce(
        (sum, entry) => sum + entry.byteSize,
        0
      );
      if (receivedBytes > maxBytes) {
        const error = new Error("chat_attachment_too_large");
        error.code = "chat_attachment_too_large";
        error.details = { maxBytes };
        throw error;
      }
      await tx.chat_attachment_uploads.update({
        where: { id: uploadId },
        data: {
          partsJson: JSON.stringify(
            parts.map((entry) => ({
              partNumber: entry.partNumber,
              bytes: entry.byteSize,
              sha256: entry.sha256,
            }))
          ),
          receivedBytes,
          updatedAt: new Date(),
        },
      });
      return { parts, receivedBytes };
    });
  },

  async completableUpload({ uploadId, workspaceId, userId }) {
    return prisma.chat_attachment_uploads.findFirst({
      where: {
        id: String(uploadId),
        workspaceId: Number(workspaceId),
        userId: userId == null ? null : Number(userId),
        status: { in: ["pending", "completed"] },
        expiresAt: { gt: new Date() },
      },
    });
  },

  async uploadParts(uploadId) {
    return prisma.chat_attachment_upload_parts.findMany({
      where: { uploadId: String(uploadId) },
      orderBy: { partNumber: "asc" },
    });
  },

  async markUploadCompleted(uploadId, { contentObjectId, receivedBytes }) {
    return prisma.chat_attachment_uploads.update({
      where: { id: String(uploadId) },
      data: {
        contentObjectId,
        receivedBytes,
        status: "completed",
        completedAt: new Date(),
        updatedAt: new Date(),
      },
    });
  },

  async stageBuffer({
    ownerType = "workspace",
    ownerId,
    domain = OBJECT_DOMAIN,
    buffer,
    mimeType = "application/octet-stream",
  }) {
    const plaintext = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const plaintextSha256 = sha256(plaintext);
    const normalizedOwnerId = String(ownerId);
    const dedupeKey = dedupeKeyFor({
      ownerType,
      ownerId: normalizedOwnerId,
      domain,
      plaintextSha256,
    });
    const where = uniqueWhere({
      ownerType,
      ownerId: normalizedOwnerId,
      domain,
      dedupeKey,
    });
    const existing = await prisma.content_objects.findUnique({ where });
    if (existing && !["corrupt", "deleted"].includes(existing.state)) {
      const stat = await contentObjectProvider(existing.provider).stat({
        objectKey: existing.objectKey,
      });
      if (stat.exists) {
        metrics.contentObjectOperations.inc({
          operation: "stage",
          outcome: "deduplicated",
          provider: existing.provider,
        });
        return existing;
      }
      await prisma.content_objects.update({
        where: { id: existing.id },
        data: { state: "corrupt" },
      });
    }

    // Repair a corrupt dedupe winner in place. Keeping the same object id
    // preserves any valid references while replacing only missing/corrupt
    // storage metadata.
    const objectId = existing?.id || crypto.randomUUID();
    const scopeHash = sha256(
      scopedIdentity({ ownerType, ownerId: normalizedOwnerId, domain })
    );
    const objectKey = objectKeyFor({
      domain,
      scopeHash,
      dedupeKey,
      objectId,
    });
    const encrypted = encryptContentBuffer({
      objectId,
      plaintext,
      chunkSize: contentObjectLimits().chunkBytes,
    });
    const providerName = contentStoreProvider();
    const provider = contentObjectProvider(providerName);
    await provider.putImmutable({
      objectKey,
      body: encrypted.encrypted,
      ciphertextSha256: encrypted.ciphertextSha256,
    });
    metrics.contentObjectBytes.inc(
      { direction: "write", domain },
      plaintext.length
    );
    metrics.contentObjectOperations.inc({
      operation: "stage",
      outcome: "stored",
      provider: providerName,
    });

    try {
      const data = {
        ownerType,
        ownerId: normalizedOwnerId,
        domain,
        scopeHash,
        dedupeKey,
        plaintextSha256,
        plaintextSize: plaintext.length,
        mimeType,
        provider: providerName,
        objectKey,
        ciphertextSha256: encrypted.ciphertextSha256,
        encryptionVersion: encrypted.metadata.version,
        wrappedDek: encrypted.wrappedDek,
        encryptionMetadataJson: JSON.stringify(encrypted.metadata),
        state: Number(existing?.refCount || 0) > 0 ? "ready" : "staging",
        deletedAt: null,
        deleteAfter: null,
        ...(Number(existing?.refCount || 0) > 0 ? { readyAt: new Date() } : {}),
      };
      if (existing) {
        return await prisma.content_objects.update({
          where: { id: existing.id },
          data,
        });
      }
      return await prisma.content_objects.create({
        data: {
          id: objectId,
          ...data,
        },
      });
    } catch (error) {
      if (error?.code !== "P2002") throw error;
      await provider.delete({ objectKey }).catch(() => null);
      const winner = await prisma.content_objects.findUnique({ where });
      if (!winner) throw error;
      const stat = await contentObjectProvider(winner.provider).stat({
        objectKey: winner.objectKey,
      });
      if (!stat.exists) {
        await prisma.content_objects.update({
          where: { id: winner.id },
          data: { state: "corrupt" },
        });
        return this.stageBuffer({
          ownerType,
          ownerId: normalizedOwnerId,
          domain,
          buffer: plaintext,
          mimeType,
        });
      }
      return winner;
    }
  },

  async stageFileParts({
    ownerType = "workspace",
    ownerId,
    domain = OBJECT_DOMAIN,
    filePaths,
    plaintextSize,
    plaintextSha256,
    mimeType = "application/octet-stream",
  }) {
    const normalizedOwnerId = String(ownerId);
    const dedupeKey = dedupeKeyFor({
      ownerType,
      ownerId: normalizedOwnerId,
      domain,
      plaintextSha256,
    });
    const where = uniqueWhere({
      ownerType,
      ownerId: normalizedOwnerId,
      domain,
      dedupeKey,
    });
    const existing = await prisma.content_objects.findUnique({ where });
    if (existing && !["corrupt", "deleted"].includes(existing.state)) {
      const stat = await contentObjectProvider(existing.provider).stat({
        objectKey: existing.objectKey,
      });
      if (stat.exists) {
        metrics.contentObjectOperations.inc({
          operation: "stage",
          outcome: "deduplicated",
          provider: existing.provider,
        });
        return existing;
      }
      await prisma.content_objects.update({
        where: { id: existing.id },
        data: { state: "corrupt" },
      });
    }
    const objectId = existing?.id || crypto.randomUUID();
    const scopeHash = sha256(
      scopedIdentity({ ownerType, ownerId: normalizedOwnerId, domain })
    );
    const objectKey = objectKeyFor({
      domain,
      scopeHash,
      dedupeKey,
      objectId,
    });
    const temporaryRoot = FileStorageProvider.resolvePath(
      path.join("tmp", "content-object-encryption")
    );
    await fs.promises.mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    const temporaryDirectory = await fs.promises.mkdtemp(
      path.join(temporaryRoot, "stage-")
    );
    const encryptedPath = path.join(temporaryDirectory, `${objectId}.athobj`);
    const providerName = contentStoreProvider();
    const provider = contentObjectProvider(providerName);
    let stored = null;
    try {
      const encrypted = await encryptContentFileParts({
        objectId,
        filePaths,
        plaintextSize: Number(plaintextSize),
        chunkSize: contentObjectLimits().chunkBytes,
        outputPath: encryptedPath,
      });
      stored = await provider.putImmutableFile({
        objectKey,
        sourcePath: encryptedPath,
        ciphertextSha256: encrypted.ciphertextSha256,
      });
      const data = {
        ownerType,
        ownerId: normalizedOwnerId,
        domain,
        scopeHash,
        dedupeKey,
        plaintextSha256,
        plaintextSize: Number(plaintextSize),
        mimeType,
        provider: providerName,
        objectKey,
        ciphertextSha256: encrypted.ciphertextSha256,
        encryptionVersion: encrypted.metadata.version,
        wrappedDek: encrypted.wrappedDek,
        encryptionMetadataJson: JSON.stringify(encrypted.metadata),
        state: Number(existing?.refCount || 0) > 0 ? "ready" : "staging",
        deletedAt: null,
        deleteAfter: null,
        ...(Number(existing?.refCount || 0) > 0 ? { readyAt: new Date() } : {}),
      };
      const row = existing
        ? await prisma.content_objects.update({
            where: { id: existing.id },
            data,
          })
        : await prisma.content_objects.create({
            data: { id: objectId, ...data },
          });
      metrics.contentObjectBytes.inc(
        { direction: "write", domain },
        Number(plaintextSize)
      );
      metrics.contentObjectOperations.inc({
        operation: "stage",
        outcome: "stored_streaming",
        provider: providerName,
      });
      return row;
    } catch (error) {
      if (stored?.created)
        await provider.delete({ objectKey }).catch(() => null);
      if (error?.code !== "P2002") throw error;
      const winner = await prisma.content_objects.findUnique({ where });
      if (!winner) throw error;
      return winner;
    } finally {
      await fs.promises.rm(temporaryDirectory, {
        recursive: true,
        force: true,
      });
    }
  },

  async attachToChat(tx, { chatId, attachments = [], contentRefs = [] }) {
    const objectIds = [];
    for (const attachment of attachments) {
      await tx.workspace_chat_attachment_refs.create({
        data: {
          id: attachment.refId,
          chatId: Number(chatId),
          contentObjectId: attachment.contentObjectId,
          ordinal: attachment.ordinal,
          displayName: attachment.name,
          mimeType: attachment.mime,
          byteSize: attachment.byteSize,
          metadataJson: JSON.stringify(attachment.metadata || {}),
        },
      });
      objectIds.push(attachment.contentObjectId);
    }
    for (const contentRef of contentRefs) {
      await tx.workspace_chat_content_refs.create({
        data: {
          id: contentRef.refId,
          chatId: Number(chatId),
          contentObjectId: contentRef.contentObjectId,
          role: contentRef.role,
          jsonPath: contentRef.jsonPath,
        },
      });
      objectIds.push(contentRef.contentObjectId);
    }
    const uniqueObjectIds = [...new Set(objectIds)];
    for (const objectId of uniqueObjectIds) {
      const increments = objectIds.filter((id) => id === objectId).length;
      await tx.content_objects.update({
        where: { id: objectId },
        data: {
          state: "ready",
          readyAt: new Date(),
          deleteAfter: null,
          refCount: { increment: increments },
        },
      });
    }
    if (!uniqueObjectIds.length) return;
    if (
      typeof tx.workspace_chats?.findUnique !== "function" ||
      typeof tx.users?.findUnique !== "function" ||
      typeof tx.user_domain_key_wraps?.upsert !== "function"
    )
      return;
    const chat = await tx.workspace_chats.findUnique({
      where: { id: Number(chatId) },
      select: { user_id: true },
    });
    if (!chat?.user_id) return;
    const user = await tx.users.findUnique({
      where: { id: Number(chat.user_id) },
      select: { id: true, authUserId: true },
    });
    if (!user?.authUserId) return;
    const objects = await tx.content_objects.findMany({
      where: { id: { in: uniqueObjectIds } },
      select: { id: true, wrappedDek: true },
    });
    for (const object of objects) {
      await queueUserDomainWrap({
        userId: user.id,
        authUserId: user.authUserId,
        resourceType: "content-object",
        resourceId: object.id,
        domain: "file",
        platformWrappedValue: object.wrappedDek,
        client: tx,
      });
    }
  },

  async prepareChatReferenceClone(
    client,
    { sourceChatId, response, workspaceSlug = null }
  ) {
    const sourceRefs = await client.workspace_chat_attachment_refs.findMany({
      where: { chatId: Number(sourceChatId) },
      orderBy: { ordinal: "asc" },
    });
    const sourceContentRefs = await client.workspace_chat_content_refs.findMany(
      {
        where: { chatId: Number(sourceChatId) },
      }
    );
    const parsed =
      typeof response === "string" ? JSON.parse(response) : response;
    const attachments = Array.isArray(parsed?.attachments)
      ? parsed.attachments.map((attachment) => ({ ...attachment }))
      : [];
    const attachmentsPrepared = sourceRefs.map((row, ordinal) => {
      const refId = crypto.randomUUID();
      if (attachments[ordinal]) {
        attachments[ordinal].attachmentId = refId;
        if (workspaceSlug) {
          attachments[ordinal].contentUrl =
            `/api/workspace/${encodeURIComponent(workspaceSlug)}` +
            `/chat-attachments/${encodeURIComponent(refId)}/content`;
        }
      }
      return {
        refId,
        contentObjectId: row.contentObjectId,
        ordinal,
        name: row.displayName,
        mime: row.mimeType,
        byteSize: row.byteSize,
        metadata: row.metadataJson ? JSON.parse(row.metadataJson) : {},
      };
    });
    const contentRefs = sourceContentRefs.map((row) => {
      const refId = crypto.randomUUID();
      if (parsed?.textRef?.refId === row.id) {
        parsed.textRef.refId = refId;
        if (workspaceSlug) {
          parsed.textRef.contentUrl =
            `/api/workspace/${encodeURIComponent(workspaceSlug)}` +
            `/chat-content/${encodeURIComponent(refId)}/content`;
        }
      }
      return {
        refId,
        contentObjectId: row.contentObjectId,
        role: row.role,
        jsonPath: row.jsonPath,
      };
    });
    return {
      response: { ...parsed, attachments },
      attachments: attachmentsPrepared,
      contentRefs,
    };
  },

  async cloneChatReferences(tx, { sourceChatId, targetChatId, response }) {
    const prepared = await this.prepareChatReferenceClone(tx, {
      sourceChatId,
      response,
    });
    await this.attachToChat(tx, {
      chatId: targetChatId,
      attachments: prepared.attachments,
      contentRefs: prepared.contentRefs,
    });
    return prepared;
  },

  async readRange(row, { start = 0, end = null } = {}) {
    const metadata = parseMetadata(row);
    const range = encryptedRangeForPlaintext({
      start,
      end,
      chunkSize: Number(metadata.chunkSize),
      plaintextSize: Number(metadata.plaintextSize),
    });
    const encrypted = await contentObjectProvider(row.provider).getRange({
      objectKey: row.objectKey,
      start: range.encryptedStart,
      end: range.encryptedEnd,
    });
    const plaintext = decryptContentRange({
      objectId: row.id,
      encrypted,
      encryptedStart: range.encryptedStart,
      wrappedDek: row.wrappedDek,
      metadata,
      start: range.start,
      end: range.end,
    });
    metrics.contentObjectBytes.inc(
      { direction: "read", domain: row.domain },
      plaintext.length
    );
    metrics.contentObjectOperations.inc({
      operation: "read",
      outcome: "success",
      provider: row.provider,
    });
    return plaintext;
  },

  async readWhole(row) {
    return this.readRange(row, { start: 0, end: row.plaintextSize - 1 });
  },

  async attachmentForWorkspace({ attachmentId, workspaceId, userId = null }) {
    const ref = await prisma.workspace_chat_attachment_refs.findUnique({
      where: { id: String(attachmentId) },
    });
    if (!ref) return null;
    const chat = await prisma.workspace_chats.findFirst({
      where: {
        id: ref.chatId,
        workspaceId: Number(workspaceId),
        ...(userId ? { user_id: Number(userId) } : {}),
      },
      select: { id: true, workspaceId: true, user_id: true, deletedAt: true },
    });
    if (!chat || chat.deletedAt) return null;
    const object = await prisma.content_objects.findUnique({
      where: { id: ref.contentObjectId },
    });
    if (!object || object.state !== "ready") return null;
    return { ref, chat, object };
  },

  async contentRefForWorkspace({ refId, workspaceId }) {
    const ref = await prisma.workspace_chat_content_refs.findUnique({
      where: { id: String(refId) },
    });
    if (!ref) return null;
    const chat = await prisma.workspace_chats.findFirst({
      where: {
        id: ref.chatId,
        workspaceId: Number(workspaceId),
        deletedAt: null,
      },
      select: { id: true, workspaceId: true, user_id: true },
    });
    if (!chat) return null;
    const object = await prisma.content_objects.findUnique({
      where: { id: ref.contentObjectId },
    });
    if (!object || object.state !== "ready") return null;
    return { ref, chat, object };
  },

  async reconcile({ stagingBefore, deleteBefore, limit = 100 }) {
    const stale = await prisma.content_objects.findMany({
      where: {
        OR: [
          { state: "staging", createdAt: { lt: stagingBefore } },
          { state: "delete_pending", deleteAfter: { lt: deleteBefore } },
        ],
      },
      take: limit,
      orderBy: { createdAt: "asc" },
    });
    const result = { inspected: stale.length, deleted: 0, retained: 0 };
    for (const row of stale) {
      const [attachmentRefs, contentRefs] = await Promise.all([
        prisma.workspace_chat_attachment_refs.count({
          where: { contentObjectId: row.id },
        }),
        prisma.workspace_chat_content_refs.count({
          where: { contentObjectId: row.id },
        }),
      ]);
      const references = attachmentRefs + contentRefs;
      if (references > 0) {
        await prisma.content_objects.update({
          where: { id: row.id },
          data: { state: "ready", refCount: references, deleteAfter: null },
        });
        result.retained += 1;
        continue;
      }
      await contentObjectProvider(row.provider).delete({
        objectKey: row.objectKey,
      });
      await prisma.content_objects.delete({ where: { id: row.id } });
      metrics.contentObjectOperations.inc({
        operation: "gc",
        outcome: "deleted",
        provider: row.provider,
      });
      result.deleted += 1;
    }
    return result;
  },

  async verify({ limit = 1_000 } = {}) {
    const rows = await prisma.content_objects.findMany({
      where: { state: "ready" },
      orderBy: { createdAt: "asc" },
      take: Math.max(1, Math.min(Number(limit) || 1_000, 10_000)),
    });
    const failures = [];
    let plaintextBytes = 0;
    for (const row of rows) {
      try {
        const provider = contentObjectProvider(row.provider);
        const encrypted = await provider.getRange({
          objectKey: row.objectKey,
          start: 0,
          end: null,
        });
        if (sha256(encrypted) !== row.ciphertextSha256)
          throw new Error("ciphertext_checksum_mismatch");
        const header = parseHeader(encrypted);
        const metadata = parseMetadata(row);
        if (
          header.plaintextSize !== Number(row.plaintextSize) ||
          header.chunkSize !== Number(metadata.chunkSize)
        )
          throw new Error("content_object_header_metadata_mismatch");
        const plaintext = decryptContentRange({
          objectId: row.id,
          encrypted,
          encryptedStart: 0,
          wrappedDek: row.wrappedDek,
          metadata,
          start: 0,
          end: row.plaintextSize - 1,
        });
        if (sha256(plaintext) !== row.plaintextSha256)
          throw new Error("plaintext_checksum_mismatch");
        const [attachmentRefs, contentRefs] = await Promise.all([
          prisma.workspace_chat_attachment_refs.count({
            where: { contentObjectId: row.id },
          }),
          prisma.workspace_chat_content_refs.count({
            where: { contentObjectId: row.id },
          }),
        ]);
        if (attachmentRefs + contentRefs !== Number(row.refCount))
          throw new Error("content_object_refcount_mismatch");
        plaintextBytes += plaintext.length;
      } catch (error) {
        failures.push({
          objectId: row.id,
          provider: row.provider,
          reason: error.code || error.message,
        });
      }
    }
    return {
      inspected: rows.length,
      verified: rows.length - failures.length,
      plaintextBytes,
      failures: failures.slice(0, 20),
      failureCount: failures.length,
    };
  },
};

module.exports = { ContentObject, dedupeKeyFor };
