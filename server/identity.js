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
  deviceBindingRecoveryEndpoints,
} = require("./endpoints/deviceBindingRecovery");
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
  appendIdentityAuditAsOwner,
  assertPrincipalFromSession,
  attachClientFromSession,
  capabilityProbe,
  consumeRealtimeTicketAsOwner,
  deleteUserStateAsOwner,
  readUserStateAsOwner,
  touchSessionAsOwner,
  upsertUserStateAsOwner,
  validateSessionAsOwner,
  verifyRequestSigningAsOwner,
} = require("./utils/authz/identityOwnerOperations");
const {
  startSecurityAuditMaintenance,
  stopSecurityAuditMaintenance,
  securityAuditMaintenanceSnapshot,
} = require("./utils/security/auditLedgerRuntime");
const {
  startAuthSessionSyncReconciler,
  stopAuthSessionSyncReconciler,
  authSessionSyncReconcilerSnapshot,
} = require("./utils/security/authSessionSyncReconciler");

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
  internalRouteCapabilities: {
    "/internal/v1/session/introspect": "identity.introspect",
    "/internal/v1/client-identity/attach": "identity.client.attach",
    "/internal/v1/realtime/tickets/consume": "identity.realtime-ticket.consume",
    "/internal/v1/request-signing/verify": "identity.request-signing.verify",
    "/internal/v1/session/validate": "identity.session.validate",
    "/internal/v1/session/touch": "identity.session.touch",
    "/internal/v1/audit/append": "identity.audit.append",
    "/internal/v1/user-state/read": "identity.user-state.read",
    "/internal/v1/user-state/upsert": "identity.user-state.upsert",
    "/internal/v1/user-state/delete": "identity.user-state.delete",
  },
  readiness: () => {
    const securityAudit = securityAuditMaintenanceSnapshot();
    const authSessions = authSessionSyncReconcilerSnapshot();
    const maintenanceReady =
      securityAudit.running &&
      securityAudit.healthy &&
      authSessions.running &&
      authSessions.healthy;
    return {
      ...state,
      ready: state.ready && maintenanceReady,
      status: state.ready && maintenanceReady ? "running" : "degraded",
      maintenance: {
        securityAudit: {
          running: securityAudit.running,
          healthy: securityAudit.healthy,
        },
        authSessions: {
          running: authSessions.running,
          healthy: authSessions.healthy,
        },
      },
    };
  },
  onStart: async () => {
    await secureDatabaseStart(role);
    state.database = "ready";
    try {
      await startAuthSessionSyncReconciler();
      await startSecurityAuditMaintenance();
      state.status = "running";
      state.ready = true;
    } catch (error) {
      state.ready = false;
      state.status = "maintenance_start_failed";
      await stopSecurityAuditMaintenance();
      await stopAuthSessionSyncReconciler();
      throw error;
    }
  },
  onDrain: async () => {
    state.ready = false;
    state.status = "draining";
    await stopSecurityAuditMaintenance();
    await stopAuthSessionSyncReconciler();
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
      deviceBindingRecoveryEndpoints(api);
    });
    app.post("/internal/v1/session/introspect", async (request, response) => {
      if (request.body?.probe === true) {
        return response.status(200).json({ success: true, available: true });
      }
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
    app.post("/internal/v1/principal/assert", async (request, response) => {
      if (request.body?.probe === true) {
        return response.status(200).json({ success: true, available: true });
      }
      const result = await assertPrincipalFromSession({
        token: request.body?.token,
        client: request.body?.client,
      });
      return response.status(200).json(result);
    });
    app.post(
      "/internal/v1/principal/assert",
      async (request, response) => {
        if (request.body?.probe === true)
          return response.json(capabilityProbe("identity.assert"));
        const result = await assertPrincipalFromSession({
          token: request.body?.token,
          client: request.body?.client,
        });
        return response.status(200).json(result);
      }
    );
    app.post(
      "/internal/v1/client-identity/attach",
      async (request, response) => {
        if (request.body?.probe === true)
          return response.json(capabilityProbe("identity.client.attach"));
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
    app.post(
      "/internal/v1/request-signing/verify",
      async (request, response) => {
        if (request.body?.probe === true)
          return response.json(
            capabilityProbe("identity.request-signing.verify")
          );
        const verified = await verifyRequestSigningAsOwner(request.body);
        return response.status(200).json({ success: true, ...verified });
      }
    );
    app.post("/internal/v1/session/validate", async (request, response) => {
      if (request.body?.probe === true)
        return response.json(capabilityProbe("identity.session.validate"));
      const result = await validateSessionAsOwner(request.body);
      return response.status(200).json(result);
    });
    app.post("/internal/v1/session/touch", async (request, response) => {
      if (request.body?.probe === true)
        return response.json(capabilityProbe("identity.session.touch"));
      const result = await touchSessionAsOwner(request.body);
      return response.status(200).json(result);
    });
    app.post("/internal/v1/audit/append", async (request, response) => {
      if (request.body?.probe === true)
        return response.json(capabilityProbe("identity.audit.append"));
      const result = await appendIdentityAuditAsOwner(request.body);
      return response.status(200).json({ success: true, ...result });
    });
    app.post("/internal/v1/user-state/read", async (request, response) => {
      if (request.body?.probe === true)
        return response.json(capabilityProbe("identity.user-state.read"));
      const result = await readUserStateAsOwner(request.body);
      return response.status(200).json({ success: true, ...result });
    });
    app.post("/internal/v1/user-state/upsert", async (request, response) => {
      if (request.body?.probe === true)
        return response.json(capabilityProbe("identity.user-state.upsert"));
      const result = await upsertUserStateAsOwner(request.body);
      return response.status(200).json({ success: true, ...result });
    });
    app.post("/internal/v1/user-state/delete", async (request, response) => {
      if (request.body?.probe === true)
        return response.json(capabilityProbe("identity.user-state.delete"));
      const result = await deleteUserStateAsOwner(request.body);
      return response.status(200).json({ success: true, ...result });
    });
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
