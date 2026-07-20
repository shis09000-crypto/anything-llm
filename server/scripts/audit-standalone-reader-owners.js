#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");

const STANDALONE_READER_SEGMENT = "__global_reader__";

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    root: null,
    dryRun: true,
    rebindUserId: null,
    rebindAuthUserId: null,
    ids: [],
    execute: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") options.root = argv[++i];
    else if (arg.startsWith("--root="))
      options.root = arg.slice("--root=".length);
    else if (arg === "--fix") options.dryRun = true;
    else if (arg === "--execute") options.execute = true;
    else if (arg === "--rebind-user-id")
      options.rebindUserId = Number(argv[++i]);
    else if (arg.startsWith("--rebind-user-id="))
      options.rebindUserId = Number(arg.slice("--rebind-user-id=".length));
    else if (arg === "--rebind-auth-user-id")
      options.rebindAuthUserId = argv[++i];
    else if (arg.startsWith("--rebind-auth-user-id="))
      options.rebindAuthUserId = arg.slice("--rebind-auth-user-id=".length);
    else if (arg === "--id") options.ids.push(argv[++i]);
    else if (arg.startsWith("--id="))
      options.ids.push(arg.slice("--id=".length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.dryRun && !Number.isFinite(options.rebindUserId)) {
    throw new Error("--fix requires --rebind-user-id");
  }
  if (argv.includes("--fix") && !Number.isFinite(options.rebindUserId)) {
    throw new Error("--fix requires --rebind-user-id");
  }
  options.dryRun = !(argv.includes("--fix") && options.execute);
  return options;
}

function standaloneReaderRoot(root = null) {
  const { storagePath } = require("../utils/environment");
  return path.resolve(
    root || storagePath("reader-documents"),
    STANDALONE_READER_SEGMENT
  );
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function listStandaloneReaderMetadata(root = null) {
  const base = standaloneReaderRoot(root);
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const metadataPath = path.join(base, entry.name, "metadata.json");
      const metadata = safeReadJson(metadataPath);
      return {
        readerDocumentId: entry.name,
        metadataPath,
        metadata,
      };
    })
    .filter((entry) => entry.metadata);
}

function ownerState(metadata = {}) {
  if (!Object.prototype.hasOwnProperty.call(metadata, "ownerUserId"))
    return "legacy_ownerless";
  if (metadata.ownerUserId === null || metadata.ownerUserId === "")
    return "ownerless";
  return "owned";
}

async function auditStandaloneReaderOwners({ root = null } = {}) {
  const entries = listStandaloneReaderMetadata(root);
  const base = standaloneReaderRoot(root);
  const documents = entries.map((entry) => ({
    readerDocumentId: entry.readerDocumentId,
    ownerState: ownerState(entry.metadata),
    ownerUserId: entry.metadata.ownerUserId ?? null,
    ownerAuthUserId: entry.metadata.ownerAuthUserId ?? null,
    metadataFile: path
      .relative(base, entry.metadataPath)
      .split(path.sep)
      .join("/"),
  }));
  return {
    success: true,
    total: documents.length,
    ownerless: documents.filter((doc) => doc.ownerState !== "owned").length,
    documents,
  };
}

async function rebindStandaloneReaderOwners({
  root = null,
  rebindUserId,
  rebindAuthUserId = null,
  ids = [],
  dryRun = true,
} = {}) {
  if (!Number.isFinite(Number(rebindUserId)))
    throw new Error("rebindUserId is required");
  const selected = new Set((ids || []).map(String));
  const entries = listStandaloneReaderMetadata(root).filter((entry) => {
    if (selected.size > 0 && !selected.has(entry.readerDocumentId))
      return false;
    return ownerState(entry.metadata) !== "owned";
  });

  let updated = 0;
  for (const entry of entries) {
    const nextMetadata = {
      ...entry.metadata,
      ownerScopeVersion: 1,
      ownerUserId: Number(rebindUserId),
      ownerAuthUserId: rebindAuthUserId || null,
    };
    if (!dryRun) {
      fs.writeFileSync(
        entry.metadataPath,
        `${JSON.stringify(nextMetadata, null, 2)}\n`
      );
    }
    updated += 1;
  }

  return {
    success: true,
    dryRun,
    matched: entries.length,
    updated,
  };
}

async function main() {
  const options = parseArgs();
  await bootstrapCliRuntime({
    access: options.dryRun ? "read" : "write",
    execute: options.execute,
    requiredTables: ["users", "_prisma_migrations"],
  });
  const root = options.root;
  const audit = await auditStandaloneReaderOwners({ root });
  let rebind = null;
  if (options.rebindUserId !== null) {
    rebind = await rebindStandaloneReaderOwners({
      root,
      rebindUserId: options.rebindUserId,
      rebindAuthUserId: options.rebindAuthUserId,
      ids: options.ids,
      dryRun: options.dryRun,
    });
  }
  console.log(JSON.stringify({ audit, rebind }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  auditStandaloneReaderOwners,
  listStandaloneReaderMetadata,
  ownerState,
  parseArgs,
  rebindStandaloneReaderOwners,
  standaloneReaderRoot,
};
