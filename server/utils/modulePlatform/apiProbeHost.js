const { MicroModuleServiceHost } = require("../microModules");
const { publicReadinessSnapshot } = require("../runtimeReadiness");
const { moduleReadinessEnvelope } = require("./readiness");
const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const {
  issueThreadTitleLease,
  verifyThreadTitleLease,
} = require("../chats/threadTitleLease");
const { publishThreadTitleUpdate } = require("../chats/threadTitleEvents");
const WorkspaceThread = lazyDataAccessFacade("workspaceThread");

const COLOCATED_MODULES = new Set(["athena-api"]);

function componentSnapshot(moduleId) {
  const publicState = publicReadinessSnapshot();
  if (moduleId === "athena-api") return publicState;
  return { ready: false, status: "not-ready", reasonCode: "module_unknown" };
}

function colocatedModuleReadiness(moduleId) {
  if (!COLOCATED_MODULES.has(moduleId)) return null;
  return moduleReadinessEnvelope(moduleId, componentSnapshot(moduleId), {
    source: "api-control",
  });
}

function createApiProbeHost({
  port = Number(process.env.ATHENA_API_INTERNAL_PORT || 3024),
} = {}) {
  return new MicroModuleServiceHost({
    manifestId: "athena-api",
    role: "api",
    port,
    readiness: () => componentSnapshot("athena-api"),
    registerRoutes: (app) => {
      app.post(
        "/internal/v1/workspace/thread-title/claim",
        async (request, response) => {
          const claim = await WorkspaceThread.claimAutomaticTitle({
            workspaceId: request.body?.workspaceId,
            threadId: request.body?.threadId,
            userId: request.body?.userId ?? null,
            scope: request.body?.scope,
            titleHash: request.body?.titleHash,
          });
          if (!claim)
            return response.status(409).json({
              success: false,
              error: "thread_title_claim_rejected",
            });
          const lease = issueThreadTitleLease({
            workspaceId: Number(request.body.workspaceId),
            threadId: Number(request.body.threadId),
            userId: request.body?.userId ?? null,
            scope: String(request.body.scope),
            titleHash: String(request.body.titleHash),
            expectedTitleVersion: claim.expectedTitleVersion,
          });
          return response.json({
            success: true,
            lease,
            expectedTitleVersion: claim.expectedTitleVersion,
          });
        }
      );
      app.post(
        "/internal/v1/workspace/thread-title/commit",
        async (request, response) => {
          let claims;
          try {
            claims = verifyThreadTitleLease(request.body?.lease);
          } catch (error) {
            return response.status(409).json({
              success: false,
              error: error.message,
            });
          }
          const updatedThread = await WorkspaceThread.updateAutomaticTitle({
            threadId: claims.threadId,
            title: request.body?.title,
            titleSource: request.body?.titleSource || "llm",
            titleHash: claims.titleHash,
            titleMessageScope: claims.scope,
            expectedTitleVersion: claims.expectedTitleVersion,
          });
          if (!updatedThread)
            return response.status(409).json({
              success: false,
              error: "thread_title_commit_conflict",
            });
          publishThreadTitleUpdate(updatedThread);
          return response.json({ success: true, thread: updatedThread });
        }
      );
      app.get(
        "/internal/v1/module-readiness/:moduleId",
        (request, response) => {
          const snapshot = colocatedModuleReadiness(request.params.moduleId);
          if (!snapshot)
            return response.status(404).json({
              success: false,
              error: "module_readiness_provider_not_found",
            });
          return response.status(snapshot.ready ? 200 : 503).json({
            success: snapshot.ready,
            ...snapshot,
          });
        }
      );
    },
    internalRouteCapabilities: {
      "/internal/v1/workspace/thread-title/claim":
        "workspace.thread-title.claim",
      "/internal/v1/workspace/thread-title/commit":
        "workspace.thread-title.commit",
    },
  });
}

module.exports = {
  COLOCATED_MODULES,
  colocatedModuleReadiness,
  componentSnapshot,
  createApiProbeHost,
};
