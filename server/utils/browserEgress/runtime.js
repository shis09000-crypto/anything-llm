const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const {
  unwrapMaterial,
  wrapMaterial,
} = require("../security/keyCustody/remoteClient");
const { emitSemanticEvent } = require("../observability/semanticEvents");
const { metrics } = require("../observability/metrics");

const BrowserEgressData = lazyDataAccessFacade("browserEgress");
const ROUTE_POLICY_VERSION = "browser-egress-route-v1";
const CONFIG_VERSION = "athena-browser-egress-client:v1";
const DEFAULT_GRANT_MS = 30 * 24 * 60 * 60_000;

function bounded(value, max = 160) {
  return String(value || "")
    .trim()
    .slice(0, max);
}

const FAILURE_CODES = new Set([
  "browser_egress_disabled",
  "browser_egress_draining",
  "browser_egress_gateway_not_configured",
  "browser_egress_gateway_unavailable",
  "browser_egress_node_key_invalid",
  "browser_egress_node_key_too_weak",
  "browser_egress_profile_invalid",
  "browser_egress_device_invalid",
  "browser_egress_grant_not_found",
  "key_custody_unavailable",
]);

function failureCode(error) {
  const candidate = bounded(error?.code || error?.message || "unknown", 64);
  return FAILURE_CODES.has(candidate) ? candidate : "internal_error";
}

function validId(value, code) {
  const id = bounded(value, 128);
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id)) {
    const error = new Error(code);
    error.code = code;
    error.httpStatus = 400;
    throw error;
  }
  return id;
}

function safePublicKey(value) {
  const pem = String(value || "");
  if (
    pem.length < 400 ||
    pem.length > 8_192 ||
    !pem.includes("BEGIN PUBLIC KEY")
  )
    throw Object.assign(new Error("browser_egress_node_key_invalid"), {
      code: "browser_egress_node_key_invalid",
      httpStatus: 400,
    });
  const key = crypto.createPublicKey(pem);
  if (key.asymmetricKeyType !== "rsa")
    throw Object.assign(new Error("browser_egress_node_key_invalid"), {
      code: "browser_egress_node_key_invalid",
      httpStatus: 400,
    });
  const bits = Number(key.asymmetricKeyDetails?.modulusLength || 0);
  if (bits < 3072)
    throw Object.assign(new Error("browser_egress_node_key_too_weak"), {
      code: "browser_egress_node_key_too_weak",
      httpStatus: 400,
    });
  return key;
}

function emit(eventType, outcome, reasonCode = null) {
  emitSemanticEvent({
    eventType,
    category: "browser-egress",
    severity: outcome === "failed" ? "error" : "info",
    outcome,
    subject: {
      type: "browser-egress",
      component: "browser-egress",
      operation: eventType.split(".").pop(),
    },
    stateTransition: reasonCode ? { reasonCode } : undefined,
    sensitivity: "metadata_only",
  });
}

function credentialContext({ userId, profileId, deviceId }) {
  return {
    purpose: "browser-egress-credential",
    domain: "browser-egress",
    resource: `${Number(userId)}:${bounded(profileId, 128)}:${bounded(deviceId, 128)}`,
    operation: "gateway-user",
  };
}

function gatewaySettings(env = process.env) {
  return {
    id: bounded(env.ATHENA_BROWSER_EGRESS_GATEWAY_ID || "overseas-primary", 80),
    host: bounded(env.ATHENA_BROWSER_EGRESS_HOST, 255),
    port: Number(env.ATHENA_BROWSER_EGRESS_PORT || 8443),
    serverName: bounded(env.ATHENA_BROWSER_EGRESS_SERVER_NAME, 255),
    realityPublicKey: bounded(
      env.ATHENA_BROWSER_EGRESS_REALITY_PUBLIC_KEY,
      512
    ),
    realityShortId: bounded(env.ATHENA_BROWSER_EGRESS_REALITY_SHORT_ID, 64),
    configDir: bounded(env.ATHENA_BROWSER_EGRESS_CONFIG_DIR, 1024),
    realityPrivateKeyFile: bounded(
      env.ATHENA_BROWSER_EGRESS_REALITY_PRIVATE_KEY_FILE,
      1024
    ),
    handshakeServer: bounded(
      env.ATHENA_BROWSER_EGRESS_HANDSHAKE_SERVER || "www.cloudflare.com",
      255
    ),
  };
}

