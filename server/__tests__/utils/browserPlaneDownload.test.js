const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const {
  persistDownloadStream,
} = require("../../utils/browserPlane/workerClient");
const {
  BrowserWorkerRuntime,
} = require("../../utils/browserPlane/workerRuntime");
const { DataAccessCenter } = require("../../utils/dataAccess");

describe("Browser Plane staged downloads", () => {
  let root;

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "athena-browser-download-test-")
    );
  });

  afterEach(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  test("streams an opaque worker download with a bounded hash contract", async () => {
    const payload = Buffer.from("browser-download-payload");
    const destination = path.join(root, "artifact.bin");
    await expect(
      persistDownloadStream(Readable.from(payload), destination, {
        maxBytes: 1_024,
        expectedBytes: payload.length,
      })
    ).resolves.toEqual({
      bytes: payload.length,
      sha256: crypto.createHash("sha256").update(payload).digest("hex"),
    });
    await expect(fs.promises.readFile(destination)).resolves.toEqual(payload);
    expect((await fs.promises.stat(destination)).mode & 0o777).toBe(0o600);
  });

  test("removes the destination when the worker stream exceeds its limit", async () => {
    const destination = path.join(root, "oversized.bin");
    await expect(
      persistDownloadStream(Readable.from(Buffer.alloc(2_048)), destination, {
        maxBytes: 1_024,
      })
    ).rejects.toMatchObject({ code: "browser_download_too_large" });
    await expect(fs.promises.stat(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("download leases are user scoped and deleted without exposing paths", async () => {
    const runtime = new BrowserWorkerRuntime({ minAvailableMemoryBytes: 0 });
    const filePath = path.join(root, "opaque-download");
    await fs.promises.writeFile(filePath, "payload", { mode: 0o600 });
    runtime.sessions.set("session-1", {
      sessionId: "session-1",
      userRef: "u-1",
      profileId: "profile-1",
      tabs: new Map(),
      currentTabId: null,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      closing: null,
      downloads: new Map([
        [
          "download-1",
          {
            downloadId: "download-1",
            filePath,
            filename: "report.pdf",
            mimeType: "application/pdf",
            bytes: 7,
            expiresAt: Date.now() + 60_000,
          },
        ],
      ]),
    });

    expect(() =>
      runtime.downloadFile("session-1", "u-2", "download-1")
    ).toThrow("browser_session_scope_denied");
    await expect(
      runtime.deleteDownload("session-1", "u-1", "download-1")
    ).resolves.toEqual({ deleted: true, downloadId: "download-1" });
    await expect(fs.promises.stat(filePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("DataAccess exposes every Browser Plane profile, task, and artifact method", () => {
    for (const method of [
      "getProfile",
      "claimProfileLease",
      "releaseProfileLease",
      "updateProfileCheckpoint",
      "markProfileDeleted",
      "idleSessions",
      "claimApprovedTask",
      "createArtifact",
      "createArtifactFromFile",
    ]) {
      expect(typeof DataAccessCenter.browserPlane[method]).toBe("function");
    }
    expect(
      typeof DataAccessCenter.toolInvocation.startAutomaticExecution
    ).toBe("function");
  });
});
