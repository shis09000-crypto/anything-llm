const db = {
  catalog: [],
  items: [],
  categories: [],
};

function resetDb() {
  db.catalog = [];
  db.items = [];
  db.categories = [];
}

function upsertBy(collection, predicate, value, update) {
  const existing = collection.find(predicate);
  if (existing) {
    Object.assign(existing, update(value, existing));
    return existing;
  }
  collection.push(value);
  return value;
}

const mockPrisma = {
  $executeRawUnsafe: jest.fn(async (sql, ...params) => {
    if (/CREATE TABLE|CREATE .*INDEX/i.test(sql)) return 0;

    if (sql.includes('INSERT INTO "reader_book_catalog"')) {
      const [
        catalogKey,
        readerDocumentId,
        workspaceSlug,
        title,
        documentType,
        mimeType,
        fingerprint,
        previewStatus,
        thumbnailStatus,
        classificationStatus,
        availability,
        metadataJson,
        createdAt,
        updatedAt,
      ] = params;
      upsertBy(
        db.catalog,
        (row) => row.catalogKey === catalogKey,
        {
          catalogKey,
          readerDocumentId,
          workspaceSlug,
          title,
          documentType,
          mimeType,
          fingerprint,
          previewStatus,
          thumbnailStatus,
          classificationStatus,
          availability,
          metadataJson,
          createdAt,
          updatedAt,
        },
        (next, existing) => ({
          ...existing,
          ...next,
          createdAt: existing.createdAt,
        })
      );
      return 1;
    }

    if (sql.includes('INSERT INTO "reader_library_categories"')) {
      const [categoryId, userId, name, sortOrder, createdAt, updatedAt] =
        params;
      if (sql.includes("DO NOTHING")) {
        const existing = db.categories.find(
          (row) => row.userId === userId && row.categoryId === categoryId
        );
        if (existing) return 0;
      }
      upsertBy(
        db.categories,
        (row) => row.userId === userId && row.categoryId === categoryId,
        {
          categoryId,
          userId,
          name,
          sortOrder,
          createdAt,
          updatedAt,
          deletedAt: null,
          hiddenAt: null,
          mutationVersion: 1,
        },
        (next, existing) => ({
          ...existing,
          name: next.name,
          sortOrder: next.sortOrder,
          deletedAt: null,
          hiddenAt: null,
          mutationVersion: existing.mutationVersion + 1,
          updatedAt: next.updatedAt,
        })
      );
      return 1;
    }

    if (sql.includes('INSERT INTO "reader_library_items"')) {
      const [
        itemId,
        userId,
        catalogKey,
        readerDocumentId,
        workspaceSlug,
        itemKey,
        title,
        categoryId,
        sortOrder,
        progressJson,
        stateJson,
        visible,
        availability,
        addedAt,
        lastOpenedAt,
        createdAt,
        updatedAt,
      ] = params;
      upsertBy(
        db.items,
        (row) => row.userId === userId && row.catalogKey === catalogKey,
        {
          id: db.items.length + 1,
          itemId,
          userId,
          catalogKey,
          readerDocumentId,
          workspaceSlug,
          itemKey,
          title,
          categoryId,
          sortOrder,
          progressJson,
          stateJson,
          visible,
          availability,
          addedAt,
          lastOpenedAt,
          createdAt,
          updatedAt,
          hiddenAt: null,
          deletedAt: null,
          tombstone: false,
          mutationVersion: 1,
        },
        (next, existing) => ({
          ...existing,
          itemKey: next.itemKey,
          title: next.title,
          categoryId: next.categoryId,
          sortOrder: next.sortOrder,
          progressJson: next.progressJson,
          stateJson: next.stateJson,
          visible: next.visible,
          availability: next.availability,
          mutationVersion: existing.mutationVersion + 1,
          updatedAt: next.updatedAt,
        })
      );
      return 1;
    }

    if (sql.includes('"tombstone" = true')) {
      const [, , updatedAt, userId, itemId, itemKey, catalogKey] = params;
      db.items
        .filter(
          (row) =>
            row.userId === userId &&
            [row.itemId, row.itemKey, row.catalogKey].some((value) =>
              [itemId, itemKey, catalogKey].includes(value)
            )
        )
        .forEach((row) => {
          row.visible = false;
          row.hiddenAt = updatedAt;
          row.deletedAt = updatedAt;
          row.tombstone = true;
          row.mutationVersion += 1;
          row.updatedAt = updatedAt;
        });
      return 1;
    }

    if (sql.includes('UPDATE "reader_library_items" SET')) {
      const [
        categoryId,
        sortOrder,
        progressJson,
        stateJson,
        visible,
        hiddenAt,
        availability,
        lastOpenedAt,
        updatedAt,
        userId,
        id,
      ] = params;
      const row = db.items.find(
        (entry) => entry.userId === userId && entry.id === id
      );
      if (!row) return 0;
      if (categoryId !== null) row.categoryId = categoryId;
      if (sortOrder !== null) row.sortOrder = sortOrder;
      if (progressJson !== null) row.progressJson = progressJson;
      row.stateJson = stateJson;
      if (visible !== null) row.visible = visible;
      row.hiddenAt = hiddenAt;
      if (availability !== null) row.availability = availability;
      if (lastOpenedAt !== null) row.lastOpenedAt = lastOpenedAt;
      row.mutationVersion += 1;
      row.updatedAt = updatedAt;
      return 1;
    }

    if (sql.includes('UPDATE "reader_library_categories"')) {
      const [deletedAt, updatedAt, userId, categoryId] = params;
      const row = db.categories.find(
        (entry) => entry.userId === userId && entry.categoryId === categoryId
      );
      if (row) {
        row.deletedAt = deletedAt;
        row.updatedAt = updatedAt;
      }
      return row ? 1 : 0;
    }

    if (sql.includes('"availability" = \'available\'')) {
      const [, userId, ...catalogKeys] = params;
      db.items
        .filter(
          (row) => row.userId === userId && catalogKeys.includes(row.catalogKey)
        )
        .forEach((row) => {
          row.availability = "available";
        });
      return 1;
    }

    return 0;
  }),

  $queryRawUnsafe: jest.fn(async (sql, ...params) => {
    if (sql.includes('SELECT "itemId", "tombstone", "deletedAt"')) {
      const [userId, catalogKey] = params;
      return db.items.filter(
        (row) => row.userId === userId && row.catalogKey === catalogKey
      );
    }

    if (sql.includes('SELECT * FROM "reader_library_categories"')) {
      const [userId] = params;
      return db.categories
        .filter((row) => row.userId === userId)
        .filter((row) =>
          sql.includes('"deletedAt" IS NULL') ? !row.deletedAt : true
        )
        .sort((a, b) => a.sortOrder - b.sortOrder);
    }

    if (sql.includes('SELECT i.*, c."title" AS "catalogTitle"')) {
      const [userId] = params;
      return db.items
        .filter((row) => row.userId === userId)
        .filter((row) =>
          sql.includes('i."deletedAt" IS NULL') ? !row.deletedAt : true
        )
        .filter((row) =>
          sql.includes('i."tombstone" = false') ? !row.tombstone : true
        )
        .filter((row) => (sql.includes('i."visible" = true') ? row.visible : true))
        .map((row) => {
          const catalog = db.catalog.find(
            (entry) => entry.catalogKey === row.catalogKey
          );
          return {
            ...row,
            catalogTitle: catalog?.title || null,
            catalogWorkspaceSlug: catalog?.workspaceSlug || null,
            catalogAvailability: catalog?.availability || null,
            catalogMetadataJson: catalog?.metadataJson || "{}",
          };
        });
    }

    if (
      sql.includes('SELECT * FROM "reader_library_items"') ||
      sql.includes('FROM "reader_library_items" WHERE')
    ) {
      const [userId, itemId, itemKey, catalogKey] = params;
      return db.items.filter(
        (row) =>
          row.userId === userId &&
          [row.itemId, row.itemKey, row.catalogKey].some((value) =>
            [itemId, itemKey, catalogKey].includes(value)
          )
      );
    }

    if (sql.includes("COUNT(*) AS total")) {
      return [
        {
          total: db.items.length,
          active: db.items.filter((row) => !row.deletedAt && !row.tombstone)
            .length,
          tombstones: db.items.filter((row) => row.tombstone).length,
          unavailable: db.items.filter((row) => row.availability !== "available")
            .length,
        },
      ];
    }

    if (sql.includes('FROM "reader_book_catalog" GROUP BY')) {
      const counts = new Map();
      db.catalog.forEach((row) => {
        counts.set(row.availability, (counts.get(row.availability) || 0) + 1);
      });
      return [...counts.entries()].map(([availability, count]) => ({
        availability,
        count,
      }));
    }

    return [];
  }),
};

