const { DataAccessCenter } = require("../utils/dataAccess");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { isSingleUserMode } = require("../utils/middleware/multiUserProtected");
const { reqBody, safeJsonParse, userFromSession } = require("../utils/http");
const { BackgroundService } = require("../utils/BackgroundWorkers");
const {
  TelemetryRepository: Telemetry,
} = require("../repositories/telemetryRepository");
const ScheduledJob = DataAccessCenter.scheduledJob.job;
const ScheduledJobRun = DataAccessCenter.scheduledJob.run;
const {
  normalizeCapabilityManifest,
} = require("../utils/plugins/securityPolicy");

// BackgroundService is a singleton, so `new BackgroundService()` anywhere in
// the codebase returns the same instance that `server/index.js` booted. We
// grab that reference once and reuse it across handlers.
const backgroundService = new BackgroundService();
const CRYPTO_ACCOUNT_TOOL_PREFIX = "crypto-account-agent#";

async function schedulerOwner(request, response) {
  const user =
    response.locals?.user || (await userFromSession(request, response));
  if (!user?.id || !user?.authUserId) return null;
  return user;
}

function scheduledJobBelongsTo(job, owner) {
  return (
    Boolean(job && owner) &&
    Number(job.ownerUserId) === Number(owner.id) &&
    Number(job.ownerAuthUserId) === Number(owner.authUserId)
  );
}

async function ownedScheduledJob(request, response, id) {
  const owner = await schedulerOwner(request, response);
  if (!owner) {
    response
      .status(401)
      .json({ job: null, error: "Scheduled job owner unavailable" });
    return null;
  }

  const job = await ScheduledJob.get({ id: Number(id) });
  if (!job) {
    response.status(404).json({ job: null, error: "Job not found" });
    return null;
  }
  if (!scheduledJobBelongsTo(job, owner)) {
    response
      .status(403)
      .json({ job: null, error: "Scheduled job owner mismatch" });
    return null;
  }
  return job;
}

function privateFunctionsFromTools(tools = []) {
  return (Array.isArray(tools) ? tools : [])
    .filter((tool) => String(tool).startsWith(CRYPTO_ACCOUNT_TOOL_PREFIX))
    .map((tool) => String(tool).slice(CRYPTO_ACCOUNT_TOOL_PREFIX.length));
}

async function accountPrivateGrant({ user, tools, confirmed }) {
  const privateTools = (Array.isArray(tools) ? tools : []).filter((tool) =>
    String(tool).startsWith(CRYPTO_ACCOUNT_TOOL_PREFIX)
  );
  const functions = privateFunctionsFromTools(privateTools);
  if (!functions.length) return null;
  if (confirmed !== true) {
    const error = new Error("ACCOUNT_PRIVATE_READ_CONFIRMATION_REQUIRED");
    error.code = "ACCOUNT_PRIVATE_READ_CONFIRMATION_REQUIRED";
    throw error;
  }
  const { agentSkillsFromSystemSettings } = require("../utils/agents/defaults");
  const enabledFunctions = new Set(await agentSkillsFromSystemSettings(user));
  if (privateTools.some((tool) => !enabledFunctions.has(String(tool)))) {
    const error = new Error("CRYPTO_ACCOUNT_TOOL_UNAVAILABLE");
    error.code = "CRYPTO_ACCOUNT_TOOL_UNAVAILABLE";
    throw error;
  }
  const { cryptoAccountEligibility } = require("../utils/cryptoAccount");
  const eligibility = await cryptoAccountEligibility(user);
  if (!eligibility.available) {
    const error = new Error(eligibility.reason || "CRYPTO_ACCOUNT_UNAVAILABLE");
    error.code = eligibility.reason || "CRYPTO_ACCOUNT_UNAVAILABLE";
    throw error;
  }
  return {
    approved: true,
    provider: "gate",
    functions,
    symbols: ["*"],
    maxDays: 90,
    maxLimit: 100,
    credentialVersion: eligibility.credentialVersion,
    rootKeyId: eligibility.rootKeyId,
    domainKeyVersion: eligibility.domainKeyVersion,
    approvedAt: new Date().toISOString(),
  };
}

