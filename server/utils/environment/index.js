const fs = require("fs");
const path = require("path");

const VALID_APP_ENVS = new Set(["production", "development"]);
const STORAGE_BASE_ENV = "ANYTHINGLLM_STORAGE_BASE_DIR";
const STORAGE_APPLIED_ENV = "ANYTHINGLLM_ENV_STORAGE_APPLIED";

function appEnvironment() {
  const fallback =
    process.env.NODE_ENV === "production" ? "production" : "development";
  const value = String(process.env.APP_ENV || fallback).trim().toLowerCase();
  if (!VALID_APP_ENVS.has(value)) {
    throw new Error(
      `Invalid APP_ENV "${process.env.APP_ENV}". Expected production or development.`
    );
  }
  return value;
}

function defaultStorageBase() {
  return path.resolve(__dirname, "../../storage");
}

function storageBaseDir() {
  if (process.env[STORAGE_BASE_ENV])
    return path.resolve(process.env[STORAGE_BASE_ENV]);
  if (process.env[STORAGE_APPLIED_ENV] === "true" && process.env.STORAGE_DIR)
    return path.dirname(path.resolve(process.env.STORAGE_DIR));
  return process.env.STORAGE_DIR
    ? path.resolve(process.env.STORAGE_DIR)
    : defaultStorageBase();
}

function storageRoot() {
  if (process.env[STORAGE_APPLIED_ENV] === "true" && process.env.STORAGE_DIR)
    return path.resolve(process.env.STORAGE_DIR);
  return path.join(storageBaseDir(), appEnvironment());
}

function applyEnvironmentStorage() {
  const base = storageBaseDir();
  process.env[STORAGE_BASE_ENV] = base;
  process.env.STORAGE_DIR = path.join(base, appEnvironment());
  process.env[STORAGE_APPLIED_ENV] = "true";
  fs.mkdirSync(process.env.STORAGE_DIR, { recursive: true });
  return process.env.STORAGE_DIR;
}

function storagePath(...segments) {
  return path.join(storageRoot(), ...segments);
}

function ensureStoragePath(...segments) {
  const target = storagePath(...segments);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

function databasePath() {
  return storagePath("anythingllm.db");
}

function vectorNamespacePrefix() {
  return `${appEnvironment()}__`;
}

function vectorNamespace(namespace = "") {
  const raw = String(namespace || "").trim();
  if (!raw) return raw;
  const prefix = vectorNamespacePrefix();
  return raw.startsWith(prefix) ? raw : `${prefix}${raw}`;
}

function unvectorNamespace(namespace = "") {
  const raw = String(namespace || "");
  const prefix = vectorNamespacePrefix();
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

function vectorStoreSummary() {
  return {
    provider: process.env.VECTOR_DB || "lancedb",
    root: storagePath("lancedb"),
    namespacePrefix: vectorNamespacePrefix(),
  };
}

function legacyStorageDetected() {
  const legacyDb = path.join(storageBaseDir(), "anythingllm.db");
  const legacyDocuments = path.join(storageBaseDir(), "documents");
  const legacyReaderDocuments = path.join(storageBaseDir(), "reader-documents");
  return {
    database: fs.existsSync(legacyDb),
    documents: fs.existsSync(legacyDocuments),
    readerDocuments: fs.existsSync(legacyReaderDocuments),
  };
}

function diagnosticSummary() {
  return {
    appEnv: appEnvironment(),
    nodeEnv: process.env.NODE_ENV || null,
    storageRoot: storageRoot(),
    database: { path: databasePath() },
    vectorStore: vectorStoreSummary(),
    featureFlags: {
      telemetryDisabled: process.env.DISABLE_TELEMETRY === "true",
      multiUserMode: process.env.AUTH_TOKEN !== undefined,
    },
    paths: {
      documents: storagePath("documents"),
      directUploads: storagePath("direct-uploads"),
      readerDocuments: storagePath("reader-documents"),
      vectorCache: storagePath("vector-cache"),
      knowledgeGraph: storagePath("knowledge-graph"),
      workspaceSupplements: storagePath("workspace-supplements"),
      assets: storagePath("assets"),
      agentSessions: storagePath("agent-sessions"),
      toolRuns: storagePath("tool-runs"),
    },
    legacyStorageDetected: legacyStorageDetected(),
  };
}

module.exports = {
  appEnvironment,
  applyEnvironmentStorage,
  databasePath,
  diagnosticSummary,
  ensureStoragePath,
  storageBaseDir,
  storagePath,
  storageRoot,
  unvectorNamespace,
  vectorNamespace,
  vectorNamespacePrefix,
};
