const crypto = require("crypto");
const prisma = require("../utils/prisma");
const {
  encryptSecret,
  decryptSecret,
} = require("../utils/security/encryption");
const { SyncV2 } = require("./syncV2");
const { nodeKeys } = require("../utils/syncV2/nodeRegistry");
const {
  memoryCandidatesProjection,
  personaMemoryProjection,
  shadowUserIdForAuthUser,
  structuredMemoryProjection,
} = require("../utils/syncV2/memoryProjection");

const MEMORY_CATEGORIES = [
  "preferences",
  "projects",
  "facts",
  "decisions",
  "open_topics",
  "interests",
];

const MEMORY_CATEGORY_LABELS = {
  preferences: "用户偏好",
  projects: "长期项目",
  facts: "长期事实",
  decisions: "重要决策",
  open_topics: "待解决问题",
  interests: "兴趣与研究方向",
};

const MEMORY_CATEGORY_DESCRIPTIONS = {
  preferences: "回答方式、称呼习惯和协作偏好。",
  projects: "持续推进的系统、产品和研究任务。",
  facts: "稳定背景、身份信息和重要上下文。",
  decisions: "已经确认的产品方向和实现取舍。",
  open_topics: "仍需继续跟进的疑问和未完成事项。",
  interests: "长期关注的主题、领域和研究线索。",
};

const MASKED_MEMORY_TEXT = "••••••••";
const MEMORY_SCHEMA_INIT_ERROR =
  "长期记忆数据库未初始化，请应用迁移后重启服务。";
const MEMORY_OWNER_REQUIRED_ERROR =
  "当前账号未完成统一身份绑定，无法使用长期记忆。";
const MEMORY_TABLE_NAMES = [
  "memory_candidates",
  "user_memory_blocks",
  "user_memory_archives",
  "user_profile_overviews",
];

async function memorySyncReady() {
  return SyncV2.enabled("memory") && (await SyncV2.schemaReady());
}

async function recordMemoryNodeChange(
  tx,
  { authUserId, kind, eventType, changedPaths, payloadHint = {}, content }
) {
  const shadowUserId = await shadowUserIdForAuthUser(tx, authUserId);
  if (!shadowUserId) return null;
  let projectedContent = content;
  if (projectedContent === undefined) {
    if (kind === "candidates")
      projectedContent = await memoryCandidatesProjection(tx, authUserId);
    else if (kind === "structured")
      projectedContent = await structuredMemoryProjection(tx, authUserId);
    else projectedContent = await personaMemoryProjection(tx, authUserId);
  }
  return await SyncV2.recordNodeChange(tx, {
    nodeKey: nodeKeys.userMemory(shadowUserId, kind),
    content: projectedContent,
    eventType,
    changedPaths,
    payloadHint,
    audience: [shadowUserId],
  });
}

function normalizeCategory(category = "") {
  const normalized = String(category || "").trim();
  if (!MEMORY_CATEGORIES.includes(normalized))
    throw new Error("Invalid memory category.");
  return normalized;
}

function normalizeText(value = "", fallback = "") {
  return String(value ?? fallback).trim();
}

function normalizeTitle(value = "") {
  return normalizeText(value).replace(/\s+/g, " ").toLowerCase();
}

function fingerprintFor({ category, title, detail }) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        category: normalizeCategory(category),
        title: normalizeTitle(title),
        detail: normalizeText(detail).replace(/\s+/g, " "),
      })
    )
    .digest("hex");
}

function ensureMemoryInput(input = {}) {
  const category = normalizeCategory(input.category);
  const title = normalizeText(input.title);
  const detail = normalizeText(input.detail);
  if (!title) throw new Error("Memory title is required.");
  if (!detail) throw new Error("Memory detail is required.");

  return {
    category,
    title: title.slice(0, 160),
    detail: detail.slice(0, 2_000),
    source: normalizeText(input.source, "手动添加").slice(0, 120),
    confidence: normalizeText(input.confidence, "中").slice(0, 24),
  };
}

function serializeMemoryValue(memory = {}) {
  return JSON.stringify({
    id: memory.id,
    category: memory.category,
    title: memory.title,
    detail: memory.detail,
    source: memory.source,
    confidence: memory.confidence,
    updatedAt: memory.updatedAt,
    isSensitive: Boolean(memory.isSensitive),
  });
}

