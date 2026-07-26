const {
  reqBody,
  queryParams,
  userFromSession,
  multiUserMode,
} = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  ROLES,
  flexUserRoleValid,
  rolePermitted,
} = require("../utils/middleware/multiUserProtected");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const { DataAccessCenter } = require("../utils/dataAccess");

const WorkspaceCognition = DataAccessCenter.workspaceCognition;
const WorkspaceThread = DataAccessCenter.workspaceThread;
const UserMemory = DataAccessCenter.userMemory;

const workspaceMiddleware = [
  validatedRequest,
  flexUserRoleValid([ROLES.all]),
  validWorkspaceSlug,
];

function canManageShared(response, user = null) {
  if (!multiUserMode(response)) return true;
  return rolePermitted(user?.role, [ROLES.admin, ROLES.owner]);
}

function failureStatus(error) {
  if (/not_found/.test(error?.message || "")) return 404;
  if (/forbidden|not_owned|permission/.test(error?.message || "")) return 403;
  return 400;
}

function workspaceCognitionEndpoints(app) {
  if (!app) return;

  app.get(
    "/workspace/:slug/cognition/profile",
    workspaceMiddleware,
    async (_request, response) => {
      try {
        const profile = await WorkspaceCognition.getLatestProfile(
          response.locals.workspace.id,
          { rebuildIfMissing: true }
        );
        response.status(200).json({ success: true, profile });
      } catch (error) {
        console.error("[WorkspaceCognition] profile", error);
        response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/cognition/items",
    workspaceMiddleware,
    async (request, response) => {
      try {
        const query = queryParams(request);
        const items = await WorkspaceCognition.listItems(
          response.locals.workspace.id,
          {
            assertionType: query.assertionType || null,
            verificationStatus: query.verificationStatus || null,
            limit: query.limit || null,
          }
        );
        response.status(200).json({ success: true, ...items });
      } catch (error) {
        response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/cognition/candidates",
    workspaceMiddleware,
    async (request, response) => {
      try {
        const query = queryParams(request);
        const candidates = await WorkspaceCognition.listCandidates(
          response.locals.workspace.id,
          {
            limit: query.limit,
            includeLegacy: ["1", "true", true].includes(query.includeLegacy),
          }
        );
        response.status(200).json({ success: true, candidates });
      } catch (error) {
        response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/cognition/extraction/state",
    workspaceMiddleware,
    async (_request, response) => {
      try {
        const state = await WorkspaceCognition.listExtractionState(
          response.locals.workspace.id
        );
        response.status(200).json({ success: true, ...state });
      } catch (error) {
        response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/cognition/extraction/jobs",
    workspaceMiddleware,
    async (_request, response) => {
      try {
        const state = await WorkspaceCognition.listExtractionState(
          response.locals.workspace.id
        );
        response.status(200).json({ success: true, jobs: state.jobs });
      } catch (error) {
        response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/cognition/assertions",
    workspaceMiddleware,
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const body = reqBody(request);
        const candidate = await WorkspaceCognition.createManualCandidate({
          workspaceId: response.locals.workspace.id,
          assertionType:
            body.asPosition !== false
              ? "user_position"
              : body.assertionType || "conclusion",
          statement: body.statement,
          origin: "user",
          subjectUserId: user?.id || null,
          stance: body.stance || null,
          rationale: body.rationale || null,
          conditions: body.conditions || {},
        });
        response.status(201).json({
          success: true,
          candidate,
          created: true,
        });
      } catch (error) {
        response
          .status(failureStatus(error))
          .json({ success: false, error: error.message, code: error.code });
      }
    }
  );

  app.post(
    "/workspace/:slug/cognition/extract-thread",
    workspaceMiddleware,
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const body = reqBody(request);
        const threadSlugs = [
          ...new Set(
            [
              ...(Array.isArray(body.threadSlugs) ? body.threadSlugs : []),
              body.threadSlug,
            ]
              .map((slug) => String(slug || "").trim())
              .filter(Boolean)
          ),
        ];
        if (!threadSlugs.length) {
          response.status(400).json({
            success: false,
            error: "thread_slug_required",
          });
          return;
        }
        const threads = [];
        for (const slug of threadSlugs) {
          const thread = await WorkspaceThread.get({
            workspace_id: response.locals.workspace.id,
            slug,
            ...(user?.id ? { user_id: user.id } : {}),
          });
          if (!thread) {
            response
              .status(404)
              .json({ success: false, error: `thread_not_found:${slug}` });
            return;
          }
          threads.push(thread);
        }
        const jobs = [];
        for (const thread of threads) {
          jobs.push(
            await WorkspaceCognition.enqueueThreadBackfill({
              workspaceId: response.locals.workspace.id,
              threadId: thread.id,
              userId: user?.id || null,
              fromChatId: body.fromChatId || null,
            })
          );
        }
        response.status(202).json({
          success: true,
          job: jobs.length === 1 ? jobs[0] : null,
          jobs,
        });
      } catch (error) {
        console.error("[WorkspaceCognition] extract thread", error);
        response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/cognition/extraction/flush",
    workspaceMiddleware,
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const body = reqBody(request);
        let threadId = null;
        if (body.threadSlug) {
          const thread = await WorkspaceThread.get({
            workspace_id: response.locals.workspace.id,
            slug: String(body.threadSlug),
            ...(user?.id ? { user_id: user.id } : {}),
          });
          if (!thread)
            return response
              .status(404)
              .json({ success: false, error: "thread_not_found" });
          threadId = thread.id;
        }
        const job = await WorkspaceCognition.requestFlush({
          workspaceId: response.locals.workspace.id,
          threadId,
          userId: user?.id || null,
          reason: body.reason || "manual",
        });
        response.status(202).json({ success: true, job });
      } catch (error) {
        response.status(400).json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/cognition/extraction/jobs/:id/retry",
    workspaceMiddleware,
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const body = reqBody(request);
        if (body.budgetOverride === "once" && !canManageShared(response, user))
          return response.status(403).json({
            success: false,
            error: "cognitive_budget_override_manager_required",
          });
        const job = await WorkspaceCognition.retryExtractionJob(
          response.locals.workspace.id,
          request.params.id,
          {
            budgetOverride: body.budgetOverride === "once" ? "once" : null,
            actorUserId: user?.id || null,
          }
        );
        if (!job)
          return response
            .status(404)
            .json({ success: false, error: "failed_job_not_found" });
        response.status(202).json({ success: true, job });
      } catch (error) {
        response.status(400).json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/cognition/candidates/:id/reviews",
    workspaceMiddleware,
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const body = reqBody(request);
        const candidates = await WorkspaceCognition.listCandidates(
          response.locals.workspace.id,
          { limit: 500 }
        );
        const candidate = candidates.find(
          (item) => Number(item.id) === Number(request.params.id)
        );
        if (!candidate)
          return response
            .status(404)
            .json({ success: false, error: "candidate_not_found" });
        const manager = canManageShared(response, user);
        const ownsPosition =
          candidate.assertionType === "user_position" &&
          user?.id &&
          Number(candidate.subjectUserId) === Number(user.id);
        const ownsCandidate =
          candidate.origin === "user" &&
          user?.id &&
          Number(candidate.subjectUserId) === Number(user.id);
        if (candidate.assertionType === "user_position" && !ownsPosition) {
          return response
            .status(403)
            .json({ success: false, error: "position_owner_required" });
        }
        if (
          ["decision", "conclusion"].includes(candidate.assertionType) &&
          ["confirmed", "temporary_confirmed"].includes(body.eventType) &&
          !manager
        ) {
          return response.status(403).json({
            success: false,
            error: "shared_assertion_manager_required",
          });
        }
        if (!manager && !ownsCandidate && !ownsPosition)
          return response
            .status(403)
            .json({ success: false, error: "candidate_review_forbidden" });
        const idempotencyKey = String(
          request.get("Idempotency-Key") || body.idempotencyKey || ""
        ).trim();
        const result = await WorkspaceCognition.reviewCandidate({
          workspaceId: response.locals.workspace.id,
          candidateId: request.params.id,
          actorUserId: user?.id || null,
          eventType: body.eventType,
          payload: body.payload || {},
          idempotencyKey,
        });
        response.status(result?.replayed ? 200 : 201).json({
          success: true,
          ...result,
        });
      } catch (error) {
        response
          .status(failureStatus(error))
          .json({ success: false, error: error.message, code: error.code });
      }
    }
  );

  app.get(
    "/workspace/:slug/cognition/items/:itemKey/history",
    workspaceMiddleware,
    async (request, response) => {
      try {
        const history = await WorkspaceCognition.itemHistory(
          response.locals.workspace.id,
          request.params.itemKey
        );
        response.status(200).json({ success: true, ...history });
      } catch (error) {
        response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/cognition/ledger",
    workspaceMiddleware,
    async (_request, response) => {
      try {
        const ledger = await WorkspaceCognition.listLedgerItems(
          response.locals.workspace.id
        );
        response.status(200).json({ success: true, ...ledger });
      } catch (error) {
        response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/cognition/relations",
    workspaceMiddleware,
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const body = reqBody(request);
        const items = await WorkspaceCognition.listItems(
          response.locals.workspace.id,
          { limit: 500 }
        );
        const from = items.assertions.find(
          (item) => Number(item.id) === Number(body.fromAssertionId)
        );
        const to = items.assertions.find(
          (item) => Number(item.id) === Number(body.toAssertionId)
        );
        if (!from?.canonicalItemId || !to?.canonicalItemId)
          return response.status(400).json({
            success: false,
            error: "canonical_relation_targets_required",
          });
        const relationMap = {
          conflicts_with: "contradicts",
          supports: "confirms",
          refutes: "contradicts",
          depends_on: "qualifies",
          supersedes: "supersedes",
          derived_from: "extends",
        };
        const candidate = await WorkspaceCognition.createManualCandidate({
          workspaceId: response.locals.workspace.id,
          assertionType: from.assertionType,
          statement: from.statement,
          origin: "user",
          subjectUserId: user?.id || null,
          suggestedRelation: {
            relationType: relationMap[body.relationType] || "contradicts",
            targetItemId: to.canonicalItemId,
            rationale: body.rationale || "manual_dispute_candidate",
          },
        });
        response.status(201).json({ success: true, candidate });
      } catch (error) {
        response
          .status(failureStatus(error))
          .json({ success: false, error: error.message, code: error.code });
      }
    }
  );

  app.post(
    "/workspace/:slug/cognition/import-account-memory",
    workspaceMiddleware,
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        if (!user?.id || !user?.authUserId) {
          response
            .status(400)
            .json({ success: false, error: "account_memory_owner_required" });
          return;
        }
        const requestedIds = new Set(
          (reqBody(request).memoryIds || [])
            .map(Number)
            .filter(Number.isInteger)
        );
        const blocks = await UserMemory.blocks(
          UserMemory.memoryOwnerIdFromSessionUser(user),
          { limit: 500, detail: "full" }
        );
        const memories = blocks
          .flatMap((block) => block.items || [])
          .filter((memory) => requestedIds.has(Number(memory.id)));
        const categoryType = {
          decisions: "decision",
          open_topics: "open_question",
          preferences: "constraint",
          projects: "hypothesis",
          facts: "conclusion",
          interests: "hypothesis",
        };
        const imported = [];
        for (const memory of memories) {
          const statement = `${memory.title}：${memory.detail}`;
          const candidate = await WorkspaceCognition.createManualCandidate({
            workspaceId: response.locals.workspace.id,
            assertionType:
              categoryType[memory.category] === "conclusion"
                ? "user_position"
                : categoryType[memory.category] || "user_position",
            statement,
            origin: "user",
            subjectUserId: user.id,
            stance: "supports",
            evidence: [
              {
                evidenceKind: "context",
                sourceType: "manual_note",
                sourceRef: `account-memory:${memory.id}`,
                sourceWorkspaceId: response.locals.workspace.id,
                excerpt: statement,
                confidence: 0.5,
                metadata: {
                  accountMemoryId: memory.id,
                  category: memory.category,
                },
              },
            ],
          });
          imported.push({ candidate });
        }
        response.status(200).json({ success: true, imported });
      } catch (error) {
        response.status(400).json({ success: false, error: error.message });
      }
    }
  );

  app.patch(
    "/workspace/:slug/cognition/assertions/:id",
    workspaceMiddleware,
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const workspaceId = response.locals.workspace.id;
        const items = await WorkspaceCognition.listItems(workspaceId, {
          limit: 500,
        });
        const existing = items.assertions.find(
          (item) => Number(item.id) === Number(request.params.id)
        );
        if (!existing) {
          response
            .status(404)
            .json({ success: false, error: "assertion_not_found" });
          return;
        }
        const body = reqBody(request);
        const manager = canManageShared(response, user);
        const ownsCandidate =
          user?.id && Number(existing.createdByUserId) === Number(user.id);
        const formalConfirmation = ["user_confirmed", "contested"].includes(
          body.verificationStatus
        );
        if (
          formalConfirmation &&
          ["decision", "conclusion"].includes(existing.assertionType) &&
          !manager
        ) {
          response.status(403).json({
            success: false,
            error: "shared_assertion_manager_required",
          });
          return;
        }
        if (!manager && !ownsCandidate) {
          response
            .status(403)
            .json({ success: false, error: "assertion_not_owned" });
          return;
        }
        if (existing.canonicalItemId) {
          await WorkspaceCognition.reviseCanonicalItemFromProjection({
            workspaceId,
            canonicalItemId: existing.canonicalItemId,
            actorUserId: user?.id || null,
            assertionPatch: body,
          });
          const refreshed = await WorkspaceCognition.listItems(workspaceId, {
            limit: 500,
          });
          return response.status(200).json({
            success: true,
            assertion: refreshed.assertions.find(
              (item) => Number(item.id) === Number(existing.id)
            ),
          });
        }
        const assertion = await WorkspaceCognition.patchAssertion(
          workspaceId,
          request.params.id,
          body
        );
        response.status(200).json({ success: true, assertion });
      } catch (error) {
        response
          .status(failureStatus(error))
          .json({ success: false, error: error.message, code: error.code });
      }
    }
  );

  app.patch(
    "/workspace/:slug/cognition/positions/:id",
    workspaceMiddleware,
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const workspaceId = response.locals.workspace.id;
        const items = await WorkspaceCognition.listItems(workspaceId, {
          limit: 500,
        });
        const existing = items.positions.find(
          (item) => Number(item.id) === Number(request.params.id)
        );
        if (!existing) {
          response
            .status(404)
            .json({ success: false, error: "position_not_found" });
          return;
        }
        if (
          multiUserMode(response) &&
          (!user?.id || Number(existing.subjectUserId) !== Number(user.id))
        ) {
          response
            .status(403)
            .json({ success: false, error: "position_owner_required" });
          return;
        }
        if (existing.canonicalPositionVersionId) {
          const assertion = items.assertions.find(
            (item) => Number(item.id) === Number(existing.assertionId)
          );
          if (assertion?.canonicalItemId) {
            await WorkspaceCognition.reviseCanonicalItemFromProjection({
              workspaceId,
              canonicalItemId: assertion.canonicalItemId,
              actorUserId: user?.id || null,
              positionId: existing.id,
              positionPatch: reqBody(request),
            });
            const refreshed = await WorkspaceCognition.listItems(workspaceId, {
              limit: 500,
            });
            return response.status(200).json({
              success: true,
              position: refreshed.positions.find(
                (item) => Number(item.id) === Number(existing.id)
              ),
            });
          }
        }
        const position = await WorkspaceCognition.patchPosition(
          workspaceId,
          request.params.id,
          reqBody(request)
        );
        response.status(200).json({ success: true, position });
      } catch (error) {
        response
          .status(failureStatus(error))
          .json({ success: false, error: error.message, code: error.code });
      }
    }
  );

  app.patch(
    "/workspace/:slug/cognition/evidence/:id",
    workspaceMiddleware,
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        if (!canManageShared(response, user)) {
          response
            .status(403)
            .json({ success: false, error: "manager_required" });
          return;
        }
        const evidence = await WorkspaceCognition.patchEvidence(
          response.locals.workspace.id,
          request.params.id,
          reqBody(request)
        );
        if (!evidence) {
          response
            .status(404)
            .json({ success: false, error: "evidence_not_found" });
          return;
        }
        if (evidence.canonicalEvidenceId) {
          await WorkspaceCognition.appendEvidencePolicyEvent({
            workspaceId: response.locals.workspace.id,
            evidenceId: evidence.canonicalEvidenceId,
            actorUserId: user?.id || null,
            patch: reqBody(request),
            idempotencyKey: `evidence-policy:${evidence.id}:${Date.now()}`,
          });
        }
        response.status(200).json({ success: true, evidence });
      } catch (error) {
        response
          .status(failureStatus(error))
          .json({ success: false, error: error.message, code: error.code });
      }
    }
  );

  app.post(
    "/workspace/:slug/cognition/profile/rebuild",
    workspaceMiddleware,
    async (_request, response) => {
      try {
        await WorkspaceCognition.rebuildCanonicalProfile(
          response.locals.workspace.id
        );
        const profile = await WorkspaceCognition.getLatestProfile(
          response.locals.workspace.id
        );
        response.status(200).json({ success: true, profile });
      } catch (error) {
        response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );
}

module.exports = { workspaceCognitionEndpoints, canManageShared };
