const { log, conclude } = require("./helpers/index.js");
require("../utils/logger")();
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { safeJsonParse } = require("../utils/http");
const {
  agentActionCb,
  SCHEDULED_JOB_TIMEOUT_MS,
  sendWebPushNotification,
} = require("./helpers/scheduled-job-helper.js");
const { DataAccessCenter } = require("../utils/dataAccess");
const {
  normalizeCapabilityManifest,
  policyMode,
  redactForLog,
  scheduledApprovalDecision,
} = require("../utils/plugins/securityPolicy");

const ScheduledJob = DataAccessCenter.scheduledJob.job;
const ScheduledJobRun = DataAccessCenter.scheduledJob.run;
const EventLogs = DataAccessCenter.eventLog;

/** Status of the scheduled job run @type {'success' | 'failed' | 'timed_out' | 'not_found' | 'killed' | undefined} */
let status;
let runId = null;

process.on("SIGTERM", async () => {
  status = "killed";
  log("Received SIGTERM, marking job as killed by user");
  if (runId) await ScheduledJobRun.kill(runId);
  conclude();
});

process.on("message", async (payload) => {
  const { jobId, runId: payloadRunId } = payload;
  runId = payloadRunId;
  let timeoutId = null;
  let errorMessage = null;

  // The run row was created by the parent process (BackgroundService) in
  // status `queued` (it may have been waiting in p-queue). The worker
  // transitions it to `running` here so `startedAt` reflects actual execution
  // start, then runs to a terminal state. If the job has been deleted between
  // enqueue and now, fail the row.
  try {
    if (!jobId || !runId) return;

    const job = await ScheduledJob.get({ id: Number(jobId) });
    if (!job) {
      log(`Scheduled job ${jobId} not found`);
      status = "not_found";
      return;
    }

    // Transition queued -> running. If this returns false, the row was
    // already moved to a terminal state (e.g. parent failed it because it
    // thought the worker had died). Bail out without touching it further.
    const transitioned = await ScheduledJobRun.markRunning(runId);
    if (!transitioned) {
      log(
        `Scheduled job "${job.name}" (id=${job.id}) is no longer queued, skipping`
      );
      return;
    }

    log(
      `Starting scheduled job: "${job.name}" (id=${job.id}) with timeout ${SCHEDULED_JOB_TIMEOUT_MS}ms`
    );
    await ScheduledJob.updateRunTimestamps(job.id);
    const { handler, thoughts, toolCalls, state } = agentActionCb();

    const { EphemeralAgentHandler } = require("../utils/agents/ephemeral.js");
    const User = require("../utils/dataAccess/lazyFacade").lazyDataAccessFacade(
      "user"
    );
    const ownerUserId = Number(job.ownerUserId);
    const ownerAuthUserId = Number(job.ownerAuthUserId);
    if (
      !Number.isSafeInteger(ownerUserId) ||
      ownerUserId < 1 ||
      !Number.isSafeInteger(ownerAuthUserId) ||
      ownerAuthUserId < 1
    ) {
      const error = new Error("SCHEDULED_JOB_OWNER_REQUIRED");
      error.code = "SCHEDULED_JOB_OWNER_REQUIRED";
      throw error;
    }
    const owner = await User.get({ id: ownerUserId });
    if (!owner || Number(owner.authUserId) !== ownerAuthUserId) {
      const error = new Error("SCHEDULED_JOB_OWNER_MISMATCH");
      error.code = "SCHEDULED_JOB_OWNER_MISMATCH";
      throw error;
    }
    const agentHandler = await new EphemeralAgentHandler({
      uuid: uuidv4(),
      prompt: job.prompt,
      userId: ownerUserId,
    }).init();

    // Tool overrides control which tools the agent can use:
    // - Array with items: only those specific tools are loaded
    // - Empty array: no tools are loaded
    const toolOverrides = safeJsonParse(job.tools, []);
    const jobCapabilities = normalizeCapabilityManifest(job.capabilityManifest);
    if (jobCapabilities.accountPrivateRead?.approved) {
      const { cryptoAccountEligibility } = require("../utils/cryptoAccount");
      const eligibility = await cryptoAccountEligibility(owner);
      const grant = jobCapabilities.accountPrivateRead;
      if (
        !eligibility.available ||
        Number(eligibility.credentialVersion) !==
          Number(grant.credentialVersion) ||
        eligibility.rootKeyId !== grant.rootKeyId ||
        Number(eligibility.domainKeyVersion) !== Number(grant.domainKeyVersion)
      ) {
        const error = new Error("SCHEDULED_CRYPTO_ACCOUNT_GRANT_STALE");
        error.code = "SCHEDULED_CRYPTO_ACCOUNT_GRANT_STALE";
        throw error;
      }
    }
    if (policyMode() === "enforce") {
      const deniedTools = toolOverrides.filter(
        (tool) => !jobCapabilities.tools.includes(String(tool))
      );
      if (deniedTools.length) {
        const error = new Error("SCHEDULED_JOB_CAPABILITY_DENIED");
        error.code = "SCHEDULED_JOB_CAPABILITY_DENIED";
        throw error;
      }
    }
    await agentHandler.createAIbitat({
      handler,
      toolOverrides,
    });
    if (jobCapabilities.maxToolCalls) {
      agentHandler.aibitat.maxToolCalls = Math.min(
        Number(
          agentHandler.aibitat.maxToolCalls || jobCapabilities.maxToolCalls
        ),
        jobCapabilities.maxToolCalls
      );
    }

    // Scheduled execution has no interactive user. Only capabilities that were
    // explicitly granted on the job may be approved; everything else fails
    // closed and remains visible in the execution trace.
    agentHandler.aibitat.requestToolApproval = async (request = {}) => {
      const decision = scheduledApprovalDecision({
        job,
        skillName: request.skillName,
        forceApproval: request.forceApproval === true,
        approvalClass: request.approvalClass,
        payload: request.payload || {},
      });
      const approvalRequestId = uuidv4();
      await DataAccessCenter.toolInvocation.requestApproval({
        approvalRequestId,
        agentInvocationId: agentHandler.aibitat.handlerProps?.invocation?.uuid,
        clientTurnId:
          agentHandler.aibitat.handlerProps?.invocation?.clientTurnId,
        ownerUserId,
        ownerAuthUserId,
        toolName: request.skillName,
        approvalClass: decision.approvalClass,
        scope: request.payload || {},
      });
      const persisted = await DataAccessCenter.toolInvocation.resolveApproval({
        approvalRequestId,
        approved: decision.approved,
        reasonCode: decision.approved ? null : "scheduled_capability_denied",
      });
      if (!persisted) {
        const error = new Error("SCHEDULED_TOOL_APPROVAL_PERSIST_FAILED");
        error.code = "SCHEDULED_TOOL_APPROVAL_PERSIST_FAILED";
        throw error;
      }
      toolCalls.push({
        type: "capability-decision",
        serviceIdentity: decision.serviceIdentity,
        toolName: decision.tool,
        approved: decision.approved,
        highRisk: decision.highRisk,
        policyMode: decision.policyMode,
        approvalClass: decision.approvalClass,
        timestamp: Date.now(),
      });
      log(
        `Scheduled capability ${decision.approved ? "approved" : "denied"}: ${decision.tool || "unknown"}`
      );
      await EventLogs.logEvent(
        "scheduled_tool_capability_decision",
        {
          serviceIdentity: decision.serviceIdentity,
          tool: decision.tool,
          approved: decision.approved,
          highRisk: decision.highRisk,
          policyMode: decision.policyMode,
          runId,
        },
        null
      );
      return {
        approved: decision.approved,
        message: decision.message,
        requestId: approvalRequestId,
      };
    };

    // Capture tool results for the execution trace
    agentHandler.aibitat.onToolCallResult(
      ({ toolName, arguments: args, result }) => {
        const privateAccountResult = String(toolName || "").startsWith(
          "crypto_account_"
        );
        toolCalls.push({
          toolName,
          ...(privateAccountResult
            ? {
                resultPolicy: "account-private/summary-only",
                argumentsSha256: crypto
                  .createHash("sha256")
                  .update(JSON.stringify(args ?? null))
                  .digest("hex"),
                resultSha256: crypto
                  .createHash("sha256")
                  .update(
                    typeof result === "string"
                      ? result
                      : JSON.stringify(result ?? null)
                  )
                  .digest("hex"),
                status: "completed",
              }
            : {
                arguments: redactForLog(args),
                result: redactForLog(result),
              }),
          timestamp: Date.now(),
        });
      }
    );

    const startTime = Date.now();
    await Promise.race([
      agentHandler.startAgentCluster(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("SCHEDULED_JOB_TIMEOUT")),
          SCHEDULED_JOB_TIMEOUT_MS
        );
      }),
    ]).finally(() => {
      if (!timeoutId) return;
      clearTimeout(timeoutId);
      timeoutId = null;
    });
    const duration = Date.now() - startTime;

    // Get outputs from aibitat which include proper type info (e.g., PptxFileDownload, ExcelFileDownload)
    // for correct re-rendering when porting to workspace chat
    const outputs = agentHandler.getPendingOutputs();
    const containsAccountPrivateRead =
      jobCapabilities.accountPrivateRead?.approved === true;
    const persistedText = containsAccountPrivateRead
      ? "加密账户只读任务已完成；私有结果未写入调度执行记录。"
      : state.textResponse;

    status = "success";
    await ScheduledJobRun.complete(runId, {
      result: {
        text: persistedText,
        thoughts: containsAccountPrivateRead ? [] : thoughts,
        toolCalls,
        outputs: containsAccountPrivateRead ? [] : outputs,
        metrics: state.metrics,
        duration,
      },
    });
    log(`Scheduled job "${job.name}" completed in ${duration}ms)`);
    await sendWebPushNotification(job, runId, persistedText, log);
  } catch (error) {
    if (error.message === "SCHEDULED_JOB_TIMEOUT") {
      status = "timed_out";
      log("Scheduled job timed out");
    } else {
      status = "failed";
      log(`Scheduled job error: ${error.message}`);
      errorMessage = error.message;
    }
  } finally {
    switch (status) {
      case "not_found":
        await ScheduledJobRun.failIfNotTerminal(runId, "Job no longer exists");
        break;
      case "timed_out":
        await ScheduledJobRun.timeout(runId);
        break;
      case "failed":
        await ScheduledJobRun.fail(runId, { error: errorMessage });
        break;
      default: // Do nothing by default (success, killed, other)
        break;
    }

    if (timeoutId) clearTimeout(timeoutId);
    conclude();
  }
});
