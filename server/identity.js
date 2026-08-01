const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
process.env.ATHENA_RUNTIME_ROLE ||= "identity";

const { startOpenTelemetry } = require("./utils/observability");
startOpenTelemetry();
require("./utils/logger")();

const { ensureWebCrypto } = require("./utils/security/webCrypto");
ensureWebCrypto();
const {
  assertProductionSecurityConfig,
} = require("./utils/security/startupValidation");
assertProductionSecurityConfig();

const { systemEndpoints } = require("./endpoints/system");
const { clientIdentityEndpoints } = require("./endpoints/clientIdentity");
const { realtimeAuthEndpoints } = require("./endpoints/realtimeAuth");
const { vaultEndpoints } = require("./endpoints/vault");
const { sensitiveSessionEndpoints } = require("./endpoints/sensitiveSessions");
const { securityKeyEndpoints } = require("./endpoints/securityKeys");
const { authPasskeyEndpoints } = require("./endpoints/authPasskeys");
const {
  authTrustedDeviceEndpoints,
} = require("./endpoints/authTrustedDevices");
const { authZkLoginEndpoints } = require("./endpoints/authZkLogin");
const {
  authSessionRecoveryEndpoints,
} = require("./endpoints/authSessionRecovery");
const {
  MicroModuleServiceHost,
  installStandaloneShutdown,
  registerCompatibleApi,
  secureDatabaseStart,
} = require("./utils/microModules");
const { createApiScope } = require("./utils/microModules/scopedApi");
const {
  introspectSessionToken,
} = require("./utils/authz/sessionIntrospection");
const {
  attachClientFromSession,
  consumeRealtimeTicketAsOwner,
} = require("./utils/authz/identityOwnerOperations");

const role = "identity";
const state = {
  ready: false,
  status: "starting",
  database: "pending",
  routeOwnership: "identity-security-v1",
};

const identityApiScope = createApiScope({
  exact: [
    "/ping",
    "/realtime/ticket",
    "/request-token",
    "/request-token/sso/simple",
    "/system/check-token",
    "/system/logout",
    "/system/user-action",
    "/system/refresh-user",
    "/system/recover-account",
    "/system/recover-account/email/request",
    "/system/recover-account/email/confirm",
    "/system/reset-password",
    "/system/update-password",
    "/system/user",
    "/system/user/delete-preview",
    "/system/user/delete/reauth/password",
    "/system/user/email-verification",
    "/system/user/email-verification/request",
    "/system/user/email-verification/confirm",
    "/system/user/memory/reauth/passkey/options",
    "/system/user/memory/reauth/passkey/verify",
    "/system/transport-security/status",
  ],
  prefixes: [
    "/auth",
    "/vault",
    "/sensitive-sessions",
    "/client-identity",
    "/admin/security/keys",
    "/system/sessions",
  ],
});

const host = new MicroModuleServiceHost({
  manifestId: "authentication",
  role,
  port: Number(process.env.IDENTITY_PORT || 3026),
  parseJson: false,
  readiness: () => ({ ...state }),
  onStart: async () => {
    await secureDatabaseStart(role);
    state.database = "ready";
    state.status = "running";
    state.ready = true;
  },
  onDrain: async () => {
    state.ready = false;
    state.status = "draining";
  },
  registerRoutes: (app) => {
    registerCompatibleApi(app, (api) => {
      api.use(identityApiScope);
      systemEndpoints(api);
      clientIdentityEndpoints(api);
      realtimeAuthEndpoints(api);
      vaultEndpoints(api);
      sensitiveSessionEndpoints(api);
      securityKeyEndpoints(api);
      authPasskeyEndpoints(api);
      authTrustedDeviceEndpoints(api);
      authZkLoginEndpoints(api);
      authSessionRecoveryEndpoints(api);
    });
    app.post("/internal/v1/session/introspect", async (request, response) => {
      const token = String(request.body?.token || "").trim();
      if (!token)
        return response.status(400).json({
          success: false,
          active: false,
          reasonCode: "session_token_required",
        });
      const result = await introspectSessionToken(token);
      return response.status(result.active ? 200 : 401).json(result);
    });
    app.post(
      "/internal/v1/client-identity/attach",
      async (request, response) => {
        const result = await attachClientFromSession({
          token: request.body?.token,
          client: request.body?.client,
        });
        return response.status(200).json({ success: true, ...result });
      }
    );
    app.post(
      "/internal/v1/realtime/tickets/consume",
      async (request, response) => {
        const entry = await consumeRealtimeTicketAsOwner(request.body?.ticket);
        return response.status(200).json({ success: true, entry });
      }
    );
  },
});

installStandaloneShutdown(host, { name: "Identity" });
host
  .start()
  .then((snapshot) =>
    console.log(`[Identity] listening on ${host.port}`, snapshot)
  )
  .catch((error) => {
    console.error("[Identity] failed to start", error);
    process.exitCode = 1;
  });
