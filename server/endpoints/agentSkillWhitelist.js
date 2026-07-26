const { DataAccessCenter } = require("../utils/dataAccess");
const { reqBody, userFromSession } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");

const AgentSkillWhitelist = DataAccessCenter.agentSkillWhitelist;

function agentSkillWhitelistEndpoints(app) {
  if (!app) return;

  app.get(
    "/agent-skills/crypto-account-agent/status",
    [validatedRequest, flexUserRoleValid(ROLES.all)],
    async (request, response) => {
      try {
        const user =
          response.locals?.user || (await userFromSession(request, response));
        const { cryptoAccountEligibility } = require("../utils/cryptoAccount");
        const status = await cryptoAccountEligibility(user);
        const {
          agentSkillsFromSystemSettings,
        } = require("../utils/agents/defaults");
        const enabledFunctions = await agentSkillsFromSystemSettings(user);
        const enabled = enabledFunctions.some((name) =>
          String(name).startsWith("crypto-account-agent#")
        );
        return response.status(200).json({
          registered: status.registered === true,
          available: status.available === true && enabled,
          approvalRequired: true,
          schedulable: status.schedulable === true && enabled,
          provider: status.provider || "gate",
          reason:
            status.reason ||
            (enabled ? null : "crypto_account_disabled_by_admin"),
        });
      } catch (error) {
        console.error(error);
        return response.status(error.httpStatus || 500).json({
          registered: true,
          available: false,
          approvalRequired: true,
          schedulable: false,
          provider: "gate",
          reason: error.code || "crypto_account_status_failed",
        });
      }
    }
  );

  app.get(
    "/agent-skills/filesystem-agent/is-available",
    [validatedRequest],
    async (_request, response) => {
      try {
        const filesystemTool = require("../utils/agents/aibitat/plugins/filesystem/lib");
        return response
          .status(200)
          .json({ available: filesystemTool.isToolAvailable() });
      } catch (e) {
        console.error(e);
        return response
          .status(e.httpStatus || 500)
          .json({ available: false, error: e.message });
      }
    }
  );

  app.get(
    "/agent-skills/create-files-agent/is-available",
    [validatedRequest],
    async (_request, response) => {
      try {
        const createFilesTool = require("../utils/agents/aibitat/plugins/create-files/lib");
        return response
          .status(200)
          .json({ available: createFilesTool.isToolAvailable() });
      } catch (e) {
        console.error(e);
        return response
          .status(e.httpStatus || 500)
          .json({ available: false, error: e.message });
      }
    }
  );

  app.post(
    "/agent-skills/whitelist/add",
    [validatedRequest, flexUserRoleValid(ROLES.all)],
    async (request, response) => {
      try {
        const { skillName } = reqBody(request);
        if (!skillName) {
          response
            .status(400)
            .json({ success: false, error: "Missing skillName" });
          return;
        }

        const user = await userFromSession(request, response);
        if (!user && response.locals?.multiUserMode) {
          return response
            .status(401)
            .json({ success: false, error: "Unauthorized" });
        }

        const userId = user?.id || null;
        const { success, error } = await AgentSkillWhitelist.add(
          skillName,
          userId
        );
        return response.status(success ? 200 : 400).json({ success, error });
      } catch (e) {
        console.error(e);
        return response
          .status(e.httpStatus || 500)
          .json({ success: false, error: e.message });
      }
    }
  );
}

module.exports = { agentSkillWhitelistEndpoints };
