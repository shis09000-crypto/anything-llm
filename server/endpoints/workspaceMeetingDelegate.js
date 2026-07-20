const { v4: uuidv4 } = require("uuid");
const { jsonrepair } = require("jsonrepair");
const { reqBody, userFromSession } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  ROLES,
  flexUserRoleValid,
} = require("../utils/middleware/multiUserProtected");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const { canManageShared } = require("./workspaceCognition");
const { DataAccessCenter } = require("../utils/dataAccess");
const { getTaskConnector } = require("../utils/llmTasks");
const {
  requestChatToolApproval,
  respondToChatToolApproval,
} = require("../utils/chats/toolApproval");
const {
  buildMeetingMessages,
  controlledRetrieve,
  normalizeMeetingOutput,
  resolveWhitelistedDocumentIds,
  snapshotForPacket,
} = require("../utils/workspaceCognition/meetingContext");
const { writeResponseChunk } = require("../utils/helpers/chat/responses");
const {
  setSseTransportHeaders,
} = require("../utils/security/transportSecurity");

const WorkspaceMeetingDelegate = DataAccessCenter.workspaceMeetingDelegate;
const WorkspaceChats = DataAccessCenter.workspaceChat;
const WorkspaceCognition = DataAccessCenter.workspaceCognition;

const workspaceMiddleware = [
  validatedRequest,
  flexUserRoleValid([ROLES.all]),
  validWorkspaceSlug,
];

function parseJson(value = "") {
  const text = String(value || "")
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(text);
  } catch {}
  try {
    return JSON.parse(jsonrepair(text));
  } catch {
    return { text: text || "当前授权资料不足", metadata: {} };
  }
}

function ownsPacket(packet, user, response) {
  if (canManageShared(response, user)) return true;
  return user?.id && Number(packet?.createdByUserId) === Number(user.id);
}

async function requireOwnedPacket({ request, response }) {
  const user = await userFromSession(request, response);
  const packet = await WorkspaceMeetingDelegate.getPacket(
    response.locals.workspace.id,
    request.params.id
  );
  return {
    user,
    packet,
    allowed: !!packet && ownsPacket(packet, user, response),
  };
}

function endpointError(response, error) {
  const message = error?.message || String(error);
  const status = /not_found|required/.test(message)
    ? 404
    : /forbidden|cannot|unconfirmed|disclosure|stale|capsule|only_draft/.test(
          message
        )
      ? 409
      : 400;
  response
    .status(status)
    .json({ success: false, error: message, code: error?.code });
}

async function resolveCommitment({ response, user, session, proposal }) {
  if (!proposal?.actionType) return null;
  const validation = await WorkspaceMeetingDelegate.validateCommitment({
    workspaceId: session.session.workspaceId,
    packetId: session.packet.id,
    proposal,
  });
  let approved = validation.allowed;
  let approvalAudit = null;
  if (validation.requiresApproval) {
    const approval = await requestChatToolApproval({
      response,
      userId: user?.id,
      skillName: "propose_commitment",
      payload: {
        meetingSessionId: session.session.id,
        proposal,
        reason: validation.reason,
      },
      description: "会议代表请求一次性承诺授权",
    });
    approved = approval.approved;
    approvalAudit = await WorkspaceMeetingDelegate.recordAudit({
      workspaceId: session.session.workspaceId,
      meetingSessionId: session.session.id,
      actorUserId: user?.id,
      eventType: "commitment_approval",
      decision: approved ? "approved" : "rejected",
      request: { proposal, reason: validation.reason },
      result: { requestId: approval.requestId },
      authorizationId: validation.authorization?.id || null,
    });
  }
  const authorizationId =
    validation.authorization?.id ||
    (approved ? approvalAudit?.id || null : null);
  await WorkspaceMeetingDelegate.recordAudit({
    workspaceId: session.session.workspaceId,
    meetingSessionId: session.session.id,
    actorUserId: user?.id,
    eventType: "commitment_policy_check",
    decision: approved ? "allowed" : "denied",
    request: proposal,
    result: { reason: validation.reason, approved },
    authorizationId,
  });
  return {
    allowed: approved,
    authorizationId,
    proposal,
    reason: approved ? null : validation.reason,
  };
}

