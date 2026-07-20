const RuntimeSettings = require("../runtimeSettings");
const { guardEnabled } = require("../networkGuard");

async function assertCollectorRuntimeSecurity() {
  if (process.env.NODE_ENV !== "production") return true;
  if (
    guardEnabled() &&
    String(process.env.COLLECTOR_ALLOW_ANY_IP || "").toLowerCase() === "true"
  )
    throw new Error(
      "COLLECTOR_ALLOW_ANY_IP is not permitted with Collector Guard V2. Use COLLECTOR_PRIVATE_NETWORK_ALLOWLIST."
    );

  const settings = new RuntimeSettings();
  settings.set(
    "browserLaunchArgs",
    process.env.ANYTHINGLLM_CHROMIUM_ARGS || []
  );
  if (process.env.ATHENA_VERIFY_CHROMIUM_SANDBOX === "false") return true;

  const puppeteer = require("puppeteer");
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: settings.get("browserLaunchArgs"),
    });
    return true;
  } catch (error) {
    throw new Error(
      `Collector Chromium sandbox self-test failed: ${error.message}`
    );
  } finally {
    await browser?.close().catch(() => null);
  }
}

module.exports = { assertCollectorRuntimeSecurity };