function archiveValueForMemory(memory = {}) {
  if (!memory?.isSensitive) return serializeMemoryValue(memory);
  return serializeMemoryValue({
    ...memory,
    title: MASKED_MEMORY_TEXT,
    detail: MASKED_MEMORY_TEXT,
  });
}

function sensitiveMemoryPayload(memory = {}) {
  if (!memory?.encryptedPayload) return {};
  try {
    return JSON.parse(decryptSecret(memory.encryptedPayload));
  } catch {
    return {};
  }
}

function toMemoryItem(
  memory = {},
  { maskSensitive = false, detail = "full" } = {}
) {
  const isSensitive = Boolean(memory.isSensitive);
  const shouldLighten = detail === "light";
  return {
    id: memory.id,
    category: memory.category,
    title: maskSensitive && isSensitive ? MASKED_MEMORY_TEXT : memory.title,
    detail:
      maskSensitive && isSensitive
        ? MASKED_MEMORY_TEXT
        : shouldLighten
          ? String(memory.detail || "").slice(0, 240)
          : memory.detail,
    source: memory.source,
    confidence: memory.confidence,
    updatedAt: memory.updatedAt,
    isSensitive,
  };
}

function categoryBlock(category, items = []) {
  return {
    key: category === "open_topics" ? "open-topics" : category,
    category,
    title: MEMORY_CATEGORY_LABELS[category],
    description: MEMORY_CATEGORY_DESCRIPTIONS[category],
    count: items.length,
    items,
  };
}

function buildOverview(activeMemories = []) {
  if (!activeMemories.length) return "暂无长期记忆画像。";

  const lines = MEMORY_CATEGORIES.map((category) => {
    const items = activeMemories
      .filter((memory) => memory.category === category && !memory.isSensitive)
      .slice(0, 5);
    if (!items.length) return null;
    return `${MEMORY_CATEGORY_LABELS[category]}：${items
      .map((item) => item.title)
      .join("、")}`;
  }).filter(Boolean);

  return lines.length ? lines.join("\n") : "暂无可展示的非敏感长期记忆画像。";
}

function isMemorySchemaMissingError(error) {
  if (["P2021", "P2022"].includes(error?.code)) return true;
  const detail = `${error?.message || ""} ${JSON.stringify(error?.meta || {})}`;
  return MEMORY_TABLE_NAMES.some((table) => detail.includes(table));
}

function memoryOwnerIdFromSessionUser(sessionUser = {}) {
  const authUserId = Number(sessionUser?.authUserId);
  if (!authUserId) throw new Error(MEMORY_OWNER_REQUIRED_ERROR);
  return authUserId;
}