function configured(settings) {
  return Boolean(
    settings.host &&
      Number.isInteger(settings.port) &&
      settings.port > 0 &&
      settings.port < 65536 &&
      settings.serverName &&
      settings.realityPublicKey &&
      settings.realityShortId
  );
}

function publicGrant(row) {
  if (!row) return null;
  return {
    id: row.id,
    profileId: row.profileId,
    deviceId: row.deviceId,
    state: row.state,
    region: row.region,
    gatewayId: row.gatewayId,
    configVersion: row.configVersion,
    quotaConnections: row.quotaConnections,
    issuedAt: row.issuedAt?.toISOString?.() || row.issuedAt || null,
    expiresAt: row.expiresAt?.toISOString?.() || row.expiresAt || null,
    revokedAt: row.revokedAt?.toISOString?.() || row.revokedAt || null,
    lastHandshakeAt:
      row.lastHandshakeAt?.toISOString?.() || row.lastHandshakeAt || null,
    lastHealthCode: row.lastHealthCode,
  };
}

class BrowserEgressRuntime {
  constructor(env = process.env) {
    this.env = env;
    this.accepting = true;
    this.stats = { issued: 0, renewed: 0, revoked: 0, failures: 0 };
  }

  settings() {
    return gatewaySettings(this.env);
  }

  status() {
    const settings = this.settings();
    const enabled = this.env.ATHENA_BROWSER_EGRESS_ENABLED === "true";
    let gatewayStatus = null;
    if (settings.configDir) {
      try {
        gatewayStatus = JSON.parse(
          fs.readFileSync(path.join(settings.configDir, "status.json"), "utf8")
        );
      } catch {}
    }
    const statusAgeMs = gatewayStatus?.checkedAt
      ? Date.now() - new Date(gatewayStatus.checkedAt).getTime()
      : null;
    const gatewayReady = Boolean(
      configured(settings) &&
        gatewayStatus?.ready === true &&
        Number.isFinite(statusAgeMs) &&
        statusAgeMs < 120_000
    );
    metrics.browserEgressEnabled.set(enabled ? 1 : 0);
    metrics.browserEgressGatewayReady.set(gatewayReady ? 1 : 0);
    return {
      ready: this.accepting,
      enabled,
      configured: configured(settings),
      gatewayReady,
      gatewayId: settings.id,
      endpoint: configured(settings)
        ? { host: settings.host, port: settings.port, region: "overseas" }
        : null,
      routePolicyVersion: ROUTE_POLICY_VERSION,
      gatewayStatus: gatewayStatus
        ? {
            ready: gatewayReady,
            configSha256: bounded(gatewayStatus.configSha256, 128) || null,
            checkedAt: gatewayStatus.checkedAt || null,
            latencyMs: Number(gatewayStatus.latencyMs || 0) || null,
            reasonCode: bounded(gatewayStatus.reasonCode, 96) || null,
          }
        : null,
      ...this.stats,
    };
  }

