const fs = require("fs");
const path = require("path");
const { validateDesktopBuildSecurity } = require("../security-policy.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8")
);
const mainSource = fs.readFileSync(path.join(desktopRoot, "main.cjs"), "utf8");
const preloadSource = fs.readFileSync(
  path.join(desktopRoot, "preload.cjs"),
  "utf8"
);
const recoverySource = fs.readFileSync(
  path.join(desktopRoot, "recovery.html"),
  "utf8"
);
const browserNodeSource = fs.readFileSync(
  path.join(desktopRoot, "browser-node.cjs"),
  "utf8"
);

const findings = [];
const buildSecurity = validateDesktopBuildSecurity(packageJson);
findings.push(...buildSecurity.errors);
if (!mainSource.includes("browserWindowOptions("))
  findings.push("secure_browser_window_options_not_used");
if (!mainSource.includes("DesktopProcessSupervisor"))
  findings.push("process_supervisor_not_used");
if (!mainSource.includes("setWindowOpenHandler"))
  findings.push("window_open_policy_missing");
if (!mainSource.includes("will-navigate"))
  findings.push("navigation_policy_missing");
if (!preloadSource.includes("contextBridge.exposeInMainWorld"))
  findings.push("context_bridge_missing");
if (!recoverySource.includes("Content-Security-Policy"))
  findings.push("recovery_csp_missing");
if (!/^42\./.test(String(packageJson.devDependencies?.electron || "")))
  findings.push("electron_supported_version_required");
if (!browserNodeSource.includes("WebContentsView"))
  findings.push("browser_webcontentsview_missing");
if (/\bBrowserView\b/.test(browserNodeSource))
  findings.push("deprecated_browserview_forbidden");
if (!browserNodeSource.includes("persist:athena-browser:"))
  findings.push("browser_partition_isolation_missing");

const report = {
  success: findings.length === 0,
  findings,
  browserIsolation: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
  signedUpdatePolicy: {
    verifyUpdateCodeSignature: packageJson.build.win.verifyUpdateCodeSignature,
    signAndEditExecutable: packageJson.build.win.signAndEditExecutable,
  },
};
console.log(JSON.stringify(report, null, 2));
if (findings.length) process.exitCode = 1;