const UserMemory = {
  categories: MEMORY_CATEGORIES,
  labels: MEMORY_CATEGORY_LABELS,
  descriptions: MEMORY_CATEGORY_DESCRIPTIONS,
  maskedText: MASKED_MEMORY_TEXT,
  memoryOwnerIdFromSessionUser,

  createCandidate: async function (userId, input = {}) {
    const memory = ensureMemoryInput(input);
    const fingerprint = fingerprintFor(memory);
    if (!(await memorySyncReady())) {
      return prisma.memory_candidates.create({
        data: {
          userId: Number(userId),
          ...memory,
          fingerprint,
        },
      });
    }
    return await prisma.$transaction(async (tx) => {
      const created = await tx.memory_candidates.create({
        data: {
          userId: Number(userId),
          ...memory,
          fingerprint,
        },
      });
      await recordMemoryNodeChange(tx, {
        authUserId: userId,
        kind: "candidates",
        eventType: "memory.candidate_created",
        changedPaths: [`candidates.${created.id}`],
        payloadHint: { operation: "append", candidateId: created.id },
      });
      return created;
    });
  },

  createSensitiveMemory: async function (userId, input = {}) {
    const memory = ensureMemoryInput(input);
    const encryptedPayload = encryptSecret(
      JSON.stringify({
        title: memory.title,
        detail: memory.detail,
      })
    );

    const create = (tx) =>
      tx.user_memory_blocks.create({
        data: {
          userId: Number(userId),
          category: memory.category,
          title: MASKED_MEMORY_TEXT,
          detail: MASKED_MEMORY_TEXT,
          source: memory.source,
          confidence: memory.confidence,
          updatedAt: new Date(),
          isSensitive: true,
          encryptedPayload,
        },
      });
    if (!(await memorySyncReady())) return await create(prisma);
    return await prisma.$transaction(async (tx) => {
      const created = await create(tx);
      await recordMemoryNodeChange(tx, {
        authUserId: userId,
        kind: "structured",
        eventType: "memory.sensitive_created",
        changedPaths: [`blocks.${created.id}`],
        payloadHint: {
          operation: "add",
          memoryId: created.id,
          sensitive: true,
        },
      });
      return created;
    });
  },

  saveActiveMemory: async function (userId, input = {}) {
    const numericUserId = Number(userId);
    if (!numericUserId) throw new Error("Invalid user id.");

    const memory = ensureMemoryInput(input);
    const isSensitive = Boolean(input?.isSensitive);
    const normalizedTitle = normalizeTitle(memory.title);

    const syncReady = await memorySyncReady();
    return prisma.$transaction(async (tx) => {
      const candidates = await tx.user_memory_blocks.findMany({
        where: {
          userId: numericUserId,
          category: memory.category,
          isSensitive,
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      });

      const previous = candidates.find((candidate) => {
        if (!isSensitive)
          return normalizeTitle(candidate.title) === normalizedTitle;
        const payload = sensitiveMemoryPayload(candidate);
        return normalizeTitle(payload.title) === normalizedTitle;
      });

      let archive = null;
      if (previous) {
        const archivedValue = archiveValueForMemory(previous);

        archive = await tx.user_memory_archives.create({
          data: {
            userId: numericUserId,
            category: memory.category,
            oldValue: archivedValue,
            replacedBy: null,
          },
        });
      }

      const encryptedPayload = isSensitive
        ? encryptSecret(
            JSON.stringify({
              title: memory.title,
              detail: memory.detail,
            })
          )
        : null;

      const saved = previous
        ? await tx.user_memory_blocks.update({
            where: { id: previous.id },
            data: {
              title: isSensitive ? MASKED_MEMORY_TEXT : memory.title,
              detail: isSensitive ? MASKED_MEMORY_TEXT : memory.detail,
              source: memory.source,
              confidence: memory.confidence,
              updatedAt: new Date(),
              encryptedPayload,
            },
          })
        : await tx.user_memory_blocks.create({
            data: {
              userId: numericUserId,
              category: memory.category,
              title: isSensitive ? MASKED_MEMORY_TEXT : memory.title,
              detail: isSensitive ? MASKED_MEMORY_TEXT : memory.detail,
              source: memory.source,
              confidence: memory.confidence,
              updatedAt: new Date(),
              isSensitive,
              encryptedPayload,
            },
          });

      if (archive) {
        await tx.user_memory_archives.update({
          where: { id: archive.id },
          data: { replacedBy: saved.id },
        });
      }

      if (syncReady) {
        await recordMemoryNodeChange(tx, {
          authUserId: numericUserId,
          kind: "structured",
          eventType: previous ? "memory.replaced" : "memory.created",
          changedPaths: [`blocks.${saved.id}`],
          payloadHint: {
            operation: previous ? "replace" : "add",
            memoryId: saved.id,
            sensitive: isSensitive,
          },
        });
      }

      return {
        memory: saved,
        created: !previous,
        replaced: Boolean(previous),
      };
    });
  },

  rebuildUserProfile: async function (userId) {
    const numericUserId = Number(userId);
    if (!numericUserId) throw new Error("Invalid user id.");

    const syncReady = await memorySyncReady();
    return prisma.$transaction(async (tx) => {
      const candidates = await tx.memory_candidates.findMany({
        where: { userId: numericUserId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });

      const activeBlocks = await tx.user_memory_blocks.findMany({
        where: { userId: numericUserId, isSensitive: false },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      });

      const activeByConflictKey = new Map();
      activeBlocks.forEach((memory) => {
        activeByConflictKey.set(
          `${memory.category}:${normalizeTitle(memory.title)}`,
          memory
        );
      });

      const promotedIds = [];
      for (const candidate of candidates) {
        const category = normalizeCategory(candidate.category);
        const conflictKey = `${category}:${normalizeTitle(candidate.title)}`;
        const previous = activeByConflictKey.get(conflictKey);
        let archive = null;

        if (previous) {
          archive = await tx.user_memory_archives.create({
            data: {
              userId: numericUserId,
              category,
              oldValue: serializeMemoryValue(previous),
              replacedBy: null,
            },
          });
          await tx.user_memory_blocks.delete({ where: { id: previous.id } });
        }

        const created = await tx.user_memory_blocks.create({
          data: {
            userId: numericUserId,
            category,
            title: candidate.title,
            detail: candidate.detail,
            source: candidate.source,
            confidence: candidate.confidence,
            updatedAt: new Date(),
            isSensitive: false,
            encryptedPayload: null,
          },
        });

        if (archive) {
          await tx.user_memory_archives.update({
            where: { id: archive.id },
            data: { replacedBy: created.id },
          });
        }

        activeByConflictKey.set(conflictKey, created);
        promotedIds.push(candidate.id);
      }

      if (promotedIds.length) {
        await tx.memory_candidates.deleteMany({
          where: { id: { in: promotedIds }, userId: numericUserId },
        });
      }

      const currentBlocks = await tx.user_memory_blocks.findMany({
        where: { userId: numericUserId, isSensitive: false },
        orderBy: [{ category: "asc" }, { updatedAt: "desc" }],
      });
      const latestOverview = await tx.user_profile_overviews.findFirst({
        where: { userId: numericUserId },
        orderBy: { version: "desc" },
      });
      const version = (latestOverview?.version || 0) + 1;
      const overview = buildOverview(currentBlocks);
      const profile = await tx.user_profile_overviews.create({
        data: {
          userId: numericUserId,
          overview,
          version,
          generatedAt: new Date(),
        },
      });

      if (syncReady) {
        await recordMemoryNodeChange(tx, {
          authUserId: numericUserId,
          kind: "candidates",
          eventType: "memory.candidates_promoted",
          changedPaths: promotedIds.length
            ? promotedIds.map((id) => `candidates.${id}`)
            : ["candidates"],
          payloadHint: {
            operation: "promote",
            promotedCount: promotedIds.length,
          },
        });
        await recordMemoryNodeChange(tx, {
          authUserId: numericUserId,
          kind: "structured",
          eventType: "memory.structured_rebuilt",
          changedPaths: ["$"],
          payloadHint: { promotedCount: promotedIds.length },
        });
        await recordMemoryNodeChange(tx, {
          authUserId: numericUserId,
          kind: "persona",
          eventType: "memory.persona_rebuilt",
          changedPaths: ["overview", "version"],
          content: {
            overview: profile.overview,
            version: profile.version,
            generatedAt: profile.generatedAt,
          },
          payloadHint: { version: profile.version },
        });
      }

      return {
        success: true,
        version: profile.version,
        generatedAt: profile.generatedAt,
        promotedCount: promotedIds.length,
      };
    });
  },

  overview: async function (userId) {
    const overview = await prisma.user_profile_overviews.findFirst({
      where: { userId: Number(userId) },
      orderBy: { version: "desc" },
    });
    return overview;
  },

  blocks: async function (userId, { limit = 0, detail = "full" } = {}) {
    const take = boundedLimit(limit, 0, 500);
    const memories = await prisma.user_memory_blocks.findMany({
      where: { userId: Number(userId), isSensitive: false },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      ...(take ? { take } : {}),
    });

    return MEMORY_CATEGORIES.map((category) => {
      const items = memories
        .filter((memory) => memory.category === category)
        .map((memory) => toMemoryItem(memory, { detail }));
      return categoryBlock(category, items);
    });
  },

  sensitive: async function (
    userId,
    { limit = 100, offset = 0, detail = "light" } = {}
  ) {
    const memories = await prisma.user_memory_blocks.findMany({
      where: { userId: Number(userId), isSensitive: true },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: boundedOffset(offset),
      take: boundedLimit(limit, 100, 500),
    });
    return memories.map((memory) =>
      toMemoryItem(memory, { maskSensitive: true, detail })
    );
  },

  revealSensitive: async function (userId, memoryId) {
    const memory = await prisma.user_memory_blocks.findFirst({
      where: {
        id: Number(memoryId),
        userId: Number(userId),
        isSensitive: true,
      },
    });
    if (!memory) throw new Error("Sensitive memory not found.");
    if (!memory.encryptedPayload)
      throw new Error("Sensitive memory payload is missing.");

    const payload = JSON.parse(decryptSecret(memory.encryptedPayload));
    return {
      ...toMemoryItem(memory),
      title: payload.title || MASKED_MEMORY_TEXT,
      detail: payload.detail || MASKED_MEMORY_TEXT,
    };
  },

  updateActiveMemory: async function (userId, memoryId, input = {}) {
    const numericUserId = Number(userId);
    const numericMemoryId = Number(memoryId);
    if (!numericUserId) throw new Error("Invalid user id.");
    if (!numericMemoryId) throw new Error("Invalid memory id.");

    const memory = ensureMemoryInput(input);
    const syncReady = await memorySyncReady();
    return prisma.$transaction(async (tx) => {
      const existing = await tx.user_memory_blocks.findFirst({
        where: { id: numericMemoryId, userId: numericUserId },
      });
      if (!existing) throw new Error("Memory not found.");

      const encryptedPayload = existing.isSensitive
        ? encryptSecret(
            JSON.stringify({
              title: memory.title,
              detail: memory.detail,
            })
          )
        : null;

      const updated = await tx.user_memory_blocks.update({
        where: { id: existing.id },
        data: {
          category: memory.category,
          title: existing.isSensitive ? MASKED_MEMORY_TEXT : memory.title,
          detail: existing.isSensitive ? MASKED_MEMORY_TEXT : memory.detail,
          source: memory.source,
          confidence: memory.confidence,
          updatedAt: new Date(),
          encryptedPayload,
        },
      });

      if (syncReady) {
        await recordMemoryNodeChange(tx, {
          authUserId: numericUserId,
          kind: "structured",
          eventType: "memory.updated",
          changedPaths: [`blocks.${updated.id}`],
          payloadHint: {
            operation: "update",
            memoryId: updated.id,
            sensitive: existing.isSensitive,
          },
        });
      }

      return toMemoryItem(updated, { maskSensitive: existing.isSensitive });
    });
  },

  deleteActiveMemory: async function (userId, memoryId) {
    const numericUserId = Number(userId);
    const numericMemoryId = Number(memoryId);
    if (!numericUserId) throw new Error("Invalid user id.");
    if (!numericMemoryId) throw new Error("Invalid memory id.");

    const syncReady = await memorySyncReady();
    return prisma.$transaction(async (tx) => {
      const existing = await tx.user_memory_blocks.findFirst({
        where: { id: numericMemoryId, userId: numericUserId },
      });
      if (!existing) throw new Error("Memory not found.");

      const archive = await tx.user_memory_archives.create({
        data: {
          userId: numericUserId,
          category: existing.category,
          oldValue: archiveValueForMemory(existing),
          replacedBy: null,
        },
      });

      await tx.user_memory_blocks.delete({ where: { id: existing.id } });
      if (syncReady) {
        await recordMemoryNodeChange(tx, {
          authUserId: numericUserId,
          kind: "structured",
          eventType: "memory.deleted",
          changedPaths: [`blocks.${existing.id}`],
          payloadHint: {
            operation: "delete",
            memoryId: existing.id,
            sensitive: existing.isSensitive,
          },
        });
      }
      return {
        success: true,
        archivedId: archive.id,
        memory: toMemoryItem(existing, { maskSensitive: existing.isSensitive }),
      };
    });
  },

  archives: async function (userId, { limit = 50, offset = 0 } = {}) {
    return prisma.user_memory_archives.findMany({
      where: { userId: Number(userId) },
      orderBy: [{ archivedAt: "desc" }, { id: "desc" }],
      skip: boundedOffset(offset),
      take: boundedLimit(limit, 50, 500),
    });
  },
};

function boundedLimit(value, fallback, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(Math.max(Math.floor(numeric), 1), max);
}

function boundedOffset(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric);
}

module.exports = {
  UserMemory,
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_LABELS,
  MEMORY_CATEGORY_DESCRIPTIONS,
  MEMORY_SCHEMA_INIT_ERROR,
  MEMORY_OWNER_REQUIRED_ERROR,
  isMemorySchemaMissingError,
  memoryOwnerIdFromSessionUser,
};
