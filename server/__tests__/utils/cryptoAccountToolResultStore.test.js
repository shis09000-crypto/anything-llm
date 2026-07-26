const fs = require("fs");
const path = require("path");
const {
  storageRoot,
} = require("../../utils/environment");

const {
  storeToolRun,
} = require("../../utils/agents/toolResultStore");

describe("private crypto tool result persistence", () => {
  const root = path.join(storageRoot(), "tool-runs");
  let createdRunDirectory = null;

  afterEach(() => {
    if (createdRunDirectory) {
      fs.rmSync(createdRunDirectory, { recursive: true, force: true });
      createdRunDirectory = null;
    }
  });

  test("stores hashes and status but never raw account values", async () => {
    const privateValue = "987654.321-private-balance";
    const stored = await storeToolRun({
      toolName: "crypto_account_overview",
      arguments: { symbol: "BTC" },
      result: JSON.stringify({
        success: true,
        totalEquityUsd: privateValue,
      }),
      resultPolicy: "account-private/summary-only",
    });
    expect(stored.stored).toBe(true);
    const resultPath = path.join(
      root,
      new Date().toISOString().slice(0, 10),
      stored.runId,
      "result.json"
    );
    createdRunDirectory = path.dirname(resultPath);
    const contents = fs.readFileSync(resultPath, "utf8");
    expect(contents).not.toContain(privateValue);
    expect(contents).not.toContain('"result":');
    expect(contents).toContain('"resultSha256"');
    expect(contents).toContain('"argumentsSha256"');
  });
});
