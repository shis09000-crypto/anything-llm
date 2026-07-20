const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  validateSiemSettings,
} = require("../../utils/security/securitySiemSink");

describe("security SIEM sink policy", () => {
  let directory;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "athena-siem-"));
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it("accepts HTTPS with a private HMAC credential file", () => {
    const keyFile = path.join(directory, "siem.key");
    fs.writeFileSync(keyFile, Buffer.alloc(32, 7), { mode: 0o600 });
    expect(
      validateSiemSettings({
        ATHENA_SECURITY_SIEM_URL: "https://siem.internal/athena",
        ATHENA_SECURITY_SIEM_HMAC_KEY_FILE: keyFile,
      })
    ).toEqual([]);
  });

  it("rejects plaintext transport and exposed credential files", () => {
    const keyFile = path.join(directory, "siem.key");
    fs.writeFileSync(keyFile, "unsafe", { mode: 0o644 });
    expect(
      validateSiemSettings({
        ATHENA_SECURITY_SIEM_URL: "http://siem.internal/athena",
        ATHENA_SECURITY_SIEM_HMAC_KEY_FILE: keyFile,
      })
    ).toEqual(
      expect.arrayContaining(["siem_https_url_required", "hmac_file_unsafe"])
    );
  });
});
