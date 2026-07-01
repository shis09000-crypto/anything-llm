#!/usr/bin/env node
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");

const serverRoot = path.resolve(__dirname, "..");
const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: path.join(serverRoot, envPath) });

const { storageBaseDir, authDatabaseUrl } = require("../utils/environment");
const { User } = require("../models/user");
const { auditSharedAuthIdentity } = require("./audit-shared-auth-identity");

const VALID_ENVS = ["development", "production"];

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    envs: [...VALID_ENVS],
    check: true,
    fixLinks: false,
    accountIdentifier: null,
    resetPasswordIdentifier: null,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") {
      args.check = true;
      continue;
    }
    if (arg === "--fix-links") {
      args.fixLinks = true;
      continue;
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--env") {
      args.envs = parseEnvList(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--env=")) {
      args.envs = parseEnvList(arg.slice("--env=".length));
      continue;
    }
    if (arg === "--account") {
      args.accountIdentifier = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--account=")) {
      args.accountIdentifier = arg.slice("--account=".length);
      continue;
    }
    if (arg === "--reset-password") {
      args.resetPasswordIdentifier = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--reset-password=")) {
      args.resetPasswordIdentifier = arg.slice("--reset-password=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  args.accountIdentifier = String(args.accountIdentifier || "").trim();
  args.resetPasswordIdentifier = String(
    args.resetPasswordIdentifier || ""
  ).trim();
  return args;
}

function parseEnvList(value = "all") {
  const normalized = String(value || "all")
    .trim()
    .toLowerCase();
  if (normalized === "all") return [...VALID_ENVS];
  const envs = normalized
    .split(",")
    .map((env) => env.trim())
    .filter(Boolean);
  const invalid = envs.filter((env) => !VALID_ENVS.includes(env));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid --env "${invalid.join(",")}". Expected development, production, or all.`
    );
  }
  return [...new Set(envs)];
}

function sqliteUrl(dbPath) {
  const url = new URL(`file:${dbPath}`);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "10");
  return url.toString();
}

function client(url) {
  return new PrismaClient({
    datasources: { db: { url } },
    log: ["error", "warn"],
  });
}

function envDbPath(envName) {
  return path.join(storageBaseDir(), envName, "anythingllm.db");
}

function identityWhere(identifier = "") {
  const value = String(identifier || "").trim();
  const lower = value.toLowerCase();
  const clauses = [];
  if (value) clauses.push({ username: value });
  if (lower && lower.includes("@")) clauses.push({ email: lower });
  if (value) clauses.push({ phone: value });
  return clauses.length > 0 ? { OR: clauses } : null;
}

function shadowIdentityClauses(authUser = {}) {
  const clauses = [{ authUserId: authUser.id }];
  if (authUser.username) clauses.push({ username: authUser.username });
  if (authUser.email) clauses.push({ email: authUser.email });
  if (authUser.phone) clauses.push({ phone: authUser.phone });
  return clauses;
}

function publicAuthUser(authUser = null) {
  if (!authUser) return null;
  return {
    id: authUser.id,
    username: authUser.username,
    email: authUser.email,
    phone: authUser.phone,
    role: authUser.role,
    status: authUser.status,
    allowedEnvs: authUser.allowedEnvs,
    suspended: Boolean(authUser.suspended),
  };
}

function publicShadowUser(user = null) {
  if (!user) return null;
  return {
    id: user.id,
    authUserId: user.authUserId,
    username: user.username,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    allowedEnvs: user.allowedEnvs,
    suspended: Boolean(user.suspended),
  };
}

async function findAuthUser(authDb, identifier = "") {
  const where = identityWhere(identifier);
  if (!where) return null;
  return authDb.users.findFirst({ where });
}

async function openEnvClients(envs = VALID_ENVS) {
  const entries = [];
  for (const envName of envs) {
    const dbPath = envDbPath(envName);
    if (!fs.existsSync(dbPath)) {
      entries.push([envName, { db: null, dbPath, missing: true }]);
      continue;
    }
    entries.push([envName, { db: client(sqliteUrl(dbPath)), dbPath }]);
  }
  return Object.fromEntries(entries);
}

async function auditEnvs({ authDb, envClients, envs, fixLinks, logger }) {
  const summaries = [];
  for (const envName of envs) {
    const envClient = envClients[envName];
    if (!envClient?.db) {
      logger.warn(`[maintain-local-auth] ${envName}: database not found.`);
      summaries.push({ envName, missing: true });
      continue;
    }
    summaries.push(
      await auditSharedAuthIdentity({
        envDb: envClient.db,
        authDb,
        envName,
        dryRun: !fixLinks,
        logger,
      })
    );
  }
  return summaries;
}

async function accountReport({ authDb, envClients, envs, identifier }) {
  if (!identifier) return null;
  const authUser = await findAuthUser(authDb, identifier);
  const report = {
    identifier,
    authUser: publicAuthUser(authUser),
    environments: {},
  };
  if (!authUser) return report;

  for (const envName of envs) {
    const envClient = envClients[envName];
    if (!envClient?.db) {
      report.environments[envName] = { missing: true, shadowUser: null };
      continue;
    }
    const shadowUser = await envClient.db.users.findFirst({
      where: { OR: shadowIdentityClauses(authUser) },
    });
    report.environments[envName] = {
      missing: false,
      shadowUser: publicShadowUser(shadowUser),
      linked:
        Boolean(shadowUser?.authUserId) &&
        Number(shadowUser.authUserId) === Number(authUser.id),
    };
  }
  return report;
}

function logAccountReport(report, logger = console) {
  if (!report) return;
  if (!report.authUser) {
    logger.warn(
      `[maintain-local-auth] account not found in shared auth: ${report.identifier}`
    );
    return;
  }
  logger.log(
    `[maintain-local-auth] shared auth user #${report.authUser.id}: ` +
      `${report.authUser.username || "-"} / ${report.authUser.email || "-"} ` +
      `(${report.authUser.role}, ${report.authUser.status})`
  );
  for (const [envName, envReport] of Object.entries(report.environments)) {
    if (envReport.missing) {
      logger.warn(`[maintain-local-auth] ${envName}: database not found.`);
      continue;
    }
    if (!envReport.shadowUser) {
      logger.warn(`[maintain-local-auth] ${envName}: no shadow user found.`);
      continue;
    }
    logger.log(
      `[maintain-local-auth] ${envName}: shadow user #${envReport.shadowUser.id}, ` +
        `authUserId=${envReport.shadowUser.authUserId || "-"}, ` +
        `linked=${envReport.linked ? "yes" : "no"}`
    );
  }
}

function promptHidden(message) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    if (!stdin.isTTY || !stdout.isTTY) {
      reject(new Error("Password reset requires an interactive TTY."));
      return;
    }

    let value = "";
    const cleanup = () => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\n");
    };
    const onData = (buffer) => {
      const char = buffer.toString("utf8");
      if (char === "\u0003") {
        cleanup();
        reject(new Error("Cancelled."));
        return;
      }
      if (char === "\r" || char === "\n") {
        cleanup();
        resolve(value);
        return;
      }
      if (char === "\u007f" || char === "\b") {
        value = value.slice(0, -1);
        return;
      }
      value += char;
    };

    stdout.write(message);
    stdin.resume();
    stdin.setRawMode?.(true);
    stdin.on("data", onData);
  });
}

