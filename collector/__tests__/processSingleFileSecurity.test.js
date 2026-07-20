const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WATCH_DIRECTORY } = require("../utils/constants");
const { processSingleFile } = require("../processSingleFile");

describe("Collector opaque input handles", () => {
  const created = [];

  beforeAll(() => {
    fs.mkdirSync(WATCH_DIRECTORY, { recursive: true });
  });

  afterEach(() => {
    while (created.length) {
      fs.rmSync(created.pop(), { force: true });
    }
  });

  it("rejects path traversal instead of normalizing it", async () => {
    await expect(
      processSingleFile("../outside.txt", { parseOnly: true })
    ).resolves.toMatchObject({
      success: false,
      reason: "collector_invalid_upload_handle",
    });
  });

  it("rejects symbolic-link handles", async () => {
    const target = path.join(
      WATCH_DIRECTORY,
      `target-${crypto.randomUUID()}.txt`
    );
    const link = path.join(WATCH_DIRECTORY, `link-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(target, "safe input");
    fs.symlinkSync(target, link);
    created.push(link, target);

    await expect(
      processSingleFile(path.basename(link), { parseOnly: true })
    ).resolves.toMatchObject({
      success: false,
      reason: "Symbolic-link inputs are not permitted.",
    });
  });

  it("rejects hard-linked handles before a parser can read them", async () => {
    const source = path.join(
      WATCH_DIRECTORY,
      `source-${crypto.randomUUID()}.txt`
    );
    const link = path.join(WATCH_DIRECTORY, `hard-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(source, "hard linked input");
    fs.linkSync(source, link);
    created.push(link, source);

    const result = await processSingleFile(path.basename(link), {
      parseOnly: true,
    });
    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/collector_input_hardlink_forbidden/);
  });
});
