#!/usr/bin/env node
/* global console, process */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const srcRoot = path.join(repoRoot, "src");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (
      /\.(js|jsx|ts|tsx|mjs)$/.test(entry.name) &&
      !/(\.test\.|\.node\.test\.|__tests__)/.test(full)
    ) {
      files.push(full);
    }
  }
  return files;
}

function has(content, pattern) {
  return pattern instanceof RegExp
    ? pattern.test(content)
    : content.includes(pattern);
}

function notHas(content, pattern) {
  return !has(content, pattern);
}

const files = {
  authTokenStorage: read("src/utils/authTokenStorage.js"),
  authUserStorage: read("src/utils/authUserStorage.js"),
  requestSigningClient: read("src/lib/communication/requestSigningClient.js"),
  deviceIdentityKey: read("src/lib/communication/deviceIdentityKey.js"),
  localCacheCrypto: read("src/utils/security/localCacheCrypto.js"),
  clearSensitiveClientState: read(
    "src/utils/security/clearSensitiveClientState.js"
  ),
  vaultCrypto: read("src/utils/security/vaultCrypto.js"),
  zkLoginStorage: read("src/utils/zkLoginStorage.js"),
  threadHistoryCache: read("src/utils/chat/threadHistoryCache.js"),
  readerStorage: read(
    "src/components/WorkspaceChat/ChatContainer/DocumentReader/storage.js"
  ),
  readerProvider: read(
    "src/components/WorkspaceChat/ChatContainer/DocumentReader/Provider.jsx"
  ),
  promptInputStorage: read("src/hooks/usePromptInputStorage.js"),
  userStateSync: read("src/utils/userStateSync.js"),
  chatDraftProvider: read("src/contexts/ChatThreadDraftProvider.jsx"),
};

