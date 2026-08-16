#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");
const {
  requiredEnvironment,
  writeReport,
} = require("../../scripts/athena-3d-test-lib.cjs");

const TRACKS = [
  "face",
  "gaze",
  "head_neck",
  "shoulders",
  "torso",
  "left_arm",
  "right_arm",
  "left_hand",
  "right_hand",
  "left_leg",
  "right_leg",
  "action",
  "speech",
];

function artifactDirectory() {
  const value =
    process.env.ATHENA_3D_E2E_ARTIFACT_DIR ||
    path.resolve(__dirname, "../../reports/athena-3d-center/e2e-artifacts");
  fs.mkdirSync(value, { recursive: true });
  return value;
}

async function main() {
  requiredEnvironment([
    "ATHENA_3D_E2E_BASE_URL",
    "ATHENA_3D_E2E_STORAGE_STATE",
  ]);
  const browser = await chromium.launch({ headless: true });
  const artifacts = artifactDirectory();
  const context = await browser.newContext({
    storageState: process.env.ATHENA_3D_E2E_STORAGE_STATE,
    recordVideo: { dir: artifacts },
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const checks = {};
  try {
    await page.goto(
      `${String(process.env.ATHENA_3D_E2E_BASE_URL).replace(/\/+$/, "")}/3d-center`,
      { waitUntil: "networkidle", timeout: 60_000 }
    );
    await page.getByTestId("athena-3d-center").waitFor();
    checks.center_visible = true;
    checks.thirteen_tracks_visible = (
      await Promise.all(
        TRACKS.map((track) =>
          page.getByTestId(`athena-3d-track-${track}`).count()
        )
      )
    ).every((count) => count === 1);
    checks.eight_face_regions_visible =
      (await page.locator("[data-face-region]").count()) === 8;
    await page.getByTestId("athena-3d-layer-planned").click();
    await page.getByTestId("athena-3d-layer-actual").click();
    checks.timing_layers_switch = true;
    await page.getByTestId("athena-3d-speed-0.5").click();
    await page.getByTestId("athena-3d-speed-2").click();
    checks.speed_controls = true;
    await page.getByTestId("athena-3d-play-pause").click();
    await page.waitForTimeout(150);
    await page.getByTestId("athena-3d-play-pause").click();
    const scrubber = page.getByTestId("athena-3d-scrubber");
    await scrubber.fill(
      String(Math.floor(Number(await scrubber.getAttribute("max")) / 2))
    );
    await page.getByTestId("athena-3d-replay").click();
    checks.play_pause_scrub_replay = true;
    checks.fixture_does_not_call_flash = (
      await page.getByTestId("athena-3d-live-panel").textContent()
    ).includes("显式触发");
    checks.warning_panel_visible =
      (await page.getByTestId("athena-3d-warnings").count()) === 1;
    checks.console_clean = consoleErrors.length === 0;
    await page.screenshot({
      path: path.join(artifacts, "athena-3d-center.png"),
      fullPage: true,
    });
    const status = Object.values(checks).every(Boolean) ? "passed" : "failed";
    const { destination, report } = writeReport("playwright-gate", {
      suite: "playwright",
      status,
      checks,
      console_errors: consoleErrors,
      screenshot: path.join(artifacts, "athena-3d-center.png"),
    });
    console.log(JSON.stringify({ report: destination, ...report }, null, 2));
    if (status !== "passed") process.exitCode = 1;
  } catch (error) {
    await page
      .screenshot({
        path: path.join(artifacts, "athena-3d-center-failure.png"),
        fullPage: true,
      })
      .catch(() => {});
    const { destination } = writeReport("playwright-gate", {
      suite: "playwright",
      status: "failed",
      checks,
      console_errors: consoleErrors,
      error: {
        code: error.code || "ATHENA_3D_E2E_FAILED",
        message: error.message,
      },
    });
    console.error(`${error.stack || error.message}\nReport: ${destination}`);
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  const { destination } = writeReport("playwright-gate", {
    suite: "playwright",
    status: "infrastructure_failed",
    error: {
      code: error.code || "ATHENA_3D_E2E_INFRASTRUCTURE_FAILED",
      message: error.message,
      missing: error.missing || [],
    },
  });
  console.error(`${error.stack || error.message}\nReport: ${destination}`);
  process.exitCode = 1;
});
