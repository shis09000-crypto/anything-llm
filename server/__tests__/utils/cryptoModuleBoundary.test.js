const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

describe("Crypto module boundary", () => {
  test("HTTP endpoints are thin adapters over the Crypto module", () => {
    const endpointFiles = [
      "endpoints/cryptoCenter.js",
      "endpoints/cryptoHub.js",
      "endpoints/cryptoGateProbe.js",
      "endpoints/cryptoForecasting.js",
    ];

    for (const endpointFile of endpointFiles) {
      const source = read(endpointFile);
      expect(source).toContain('require("../modules/crypto/httpAdapter")');
      expect(source).not.toContain("../utils/cryptoHub");
      expect(source).not.toContain("../utils/cryptoGate");
      expect(source).not.toContain("../utils/cryptoCenter");
    }
  });

  test("Crypto runtime facade does not import endpoint adapters", () => {
    const source = read("modules/crypto/runtime.js");
    expect(source).toContain('require("../../utils/cryptoHub")');
    expect(source).toContain('require("../../utils/cryptoGate")');
    expect(source).not.toContain("endpoints/cryptoCenter");
    expect(source).not.toContain("endpoints/cryptoHub");
    expect(source).not.toContain("endpoints/cryptoGateProbe");
  });

  test("HTTP adapter composes focused crypto route groups", () => {
    const source = read("modules/crypto/httpAdapter.js");
    expect(source).toContain('require("./httpCenterHandlers")');
    expect(source).toContain('require("./httpHubHandlers")');
    expect(source).toContain('require("./httpGateHandlers")');
    expect(source).toContain('require("./httpForecastingHandlers")');
    expect(source).not.toContain("../../utils/cryptoHub");
    expect(source).not.toContain("../../utils/cryptoGate");
  });

  test("private Crypto Hub detail routes use the authenticated account hub", () => {
    const source = read("modules/crypto/httpHubHandlers.js");

    expect(source).toContain(
      "await response.locals.cryptoDataHub.getTradingPairDetail({"
    );
    expect(source).toContain(
      "await response.locals.cryptoDataHub.getBtcSummary({"
    );
    expect(source).not.toContain(
      "await cryptoDataHub.getTradingPairDetail({"
    );
    expect(source).not.toContain("await cryptoDataHub.getBtcSummary({");
  });

  test("DataAccess and background worker use CryptoRuntime facade", () => {
    const repository = read("repositories/cryptoRepository.js");
    const backgroundWorker = read("utils/BackgroundWorkers/index.js");

    expect(repository).toContain('require("../modules/crypto")');
    expect(repository).not.toContain("../utils/cryptoHub");
    expect(repository).not.toContain("../utils/cryptoGate");

    expect(backgroundWorker).toContain('require("../../modules/crypto")');
    expect(backgroundWorker).not.toContain("../cryptoHub/backgroundRuntime");
    expect(backgroundWorker).not.toContain('require("../cryptoHub")');
  });
});