const requiredChecks = [
  {
    id: "auth-token-session-only",
    area: "auth",
    pass:
      has(files.authTokenStorage, 'AUTH_TOKEN_STORAGE_MODE = "session"') &&
      has(files.authTokenStorage, "sessionStorage?.setItem(AUTH_TOKEN") &&
      has(files.authTokenStorage, "localStorage?.removeItem(AUTH_TOKEN") &&
      notHas(files.authTokenStorage, "localStorage?.setItem(AUTH_TOKEN"),
  },
  {
    id: "auth-user-session-sanitized",
    area: "auth",
    pass:
      has(files.authUserStorage, "sanitizeStoredAuthUser") &&
      has(files.authUserStorage, "sessionStorage?.setItem(AUTH_USER") &&
      has(files.authUserStorage, "localStorage?.removeItem(AUTH_USER") &&
      notHas(files.authUserStorage, "localStorage?.setItem(AUTH_USER"),
  },
  {
    id: "request-signing-secret-session-only",
    area: "communication",
    pass:
      has(files.requestSigningClient, "SIGNING_SECRET_SESSION_PREFIX") &&
      has(files.requestSigningClient, "safeSessionStorage") &&
      notHas(files.requestSigningClient, /localStorage\.(setItem|getItem)/),
  },
  {
    id: "device-identity-non-extractable-webcrypto",
    area: "communication",
    pass:
      has(files.deviceIdentityKey, "ECDSA") &&
      has(files.deviceIdentityKey, "P-256") &&
      has(files.deviceIdentityKey, /generateKey\([\s\S]*false,[\s\S]*\[/),
  },
  {
    id: "local-cache-aes-gcm-non-extractable",
    area: "local-cache",
    pass:
      has(files.localCacheCrypto, "athena-local-cache:v1") &&
      has(files.localCacheCrypto, "AES-GCM-256") &&
      has(files.localCacheCrypto, /generateKey\([\s\S]*false,[\s\S]*\[/),
  },
  {
    id: "thread-history-cache-sealed-before-storage",
    area: "chat-cache",
    pass:
      has(files.threadHistoryCache, "encryptLocalCachePayload") &&
      has(files.threadHistoryCache, "decryptLocalCachePayload") &&
      has(files.threadHistoryCache, "sealEntry") &&
      has(files.threadHistoryCache, "encryptedPayload"),
  },
  {
    id: "chat-draft-session-cache-sealed",
    area: "chat-cache",
    pass:
      has(files.chatDraftProvider, "encryptLocalCachePayload") &&
      has(files.chatDraftProvider, "decryptLocalCachePayload") &&
      has(files.chatDraftProvider, "secure_storage_encryption_unavailable"),
  },
  {
    id: "prompt-draft-local-legacy-cleared",
    area: "draft-cache",
    pass:
      has(files.promptInputStorage, "persistPromptDraft") &&
      has(files.promptInputStorage, "clearPromptDraft") &&
      has(files.promptInputStorage, "localStorage.removeItem(USER_PROMPT_INPUT_MAP)") &&
      has(files.userStateSync, "athena-chat-draft:v1") &&
      has(files.userStateSync, "encryptLocalCachePayload"),
  },
  {
    id: "reader-local-cache-sealed",
    area: "reader-cache",
    pass:
      has(files.readerStorage, "athena-reader-local-cache:v1") &&
      has(files.readerStorage, "encryptLocalCachePayload") &&
      has(files.readerStorage, "decryptLocalCachePayload") &&
      has(files.readerStorage, "writeReaderLocalJson") &&
      has(files.readerStorage, "readReaderLocalJson"),
  },
  {
    id: "reader-provider-no-direct-document-storage",
    area: "reader-cache",
    pass:
      notHas(files.readerProvider, /localStorage\.setItem\(\s*storageKey/) &&
      notHas(files.readerProvider, /localStorage\.getItem\(\s*storageKey/) &&
      notHas(files.readerProvider, /localStorage\.setItem\(\s*sourcesKey/) &&
      notHas(files.readerProvider, /localStorage\.getItem\(\s*sourcesKey/) &&
      has(files.readerProvider, "writeReaderCurrentDocument") &&
      has(files.readerProvider, "readReaderCurrentDocument") &&
      has(files.readerProvider, "writeReaderSources") &&
      has(files.readerProvider, "readReaderSources"),
  },
  {
    id: "vault-client-key-hierarchy-recovery-lock",
    area: "vault",
    pass:
      has(files.vaultCrypto, "athena-vault-item:v1") &&
      has(files.vaultCrypto, "AES-GCM-256+AES-KW") &&
      has(files.vaultCrypto, "createVaultRecoveryKit") &&
      has(files.vaultCrypto, "recoverVaultKeyHierarchy") &&
      has(files.vaultCrypto, "installVaultAutoLock") &&
      has(files.vaultCrypto, "assertVaultUnlocked"),
  },
  {
    id: "zk-login-device-secret-wrapped",
    area: "device-trust",
    pass:
      has(files.zkLoginStorage, "wrappedSecret") &&
      has(files.zkLoginStorage, "AES-GCM") &&
      has(files.zkLoginStorage, "device-secret-wrap-key") &&
      has(files.zkLoginStorage, "ZK_LOGIN_DEVICE_INDEX"),
  },
  {
    id: "sensitive-clear-paths",
    area: "cleanup",
    pass:
      has(files.clearSensitiveClientState, "removeAuthToken") &&
      has(files.clearSensitiveClientState, "removeStoredAuthUser") &&
      has(files.clearSensitiveClientState, "threadHistoryCache.clearAll") &&
      has(files.clearSensitiveClientState, "clearLocalCacheCryptoKeys"),
  },
];

const forbiddenPatterns = [
  {
    id: "auth-token-local-storage-write",
    pattern: /localStorage\??\.setItem\(\s*AUTH_TOKEN/,
    severity: "high",
  },
  {
    id: "auth-user-local-storage-write",
    pattern: /localStorage\??\.setItem\(\s*AUTH_USER/,
    severity: "high",
  },
  {
    id: "signing-secret-local-storage",
    pattern: /localStorage[\s\S]{0,120}athena_signing_secret_v1/,
    severity: "high",
  },
  {
    id: "reader-provider-direct-document-write",
    pattern: /localStorage\.setItem\(\s*(storageKey|sourcesKey)/,
    severity: "high",
    filePattern: /DocumentReader\/Provider\.jsx$/,
  },
  {
    id: "legacy-prompt-draft-write",
    pattern: /localStorage\.setItem\(\s*USER_PROMPT_INPUT_MAP/,
    severity: "medium",
    filePattern: /usePromptInputStorage\.js$/,
    allowedPattern: /localStorage\.removeItem\(USER_PROMPT_INPUT_MAP\)/,
  },
];

const forbiddenFindings = [];
for (const file of walk(srcRoot)) {
  const rel = path.relative(repoRoot, file).split(path.sep).join("/");
  const content = fs.readFileSync(file, "utf8");
  for (const rule of forbiddenPatterns) {
    if (rule.filePattern && !rule.filePattern.test(rel)) continue;
    if (!rule.pattern.test(content)) continue;
    if (rule.allowedPattern?.test(content)) continue;
    forbiddenFindings.push({
      id: rule.id,
      severity: rule.severity,
      file: rel,
    });
  }
}

const failedChecks = requiredChecks.filter((check) => !check.pass);
const highRiskFindings = forbiddenFindings.filter(
  (finding) => finding.severity === "high"
);

const report = {
  success: failedChecks.length === 0 && highRiskFindings.length === 0,
  generatedAt: new Date().toISOString(),
  summary: {
    requiredChecks: requiredChecks.length,
    failedChecks: failedChecks.length,
    forbiddenFindings: forbiddenFindings.length,
    highRiskFindings: highRiskFindings.length,
  },
  passedChecks: requiredChecks
    .filter((check) => check.pass)
    .map(({ id, area }) => ({ id, area })),
  failedChecks: failedChecks.map(({ id, area }) => ({ id, area })),
  forbiddenFindings,
  acceptedPlaintextClasses: [
    "theme and appearance preferences",
    "workspace ordering and layout preferences",
    "debug flags in development tools",
    "non-sensitive navigation timestamps",
    "sanitized reader library metadata after sensitive fields are stripped",
  ],
  notes: [
    "This is a static coverage audit. Runtime browser storage inspection should be run separately in an authenticated browser session.",
    "IndexedDB CryptoKey records are accepted only when generated non-extractable or used to wrap encrypted payloads.",
  ],
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.success ? 0 : 1);
