const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  auditResourceCommunicationAccess,
} = require("../../scripts/audit-resource-communication-access");

describe("resource communication access audit script", () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "resource-access-audit-"));
    fs.mkdirSync(path.join(root, "server/utils"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports bare chat/thread lookups and raw URL logs", () => {
    fs.writeFileSync(
      path.join(root, "server/utils/example.js"),
      [
        "WorkspaceChats.get({ id: Number(chatId) });",
        "WorkspaceThread.get({ id: Number(threadId) });",
        "console.log(`Scraping ${link}`);",
      ].join("\n")
    );

    const result = auditResourceCommunicationAccess({
      rootDir: root,
      scanDirs: ["server/utils"],
      allowlist: [],
    });

    expect(result.success).toBe(false);
    expect(result.findings.map((finding) => finding.id)).toEqual([
      "workspace_chat_id_only_lookup",
      "workspace_thread_id_only_lookup",
      "raw_url_log",
    ]);
  });

  it("respects explicit allowlist entries", () => {
    fs.writeFileSync(
      path.join(root, "server/utils/example.js"),
      "WorkspaceChats.get({ id: Number(chatId) });"
    );

    const result = auditResourceCommunicationAccess({
      rootDir: root,
      scanDirs: ["server/utils"],
      allowlist: [
        {
          id: "workspace_chat_id_only_lookup",
          file: "server/utils/example.js",
        },
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        findings: [],
      })
    );
  });
});