async function resolveLiveSources({
  response,
  workspace,
  user,
  session,
  requestBody,
}) {
  const live = requestBody.liveRetrieve;
  if (!live?.enabled) return { sources: [], evidenceRefs: [] };
  const whitelistIds = await resolveWhitelistedDocumentIds({
    workspace,
    packet: session.packet,
  });
  const requestedIds = (live.documentIds || []).map(String).filter(Boolean);
  const outside = requestedIds.filter((id) => !whitelistIds.has(id));
  let oneTimeDocumentIds = [];
  if (outside.length) {
    const approval = await requestChatToolApproval({
      response,
      userId: user?.id,
      skillName: "workspace_live_retrieve",
      payload: {
        meetingSessionId: session.session.id,
        documentIds: outside,
        query: String(live.query || requestBody.message || "").slice(0, 500),
      },
      description: "会议代表请求访问白名单外资料",
    });
    await WorkspaceMeetingDelegate.recordAudit({
      workspaceId: workspace.id,
      meetingSessionId: session.session.id,
      actorUserId: user?.id,
      eventType: "live_retrieval_approval",
      decision: approval.approved ? "approved" : "rejected",
      request: {
        documentIds: outside,
        query: live.query || requestBody.message,
      },
      result: { requestId: approval.requestId },
    });
    if (approval.approved) oneTimeDocumentIds = outside;
  }
  const retrieval = await controlledRetrieve({
    workspace,
    packet: session.packet,
    query: live.query || requestBody.message,
    oneTimeDocumentIds,
  });
  const evidenceRefs = retrieval.sources.map((_, index) => `live:${index + 1}`);
  await WorkspaceMeetingDelegate.recordAudit({
    workspaceId: workspace.id,
    meetingSessionId: session.session.id,
    actorUserId: user?.id,
    eventType: "live_retrieval",
    decision: retrieval.insufficient ? "insufficient" : "allowed",
    request: {
      query: live.query || requestBody.message,
      requestedDocumentIds: requestedIds,
    },
    result: {
      hitCount: retrieval.sources.length,
      sourceDocIds: retrieval.sources.map((item) => item.docId || null),
    },
    evidenceRefs,
  });
  return { sources: retrieval.sources, evidenceRefs };
}

