const path = require("path");
const { spawnSync } = require("child_process");

const electron = require("electron");
const script = path.join(__dirname, "prepare-browser-egress-core.cjs");
const result = spawnSync(electron, [script, ...process.argv.slice(2)], {
  stdio: "inherit",
  windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
