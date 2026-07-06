const { v4: uuidv4 } = require("uuid");
const prisma = require("../utils/prisma");
const { safeJsonParse } = require("../utils/http");
const { SENSITIVE_FIELD_KEY } = require("../utils/dataAccess/dataAccessPolicy");

const CATALOG_TABLE = "reader_book_catalog";
const ITEM_TABLE = "reader_library_items";
const CATEGORY_TABLE = "reader_library_categories";
const UNKNOWN_CATEGORY_ID = "unknown";
function stringify(value, fallback = {}) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function json(value, fallback = {}) {
  return safeJsonParse(value, fallback) ?? fallback;
}

function compactString(value = "", max = 512) {
  const next = String(value || "").trim();
  return next.length > max ? next.slice(0, max) : next;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function iso(value = null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function catalogKey({ workspaceSlug = null, readerDocumentId = null } = {}) {
  if (!readerDocumentId) return null;
  return workspaceSlug
    ? `workspace:${workspaceSlug}:${readerDocumentId}`
    : `global:${readerDocumentId}`;
}

function safeMetadata(source = {}) {
  const metadata =
    source?.metadata && typeof source.metadata === "object"
      ? { ...source, ...source.metadata, metadata: undefined }
      : source || {};
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([key]) => !SENSITIVE_FIELD_KEY.test(key))
      .map(([key, value]) => {
        if (value === undefined || typeof value === "function")
          return [key, null];
        if (typeof value === "string") return [key, compactString(value, 512)];
        if (typeof value === "number" || typeof value === "boolean")
          return [key, value];
        if (value === null) return [key, null];
        if (Array.isArray(value)) return [key, value.slice(0, 20)];
        return [key, "[object]"];
      })
  );
}

function readerDocumentIdFrom(value = {}) {
  return (
    value.readerDocumentId ||
    value.backupReaderDocumentId ||
    value.metadata?.readerDocumentId ||
    value.id ||
    null
  );
}

function workspaceSlugFrom(value = {}, fallback = null) {
  return (
    value.readerDocumentWorkspaceSlug ||
    value.workspaceSlug ||
    value.metadata?.readerDocumentWorkspaceSlug ||
    fallback ||
    null
  );
}

function itemKeyFor(item = {}, workspaceSlug = null, readerDocumentId = null) {
  if (item.itemKey) return compactString(item.itemKey, 768);
  if (item.key) return compactString(item.key, 768);
  const key = catalogKey({ workspaceSlug, readerDocumentId });
  if (key) return key;
  return compactString(
    `${item.title || item.filename || "reader-book"}:${item.addedAt || ""}`,
    768
  );
}

function categoryIdFrom(item = {}) {
  return (
    item.categoryId ||
    item.category?.primaryCategoryId ||
    item.category?.id ||
    UNKNOWN_CATEGORY_ID
  );
}

function categoryNameFrom(item = {}, categoryId = UNKNOWN_CATEGORY_ID) {
  return (
    item.categoryName ||
    item.category?.primaryCategoryName ||
    item.name ||
    (categoryId === UNKNOWN_CATEGORY_ID ? "未知分类" : categoryId)
  );
}

