#!/usr/bin/env node
process.env.NODE_ENV ||= "development";

const path = require("path");
const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: path.join(__dirname, "..", envPath) });

const { applyEnvironmentStorage } = require("../utils/environment");
applyEnvironmentStorage();

const prisma = require("../utils/prisma");
const {
  MASTER_KEY_ENV,
  isEncryptedSecret,
  saveSecret,
} = require("../utils/security");
const {
  _private: { hashTemporaryAuthToken },
} = require("../models/temporaryAuthToken");

const MASKED_MEMORY_TEXT = "••••••••";
const TEMP_AUTH_TOKEN_HASH_PREFIX = "sha256:v1:";

function hasArg(name) {
  return process.argv.includes(name);
}

function encryptionReady() {
  return Boolean(String(process.env[MASTER_KEY_ENV] || "").trim());
}

function encryptValue(value = null) {
  if (value === null || value === undefined || value === "") return value;
  const text = String(value);
  if (isEncryptedSecret(text)) return text;
  return saveSecret(text);
}

async function safeSection(name, fn) {
  try {
    return { name, ...(await fn()) };
  } catch (error) {
    return {
      name,
      success: false,
      error: error?.message || String(error),
    };
  }
}

async function migrateSystemPromptVariables({ apply }) {
  const rows = await prisma.system_prompt_variables.findMany({
    select: { id: true, value: true },
  });
  let alreadyProtected = 0;
  let candidates = 0;
  let updated = 0;

  for (const row of rows) {
    if (!row.value) continue;
    if (isEncryptedSecret(row.value)) {
      alreadyProtected += 1;
      continue;
    }
    candidates += 1;
    if (!apply) continue;
    await prisma.system_prompt_variables.update({
      where: { id: row.id },
      data: { value: encryptValue(row.value) },
    });
    updated += 1;
  }

  return {
    success: true,
    scanned: rows.length,
    alreadyProtected,
    candidates,
    updated,
  };
}

async function migrateAgentSqlConnections({ apply }) {
  const setting = await prisma.system_settings.findUnique({
    where: { label: "agent_sql_connections" },
  });
  if (!setting?.value) {
    return {
      success: true,
      scannedConnections: 0,
      alreadyProtected: 0,
      candidates: 0,
      updatedConnections: 0,
      settingUpdated: false,
    };
  }

  const connections = JSON.parse(setting.value);
  let alreadyProtected = 0;
  let candidates = 0;
  let updatedConnections = 0;
  const next = connections.map((connection) => {
    if (!connection?.connectionString) return connection;
    if (isEncryptedSecret(connection.connectionString)) {
      alreadyProtected += 1;
      return connection;
    }
    candidates += 1;
    if (!apply) return connection;
    updatedConnections += 1;
    return {
      ...connection,
      connectionString: encryptValue(connection.connectionString),
    };
  });

  if (apply && updatedConnections > 0) {
    await prisma.system_settings.update({
      where: { label: "agent_sql_connections" },
      data: { value: JSON.stringify(next) },
    });
  }

  return {
    success: true,
    scannedConnections: connections.length,
    alreadyProtected,
    candidates,
    updatedConnections,
    settingUpdated: apply && updatedConnections > 0,
  };
}

async function migrateWorkspaceChatCompactions({ apply }) {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT id, summary, capsule_json
    FROM "workspace_chat_compactions"
  `);
  let alreadyProtected = 0;
  let candidates = 0;
  let updated = 0;

  for (const row of rows) {
    const updates = {};
    for (const field of ["summary", "capsule_json"]) {
      const value = row[field];
      if (!value) continue;
      if (isEncryptedSecret(value)) {
        alreadyProtected += 1;
        continue;
      }
      candidates += 1;
      if (apply) updates[field] = encryptValue(value);
    }
    if (apply && Object.keys(updates).length > 0) {
      await prisma.workspace_chat_compactions.update({
        where: { id: row.id },
        data: updates,
      });
      updated += 1;
    }
  }

  return {
    success: true,
    scanned: rows.length,
    alreadyProtected,
    candidates,
    updated,
  };
}

async function migrateTemporaryAuthTokens({ apply }) {
  const rows = await prisma.temporary_auth_tokens.findMany({
    select: { id: true, token: true },
  });
  let alreadyProtected = 0;
  let candidates = 0;
  let updated = 0;

  for (const row of rows) {
    if (!row.token) continue;
    if (String(row.token).startsWith(TEMP_AUTH_TOKEN_HASH_PREFIX)) {
      alreadyProtected += 1;
      continue;
    }
    candidates += 1;
    if (!apply) continue;
    await prisma.temporary_auth_tokens.update({
      where: { id: row.id },
      data: { token: hashTemporaryAuthToken(row.token) },
    });
    updated += 1;
  }

  return {
    success: true,
    scanned: rows.length,
    alreadyProtected,
    candidates,
    updated,
  };
}

async function sanitizeSensitiveMemoryArchives({ apply }) {
  const rows = await prisma.user_memory_archives.findMany({
    select: { id: true, oldValue: true },
  });
  let alreadyProtected = 0;
  let candidates = 0;
  let updated = 0;

  for (const row of rows) {
    let parsed;
    try {
      parsed = JSON.parse(row.oldValue || "{}");
    } catch {
      alreadyProtected += 1;
      continue;
    }

    if (!parsed?.isSensitive) {
      alreadyProtected += 1;
      continue;
    }
    if (
      parsed.title === MASKED_MEMORY_TEXT &&
      parsed.detail === MASKED_MEMORY_TEXT
    ) {
      alreadyProtected += 1;
      continue;
    }

    candidates += 1;
    if (!apply) continue;
    await prisma.user_memory_archives.update({
      where: { id: row.id },
      data: {
        oldValue: JSON.stringify({
          ...parsed,
          title: MASKED_MEMORY_TEXT,
          detail: MASKED_MEMORY_TEXT,
        }),
      },
    });
    updated += 1;
  }

  return {
    success: true,
    scanned: rows.length,
    alreadyProtected,
    candidates,
    updated,
  };
}

async function main() {
  const apply = hasArg("--apply");
  if (apply && !encryptionReady()) {
    throw new Error(
      `${MASTER_KEY_ENV} is required to apply high-risk encryption migration.`
    );
  }

  const results = [];
  results.push(
    await safeSection("system_prompt_variables.value", () =>
      migrateSystemPromptVariables({ apply })
    )
  );
  results.push(
    await safeSection("system_settings.agent_sql_connections", () =>
      migrateAgentSqlConnections({ apply })
    )
  );
  results.push(
    await safeSection("workspace_chat_compactions", () =>
      migrateWorkspaceChatCompactions({ apply })
    )
  );
  results.push(
    await safeSection("temporary_auth_tokens.token", () =>
      migrateTemporaryAuthTokens({ apply })
    )
  );
  results.push(
    await safeSection("user_memory_archives.sensitive_oldValue", () =>
      sanitizeSensitiveMemoryArchives({ apply })
    )
  );

  const success = results.every((result) => result.success !== false);
  console.log(
    JSON.stringify(
      {
        success,
        mode: apply ? "apply" : "dry-run",
        encryptionReady: encryptionReady(),
        generatedAt: new Date().toISOString(),
        results,
      },
      null,
      2
    )
  );
  process.exit(success ? 0 : 1);
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify(
        { success: false, error: error?.message || String(error) },
        null,
        2
      )
    );
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect?.().catch(() => null);
  });
