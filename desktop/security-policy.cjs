const path = require("path");
const { fileURLToPath } = require("url");

const SECURE_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
});

function browserWindowOptions(preloadPath) {
  return {
    ...SECURE_WEB_PREFERENCES,
    preload: path.resolve(preloadPath),
  };
}

function isRecoveryRendererUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "file:" &&
      path.resolve(fileURLToPath(url)) === path.resolve(__dirname, "recovery.html")
    );
  } catch {
    return false;
  }
}

function isTrustedRendererUrl(rawUrl, serverPort) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "file:") return isRecoveryRendererUrl(rawUrl);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      Number(url.port) === Number(serverPort)
    );
  } catch {
    return false;
  }
}

function isSafeExternalUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function validateDesktopBuildSecurity(packageJson = {}) {
  const preferences = SECURE_WEB_PREFERENCES;
  const win = packageJson?.build?.win || {};
  const errors = [];
  if (preferences.contextIsolation !== true) errors.push("contextIsolation");
  if (preferences.nodeIntegration !== false) errors.push("nodeIntegration");
  if (preferences.sandbox !== true) errors.push("sandbox");
  if (win.verifyUpdateCodeSignature !== true)
    errors.push("verifyUpdateCodeSignature");
  if (win.signAndEditExecutable !== true) errors.push("signAndEditExecutable");
  return { ok: errors.length === 0, errors };
}

module.exports = {
  SECURE_WEB_PREFERENCES,
  browserWindowOptions,
  isRecoveryRendererUrl,
  isSafeExternalUrl,
  isTrustedRendererUrl,
  validateDesktopBuildSecurity,
};