  async issue({ userId, profileId, deviceId, encryptionPublicKey } = {}) {
    if (!this.accepting)
      throw Object.assign(new Error("browser_egress_draining"), {
        code: "browser_egress_draining",
        httpStatus: 503,
      });
    const settings = this.settings();
    if (this.env.ATHENA_BROWSER_EGRESS_ENABLED !== "true")
      throw Object.assign(new Error("browser_egress_disabled"), {
        code: "browser_egress_disabled",
        httpStatus: 503,
      });
    if (!configured(settings))
      throw Object.assign(new Error("browser_egress_gateway_not_configured"), {
        code: "browser_egress_gateway_not_configured",
        httpStatus: 503,
      });
    if (!this.status().gatewayReady)
      throw Object.assign(new Error("browser_egress_gateway_unavailable"), {
        code: "browser_egress_gateway_unavailable",
        httpStatus: 503,
      });
    const targetKey = safePublicKey(encryptionPublicKey);
    const owner = Number(userId);
    const profile = validId(profileId, "browser_egress_profile_invalid");
    const device = validId(deviceId, "browser_egress_device_invalid");
    const credential = crypto.randomUUID();
    const expiresAt = new Date(
      Date.now() +
        Number(this.env.ATHENA_BROWSER_EGRESS_GRANT_MS || DEFAULT_GRANT_MS)
    );
    try {
      const credentialRef = await wrapMaterial(
        credential,
        credentialContext({
          userId: owner,
          profileId: profile,
          deviceId: device,
        }),
        this.env
      );
      const grant = await BrowserEgressData.grant({
        userId: owner,
        profileId: profile,
        deviceId: device,
        credentialRef,
        configVersion: CONFIG_VERSION,
        gatewayId: settings.id,
        expiresAt,
      });
      await this.renderGatewayConfig();
      const clientConfig = Buffer.from(
        JSON.stringify({
          version: CONFIG_VERSION,
          grantId: grant.id,
          routePolicyVersion: ROUTE_POLICY_VERSION,
          expiresAt: expiresAt.toISOString(),
          endpoint: {
            host: settings.host,
            port: settings.port,
            serverName: settings.serverName,
          },
          transport: {
            type: "vless",
            uuid: credential,
            flow: "xtls-rprx-vision",
            realityPublicKey: settings.realityPublicKey,
            realityShortId: settings.realityShortId,
          },
        }),
        "utf8"
      );
      const envelopeKey = crypto.randomBytes(32);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", envelopeKey, iv);
      const ciphertext = Buffer.concat([
        cipher.update(clientConfig),
        cipher.final(),
      ]);
      const encryptedKey = crypto.publicEncrypt(
        {
          key: targetKey,
          oaepHash: "sha256",
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        },
        envelopeKey
      );
      this.stats.issued += 1;
      metrics.browserEgressGrants.inc({ action: "issue", outcome: "success" });
      emit("browser.egress.grant_issued", "success");
      return {
        grant: publicGrant(grant),
        sealedConfig: {
          version: "athena-browser-egress-sealed:v1",
          algorithm: "RSA-OAEP-3072-SHA256+A256GCM",
          encryptedKey: encryptedKey.toString("base64"),
          iv: iv.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          ciphertext: ciphertext.toString("base64"),
        },
      };
    } catch (error) {
      this.stats.failures += 1;
      metrics.browserEgressGrants.inc({ action: "issue", outcome: "failed" });
      metrics.browserEgressFailures.inc({
        operation: "issue",
        code: failureCode(error),
      });
      emit("browser.egress.grant_issued", "failed", failureCode(error));
      throw error;
    }
  }

  async renew({ userId, grantId } = {}) {
    const expiresAt = new Date(
      Date.now() +
        Number(this.env.ATHENA_BROWSER_EGRESS_GRANT_MS || DEFAULT_GRANT_MS)
    );
    const grant = await BrowserEgressData.renew({ userId, grantId, expiresAt });
    if (!grant)
      throw Object.assign(new Error("browser_egress_grant_not_found"), {
        code: "browser_egress_grant_not_found",
        httpStatus: 404,
      });
    this.stats.renewed += 1;
    metrics.browserEgressGrants.inc({ action: "renew", outcome: "success" });
    emit("browser.egress.grant_renewed", "success");
    return publicGrant(grant);
  }

  async revoke({ userId, grantId } = {}) {
    const existing = await BrowserEgressData.grantById({ userId, grantId });
    const revoked = await BrowserEgressData.revoke({ userId, grantId });
    if (!revoked)
      throw Object.assign(new Error("browser_egress_grant_not_found"), {
        code: "browser_egress_grant_not_found",
        httpStatus: 404,
      });
    await this.renderGatewayConfig();
    this.stats.revoked += 1;
    metrics.browserEgressGrants.inc({ action: "revoke", outcome: "success" });
    emit("browser.egress.grant_revoked", "success");
    return {
      grantId: String(grantId),
      profileId: existing?.profileId || null,
      revoked: true,
    };
  }

  async revokeDevice({ userId, deviceId } = {}) {
    const result = await BrowserEgressData.revokeDevice({ userId, deviceId });
    if (result.count > 0) await this.renderGatewayConfig();
    this.stats.revoked += result.count;
    metrics.browserEgressGrants.inc(
      { action: "revoke_device", outcome: "success" },
      result.count || 1
    );
    emit("browser.egress.device_revoked", "success");
    return { revoked: result.count };
  }

