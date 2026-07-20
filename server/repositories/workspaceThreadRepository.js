const { WorkspaceThread } = require("../models/workspaceThread");
const { createModelRepository } = require("./createModelRepository");
const prisma = require("../utils/prisma");
const {
  databaseTableColumns,
} = require("../utils/database/schemaIntrospection");
const {
  throwModelDataAccessError,
} = require("../utils/dataAccess/modelErrors");

const WorkspaceThreadRepository = createModelRepository(WorkspaceThread, {
  domain: "workspace-thread",
  repositoryName: "WorkspaceThreadRepository",
});

WorkspaceThreadRepository.fingerprintManifestForRequest = async function ({
  client = prisma,
  userId = null,
  requireMembership = true,
  requests = [],
} = {}) {
  if (!Array.isArray(requests) || requests.length === 0) return [];
  const workspaceSlugs = [
    ...new Set(requests.map((item) => String(item.workspaceSlug))),
  ];
  const threadSlugs = [
    ...new Set(requests.map((item) => String(item.threadSlug))),
  ];

  try {
    const workspaces = await client.workspaces.findMany({
      where: {
        slug: { in: workspaceSlugs },
        ...(requireMembership
          ? {
              workspace_users: {
                some: { user_id: Number(userId) },
              },
            }
          : {}),
      },
      select: { id: true, slug: true },
    });
    const workspaceBySlug = new Map(
      workspaces.map((workspace) => [workspace.slug, workspace])
    );
    const workspaceIds = workspaces.map((workspace) => Number(workspace.id));
    const foundThreads = workspaceIds.length
      ? await client.workspace_threads.findMany({
          where: {
            workspace_id: { in: workspaceIds },
            user_id: userId ? Number(userId) : null,
            slug: { in: threadSlugs },
          },
          select: {
            id: true,
            workspace_id: true,
            slug: true,
            historyRevision: true,
          },
        })
      : [];
    const fingerprintRows = await this.historyFingerprintManifest({
      threads: foundThreads,
      userId: userId || null,
    });
    const fingerprintByThreadId = new Map(
      fingerprintRows.map((row) => [Number(row.threadId), row])
    );
    const threadByKey = new Map(
      foundThreads.map((thread) => [
        `${thread.workspace_id}:${thread.slug}`,
        thread,
      ])
    );

    return requests.map((requested) => {
      const workspace = workspaceBySlug.get(requested.workspaceSlug);
      const thread = workspace
        ? threadByKey.get(`${workspace.id}:${requested.threadSlug}`)
        : null;
      const fingerprint = thread
        ? fingerprintByThreadId.get(Number(thread.id))
        : null;
      if (!workspace || !thread || !fingerprint) {
        return {
          workspaceSlug: requested.workspaceSlug,
          threadSlug: requested.threadSlug,
          status: "unavailable",
        };
      }
      return {
        workspaceSlug: requested.workspaceSlug,
        threadSlug: requested.threadSlug,
        status:
          requested.fingerprint === fingerprint.historyFingerprint
            ? "unchanged"
            : "changed",
        historyFingerprint: fingerprint.historyFingerprint,
        historyRevision: fingerprint.historyRevision,
        latestChatId: fingerprint.latestChatId,
        latestChatAt:
          fingerprint.latestChatAt?.toISOString?.() ||
          fingerprint.latestChatAt ||
          null,
      };
    });
  } catch (error) {
    throwModelDataAccessError("SyncV2.threadFingerprintManifest", error, {
      requestCount: requests.length,
      workspaceCount: workspaceSlugs.length,
    });
  }
};

WorkspaceThreadRepository.titleMetadataSchemaReady = async function (
  fields = []
) {
  const requiredFields = Array.isArray(fields) ? fields : [];
  const prismaFields =
    prisma._runtimeDataModel?.models?.workspace_threads?.fields?.map(
      (field) => field.name
    ) || [];
  const prismaReady = requiredFields.every((field) =>
    prismaFields.includes(field)
  );

  if (typeof prisma.$queryRawUnsafe !== "function") {
    return { ready: false, prismaReady, dbReady: false };
  }

  const columnNames = await databaseTableColumns(prisma, "workspace_threads");
  const dbReady = requiredFields.every((field) => columnNames.has(field));

  return { ready: prismaReady && dbReady, prismaReady, dbReady };
};

module.exports = { WorkspaceThreadRepository };