function rowRevision(rows = []) {
  const latest = rows
    .map((row) => new Date(row.updatedAt || row.createdAt || 0).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  return latest ? new Date(latest).toISOString() : new Date(0).toISOString();
}

function rowToCategory(row = {}) {
  if (!row) return null;
  return {
    id: row.categoryId,
    name: row.name,
    sortOrder: numberOrZero(row.sortOrder),
    hidden: !!row.hiddenAt,
    deleted: !!row.deletedAt,
    mutationVersion: numberOrZero(row.mutationVersion) || 1,
    updatedAt: iso(row.updatedAt),
    createdAt: iso(row.createdAt),
  };
}

function rowToBookshelfItem(
  row = {},
  catalog = {},
  categoriesById = new Map()
) {
  if (!row) return null;
  const state = json(row.stateJson, {});
  const progress = json(row.progressJson, null);
  const stateCategory =
    state.category &&
    typeof state.category === "object" &&
    !Array.isArray(state.category)
      ? state.category
      : {};
  const categoryId = row.categoryId || UNKNOWN_CATEGORY_ID;
  const category = categoriesById.get(categoryId);
  const title = row.title || catalog.title || state.title || "未命名书籍";
  const workspaceSlug = row.workspaceSlug || catalog.workspaceSlug || null;
  const readerDocumentId = row.readerDocumentId || catalog.readerDocumentId;
  const key =
    row.itemKey ||
    itemKeyFor({ title }, workspaceSlug || null, readerDocumentId || null);
  return {
    ...state,
    key,
    itemKey: row.itemKey,
    libraryItemId: row.itemId,
    authoritySource: "reader-data-authority",
    authorityRevision: iso(row.updatedAt),
    title,
    readerDocumentId,
    backupReaderDocumentId:
      state.backupReaderDocumentId || row.readerDocumentId || null,
    readerDocumentWorkspaceSlug: workspaceSlug,
    workspaceSlug,
    uploaded: true,
    hidden: !!row.hiddenAt || row.visible === 0 || row.visible === false,
    tombstone: !!row.tombstone,
    deletedAt: iso(row.deletedAt),
    availability:
      row.availability ||
      catalog.availability ||
      state.availability ||
      "available",
    readerAvailability:
      row.availability ||
      catalog.availability ||
      state.readerAvailability ||
      "available",
    progress,
    sortOrder: numberOrZero(row.sortOrder),
    addedAt: iso(row.addedAt) || state.addedAt || iso(row.createdAt),
    lastOpenedAt: iso(row.lastOpenedAt) || state.lastOpenedAt || null,
    updatedAt: iso(row.updatedAt) || state.updatedAt || null,
    categoryStatus:
      state.categoryStatus ||
      (categoryId === UNKNOWN_CATEGORY_ID ? "unknown" : "manual"),
    categoryStage:
      state.categoryStage ||
      (categoryId === UNKNOWN_CATEGORY_ID ? "unknownReason" : "manual"),
    categoryReason:
      state.categoryReason ||
      (categoryId === UNKNOWN_CATEGORY_ID ? "" : "用户手动修改"),
    category: {
      ...stateCategory,
      primaryCategoryId: categoryId,
      primaryCategoryName:
        category?.name || stateCategory.primaryCategoryName || categoryId,
    },
  };
}

const ReaderLibraryRepository = {
  UNKNOWN_CATEGORY_ID,
  catalogKey,

  ensureTable: async function () {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "${CATALOG_TABLE}" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "catalogKey" TEXT NOT NULL,
        "readerDocumentId" TEXT NOT NULL,
        "workspaceSlug" TEXT,
        "title" TEXT,
        "documentType" TEXT,
        "mimeType" TEXT,
        "fingerprint" TEXT,
        "previewStatus" TEXT,
        "thumbnailStatus" TEXT,
        "classificationStatus" TEXT,
        "availability" TEXT NOT NULL DEFAULT 'available',
        "metadataJson" TEXT NOT NULL DEFAULT '{}',
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "reader_book_catalog_catalogKey_key" ON "${CATALOG_TABLE}"("catalogKey")`
    );
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "reader_book_catalog_readerDocumentId_idx" ON "${CATALOG_TABLE}"("readerDocumentId")`
    );
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "reader_book_catalog_workspaceSlug_idx" ON "${CATALOG_TABLE}"("workspaceSlug")`
    );
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "reader_book_catalog_availability_idx" ON "${CATALOG_TABLE}"("availability")`
    );

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "${ITEM_TABLE}" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "itemId" TEXT NOT NULL,
        "userId" INTEGER NOT NULL,
        "catalogKey" TEXT NOT NULL,
        "readerDocumentId" TEXT NOT NULL,
        "workspaceSlug" TEXT,
        "itemKey" TEXT NOT NULL,
        "title" TEXT,
        "categoryId" TEXT,
        "sortOrder" INTEGER NOT NULL DEFAULT 0,
        "progressJson" TEXT NOT NULL DEFAULT '{}',
        "stateJson" TEXT NOT NULL DEFAULT '{}',
        "visible" BOOLEAN NOT NULL DEFAULT true,
        "hiddenAt" DATETIME,
        "deletedAt" DATETIME,
        "tombstone" BOOLEAN NOT NULL DEFAULT false,
        "availability" TEXT NOT NULL DEFAULT 'available',
        "mutationVersion" INTEGER NOT NULL DEFAULT 1,
        "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "lastOpenedAt" DATETIME,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "reader_library_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "reader_library_items_itemId_key" ON "${ITEM_TABLE}"("itemId")`
    );
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "reader_library_items_userId_catalogKey_key" ON "${ITEM_TABLE}"("userId", "catalogKey")`
    );
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "reader_library_items_userId_itemKey_key" ON "${ITEM_TABLE}"("userId", "itemKey")`
    );
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "reader_library_items_userId_idx" ON "${ITEM_TABLE}"("userId")`
    );
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "reader_library_items_userId_deletedAt_tombstone_idx" ON "${ITEM_TABLE}"("userId", "deletedAt", "tombstone")`
    );
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "reader_library_items_catalogKey_idx" ON "${ITEM_TABLE}"("catalogKey")`
    );

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "${CATEGORY_TABLE}" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "categoryId" TEXT NOT NULL,
        "userId" INTEGER NOT NULL,
        "name" TEXT NOT NULL,
        "sortOrder" INTEGER NOT NULL DEFAULT 0,
        "hiddenAt" DATETIME,
        "deletedAt" DATETIME,
        "mutationVersion" INTEGER NOT NULL DEFAULT 1,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "reader_library_categories_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "reader_library_categories_userId_categoryId_key" ON "${CATEGORY_TABLE}"("userId", "categoryId")`
    );
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "reader_library_categories_userId_idx" ON "${CATEGORY_TABLE}"("userId")`
    );
  },

  upsertCatalog: async function ({
    document = {},
    workspaceSlug = null,
    availability = "available",
  } = {}) {
    await this.ensureTable();
    const readerDocumentId = readerDocumentIdFrom(document);
    const scope = workspaceSlugFrom(document, workspaceSlug);
    const key = catalogKey({ workspaceSlug: scope, readerDocumentId });
    if (!key || !readerDocumentId) return null;
    const metadata = safeMetadata(document);
    const now = new Date();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${CATALOG_TABLE}"
        ("catalogKey", "readerDocumentId", "workspaceSlug", "title", "documentType", "mimeType", "fingerprint", "previewStatus", "thumbnailStatus", "classificationStatus", "availability", "metadataJson", "createdAt", "updatedAt")
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT("catalogKey") DO UPDATE SET
          "title" = excluded."title",
          "documentType" = excluded."documentType",
          "mimeType" = excluded."mimeType",
          "fingerprint" = excluded."fingerprint",
          "previewStatus" = excluded."previewStatus",
          "thumbnailStatus" = excluded."thumbnailStatus",
          "classificationStatus" = excluded."classificationStatus",
          "availability" = excluded."availability",
          "metadataJson" = excluded."metadataJson",
          "updatedAt" = excluded."updatedAt"`,
      key,
      readerDocumentId,
      scope,
      compactString(
        document.title ||
          document.filename ||
          metadata.title ||
          metadata.filename ||
          ""
      ),
      compactString(document.documentType || metadata.documentType || ""),
      compactString(document.mimeType || metadata.mimeType || ""),
      compactString(
        document.fingerprint ||
          metadata.fingerprint ||
          metadata.contentHash ||
          ""
      ),
      compactString(document.previewStatus || metadata.previewStatus || ""),
      compactString(document.thumbnailStatus || metadata.thumbnailStatus || ""),
      compactString(
        document.classificationStatus || metadata.classificationStatus || ""
      ),
      availability || "available",
      stringify(metadata),
      now,
      now
    );
    return key;
  },

  ensureCategory: async function ({
    userId,
    categoryId = UNKNOWN_CATEGORY_ID,
    name = "未知分类",
    sortOrder = 0,
    createOnly = false,
  } = {}) {
    if (!userId || !categoryId) return null;
    await this.ensureTable();
    const now = new Date();
    if (createOnly) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "${CATEGORY_TABLE}"
          ("categoryId", "userId", "name", "sortOrder", "createdAt", "updatedAt")
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT("userId", "categoryId") DO NOTHING`,
        String(categoryId),
        Number(userId),
        compactString(name || categoryId, 128),
        numberOrZero(sortOrder),
        now,
        now
      );
      return categoryId;
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${CATEGORY_TABLE}"
        ("categoryId", "userId", "name", "sortOrder", "createdAt", "updatedAt")
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT("userId", "categoryId") DO UPDATE SET
          "name" = excluded."name",
          "sortOrder" = excluded."sortOrder",
          "deletedAt" = NULL,
          "hiddenAt" = NULL,
          "mutationVersion" = "${CATEGORY_TABLE}"."mutationVersion" + 1,
          "updatedAt" = excluded."updatedAt"`,
      String(categoryId),
      Number(userId),
      compactString(name || categoryId, 128),
      numberOrZero(sortOrder),
      now,
      now
    );
    return categoryId;
  },

  upsertItem: async function ({
    userId,
    item = {},
    workspaceSlug = null,
    bootstrap = false,
  } = {}) {
    if (!userId) return null;
    await this.ensureTable();
    const readerDocumentId = readerDocumentIdFrom(item);
    const scope = workspaceSlugFrom(item, workspaceSlug);
    const key = catalogKey({ workspaceSlug: scope, readerDocumentId });
    if (!key || !readerDocumentId) return null;

    const categoryId = categoryIdFrom(item);
    await this.ensureCategory({
      userId,
      categoryId,
      name: categoryNameFrom(item, categoryId),
      sortOrder: item.categorySortOrder || 0,
    });
    await this.upsertCatalog({ document: item, workspaceSlug: scope });

    const existing = await prisma.$queryRawUnsafe(
      `SELECT "itemId", "tombstone", "deletedAt" FROM "${ITEM_TABLE}" WHERE "userId" = ? AND "catalogKey" = ? LIMIT 1`,
      Number(userId),
      key
    );
    if (existing?.[0]?.tombstone) {
      return { skipped: true, reason: "tombstone", itemId: existing[0].itemId };
    }
    if (bootstrap && existing?.[0]?.itemId) {
      return {
        skipped: true,
        reason: "already_exists",
        itemId: existing[0].itemId,
      };
    }

    const itemId = existing?.[0]?.itemId || item.libraryItemId || uuidv4();
    const itemKey = itemKeyFor(item, scope, readerDocumentId);
    const title = compactString(item.title || item.filename || "未命名书籍");
    const now = new Date();
    const state = safeMetadata({
      ...item,
      title,
      readerDocumentId,
      readerDocumentWorkspaceSlug: scope,
      workspaceSlug: scope,
      categoryStatus: item.categoryStatus,
      categoryStage: item.categoryStage,
      categoryReason: item.categoryReason,
    });
    if (item.category && typeof item.category === "object") {
      state.category = item.category;
    }
    const stateJson = stringify(state);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${ITEM_TABLE}"
        ("itemId", "userId", "catalogKey", "readerDocumentId", "workspaceSlug", "itemKey", "title", "categoryId", "sortOrder", "progressJson", "stateJson", "visible", "availability", "addedAt", "lastOpenedAt", "createdAt", "updatedAt")
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT("userId", "catalogKey") DO UPDATE SET
          "itemKey" = excluded."itemKey",
          "title" = excluded."title",
          "categoryId" = excluded."categoryId",
          "sortOrder" = excluded."sortOrder",
          "progressJson" = excluded."progressJson",
          "stateJson" = excluded."stateJson",
          "visible" = excluded."visible",
          "availability" = excluded."availability",
          "mutationVersion" = "${ITEM_TABLE}"."mutationVersion" + 1,
          "updatedAt" = excluded."updatedAt",
          "lastOpenedAt" = COALESCE(excluded."lastOpenedAt", "${ITEM_TABLE}"."lastOpenedAt")`,
      itemId,
      Number(userId),
      key,
      readerDocumentId,
      scope,
      itemKey,
      title,
      categoryId,
      numberOrZero(item.sortOrder || item.order || 0),
      stringify(item.progress || null, null),
      stateJson,
      item.hidden ? 0 : 1,
      item.availability || item.readerAvailability || "available",
      item.addedAt ? new Date(item.addedAt) : now,
      item.lastOpenedAt ? new Date(item.lastOpenedAt) : null,
      now,
      now
    );
    return { itemId, catalogKey: key };
  },

  bootstrap: async function ({ userId, bookshelf = [], categories = [] } = {}) {
    if (!userId) return this.listLibrary({ userId });
    await this.ensureTable();
    const safeCategories = Array.isArray(categories) ? categories : [];
    for (let index = 0; index < safeCategories.length; index += 1) {
      const category = safeCategories[index] || {};
      await this.ensureCategory({
        userId,
        categoryId: category.id || category.categoryId || UNKNOWN_CATEGORY_ID,
        name: category.name || category.label || category.id || "未知分类",
        sortOrder: category.sortOrder ?? index,
        createOnly: true,
      });
    }
    await this.ensureCategory({
      userId,
      categoryId: UNKNOWN_CATEGORY_ID,
      name: "未知分类",
      sortOrder: 0,
      createOnly: true,
    });
    for (const item of Array.isArray(bookshelf) ? bookshelf : []) {
      await this.upsertItem({ userId, item, bootstrap: true });
    }
    return this.listLibrary({ userId });
  },

  listLibrary: async function ({
    userId,
    includeHidden = false,
    includeDeleted = false,
  } = {}) {
    if (!userId) return { revision: null, categories: [], bookshelf: [] };
    await this.ensureTable();
    const categories = await prisma.$queryRawUnsafe(
      `SELECT * FROM "${CATEGORY_TABLE}" WHERE "userId" = ? ${
        includeDeleted ? "" : `AND "deletedAt" IS NULL`
      } ORDER BY "sortOrder" ASC, "name" ASC`,
      Number(userId)
    );
    const categoryList = categories.map(rowToCategory).filter(Boolean);
    const categoriesById = new Map(
      categoryList.map((category) => [category.id, category])
    );
    const itemClauses = [`i."userId" = ?`];
    if (!includeDeleted)
      itemClauses.push(`i."deletedAt" IS NULL`, `i."tombstone" = false`);
    if (!includeHidden)
      itemClauses.push(`i."visible" = true`, `i."hiddenAt" IS NULL`);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT i.*, c."title" AS "catalogTitle", c."workspaceSlug" AS "catalogWorkspaceSlug", c."availability" AS "catalogAvailability", c."metadataJson" AS "catalogMetadataJson"
        FROM "${ITEM_TABLE}" i
        LEFT JOIN "${CATALOG_TABLE}" c ON c."catalogKey" = i."catalogKey"
        WHERE ${itemClauses.join(" AND ")}
        ORDER BY i."sortOrder" ASC, i."addedAt" DESC, i."updatedAt" DESC`,
      Number(userId)
    );
    const bookshelf = rows
      .map((row) =>
        rowToBookshelfItem(
          row,
          {
            title: row.catalogTitle,
            workspaceSlug: row.catalogWorkspaceSlug,
            availability: row.catalogAvailability,
            ...json(row.catalogMetadataJson, {}),
          },
          categoriesById
        )
      )
      .filter(Boolean);
    return {
      revision: rowRevision([...rows, ...categories]),
      categories: categoryList,
      bookshelf,
      counts: {
        categories: categoryList.length,
        bookshelf: bookshelf.length,
      },
    };
  },

  patchItem: async function ({ userId, itemId, patch = {} } = {}) {
    if (!userId || !itemId) return null;
    await this.ensureTable();
    const rows = await prisma.$queryRawUnsafe(
      `SELECT * FROM "${ITEM_TABLE}" WHERE "userId" = ? AND ("itemId" = ? OR "itemKey" = ? OR "catalogKey" = ?) LIMIT 1`,
      Number(userId),
      String(itemId),
      String(itemId),
      String(itemId)
    );
    const row = rows?.[0];
    if (!row) return null;
    const now = new Date();
    const currentState = json(row.stateJson, {});
    const nextState = {
      ...currentState,
      ...(patch.state || {}),
      ...(patch.category ? { category: patch.category } : {}),
      ...(patch.categoryStatus ? { categoryStatus: patch.categoryStatus } : {}),
      ...(patch.categoryStage ? { categoryStage: patch.categoryStage } : {}),
      ...(patch.categoryReason ? { categoryReason: patch.categoryReason } : {}),
    };
    const categoryId =
      patch.categoryId || patch.category?.primaryCategoryId || row.categoryId;
    if (categoryId) {
      await this.ensureCategory({
        userId,
        categoryId,
        name: patch.category?.primaryCategoryName || categoryId,
      });
    }
    await prisma.$executeRawUnsafe(
      `UPDATE "${ITEM_TABLE}" SET
        "categoryId" = COALESCE(?, "categoryId"),
        "sortOrder" = COALESCE(?, "sortOrder"),
        "progressJson" = COALESCE(?, "progressJson"),
        "stateJson" = ?,
        "visible" = COALESCE(?, "visible"),
        "hiddenAt" = ?,
        "availability" = COALESCE(?, "availability"),
        "lastOpenedAt" = COALESCE(?, "lastOpenedAt"),
        "mutationVersion" = "mutationVersion" + 1,
        "updatedAt" = ?
       WHERE "userId" = ? AND "id" = ?`,
      categoryId || null,
      patch.sortOrder === undefined ? null : numberOrZero(patch.sortOrder),
      patch.progress === undefined
        ? null
        : stringify(patch.progress || null, null),
      stringify(nextState),
      patch.visible === undefined ? null : patch.visible ? 1 : 0,
      patch.hidden === true
        ? now
        : patch.hidden === false
          ? null
          : row.hiddenAt,
      patch.availability || patch.readerAvailability || null,
      patch.lastOpenedAt ? new Date(patch.lastOpenedAt) : null,
      now,
      Number(userId),
      row.id
    );
    return this.listLibrary({ userId });
  },

  softDeleteItem: async function ({ userId, itemId } = {}) {
    if (!userId || !itemId) return null;
    await this.ensureTable();
    const now = new Date();
    await prisma.$executeRawUnsafe(
      `UPDATE "${ITEM_TABLE}" SET
        "visible" = false,
        "hiddenAt" = COALESCE("hiddenAt", ?),
        "deletedAt" = COALESCE("deletedAt", ?),
        "tombstone" = true,
        "mutationVersion" = "mutationVersion" + 1,
        "updatedAt" = ?
       WHERE "userId" = ? AND ("itemId" = ? OR "itemKey" = ? OR "catalogKey" = ?)`,
      now,
      now,
      now,
      Number(userId),
      String(itemId),
      String(itemId),
      String(itemId)
    );
    return this.listLibrary({ userId });
  },

  restoreItem: async function ({ userId, itemId } = {}) {
    if (!userId || !itemId) return null;
    await this.ensureTable();
    const now = new Date();
    await prisma.$executeRawUnsafe(
      `UPDATE "${ITEM_TABLE}" SET
        "visible" = true,
        "hiddenAt" = NULL,
        "deletedAt" = NULL,
        "tombstone" = false,
        "mutationVersion" = "mutationVersion" + 1,
        "updatedAt" = ?
       WHERE "userId" = ? AND ("itemId" = ? OR "itemKey" = ? OR "catalogKey" = ?)`,
      now,
      Number(userId),
      String(itemId),
      String(itemId),
      String(itemId)
    );
    return this.listLibrary({ userId });
  },

  patchCategory: async function ({ userId, categoryId, patch = {} } = {}) {
    if (!userId || !categoryId) return null;
    await this.ensureTable();
    if (patch.deleted) {
      const now = new Date();
      await prisma.$executeRawUnsafe(
        `UPDATE "${CATEGORY_TABLE}" SET "deletedAt" = ?, "mutationVersion" = "mutationVersion" + 1, "updatedAt" = ? WHERE "userId" = ? AND "categoryId" = ?`,
        now,
        now,
        Number(userId),
        String(categoryId)
      );
    } else {
      await this.ensureCategory({
        userId,
        categoryId,
        name: patch.name || categoryId,
        sortOrder: patch.sortOrder || 0,
      });
    }
    return this.listLibrary({ userId });
  },

  reconcileCatalog: async function ({
    userId,
    documents = [],
    workspaceSlug = null,
  } = {}) {
    await this.ensureTable();
    const seen = new Set();
    for (const document of Array.isArray(documents) ? documents : []) {
      const key = await this.upsertCatalog({
        document,
        workspaceSlug: workspaceSlugFrom(document, workspaceSlug),
        availability:
          document.availability || document.readerAvailability || "available",
      });
      if (key) seen.add(key);
    }
    if (userId && seen.size > 0) {
      await prisma.$executeRawUnsafe(
        `UPDATE "${ITEM_TABLE}" SET "availability" = 'available', "updatedAt" = ?
          WHERE "userId" = ? AND "catalogKey" IN (${[...seen].map(() => "?").join(",")})`,
        new Date(),
        Number(userId),
        ...[...seen]
      );
    }
    return userId ? this.listLibrary({ userId }) : { seen: [...seen] };
  },

  snapshot: async function ({ userId = null } = {}) {
    await this.ensureTable();
    const params = userId ? [Number(userId)] : [];
    const userClause = userId ? `WHERE "userId" = ?` : "";
    const itemCounts = await prisma.$queryRawUnsafe(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN "deletedAt" IS NULL AND "tombstone" = false THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN "tombstone" = true THEN 1 ELSE 0 END) AS tombstones,
        SUM(CASE WHEN "availability" != 'available' THEN 1 ELSE 0 END) AS unavailable
       FROM "${ITEM_TABLE}" ${userClause}`,
      ...params
    );
    const catalogCounts = await prisma.$queryRawUnsafe(
      `SELECT "availability", COUNT(*) AS count FROM "${CATALOG_TABLE}" GROUP BY "availability"`
    );
    return {
      userId: userId || null,
      items: itemCounts?.[0] || {},
      catalog: catalogCounts || [],
    };
  },
};

module.exports = { ReaderLibraryRepository };