  async resolve({ userId, profileId, deviceId } = {}) {
    const grant = await BrowserEgressData.activeGrant({
      userId,
      profileId,
      deviceId,
    });
    const health = this.status();
    return {
      requestedRoute: "athena_egress",
      effectiveRoute:
        grant && health.gatewayReady ? "athena_egress" : "unavailable",
      region: "overseas",
      connected: Boolean(grant && health.gatewayReady),
      latencyMs: Number(health.gatewayStatus?.latencyMs || 0) || null,
      grantExpiresAt: grant?.expiresAt?.toISOString?.() || null,
      degradedReason: !grant
        ? "browser_egress_grant_missing"
        : !health.gatewayReady
          ? "browser_egress_gateway_unavailable"
          : null,
      grant: publicGrant(grant),
    };
  }

  async recordHealth({
    userId,
    grantId,
    code,
    handshakeAt = null,
    latencyMs = null,
  } = {}) {
    const allowedCode = [
      "connected",
      "failed",
      "timeout",
      "core_exited",
    ].includes(String(code))
      ? String(code)
      : "failed";
    const updated = await BrowserEgressData.recordHealth({
      userId,
      grantId,
      code: allowedCode,
      handshakeAt,
    });
    if (!updated)
      throw Object.assign(new Error("browser_egress_grant_not_found"), {
        code: "browser_egress_grant_not_found",
        httpStatus: 404,
      });
    if (allowedCode === "connected" && Number.isFinite(Number(latencyMs)))
      metrics.browserEgressHandshakeLatency.observe(
        { outcome: "success" },
        Math.max(0, Number(latencyMs)) / 1000
      );
    return { recorded: true, code: allowedCode };
  }

  async renderGatewayConfig() {
    const settings = this.settings();
    if (!settings.configDir || !settings.realityPrivateKeyFile) return false;
    const privateKey = fs
      .readFileSync(settings.realityPrivateKeyFile, "utf8")
      .trim();
    if (!privateKey)
      throw new Error("browser_egress_reality_private_key_missing");
    const grants = await BrowserEgressData.activeGrants();
    const users = [];
    for (const grant of grants) {
      const uuid = await unwrapMaterial(
        grant.credentialRef,
        credentialContext({
          userId: grant.ownerUserId,
          profileId: grant.profileId,
          deviceId: grant.deviceId,
        }),
        this.env
      );
      users.push({ name: grant.id, uuid, flow: "xtls-rprx-vision" });
    }
    const config = {
      log: { level: "warn", timestamp: true },
      dns: {
        servers: [{ type: "local", tag: "local" }],
        final: "local",
        strategy: "prefer_ipv4",
      },
      inbounds: [
        {
          type: "vless",
          tag: "browser-egress-in",
          listen: "::",
          listen_port: settings.port,
          users,
          tls: {
            enabled: true,
            server_name: settings.serverName,
            reality: {
              enabled: true,
              handshake: { server: settings.handshakeServer, server_port: 443 },
              private_key: privateKey,
              short_id: [settings.realityShortId],
            },
          },
        },
      ],
      outbounds: [
        { type: "direct", tag: "direct" },
        { type: "block", tag: "block" },
      ],
      route: {
        rules: [
          { action: "resolve", strategy: "prefer_ipv4" },
          { ip_is_private: true, action: "reject" },
          {
            ip_cidr: [
              "0.0.0.0/8",
              "100.64.0.0/10",
              "127.0.0.0/8",
              "169.254.0.0/16",
              "192.0.0.0/24",
              "192.0.2.0/24",
              "198.18.0.0/15",
              "198.51.100.0/24",
              "203.0.113.0/24",
              "224.0.0.0/4",
              "240.0.0.0/4",
              "::1/128",
              "fc00::/7",
              "fe80::/10",
            ],
            action: "reject",
          },
        ],
        final: "direct",
      },
    };
    fs.mkdirSync(settings.configDir, { recursive: true, mode: 0o700 });
    const desired = path.join(settings.configDir, "desired.json");
    const temporary = `${desired}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(config)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporary, desired);
    return true;
  }

  async drain() {
    this.accepting = false;
    return this.status();
  }
}

const browserEgressRuntime = new BrowserEgressRuntime();

module.exports = {
  BrowserEgressRuntime,
  CONFIG_VERSION,
  ROUTE_POLICY_VERSION,
  browserEgressRuntime,
  gatewaySettings,
  safePublicKey,
};