function scheduledJobEndpoints(app) {
  if (!app) return;

  // List available tools for job configuration
  app.get(
    "/scheduled-jobs/available-tools",
    [validatedRequest, isSingleUserMode],
    async (request, response) => {
      try {
        const user = await schedulerOwner(request, response);
        const tools = await ScheduledJob.availableTools(user);
        return response.status(200).json({ tools });
      } catch (e) {
        console.error(e.message, e);
        response.status(e.httpStatus || 500).json({ tools: [] });
      }
    }
  );

  // Get a single run detail
  app.get(
    "/scheduled-jobs/runs/:runId",
    [validatedRequest, isSingleUserMode],
    async (request, response) => {
      try {
        const run = await ScheduledJobRun.get({
          id: Number(request.params.runId),
        });
        if (!run) {
          return response
            .status(404)
            .json({ run: null, error: "Run not found" });
        }

        const job = await ownedScheduledJob(request, response, run.jobId);
        if (!job) return;
        return response.status(200).json({
          run: {
            ...run,
            result: safeJsonParse(run.result, null),
          },
          job,
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(e.httpStatus || 500);
      }
    }
  );

  // Mark a run as read or continue in thread, or kill a running or queued job run
  app.post(
    "/scheduled-jobs/runs/:runId/:action",
    [validatedRequest, isSingleUserMode],
    async (request, response) => {
      try {
        const { action } = request.params;

        if (!["read", "continue", "kill"].includes(action))
          throw new Error("Invalid action");

        const run = await ScheduledJobRun.get({
          id: Number(request.params.runId),
        });
        if (!run) return response.status(404).json({ error: "Run not found" });
        const job = await ownedScheduledJob(request, response, run.jobId);
        if (!job) return;

        if (action === "read") {
          await ScheduledJobRun.markRead(run.id);
          return response.status(200).json({ success: true });
        }

        if (action === "continue") {
          const { workspace, thread, error } =
            await ScheduledJobRun.continueInThread(run.id);
          if (error) return response.status(500).json({ error });

          return response.status(200).json({
            workspaceSlug: workspace.slug,
            threadSlug: thread.slug,
          });
        }

        if (action === "kill") {
          if (!["queued", "running"].includes(run.status)) {
            return response.status(400).json({
              error: "Only running or queued jobs can be killed",
            });
          }

          const killed = backgroundService.killRun(run.jobId, run.id);
          if (!killed) await ScheduledJobRun.kill(run.id);
          return response.status(200).json({ success: true });
        }
      } catch {
        response.sendStatus(500);
      }
    }
  );

  // List all scheduled jobs
  app.get(
    "/scheduled-jobs",
    [validatedRequest, isSingleUserMode],
    async (request, response) => {
      try {
        const owner = await schedulerOwner(request, response);
        if (!owner) {
          return response
            .status(401)
            .json({ jobs: [], error: "Scheduled job owner unavailable" });
        }
        const jobs = await ScheduledJob.where(
          {
            ownerUserId: owner.id,
            ownerAuthUserId: owner.authUserId,
          },
          null,
          null,
          {
            runs: {
              take: 1,
              orderBy: { startedAt: "desc" },
            },
          }
        );

        const jobsWithStatus = jobs.map(({ runs, ...job }) => ({
          ...job,
          latestRun: runs[0] || null,
        }));

        return response.status(200).json({ jobs: jobsWithStatus });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(e.httpStatus || 500);
      }
    }
  );

  // Create a new scheduled job
  app.post(
    "/scheduled-jobs/new",
    [validatedRequest, isSingleUserMode],
    async (request, response) => {
      try {
        const {
          name,
          prompt,
          tools,
          schedule,
          capabilityManifest,
          accountPrivateReadApproval,
        } = reqBody(request);
        let errorMessage = null;

        if (!name?.trim()) {
          errorMessage = "Name is required";
        } else if (!prompt?.trim()) {
          errorMessage = "Prompt is required";
        } else if (!schedule?.trim()) {
          errorMessage = "Schedule is required";
        } else if (!ScheduledJob.isValidCron(schedule)) {
          errorMessage = "Invalid cron expression";
        } else if (
          tools !== undefined &&
          tools !== null &&
          !Array.isArray(tools)
        ) {
          errorMessage = "Tools must be an array";
        }
        if (errorMessage)
          return response.status(400).json({
            job: null,
            error: errorMessage,
          });

        // New jobs default to enabled, so creating one always counts as an
        // activation. Reject if it would push us past the configured cap.
        const activation = await ScheduledJob.canActivate();
        if (!activation.allowed) {
          return response.status(400).json({
            job: null,
            error: `Cannot create: maximum of ${activation.limit} active scheduled jobs reached. Disable another job first.`,
          });
        }

        const owner = await schedulerOwner(request, response);
        if (!owner) {
          return response
            .status(401)
            .json({ job: null, error: "Scheduled job owner unavailable" });
        }
        const privateGrant = await accountPrivateGrant({
          user: owner,
          tools: tools || [],
          confirmed: accountPrivateReadApproval,
        });
        const normalizedManifest = normalizeCapabilityManifest(
          capabilityManifest || {
            tools: tools || [],
            scheduledAutoApprove: tools || [],
            allowHighRisk: false,
            maxToolCalls: 10,
          }
        );
        const { job, error } = await ScheduledJob.create({
          name: name.trim(),
          prompt: prompt.trim(),
          tools: tools || null,
          schedule: schedule.trim(),
          capabilityManifest: {
            ...normalizedManifest,
            accountPrivateRead: privateGrant,
          },
          ownerUserId: owner.id,
          ownerAuthUserId: owner.authUserId,
        });

        if (error) {
          return response.status(400).json({ job: null, error });
        }

        backgroundService.addScheduledJob(job);
        Telemetry.sendTelemetry("scheduled_job_created").catch(() => {});
        return response.status(201).json({ job, error: null });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(e.httpStatus || 500);
      }
    }
  );

  // Get a single scheduled job
  app.get(
    "/scheduled-jobs/:id",
    [validatedRequest, isSingleUserMode],
    async (request, response) => {
      try {
        const job = await ownedScheduledJob(
          request,
          response,
          request.params.id
        );
        if (!job) return;
        return response.status(200).json({ job });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(e.httpStatus || 500);
      }
    }
  );

  // Update a scheduled job
  app.put(
    "/scheduled-jobs/:id",
    [validatedRequest, isSingleUserMode],
    async (request, response) => {
      try {
        const {
          name,
          prompt,
          tools,
          schedule,
          enabled,
          capabilityManifest,
          accountPrivateReadApproval,
        } = reqBody(request);
        const updates = {};
        const currentJob = await ownedScheduledJob(
          request,
          response,
          request.params.id
        );
        if (!currentJob) return;
        const owner = await schedulerOwner(request, response);

        if (tools !== undefined && tools !== null && !Array.isArray(tools)) {
          return response
            .status(400)
            .json({ job: null, error: "Tools must be an array" });
        }

        if (name !== undefined) updates.name = String(name).trim();
        if (prompt !== undefined) updates.prompt = String(prompt).trim();
        if (tools !== undefined) updates.tools = tools;
        if (enabled !== undefined) updates.enabled = Boolean(enabled);
        if (capabilityManifest !== undefined) {
          updates.capabilityManifest = normalizeCapabilityManifest(
            capabilityManifest || {}
          );
        } else if (tools !== undefined) {
          // The existing UI only edits the selected tools. Keep the capability
          // policy in sync so a routine edit cannot silently disable a job in
          // enforce mode. High-risk tools remain blocked unless the existing
          // manifest explicitly opted into them.
          const currentManifest = normalizeCapabilityManifest(
            currentJob.capabilityManifest
          );
          updates.capabilityManifest = {
            ...currentManifest,
            tools: tools || [],
            scheduledAutoApprove: tools || [],
          };
        }
        const effectiveTools =
          tools !== undefined
            ? tools || []
            : safeJsonParse(currentJob.tools, []);
        const privateGrant = await accountPrivateGrant({
          user: owner,
          tools: effectiveTools,
          confirmed: accountPrivateReadApproval,
        });
        const baseManifest = normalizeCapabilityManifest(
          updates.capabilityManifest || currentJob.capabilityManifest
        );
        updates.capabilityManifest = {
          ...baseManifest,
          accountPrivateRead: privateGrant,
        };
        if (schedule !== undefined) {
          if (!ScheduledJob.isValidCron(schedule)) {
            return response
              .status(400)
              .json({ job: null, error: "Invalid cron expression" });
          }
          updates.schedule = String(schedule).trim();
        }

        // If this update would activate the job, enforce the active-jobs cap.
        // We pass excludeId so a re-save of an already-enabled job is not
        // double-counted against the limit.
        if (updates.enabled === true) {
          const activation = await ScheduledJob.canActivate({
            excludeId: Number(request.params.id),
          });
          if (!activation.allowed) {
            return response.status(400).json({
              job: null,
              error: `Cannot enable: maximum of ${activation.limit} active scheduled jobs reached. Disable another job first.`,
            });
          }
        }

        const { job, error } = await ScheduledJob.update(
          Number(request.params.id),
          updates
        );

        if (error) {
          return response.status(400).json({ job: null, error });
        }

        await backgroundService.syncScheduledJob(job.id);

        return response.status(200).json({ job, error: null });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(e.httpStatus || 500);
      }
    }
  );

  // Delete a scheduled job
  app.delete(
    "/scheduled-jobs/:id",
    [validatedRequest, isSingleUserMode],
    async (request, response) => {
      try {
        const job = await ownedScheduledJob(
          request,
          response,
          request.params.id
        );
        if (!job) return;
        backgroundService.removeScheduledJob(job.id);

        const success = await ScheduledJob.delete(job.id);
        return response.status(200).json({ success });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(e.httpStatus || 500);
      }
    }
  );

  // Toggle enable/disable
  app.post(
    "/scheduled-jobs/:id/toggle",
    [validatedRequest, isSingleUserMode],
    async (request, response) => {
      try {
        const job = await ownedScheduledJob(
          request,
          response,
          request.params.id
        );
        if (!job) return;

        // Toggling a disabled job to enabled is an activation — enforce the cap.
        // Disabling never needs a check.
        if (!job.enabled) {
          const activation = await ScheduledJob.canActivate({
            excludeId: job.id,
          });
          if (!activation.allowed) {
            return response.status(400).json({
              job: null,
              error: `Cannot enable: maximum of ${activation.limit} active scheduled jobs reached. Disable another job first.`,
            });
          }
        }

        const { job: updated } = await ScheduledJob.update(job.id, {
          enabled: !job.enabled,
        });

        await backgroundService.syncScheduledJob(job.id);

        return response.status(200).json({ job: updated });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(e.httpStatus || 500);
      }
    }
  );

  // Manual trigger — runs the job immediately
  app.post(
    "/scheduled-jobs/:id/trigger",
    [validatedRequest, isSingleUserMode],
    async (request, response) => {
      try {
        const job = await ownedScheduledJob(
          request,
          response,
          request.params.id
        );
        if (!job) return;

        const run = await backgroundService.enqueueScheduledJob(job.id);
        return response
          .status(200)
          .json({ success: true, skipped: !run, error: null });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(e.httpStatus || 500);
      }
    }
  );

  // List runs for a job
  app.get(
    "/scheduled-jobs/:id/runs",
    [validatedRequest, isSingleUserMode],
    async (request, response) => {
      try {
        const job = await ownedScheduledJob(
          request,
          response,
          request.params.id
        );
        if (!job) return;
        const runs = await ScheduledJobRun.where({ jobId: job.id }, 50, {
          startedAt: "desc",
        });
        return response.status(200).json({ runs });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(e.httpStatus || 500);
      }
    }
  );
}

module.exports = {
  accountPrivateGrant,
  scheduledJobBelongsTo,
  scheduledJobEndpoints,
};