function workspaceMeetingDelegateEndpoints(app) {
  if (!app) return;

  app.get(
    "/workspace/:slug/meeting-packets",
    workspaceMiddleware,
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        let packets = await WorkspaceMeetingDelegate.listPackets(
          response.locals.workspace.id
        );
        if (!canManageShared(response, user)) {
          packets = packets.filter(
            (packet) =>
              user?.id && Number(packet.createdByUserId) === Number(user.id)
          );
        }
        response.status(200).json({ success: true, packets });
      } catch (error) {
        response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/meeting-packets",
    workspaceMiddleware,
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const body = reqBody(request);
        if (
          body.delegateUserId &&
          user?.id &&
          Number(body.delegateUserId) !== Number(user.id) &&
          !canManageShared(response, user)
        ) {
          response
            .status(403)
            .json({ success: false, error: "delegate_owner_required" });
          return;
        }
        const packet = await WorkspaceMeetingDelegate.createPacket({
          workspaceId: response.locals.workspace.id,
          userId: user?.id || null,
          data: body,
        });
        response.status(201).json({ success: true, packet });
      } catch (error) {
        endpointError(response, error);
      }
    }
  );

  app.patch(
    "/workspace/:slug/meeting-packets/:id",
    workspaceMiddleware,
    async (request, response) => {
      try {
        const scoped = await requireOwnedPacket({ request, response });
        if (!scoped.packet) {
          response
            .status(404)
            .json({ success: false, error: "meeting_packet_not_found" });
          return;
        }
        if (!scoped.allowed) {
          response
            .status(403)
            .json({ success: false, error: "meeting_packet_not_owned" });
          return;
        }
        const packet = await WorkspaceMeetingDelegate.updatePacket({
          workspaceId: response.locals.workspace.id,
          packetId: scoped.packet.id,
          userId: scoped.user?.id || null,
          data: reqBody(request),
        });
        response.status(200).json({ success: true, packet });
      } catch (error) {
        endpointError(response, error);
      }
    }
  );

  app.post(
    "/workspace/:slug/meeting-packets/:id/freeze",
    workspaceMiddleware,
    async (request, response) => {
      try {
        const scoped = await requireOwnedPacket({ request, response });
        if (!scoped.packet) {
          response
            .status(404)
            .json({ success: false, error: "meeting_packet_not_found" });
          return;
        }
        if (!scoped.allowed) {
          response
            .status(403)
            .json({ success: false, error: "meeting_packet_not_owned" });
          return;
        }
        const packet = await WorkspaceMeetingDelegate.freezePacket(
          response.locals.workspace.id,
          scoped.packet.id
        );
        response.status(200).json({ success: true, packet });
      } catch (error) {
        endpointError(response, error);
      }
    }
  );

  app.post(
    "/workspace/:slug/meeting-packets/:id/revoke",
    workspaceMiddleware,
    async (request, response) => {
      try {
        const scoped = await requireOwnedPacket({ request, response });
        if (!scoped.packet) {
          response
            .status(404)
            .json({ success: false, error: "meeting_packet_not_found" });
          return;
        }
        if (!scoped.allowed) {
          response
            .status(403)
            .json({ success: false, error: "meeting_packet_not_owned" });
          return;
        }
        const packet = await WorkspaceMeetingDelegate.revokePacket(
          response.locals.workspace.id,
          scoped.packet.id
        );
        response.status(200).json({ success: true, packet });
      } catch (error) {
        endpointError(response, error);
      }
    }
  );

  app.post(
    "/workspace/:slug/meeting-sessions",
    workspaceMiddleware,
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const packet = await WorkspaceMeetingDelegate.getPacket(
          response.locals.workspace.id,
          reqBody(request).meetingPacketId
        );
        if (!packet) {
          response
            .status(404)
            .json({ success: false, error: "meeting_packet_not_found" });
          return;
        }
        if (!ownsPacket(packet, user, response)) {
          response
            .status(403)
            .json({ success: false, error: "meeting_packet_not_owned" });
          return;
        }
        const result = await WorkspaceMeetingDelegate.createSession({
          workspace: response.locals.workspace,
          packetId: packet.id,
          userId: user?.id || null,
        });
        response.status(201).json({ success: true, ...result });
      } catch (error) {
        endpointError(response, error);
      }
    }
  );

  app.post(
    "/workspace/:slug/meeting-sessions/:id/chat/stream",
    workspaceMiddleware,
    async (request, response) => {
      const uuid = uuidv4();
      try {
        const workspace = response.locals.workspace;
        const user = await userFromSession(request, response);
        const body = reqBody(request);
        if (!body.message || typeof body.message !== "string") {
          response
            .status(400)
            .json({ success: false, error: "message_required" });
          return;
        }
        const scoped = await WorkspaceMeetingDelegate.getSession(
          workspace.id,
          request.params.id
        );
        if (
          !scoped ||
          scoped.session.status !== "active" ||
          scoped.packet?.status !== "frozen"
        ) {
          response.status(404).json({
            success: false,
            error: "active_meeting_session_not_found",
          });
          return;
        }
        if (!ownsPacket(scoped.packet, user, response)) {
          response
            .status(403)
            .json({ success: false, error: "meeting_session_not_owned" });
          return;
        }
        setSseTransportHeaders(response);
        response.flushHeaders();

        const live = await resolveLiveSources({
          response,
          workspace,
          user,
          session: scoped,
          requestBody: body,
        });
        const commitment = await resolveCommitment({
          response,
          user,
          session: scoped,
          proposal: body.commitmentProposal || null,
        });
        const snapshot = snapshotForPacket(scoped.packet);
        const frozenRefs = (snapshot.evidence || []).map(
          (item) => `evidence:${item.id}`
        );
        const allowedEvidenceRefs = [...frozenRefs, ...live.evidenceRefs];
        const messages = buildMeetingMessages({
          packet: scoped.packet,
          prompt: body.message,
          liveSources: live.sources,
          commitment,
        });
        const { connector, provider, model } = getTaskConnector(
          "meeting_delegate_response",
          { workspace }
        );
        const completion = await connector.getChatCompletion(messages, {
          temperature: 0.2,
          responseFormat: { type: "json_object" },
        });
        const output = normalizeMeetingOutput(
          parseJson(completion?.textResponse),
          {
            packet: scoped.packet,
            allowedEvidenceRefs,
            commitment,
          }
        );
        writeResponseChunk(response, {
          uuid,
          type: "textResponseChunk",
          textResponse: output.text,
          sources: live.sources,
          close: false,
          error: false,
        });
        writeResponseChunk(response, {
          uuid,
          type: "meetingStatement",
          metadata: output.metadata,
          packetHash: scoped.packet.contentHash,
          close: false,
          error: false,
        });
        const { chat } = await WorkspaceChats.new({
          sourceChannel: "meeting",
          workspaceId: workspace.id,
          prompt: body.message,
          response: {
            text: output.text,
            sources: live.sources,
            type: "meeting",
            meetingMetadata: output.metadata,
            meetingPacketId: scoped.packet.id,
            meetingPacketHash: scoped.packet.contentHash,
          },
          user,
          threadId: scoped.session.threadId,
          include: true,
          clientTurnId: body.clientTurnId || null,
        });
        if (
          output.metadata.statementType === "commitment" &&
          commitment?.allowed
        ) {
          const candidate = await WorkspaceCognition.createAssertion({
            workspaceId: workspace.id,
            assertionType: "decision",
            statement: output.text,
            verificationStatus: "candidate",
            confidence: output.metadata.confidence,
            createdByType: "assistant",
            disclosureLevel: "workspace_only",
            reviewReason: "meeting_commitment_candidate",
          });
          await WorkspaceCognition.addEvidence({
            workspaceId: workspace.id,
            assertionId: candidate.assertion.id,
            evidenceKind: "context",
            sourceType: "chat_turn",
            sourceRef: `meeting-chat:${chat?.id || uuid}`,
            chatId: chat?.id || null,
            threadId: scoped.session.threadId,
            excerpt: output.text,
            confidence: output.metadata.confidence,
          });
        }
        await WorkspaceMeetingDelegate.recordAudit({
          workspaceId: workspace.id,
          meetingSessionId: scoped.session.id,
          actorUserId: user?.id,
          eventType: "delegate_statement",
          decision: output.metadata.disclosureDecision,
          request: { message: body.message },
          result: {
            chatId: chat?.id || null,
            metadata: output.metadata,
            provider,
            model: completion?.metrics?.model || model,
          },
          evidenceRefs: output.metadata.evidenceRefs,
          authorizationId: output.metadata.commitmentAuthorizationId,
        });
        writeResponseChunk(response, {
          uuid,
          type: "finalizeResponseStream",
          chatId: chat?.id || null,
          close: true,
          error: false,
        });
        response.end();
      } catch (error) {
        console.error("[MeetingDelegate] stream failed", error);
        if (!response.headersSent) setSseTransportHeaders(response);
        writeResponseChunk(response, {
          uuid,
          type: "abort",
          textResponse: null,
          sources: [],
          close: true,
          error: error.message,
        });
        response.end();
      }
    }
  );

  app.post(
    "/workspace/:slug/meeting-sessions/:id/approvals/:requestId",
    workspaceMiddleware,
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const scoped = await WorkspaceMeetingDelegate.getSession(
          response.locals.workspace.id,
          request.params.id
        );
        if (!scoped || !ownsPacket(scoped.packet, user, response)) {
          response
            .status(404)
            .json({ success: false, error: "meeting_session_not_found" });
          return;
        }
        const result = respondToChatToolApproval({
          requestId: request.params.requestId,
          userId: user?.id,
          approved: Boolean(reqBody(request).approved),
        });
        response.status(result.success ? 200 : 404).json(result);
      } catch (error) {
        response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/meeting-sessions/:id/audit",
    workspaceMiddleware,
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const scoped = await WorkspaceMeetingDelegate.getSession(
          response.locals.workspace.id,
          request.params.id
        );
        if (!scoped || !ownsPacket(scoped.packet, user, response)) {
          response
            .status(404)
            .json({ success: false, error: "meeting_session_not_found" });
          return;
        }
        const audit = await WorkspaceMeetingDelegate.listAudit(
          response.locals.workspace.id,
          request.params.id
        );
        response.status(200).json({ success: true, audit });
      } catch (error) {
        response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );
}

module.exports = { workspaceMeetingDelegateEndpoints };
