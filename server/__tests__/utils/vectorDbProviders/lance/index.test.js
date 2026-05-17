/* global describe, afterEach, it, expect */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LanceDb } = require("../../../../utils/vectorDbProviders/lance");

describe("LanceDb schema normalization", () => {
  const originalStorageDir = process.env.STORAGE_DIR;
  let tempStorageDir;

  afterEach(() => {
    if (originalStorageDir === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = originalStorageDir;

    if (tempStorageDir) fs.rmSync(tempStorageDir, { recursive: true });
    tempStorageDir = null;
  });

  it("fills missing Utf8 schema fields before appending rows", () => {
    const input = [{ id: "vector-1", vector: [1, 2, 3], text: "hello" }];
    const normalized = LanceDb.normalizeRowsForSchema(input, {
      fields: [
        { name: "id", type: { toString: () => "Utf8" } },
        { name: "docId", type: { toString: () => "Utf8" } },
        { name: "wordCount", type: { toString: () => "Float64" } },
      ],
    });

    expect(normalized).toEqual([
      { id: "vector-1", vector: [1, 2, 3], text: "hello", docId: "" },
    ]);
    expect(input[0]).not.toHaveProperty("docId");
  });

  it("can append rows that are missing existing string metadata columns", async () => {
    tempStorageDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "anythingllm-lance-test-")
    );
    process.env.STORAGE_DIR = tempStorageDir;

    const vectorDb = new LanceDb();
    const { client } = await vectorDb.connect();
    await client.createTable("schema_test", [
      {
        id: "vector-1",
        vector: [1, 2, 3],
        text: "hello",
        docId: "doc-1",
        docpath: "custom-documents/example.json",
      },
    ]);

    await vectorDb.updateOrCreateCollection(
      client,
      [{ id: "vector-2", vector: [1, 2, 3], text: "world" }],
      "schema_test"
    );

    const table = await client.openTable("schema_test");
    expect(await table.countRows()).toBe(2);
  });
});
