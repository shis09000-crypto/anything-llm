/* global describe, afterEach, it, expect */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  normalizeRowsForSchema,
} = require("../../../../utils/vectorDbProviders/lance/schema");

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
    const normalized = normalizeRowsForSchema(input, {
      fields: [
        { name: "id", type: { toString: () => "Utf8" } },
        { name: "docId", type: { toString: () => "Utf8" } },
        { name: "wordCount", type: { toString: () => "Float64" } },
      ],
    });

    expect(normalized).toEqual([
      {
        id: "vector-1",
        vector: [1, 2, 3],
        text: "hello",
        docId: "",
        wordCount: 0,
      },
    ]);
    expect(input[0]).not.toHaveProperty("docId");
  });

  it("can append rows that are missing existing string metadata columns", () => {
    tempStorageDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "anythingllm-lance-test-")
    );
    process.env.STORAGE_DIR = tempStorageDir;

    const lanceModule = path.resolve(
      __dirname,
      "../../../../utils/vectorDbProviders/lance"
    );
    const program = `
      const { LanceDb } = require(${JSON.stringify(lanceModule)});
      (async () => {
        const vectorDb = new LanceDb();
        const { client } = await vectorDb.connect();
        try {
          await client.createTable("schema_test", [{
            id: "vector-1", vector: [1, 2, 3], text: "hello",
            docId: "doc-1", docpath: "custom-documents/example.json"
          }]);
          await vectorDb.updateOrCreateCollection(client, [
            { id: "vector-2", vector: [1, 2, 3], text: "world" }
          ], "schema_test");
          const table = await client.openTable("schema_test");
          process.stdout.write(String(await table.countRows()));
        } finally {
          await client.close();
        }
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `;
    const result = spawnSync(process.execPath, ["-e", program], {
      cwd: path.resolve(__dirname, "../../../../.."),
      env: { ...process.env, STORAGE_DIR: tempStorageDir },
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("2");
  });
});