async function promptNewPassword() {
  const first = await promptHidden("New local password: ");
  const second = await promptHidden("Confirm new local password: ");
  if (first !== second)
    throw new Error("Password confirmation does not match.");

  const complexity = User.checkPasswordComplexity(first);
  if (!complexity.checkedOK) throw new Error(complexity.error);
  return first;
}

async function resetPassword({ authDb, envClients, envs, identifier, logger }) {
  const authUser = await findAuthUser(authDb, identifier);
  if (!authUser) {
    throw new Error(`Account not found in shared auth: ${identifier}`);
  }

  const password = await promptNewPassword();
  const passwordHash = bcrypt.hashSync(password, 10);
  await authDb.users.update({
    where: { id: authUser.id },
    data: { password: passwordHash },
  });

  for (const envName of envs) {
    const envClient = envClients[envName];
    if (!envClient?.db) continue;
    const result = await envClient.db.users.updateMany({
      where: { OR: shadowIdentityClauses(authUser) },
      data: { password: passwordHash },
    });
    logger.log(
      `[maintain-local-auth] ${envName}: updated ${result.count} shadow password hash(es).`
    );
  }
  logger.log(
    `[maintain-local-auth] password reset complete for shared auth user #${authUser.id}.`
  );
}

async function main() {
  const args = parseArgs();
  const logger = args.json
    ? { log: () => {}, warn: () => {}, error: console.error }
    : console;
  const authDb = client(authDatabaseUrl());
  const envClients = await openEnvClients(args.envs);
  const clients = [
    authDb,
    ...Object.values(envClients).map((entry) => entry.db),
  ];

  try {
    const audits = await auditEnvs({
      authDb,
      envClients,
      envs: args.envs,
      fixLinks: args.fixLinks,
      logger,
    });
    const report = await accountReport({
      authDb,
      envClients,
      envs: args.envs,
      identifier: args.accountIdentifier || args.resetPasswordIdentifier,
    });

    if (!args.json) logAccountReport(report, logger);

    if (args.resetPasswordIdentifier) {
      await resetPassword({
        authDb,
        envClients,
        envs: args.envs,
        identifier: args.resetPasswordIdentifier,
        logger,
      });
    }

    if (args.json) {
      process.stdout.write(JSON.stringify({ audits, report }, null, 2) + "\n");
    }
  } finally {
    await Promise.allSettled(
      clients.filter(Boolean).map((db) => db.$disconnect())
    );
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[maintain-local-auth] ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  accountReport,
  parseArgs,
  resetPassword,
};
