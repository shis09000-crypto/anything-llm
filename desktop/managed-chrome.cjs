const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

function chromeExecutable() {
  if (process.platform === "darwin")
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (process.platform === "win32") {
    const candidates = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ]
      .filter(Boolean)
      .map((base) =>
        path.join(base, "Google", "Chrome", "Application", "chrome.exe")
      );
    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
  }
  return null;
}

function verifyChrome(binary) {
  if (!binary || !fs.existsSync(binary))
    throw new Error("browser_system_chrome_not_installed");
  if (process.platform === "darwin") {
    const bundle = "/Applications/Google Chrome.app";
    const verified = spawnSync(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", bundle],
      {
        encoding: "utf8",
        timeout: 10_000,
      }
    );
    if (verified.status !== 0)
      throw new Error("browser_system_chrome_signature_invalid");
    const identity = spawnSync(
      "/usr/bin/codesign",
      ["-dv", "--verbose=4", bundle],
      {
        encoding: "utf8",
        timeout: 10_000,
      }
    );
    const details = `${identity.stdout || ""}\n${identity.stderr || ""}`;
    if (!details.includes("TeamIdentifier=EQHXZ8M8AV"))
      throw new Error("browser_system_chrome_publisher_invalid");
  }
  if (process.platform === "win32") {
    const checked = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "param([string]$p); $s=Get-AuthenticodeSignature -LiteralPath $p; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'Google LLC'){exit 2}",
        binary,
      ],
      { encoding: "utf8", timeout: 10_000, windowsHide: true }
    );
    if (checked.status !== 0)
      throw new Error("browser_system_chrome_signature_invalid");
  }
  return binary;
}

function safeUrl(value) {
  const url = new URL(String(value || "about:blank"));
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("browser_system_chrome_url_invalid");
  return url.toString();
}

function openManagedChrome({
  app,
  url,
  profileId,
  networkRoute,
  proxyServer = null,
} = {}) {
  if (networkRoute === "athena_egress" && !proxyServer)
    throw new Error("browser_system_chrome_egress_proxy_missing");
  const binary = verifyChrome(chromeExecutable());
  const directory = path.join(
    app.getPath("userData"),
    "athena-managed-chrome",
    String(profileId || "default")
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .slice(0, 96)
  );
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const args = [
    `--user-data-dir=${directory}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(networkRoute === "direct" ? ["--no-proxy-server"] : []),
    ...(networkRoute === "athena_egress"
      ? [
          `--proxy-server=http://${proxyServer.host}:${proxyServer.port}`,
          "--proxy-bypass-list=<-loopback>",
        ]
      : []),
    safeUrl(url),
  ];
  const child = spawn(binary, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return {
    opened: true,
    driver: "system_chrome",
    networkRoute,
    proxyConnected: networkRoute !== "athena_egress" || Boolean(proxyServer),
  };
}

module.exports = { chromeExecutable, openManagedChrome, verifyChrome };