jest.mock("../../utils/prisma", () => mockPrisma);

const { ReaderDataAuthority } = require("../../models/readerDataAuthority");

describe("ReaderDataAuthority", () => {
  beforeEach(() => {
    resetDb();
    jest.clearAllMocks();
  });

  test("bootstraps local bookshelf into user scoped DB library", async () => {
    const result = await ReaderDataAuthority.bootstrap({
      userId: 7,
      categories: [{ id: "finance", name: "金融经济" }],
      bookshelf: [
        {
          key: "money:main",
          title: "金钱心理学",
          readerDocumentId: "doc-a",
          category: {
            primaryCategoryId: "finance",
            primaryCategoryName: "金融经济",
          },
        },
      ],
    });

    expect(result.bookshelf).toHaveLength(1);
    expect(result.bookshelf[0]).toMatchObject({
      title: "金钱心理学",
      readerDocumentId: "doc-a",
      category: { primaryCategoryId: "finance" },
    });
  });

  test("tombstone blocks old cache from resurrecting a deleted book", async () => {
    await ReaderDataAuthority.bootstrap({
      userId: 7,
      bookshelf: [{ key: "book:main", title: "旧书", readerDocumentId: "doc-a" }],
    });
    const first = await ReaderDataAuthority.listLibrary({ userId: 7 });
    await ReaderDataAuthority.softDeleteItem({
      userId: 7,
      itemId: first.bookshelf[0].libraryItemId,
    });

    await ReaderDataAuthority.bootstrap({
      userId: 7,
      bookshelf: [{ key: "book:main", title: "旧书", readerDocumentId: "doc-a" }],
    });

    const visible = await ReaderDataAuthority.listLibrary({ userId: 7 });
    const all = await ReaderDataAuthority.listLibrary({
      userId: 7,
      includeDeleted: true,
      includeHidden: true,
    });
    expect(visible.bookshelf).toHaveLength(0);
    expect(all.bookshelf[0].tombstone).toBe(true);
  });

  test("bootstrap does not let stale local cache overwrite an existing DB item", async () => {
    await ReaderDataAuthority.bootstrap({
      userId: 7,
      categories: [{ id: "finance", name: "金融经济" }],
      bookshelf: [
        {
          key: "book:main",
          title: "数据库书名",
          readerDocumentId: "doc-a",
          category: {
            primaryCategoryId: "finance",
            primaryCategoryName: "金融经济",
          },
        },
      ],
    });

    await ReaderDataAuthority.patchItem({
      userId: 7,
      itemId: "global:doc-a",
      patch: {
        category: {
          primaryCategoryId: "manual",
          primaryCategoryName: "手动分类",
        },
      },
    });

    await ReaderDataAuthority.bootstrap({
      userId: 7,
      categories: [{ id: "finance", name: "旧缓存分类" }],
      bookshelf: [
        {
          key: "book:main",
          title: "旧缓存书名",
          readerDocumentId: "doc-a",
          category: {
            primaryCategoryId: "finance",
            primaryCategoryName: "旧缓存分类",
          },
        },
      ],
    });

    const result = await ReaderDataAuthority.listLibrary({ userId: 7 });
    expect(result.bookshelf[0]).toMatchObject({
      title: "数据库书名",
      category: { primaryCategoryId: "manual" },
    });
  });

  test("sanitizes legacy cache payload before writing authority metadata", async () => {
    await ReaderDataAuthority.bootstrap({
      userId: 7,
      bookshelf: [
        {
          key: "leaky:main",
          title: "安全书籍",
          readerDocumentId: "doc-safe",
          originalUrl: "https://example.test/original.pdf?token=secret",
          token: "secret-token",
          text: "raw document body",
          category: {
            primaryCategoryId: "safe",
            primaryCategoryName: "安全分类",
          },
        },
      ],
    });

    const result = await ReaderDataAuthority.listLibrary({ userId: 7 });
    expect(result.bookshelf[0]).toMatchObject({
      title: "安全书籍",
      readerDocumentId: "doc-safe",
    });
    expect(result.bookshelf[0].originalUrl).toBeUndefined();
    expect(result.bookshelf[0].token).toBeUndefined();
    expect(result.bookshelf[0].text).toBeUndefined();
    expect(db.items[0].stateJson).not.toContain("secret-token");
    expect(db.items[0].stateJson).not.toContain("raw document body");
  });

  test("catalog reconcile does not add new user library members", async () => {
    await ReaderDataAuthority.reconcileCatalog({
      userId: 7,
      documents: [{ title: "目录里的书", readerDocumentId: "doc-only" }],
    });

    const result = await ReaderDataAuthority.listLibrary({ userId: 7 });
    expect(result.bookshelf).toHaveLength(0);
    expect(db.catalog).toHaveLength(1);
  });

  test("keeps users isolated", async () => {
    await ReaderDataAuthority.bootstrap({
      userId: 7,
      bookshelf: [{ key: "a:main", title: "A", readerDocumentId: "doc-a" }],
    });
    await ReaderDataAuthority.bootstrap({
      userId: 8,
      bookshelf: [{ key: "b:main", title: "B", readerDocumentId: "doc-b" }],
    });

    const userA = await ReaderDataAuthority.listLibrary({ userId: 7 });
    const userB = await ReaderDataAuthority.listLibrary({ userId: 8 });
    expect(userA.bookshelf.map((item) => item.title)).toEqual(["A"]);
    expect(userB.bookshelf.map((item) => item.title)).toEqual(["B"]);
  });
});
