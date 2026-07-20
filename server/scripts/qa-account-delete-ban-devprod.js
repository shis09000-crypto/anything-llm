#!/usr/bin/env node
const crypto = require("crypto");
const path = require("path");
const readline = require("readline");
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");

const serverRoot = path.resolve(__dirname, "..");
const root = path.resolve(serverRoot, "..");
dotenv.config({ path: path.join(serverRoot, ".env") });

const execute = process.argv.includes("--execute");
const timestamp = String(Date.now());
const testRunId = `qa_devprod_${timestamp}`;
const envs = ["development", "production"];
const baseUrls = {
  development: "http://localhost:3002/api",
  production: "http://localhost:3001/api",
};

const sharedAuthPath = path.join(
  root,
  "server",
  "storage",
  "shared",
  "auth.db"
);
const envDbPaths = {
  development: path.join(
    root,
    "server",
    "storage",
    "development",
    "anythingllm.db"
  ),
  production: path.join(
    root,
    "server",
    "storage",
    "production",
    "anythingllm.db"
  ),
};

function sqliteUrl(dbPath) {
  const url = new URL(`file:${dbPath}`);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "10");
  return url.toString();
}

const authDb = new PrismaClient({
  datasources: { db: { url: sqliteUrl(sharedAuthPath) } },
  log: ["error"],
});
const envDb = Object.fromEntries(
  envs.map((env) => [
    env,
    new PrismaClient({
      datasources: { db: { url: sqliteUrl(envDbPaths[env]) } },
      log: ["error"],
    }),
  ])
);

