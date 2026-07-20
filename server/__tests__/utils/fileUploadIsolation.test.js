const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const {
  _internals: {
    cleanupTemporaryUploadOnResponse,
    isolatedDocumentFilename,
  },
} = require("../../utils/files/multer");

describe("document upload isolation", () => {
  it("preserves the display name while assigning a unique physical name", () => {
    const first = { originalname: "shared-name.txt" };
    const second = { originalname: "shared-name.txt" };

    const firstPhysical = isolatedDocumentFilename(first);
    const secondPhysical = isolatedDocumentFilename(second);

    expect(first.originalname).toBe("shared-name.txt");
    expect(second.originalname).toBe("shared-name.txt");
    expect(firstPhysical).not.toBe(secondPhysical);
    expect(firstPhysical).toMatch(/^[0-9a-f-]+-shared-name\.txt$/);
  });

  it("keeps long Unicode physical names within filesystem limits", () => {
    const file = { originalname: `${"文档".repeat(200)}.pdf` };
    const physical = isolatedDocumentFilename(file);

    expect(Buffer.byteLength(physical, "utf8")).toBeLessThanOrEqual(240);
    expect(physical.endsWith(".pdf")).toBe(true);
    expect(file.originalname.endsWith(".pdf")).toBe(true);
  });

  it("removes an abandoned temporary upload when the response closes", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "athena-upload-cleanup-")
    );
    const target = path.join(directory, "upload.txt");
    fs.writeFileSync(target, "temporary");
    const response = new EventEmitter();

    cleanupTemporaryUploadOnResponse({ file: { path: target } }, response);
    response.emit("finish");

    expect(fs.existsSync(target)).toBe(false);
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
