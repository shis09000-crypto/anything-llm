const fs = require("fs");
const http2 = require("http2");
const jwt = require("jsonwebtoken");
const { DataAccessCenter } = require("../dataAccess");

const IOSPushToken = DataAccessCenter.iosPushToken;

const pendingByUser = new Map();
let cachedProviderToken = null;
let cachedProviderTokenAt = 0;

function compact(value = null) {
  const next = String(value || "").trim();
  return next || null;
}

function configuration(env = process.env) {
  const enabled = ["1", "true", "yes", "on"].includes(
    String(env.ATHENA_IOS_APNS_ENABLED || "").toLowerCase()
  );
  const environment = compact(env.ATHENA_IOS_APNS_ENVIRONMENT) || "development";
  const bundleId = compact(env.ATHENA_IOS_BUNDLE_ID);
  const teamId = compact(env.ATHENA_IOS_TEAM_ID);
  const keyId = compact(env.ATHENA_IOS_APNS_KEY_ID);
  const keyPath = compact(env.ATHENA_IOS_APNS_KEY_PATH);
  return {
    enabled,
    configured: enabled && !!bundleId && !!teamId && !!keyId && !!keyPath,
    environment,
    bundleId,
    teamId,
    keyId,
    keyPath,
    host:
      environment === "production"
        ? "https://api.push.apple.com"
        : "https://api.sandbox.push.apple.com",
  };
}

function providerToken(config) {
  const now = Date.now();
  if (cachedProviderToken && now - cachedProviderTokenAt < 50 * 60 * 1_000) {
    return cachedProviderToken;
  }
  const privateKey = fs.readFileSync(config.keyPath, "utf8");
  cachedProviderToken = jwt.sign({}, privateKey, {
    algorithm: "ES256",
    issuer: config.teamId,
    header: { alg: "ES256", kid: config.keyId },
  });
  cachedProviderTokenAt = now;
  return cachedProviderToken;
}

function sendOne(client, token, event, config, authorization) {
  return new Promise((resolve, reject) => {
    const request = client.request({
      ":method": "POST",
      ":path": `/3/device/${token.deviceToken}`,
      authorization: `bearer ${authorization}`,
      "apns-topic": config.bundleId,
      "apns-push-type": "background",
      "apns-priority": "5",
      "apns-collapse-id": `athena-sync-${token.userId}`,
      "content-type": "application/json",
    });
    let status = 0;
    let responseBody = "";
    request.setEncoding("utf8");
    request.on("response", (headers) => {
      status = Number(headers[":status"] || 0);
    });
    request.on("data", (chunk) => {
      responseBody += chunk;
    });
    request.on("end", () => {
      let reason = null;
      try {
        reason = JSON.parse(responseBody || "{}").reason || null;
      } catch {}
      resolve({ status, reason, tokenId: token.id });
    });
    request.on("error", reject);
    request.end(
      JSON.stringify({
        aps: { "content-available": 1 },
        syncReason: event.reason || "sync_event",
        latestEventId: event.eventId || null,
      })
    );
  });
}

async function deliver(userId, event) {
  const config = configuration();
  if (!config.configured || !Number.isFinite(Number(userId))) return;
  const tokens = await IOSPushToken.activeForUser(
    userId,
    event.sourceClientId || null
  );
  if (!tokens.length) return;

  const client = http2.connect(config.host);
  try {
    const authorization = providerToken(config);
    const results = await Promise.allSettled(
      tokens.map((token) =>
        sendOne(client, token, event, config, authorization)
      )
    );
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const { status, reason, tokenId } = result.value;
      if (
        status === 410 ||
        ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(
          reason
        )
      ) {
        await IOSPushToken.revokeById(tokenId);
      }
    }
  } finally {
    client.close();
  }
}

function enqueueSyncPush(event = {}) {
  const userId = Number(event.scope?.userId);
  const config = configuration();
  if (!config.configured || !Number.isFinite(userId)) return false;
  const existing = pendingByUser.get(userId);
  if (existing) {
    existing.event = {
      eventId: event.eventId || existing.event.eventId,
      sourceClientId: event.sourceClientId || existing.event.sourceClientId,
      reason: event.type || existing.event.reason,
    };
    return true;
  }

  const pending = {
    event: {
      eventId: event.eventId || null,
      sourceClientId: event.sourceClientId || null,
      reason: event.type || "sync_event",
    },
    timer: null,
  };
  pending.timer = setTimeout(async () => {
    pendingByUser.delete(userId);
    try {
      await deliver(userId, pending.event);
    } catch (error) {
      console.warn("[APNs] background sync delivery failed", {
        userId,
        code: error?.code || "delivery_failed",
      });
    }
  }, 750);
  pendingByUser.set(userId, pending);
  return true;
}

module.exports = {
  configuration,
  enqueueSyncPush,
  _internals: { deliver, pendingByUser, sendOne },
};