const state = {
  authUsers: {},
  authUserIds: [],
  authUserHashes: [],
  shadowUsers: { development: {}, production: {} },
  shadowUserIds: { development: [], production: [] },
  workspaces: { development: [], production: [] },
  workspaceIds: { development: [], production: [] },
  threadIds: { development: [], production: [] },
  docIds: { development: [], production: [] },
  vectorIds: { development: [], production: [] },
};

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function stableHash(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function authUserHash(authUserId) {
  return crypto
    .createHash("sha256")
    .update(String(authUserId))
    .digest("hex")
    .slice(0, 16);
}

function qaUsername(kind) {
  return `qa_${kind}_devprod_${timestamp}`;
}

function qaEmail(kind) {
  return `qa+${timestamp}.${kind}@example.test`;
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

async function promptHidden(question) {
  if (process.env.QA_PRIMARY_OWNER_PASSWORD) {
    return process.env.QA_PRIMARY_OWNER_PASSWORD;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  return new Promise((resolve) => {
    const stdin = process.stdin;
    const onData = (char) => {
      char = String(char);
      switch (char) {
        case "\n":
        case "\r":
        case "\u0004":
          stdin.removeListener("data", onData);
          break;
        default:
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0);
          process.stdout.write(question + "*".repeat(rl.line.length));
          break;
      }
    };
    stdin.on("data", onData);
    rl.question(question, (answer) => {
      rl.history = rl.history.slice(1);
      process.stdout.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

async function api(
  env,
  pathPart,
  { method = "GET", token = null, body = null } = {}
) {
  const response = await fetch(`${baseUrls[env]}${pathPart}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? bearer(token) : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: response.status, ok: response.ok, json };
}

async function requireApiOnline(env) {
  try {
    const result = await api(env, "/system/check-token");
    assert(
      result.status === 401 || result.status === 200,
      `${env} API returned unexpected status ${result.status}`
    );
  } catch (error) {
    fail(`${env} API is not reachable at ${baseUrls[env]}: ${error.message}`);
  }
}

function normalizeAllowedEnvs() {
  return JSON.stringify(["production", "development"]);
}

function roleDefaults(role, ownerType = null) {
  return {
    role,
    status: "active",
    suspended: 0,
    allowedEnvs: normalizeAllowedEnvs(),
    ownerType: role === "owner" ? ownerType || "secondary" : null,
    originEnv: "production",
  };
}

async function abortIfQaResidueExists() {
  const authResidue = await authDb.users.findMany({
    where: {
      OR: [{ username: { contains: "qa_" } }, { email: { startsWith: "qa+" } }],
    },
    select: { id: true, username: true, email: true },
  });
  if (authResidue.length > 0) {
    fail(
      `Existing QA auth users found; refusing to run: ${JSON.stringify(authResidue)}`
    );
  }

  for (const env of envs) {
    const [users, workspaces, threads, docs, vectors] = await Promise.all([
      envDb[env].users.findMany({
        where: {
          OR: [
            { username: { contains: "qa_" } },
            { email: { startsWith: "qa+" } },
          ],
        },
        select: { id: true, username: true, email: true },
      }),
      envDb[env].workspaces.findMany({
        where: {
          OR: [{ name: { contains: "qa_" } }, { slug: { contains: "qa-" } }],
        },
        select: { id: true, name: true, slug: true },
      }),
      envDb[env].workspace_threads.findMany({
        where: {
          OR: [
            { name: { contains: "qa_" } },
            { slug: { contains: "qa-" } },
            { title: { contains: "qa_" } },
          ],
        },
        select: { id: true, name: true, slug: true, title: true },
      }),
      envDb[env].workspace_documents.findMany({
        where: {
          OR: [
            { docId: { contains: "qa_" } },
            { filename: { contains: "qa_" } },
            { docpath: { contains: "qa_" } },
          ],
        },
        select: { id: true, docId: true, filename: true },
      }),
      envDb[env].document_vectors.findMany({
        where: {
          OR: [
            { docId: { contains: "qa_" } },
            { vectorId: { contains: "qa_" } },
          ],
        },
        select: { id: true, docId: true, vectorId: true },
      }),
    ]);
    const residue = { users, workspaces, threads, docs, vectors };
    if (Object.values(residue).some((rows) => rows.length > 0)) {
      fail(
        `Existing QA ${env} residue found; refusing to run: ${JSON.stringify(residue)}`
      );
    }
  }
}

async function snapshotNormal() {
  const authUsers = await authDb.users.findMany({
    where: {
      AND: [
        { username: { not: { startsWith: "qa_" } } },
        { email: { not: { startsWith: "qa+" } } },
      ],
    },
    select: {
      id: true,
      username: true,
      email: true,
      role: true,
      status: true,
      suspended: true,
      allowedEnvs: true,
      ownerType: true,
    },
    orderBy: { id: "asc" },
  });
  const authDeletions = await authDb.authEnvironmentDeletion.findMany({
    where: { authUserId: { notIn: state.authUserIds } },
    orderBy: { id: "asc" },
  });

  const envSnapshots = {};
  for (const env of envs) {
    const qaWorkspaceIds = state.workspaceIds[env];
    const qaUserIds = state.shadowUserIds[env];
    const qaDocIds = state.docIds[env];
    const qaHashes = state.authUserHashes;
    const eventLogWhere =
      qaHashes.length > 0
        ? { NOT: qaHashes.map((hash) => ({ metadata: { contains: hash } })) }
        : {};
    const [
      users,
      workspaces,
      workspaceUsers,
      threads,
      chats,
      docs,
      vectors,
      eventLogs,
    ] = await Promise.all([
      envDb[env].users.findMany({
        where: {
          AND: [
            { id: { notIn: qaUserIds } },
            { username: { not: { startsWith: "qa_" } } },
            { email: { not: { startsWith: "qa+" } } },
          ],
        },
        select: {
          id: true,
          authUserId: true,
          username: true,
          email: true,
          role: true,
          status: true,
          suspended: true,
          allowedEnvs: true,
          ownerType: true,
        },
        orderBy: { id: "asc" },
      }),
      envDb[env].workspaces.findMany({
        where: {
          AND: [
            { id: { notIn: qaWorkspaceIds } },
            { slug: { not: { contains: "qa-" } } },
            { name: { not: { startsWith: "qa_" } } },
          ],
        },
        select: { id: true, name: true, slug: true },
        orderBy: { id: "asc" },
      }),
      envDb[env].workspace_users.findMany({
        where: {
          user_id: { notIn: qaUserIds },
          workspace_id: { notIn: qaWorkspaceIds },
        },
        select: { id: true, user_id: true, workspace_id: true },
        orderBy: { id: "asc" },
      }),
      envDb[env].workspace_threads.findMany({
        where: {
          workspace_id: { notIn: qaWorkspaceIds },
          user_id: { notIn: qaUserIds },
          slug: { not: { contains: "qa-" } },
        },
        select: { id: true, slug: true, workspace_id: true, user_id: true },
        orderBy: { id: "asc" },
      }),
      envDb[env].workspace_chats.findMany({
        where: {
          workspaceId: { notIn: qaWorkspaceIds },
          user_id: { notIn: qaUserIds },
        },
        select: { id: true, workspaceId: true, user_id: true, thread_id: true },
        orderBy: { id: "asc" },
      }),
      envDb[env].workspace_documents.findMany({
        where: {
          workspaceId: { notIn: qaWorkspaceIds },
          docId: { not: { in: qaDocIds } },
        },
        select: { id: true, docId: true, filename: true, workspaceId: true },
        orderBy: { id: "asc" },
      }),
      envDb[env].document_vectors.findMany({
        where: {
          docId: { not: { in: qaDocIds } },
          vectorId: { not: { contains: testRunId } },
        },
        select: { id: true, docId: true, vectorId: true },
        orderBy: { id: "asc" },
      }),
      envDb[env].event_logs.findMany({
        where: eventLogWhere,
        select: { id: true, event: true, metadata: true, userId: true },
        orderBy: { id: "asc" },
      }),
    ]);
    envSnapshots[env] = {
      users,
      workspaces,
      workspaceUsers,
      threads,
      chats,
      docs,
      vectors,
      eventLogs,
    };
  }

  const snapshot = { authUsers, authDeletions, envSnapshots };
  return {
    counts: {
      authUsers: authUsers.length,
      authDeletions: authDeletions.length,
      developmentUsers: envSnapshots.development.users.length,
      productionUsers: envSnapshots.production.users.length,
    },
    hash: stableHash(snapshot),
    snapshot,
  };
}

async function seedTempData() {
  const password = `QaTemp!${timestamp}`;
  const passwordHash = bcrypt.hashSync(password, 10);
  const cases = [
    { key: "user", role: "user", ownerType: null },
    { key: "admin", role: "admin", ownerType: null },
    { key: "secondary_owner", role: "owner", ownerType: "secondary" },
  ];

  for (const item of cases) {
    const username = qaUsername(item.key);
    const email = qaEmail(item.key);
    const defaults = roleDefaults(item.role, item.ownerType);
    const authUser = await authDb.users.create({
      data: {
        username,
        displayName: username,
        password: passwordHash,
        email,
        email_verified_at: new Date(),
        seen_recovery_codes: true,
        bio: testRunId,
        dailyMessageLimit: null,
        ...defaults,
      },
    });
    state.authUsers[item.key] = { ...authUser, testPassword: password };
    state.authUserIds.push(authUser.id);
    state.authUserHashes.push(authUserHash(authUser.id));

    for (const env of envs) {
      const shadow = await envDb[env].users.create({
        data: {
          authUserId: authUser.id,
          originEnv: defaults.originEnv,
          username,
          displayName: username,
          password: passwordHash,
          email,
          email_verified_at: new Date(),
          seen_recovery_codes: true,
          bio: testRunId,
          dailyMessageLimit: null,
          role: defaults.role,
          status: defaults.status,
          suspended: defaults.suspended,
          allowedEnvs: defaults.allowedEnvs,
          ownerType: defaults.ownerType,
        },
      });
      state.shadowUsers[env][item.key] = shadow;
      state.shadowUserIds[env].push(shadow.id);
    }
  }

  for (const env of envs) {
    const user = state.shadowUsers[env].user;
    const workspace = await envDb[env].workspaces.create({
      data: {
        name: `${qaUsername("workspace")}_${env}`,
        slug: `qa-workspace-devprod-${timestamp}-${env}`,
        vectorTag: testRunId,
      },
    });
    state.workspaces[env].push(workspace);
    state.workspaceIds[env].push(workspace.id);
    await envDb[env].workspace_users.create({
      data: { user_id: user.id, workspace_id: workspace.id },
    });
    const thread = await envDb[env].workspace_threads.create({
      data: {
        name: `${qaUsername("thread")}_${env}`,
        title: `${qaUsername("thread")}_${env}`,
        slug: `qa-thread-devprod-${timestamp}-${env}`,
        workspace_id: workspace.id,
        user_id: user.id,
      },
    });
    state.threadIds[env].push(thread.id);
    await envDb[env].workspace_chats.create({
      data: {
        workspaceId: workspace.id,
        user_id: user.id,
        thread_id: thread.id,
        prompt: `${testRunId} prompt`,
        response: `${testRunId} response`,
      },
    });
    const docId = `${testRunId}_${env}_doc`;
    state.docIds[env].push(docId);
    await envDb[env].workspace_documents.create({
      data: {
        docId,
        filename: `${testRunId}_${env}.txt`,
        docpath: `custom-documents/${testRunId}_${env}.txt`,
        workspaceId: workspace.id,
        metadata: JSON.stringify({ testRunId }),
      },
    });
    const vector = await envDb[env].document_vectors.create({
      data: {
        docId,
        vectorId: `${testRunId}_${env}_vector`,
      },
    });
    state.vectorIds[env].push(vector.id);
  }

  return password;
}

async function login(env, identifier, password) {
  const result = await api(env, "/request-token", {
    method: "POST",
    body: { identifier, password },
  });
  return result.json;
}

async function loginMustPass(env, identifier, password, label) {
  const result = await login(env, identifier, password);
  assert(
    result.valid === true && result.token,
    `${label} login failed in ${env}`
  );
  return result;
}

async function loginMustFail(
  env,
  identifier,
  password,
  label,
  expectedMessage = null
) {
  const result = await login(env, identifier, password);
  assert(result.valid === false, `${label} unexpectedly logged in to ${env}`);
  if (expectedMessage) {
    assert(
      result.message === expectedMessage,
      `${label} wrong login failure message in ${env}: ${result.message}`
    );
  }
  return result;
}

async function primaryToken(env) {
  const primary = await envDb[env].users.findFirst({
    where: {
      OR: [{ username: "shis500225" }, { email: "shis500225@gmail.com" }],
    },
  });
  assert(primary, `Primary owner shadow user not found in ${env}`);
  assert(
    process.env.JWT_SECRET,
    "JWT_SECRET is unset; cannot mint primary owner test token"
  );
  return jwt.sign(
    {
      id: primary.id,
      userId: primary.id,
      authUserId: primary.authUserId || null,
      username: primary.username,
      role: primary.role,
      allowedEnvs: JSON.parse(primary.allowedEnvs || "[]"),
      lastUserActionAt: Date.now(),
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRY || "30d" }
  );
}

async function reauthPassword(env, token, currentPassword) {
  const result = await api(env, "/system/user/delete/reauth/password", {
    method: "POST",
    token,
    body: { currentPassword },
  });
  assert(
    result.status === 200 && result.json?.success && result.json?.reauthToken,
    `${env} reauth failed: ${JSON.stringify(result.json)}`
  );
  return result.json.reauthToken;
}

async function expectApiSuccess(label, promise) {
  const result = await promise;
  assert(
    result.json?.success === true,
    `${label} failed: ${JSON.stringify(result.json)}`
  );
  return result;
}

async function expectApiFailure(label, promise) {
  const result = await promise;
  assert(
    result.json?.success === false || result.status >= 400,
    `${label} unexpectedly succeeded: ${JSON.stringify(result.json)}`
  );
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deleteTargetByPrimary(env, targetKey, primaryPassword) {
  const token = await primaryToken(env);
  const target = state.shadowUsers[env][targetKey];
  await expectApiSuccess(
    `${env} primary preview delete ${targetKey}`,
    api(env, `/admin/users/${target.id}/delete-preview`, { token })
  );
  const reauthToken = await reauthPassword(env, token, primaryPassword);
  await sleep(5100);
  return expectApiSuccess(
    `${env} primary delete ${targetKey}`,
    api(env, `/admin/users/${target.id}`, {
      method: "DELETE",
      token,
      body: { confirm: true, reauthToken },
    })
  );
}

async function selfDelete(env, key, password) {
  const loginResult = await loginMustPass(
    env,
    state.authUsers[key].email,
    password,
    `${key} self`
  );
  await expectApiSuccess(
    `${env} ${key} self preview delete`,
    api(env, "/system/user/delete-preview", { token: loginResult.token })
  );
  const reauthToken = await reauthPassword(env, loginResult.token, password);
  await sleep(5100);
  return expectApiSuccess(
    `${env} ${key} self delete`,
    api(env, "/system/user", {
      method: "DELETE",
      token: loginResult.token,
      body: { confirm: true, reauthToken },
    })
  );
}

async function runPermissionScenarios(primaryPassword, tempPassword) {
  const results = [];
  const pass = async (name, fn) => {
    await fn();
    results.push({ name, status: "PASS" });
    log(`PASS ${name}`);
  };

  for (const env of envs) {
    await pass(
      `${env}: temp user/admin/secondary owner can login`,
      async () => {
        await loginMustPass(
          env,
          state.authUsers.user.email,
          tempPassword,
          "temp user"
        );
        await loginMustPass(
          env,
          state.authUsers.admin.email,
          tempPassword,
          "temp admin"
        );
        await loginMustPass(
          env,
          state.authUsers.secondary_owner.email,
          tempPassword,
          "temp secondary owner"
        );
      }
    );

    const adminLogin = await loginMustPass(
      env,
      state.authUsers.admin.email,
      tempPassword,
      "admin"
    );
    const secondaryLogin = await loginMustPass(
      env,
      state.authUsers.secondary_owner.email,
      tempPassword,
      "secondary owner"
    );
    const primary = await primaryToken(env);

    await pass(`${env}: admin can ban/unban user`, async () => {
      await expectApiSuccess(
        "admin ban user",
        api(env, `/admin/users/${state.shadowUsers[env].user.id}/ban`, {
          method: "POST",
          token: adminLogin.token,
          body: { reason: testRunId },
        })
      );
      await loginMustFail(
        env,
        state.authUsers.user.email,
        tempPassword,
        "banned user",
        "账号已被禁用"
      );
      await expectApiSuccess(
        "admin unban user",
        api(env, `/admin/users/${state.shadowUsers[env].user.id}/unban`, {
          method: "POST",
          token: adminLogin.token,
          body: {
            restoreRole: "user",
            restoreAllowedEnvs: ["production", "development"],
          },
        })
      );
      await loginMustPass(
        env,
        state.authUsers.user.email,
        tempPassword,
        "unbanned user"
      );
    });

    await pass(
      `${env}: admin cannot ban admin/owner or delete accounts`,
      async () => {
        await expectApiFailure(
          "admin ban admin",
          api(env, `/admin/users/${state.shadowUsers[env].admin.id}/ban`, {
            method: "POST",
            token: adminLogin.token,
            body: { reason: testRunId },
          })
        );
        await expectApiFailure(
          "admin delete user preview",
          api(
            env,
            `/admin/users/${state.shadowUsers[env].user.id}/delete-preview`,
            {
              token: adminLogin.token,
            }
          )
        );
        await expectApiFailure(
          "admin ban secondary owner",
          api(
            env,
            `/admin/users/${state.shadowUsers[env].secondary_owner.id}/ban`,
            {
              method: "POST",
              token: adminLogin.token,
              body: { reason: testRunId },
            }
          )
        );
      }
    );

    await pass(
      `${env}: secondary owner cannot operate owner/primary owner`,
      async () => {
        const primaryShadow = await envDb[env].users.findFirst({
          where: { authUserId: 2 },
        });
        assert(primaryShadow, `${env} primary owner shadow missing`);
        await expectApiFailure(
          "secondary owner ban primary",
          api(env, `/admin/users/${primaryShadow.id}/ban`, {
            method: "POST",
            token: secondaryLogin.token,
            body: { reason: testRunId },
          })
        );
        await expectApiFailure(
          "secondary owner delete primary preview",
          api(env, `/admin/users/${primaryShadow.id}/delete-preview`, {
            token: secondaryLogin.token,
          })
        );
      }
    );

    await pass(
      `${env}: primary owner cannot self-delete or be banned`,
      async () => {
        await expectApiFailure(
          "primary self delete preview",
          api(env, "/system/user/delete-preview", { token: primary })
        );
        const primaryShadow = await envDb[env].users.findFirst({
          where: { authUserId: 2 },
        });
        await expectApiFailure(
          "secondary owner ban primary",
          api(env, `/admin/users/${primaryShadow.id}/ban`, {
            method: "POST",
            token: secondaryLogin.token,
            body: { reason: testRunId },
          })
        );
      }
    );

    await pass(
      `${env}: primary owner can ban/unban secondary owner as owner`,
      async () => {
        await expectApiSuccess(
          "primary ban secondary owner",
          api(
            env,
            `/admin/users/${state.shadowUsers[env].secondary_owner.id}/ban`,
            {
              method: "POST",
              token: primary,
              body: { reason: testRunId },
            }
          )
        );
        await loginMustFail(
          env,
          state.authUsers.secondary_owner.email,
          tempPassword,
          "banned secondary owner",
          "账号已被禁用"
        );
        await expectApiSuccess(
          "primary unban secondary owner",
          api(
            env,
            `/admin/users/${state.shadowUsers[env].secondary_owner.id}/unban`,
            {
              method: "POST",
              token: primary,
              body: {
                restoreRole: "owner",
                restoreAllowedEnvs: ["production", "development"],
              },
            }
          )
        );
        await loginMustPass(
          env,
          state.authUsers.secondary_owner.email,
          tempPassword,
          "unbanned secondary owner"
        );
      }
    );
  }

  await pass(
    "development: primary owner deletes user and writes tombstone",
    async () => {
      await deleteTargetByPrimary("development", "user", primaryPassword);
      const authUser = await authDb.users.findUnique({
        where: { id: state.authUsers.user.id },
      });
      assert(
        authUser,
        "shared auth user should remain after development-only deletion"
      );
      const tombstone = await authDb.authEnvironmentDeletion.findUnique({
        where: {
          authUserId_env: {
            authUserId: state.authUsers.user.id,
            env: "development",
          },
        },
      });
      assert(tombstone, "development tombstone missing");
      const devWorkspace = await envDb.development.workspaces.findUnique({
        where: { id: state.workspaces.development[0].id },
      });
      assert(
        !devWorkspace,
        "development QA workspace still exists after deletion"
      );
      const devVectors = await envDb.development.document_vectors.findMany({
        where: { docId: { in: state.docIds.development } },
      });
      assert(
        devVectors.length === 0,
        "development QA document vectors still exist"
      );
      await loginMustFail(
        "development",
        state.authUsers.user.email,
        tempPassword,
        "deleted development user"
      );
      await loginMustPass(
        "production",
        state.authUsers.user.email,
        tempPassword,
        "production user after dev deletion"
      );
    }
  );

  await pass(
    "production: primary owner deletes remaining user and shared auth",
    async () => {
      await deleteTargetByPrimary("production", "user", primaryPassword);
      const authUser = await authDb.users.findUnique({
        where: { id: state.authUsers.user.id },
      });
      assert(
        !authUser,
        "shared auth user should be deleted after final environment deletion"
      );
      const prodWorkspace = await envDb.production.workspaces.findUnique({
        where: { id: state.workspaces.production[0].id },
      });
      assert(
        !prodWorkspace,
        "production QA workspace still exists after deletion"
      );
      const prodVectors = await envDb.production.document_vectors.findMany({
        where: { docId: { in: state.docIds.production } },
      });
      assert(
        prodVectors.length === 0,
        "production QA document vectors still exist"
      );
    }
  );

  await pass("development: admin can self-delete with reauth", async () => {
    await selfDelete("development", "admin", tempPassword);
    const shadow = await envDb.development.users.findUnique({
      where: { id: state.shadowUsers.development.admin.id },
    });
    assert(
      !shadow,
      "development admin shadow should be gone after self-delete"
    );
  });

  return results;
}

async function cleanup() {
  log("cleanup: removing QA temp data");
  for (const env of envs) {
    const db = envDb[env];
    const userIds = state.shadowUserIds[env];
    const workspaceIds = state.workspaceIds[env];
    const docIds = state.docIds[env];
    await Promise.allSettled([
      db.workspace_chats.deleteMany({
        where: {
          OR: [
            { workspaceId: { in: workspaceIds } },
            { user_id: { in: userIds } },
            { prompt: { contains: testRunId } },
          ],
        },
      }),
      db.workspace_chat_compactions
        .deleteMany({
          where: {
            OR: [
              { workspace_id: { in: workspaceIds } },
              { user_id: { in: userIds } },
              { metadata_json: { contains: testRunId } },
            ],
          },
        })
        .catch(() => null),
      db.workspace_mind_maps
        .deleteMany({
          where: {
            OR: [
              { workspaceId: { in: workspaceIds } },
              { user_id: { in: userIds } },
              { title: { contains: testRunId } },
            ],
          },
        })
        .catch(() => null),
      db.workspace_agent_invocations
        .deleteMany({
          where: {
            OR: [
              { workspace_id: { in: workspaceIds } },
              { user_id: { in: userIds } },
              { prompt: { contains: testRunId } },
            ],
          },
        })
        .catch(() => null),
      db.prompt_history
        .deleteMany({
          where: {
            OR: [
              { workspaceId: { in: workspaceIds } },
              { modifiedBy: { in: userIds } },
              { prompt: { contains: testRunId } },
            ],
          },
        })
        .catch(() => null),
      db.workspace_parsed_files
        .deleteMany({
          where: {
            OR: [
              { workspaceId: { in: workspaceIds } },
              { userId: { in: userIds } },
              { filename: { contains: testRunId } },
            ],
          },
        })
        .catch(() => null),
      db.documentIndexStatus
        .deleteMany({
          where: {
            OR: [
              { workspaceId: { in: workspaceIds } },
              { docId: { in: docIds } },
              { filePath: { contains: testRunId } },
            ],
          },
        })
        .catch(() => null),
      db.document_vectors.deleteMany({
        where: {
          OR: [
            { id: { in: state.vectorIds[env] } },
            { docId: { in: docIds } },
            { vectorId: { contains: testRunId } },
          ],
        },
      }),
      db.workspace_documents.deleteMany({
        where: {
          OR: [
            { workspaceId: { in: workspaceIds } },
            { docId: { in: docIds } },
            { filename: { contains: testRunId } },
          ],
        },
      }),
      db.workspace_threads.deleteMany({
        where: {
          OR: [
            { id: { in: state.threadIds[env] } },
            { workspace_id: { in: workspaceIds } },
            { user_id: { in: userIds } },
            { slug: { contains: `devprod-${timestamp}` } },
          ],
        },
      }),
      db.workspace_users.deleteMany({
        where: {
          OR: [
            { user_id: { in: userIds } },
            { workspace_id: { in: workspaceIds } },
          ],
        },
      }),
      db.workspaces.deleteMany({
        where: {
          OR: [
            { id: { in: workspaceIds } },
            { slug: { contains: `devprod-${timestamp}` } },
            { name: { contains: testRunId } },
          ],
        },
      }),
      db.browser_extension_api_keys
        .deleteMany({ where: { user_id: { in: userIds } } })
        .catch(() => null),
      db.temporary_auth_tokens
        .deleteMany({ where: { userId: { in: userIds } } })
        .catch(() => null),
      db.system_prompt_variables
        .deleteMany({ where: { userId: { in: userIds } } })
        .catch(() => null),
      db.desktop_mobile_devices
        .deleteMany({ where: { userId: { in: userIds } } })
        .catch(() => null),
      db.event_logs.deleteMany({
        where: {
          OR: [
            { userId: { in: userIds } },
            { metadata: { contains: testRunId } },
            { metadata: { contains: `qa+${timestamp}` } },
            { metadata: { contains: "@example.test" } },
            ...state.authUserHashes.map((hash) => ({
              metadata: { contains: hash },
            })),
          ],
        },
      }),
      db.users.deleteMany({
        where: {
          OR: [
            { id: { in: userIds } },
            { authUserId: { in: state.authUserIds } },
            { username: { contains: `devprod_${timestamp}` } },
            { email: { startsWith: `qa+${timestamp}` } },
          ],
        },
      }),
    ]);
    await db.workspace_users
      .deleteMany({
        where: {
          OR: [
            { user_id: { in: userIds } },
            { workspace_id: { in: workspaceIds } },
          ],
        },
      })
      .catch(() => null);
    await db.workspaces
      .deleteMany({
        where: {
          OR: [
            { id: { in: workspaceIds } },
            { slug: { contains: `devprod-${timestamp}` } },
            { name: { contains: testRunId } },
          ],
        },
      })
      .catch(() => null);
    await db.users
      .deleteMany({
        where: {
          OR: [
            { id: { in: userIds } },
            { authUserId: { in: state.authUserIds } },
            { username: { contains: `devprod_${timestamp}` } },
            { email: { startsWith: `qa+${timestamp}` } },
          ],
        },
      })
      .catch(() => null);
  }

  await Promise.allSettled([
    authDb.recovery_codes
      .deleteMany({ where: { user_id: { in: state.authUserIds } } })
      .catch(() => null),
    authDb.password_reset_tokens
      .deleteMany({ where: { user_id: { in: state.authUserIds } } })
      .catch(() => null),
    authDb.email_verification_codes
      .deleteMany({
        where: {
          OR: [
            { user_id: { in: state.authUserIds } },
            { email: { startsWith: `qa+${timestamp}` } },
          ],
        },
      })
      .catch(() => null),
    authDb.passkeyCredential
      .deleteMany({ where: { userId: { in: state.authUserIds } } })
      .catch(() => null),
    authDb.passkeyChallenge
      .deleteMany({ where: { userId: { in: state.authUserIds } } })
      .catch(() => null),
    authDb.trustedLoginDevice
      .deleteMany({ where: { userId: { in: state.authUserIds } } })
      .catch(() => null),
    authDb.zkLoginAttempt
      .deleteMany({ where: { userId: { in: state.authUserIds } } })
      .catch(() => null),
    authDb.authEnvironmentDeletion.deleteMany({
      where: { authUserId: { in: state.authUserIds } },
    }),
    authDb.invites
      .updateMany({
        where: { usedByUserId: { in: state.authUserIds } },
        data: { usedByUserId: null },
      })
      .catch(() => null),
    authDb.users.deleteMany({
      where: {
        OR: [
          { id: { in: state.authUserIds } },
          { username: { contains: `devprod_${timestamp}` } },
          { email: { startsWith: `qa+${timestamp}` } },
        ],
      },
    }),
  ]);
}

async function assertNoResidue() {
  const authResidue = await authDb.users.findMany({
    where: {
      OR: [
        { id: { in: state.authUserIds } },
        { username: { contains: `devprod_${timestamp}` } },
        { email: { startsWith: `qa+${timestamp}` } },
      ],
    },
  });
  assert(
    authResidue.length === 0,
    `Auth QA residue remains: ${JSON.stringify(authResidue)}`
  );
  for (const env of envs) {
    const [users, workspaces, threads, docs, vectors] = await Promise.all([
      envDb[env].users.findMany({
        where: { id: { in: state.shadowUserIds[env] } },
      }),
      envDb[env].workspaces.findMany({
        where: { id: { in: state.workspaceIds[env] } },
      }),
      envDb[env].workspace_threads.findMany({
        where: { id: { in: state.threadIds[env] } },
      }),
      envDb[env].workspace_documents.findMany({
        where: { docId: { in: state.docIds[env] } },
      }),
      envDb[env].document_vectors.findMany({
        where: { docId: { in: state.docIds[env] } },
      }),
    ]);
    assert(
      users.length +
        workspaces.length +
        threads.length +
        docs.length +
        vectors.length ===
        0,
      `${env} QA residue remains: ${JSON.stringify({ users, workspaces, threads, docs, vectors })}`
    );
  }
}

function resetSnapshotFilters() {
  state.authUserIds = [];
  state.authUserHashes = [];
  for (const env of envs) {
    state.shadowUserIds[env] = [];
    state.workspaceIds[env] = [];
    state.docIds[env] = [];
    state.vectorIds[env] = [];
  }
}

async function main() {
  log(`testRunId=${testRunId}`);
  if (!execute) {
    log(
      "dry-run only. Re-run with --execute to create isolated QA data and test APIs."
    );
    return;
  }
  await abortIfQaResidueExists();
  for (const env of envs) await requireApiOnline(env);
  const before = await snapshotNormal();
  log(`beforeHash=${before.hash}`);

  const primaryPassword = await promptHidden(
    "Primary owner password (hidden): "
  );
  assert(primaryPassword, "Primary owner password is required");
  const tempPassword = await seedTempData();
  const afterSeed = await snapshotNormal();
  if (before.hash !== afterSeed.hash) {
    log(`afterSeedHash=${afterSeed.hash}`);
    log(`beforeCounts=${JSON.stringify(before.counts)}`);
    log(`afterSeedCounts=${JSON.stringify(afterSeed.counts)}`);
    log(
      "warning: normal snapshot changed while QA seed exists; final cleanup snapshot will remain authoritative."
    );
  }

  let results = [];
  try {
    results = await runPermissionScenarios(primaryPassword, tempPassword);
  } finally {
    await cleanup();
  }

  await assertNoResidue();
  resetSnapshotFilters();
  const after = await snapshotNormal();
  assert(
    before.hash === after.hash,
    `Normal data snapshot changed after cleanup.\nbefore=${before.hash}\nafter=${after.hash}`
  );
  log(`afterHash=${after.hash}`);
  log(
    JSON.stringify(
      { testRunId, results, cleanup: "PASS", normalDataUnchanged: "PASS" },
      null,
      2
    )
  );
}

main()
  .catch(async (error) => {
    process.stderr.write(`FAIL ${error.message}\n`);
    try {
      await cleanup();
      await assertNoResidue();
      process.stderr.write("cleanup=PASS\n");
    } catch (cleanupError) {
      process.stderr.write(`cleanup=FAIL ${cleanupError.message}\n`);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await authDb.$disconnect().catch(() => null);
    await Promise.all(
      envs.map((env) => envDb[env].$disconnect().catch(() => null))
    );
  });
