import crypto from "node:crypto";
import fs from "node:fs";

const BASE = process.env.ATHENA_BASE_URL || "https://athenallm.online/api";
const WS_BASE = BASE.replace(/^http/i, "ws").replace(/\/api$/, "");
const EMAIL = process.env.ATHENA_LOGIN_EMAIL;
const PASSWORD = process.env.ATHENA_LOGIN_PASSWORD;
const AGREEMENT_KEY =
  process.env.ATHENA_CODEX_AGREEMENT_KEY ||
  fs
    .readFileSync(process.env.ATHENA_CODEX_AGREEMENT_KEY_FILE || "", "utf8")
    .trim();
const WORKSPACE =
  process.env.ATHENA_WORKSPACE_SLUG ||
  "f57f6abb-56e7-4ec7-a423-1d844271cea4";

if (!EMAIL || !PASSWORD || !AGREEMENT_KEY) {
  throw new Error("Missing ATHENA_LOGIN_EMAIL, ATHENA_LOGIN_PASSWORD, or key.");
}

function uuid() {
  return crypto.randomUUID();
}

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

function sha256(value = "") {
  return b64url(crypto.createHash("sha256").update(String(value)).digest());
}

function hmac(secret, value) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function stableJson(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function deviceContext(clientId) {
  const device = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    clientId,
    device,
    publicJwk: device.publicKey.export({ format: "jwk" }),
    signingSecret: null,
  };
}

function clientQuery({ token, clientId, requestId = uuid() }) {
  const query = new URLSearchParams();
  query.set("token", token);
  query.set("athenaClientId", clientId);
  query.set("athenaPlatform", "web");
  query.set("athenaAppVersion", "codex-broadcast-probe");
  query.set("athenaRequestId", requestId);
  query.set("athenaCapabilitySource", "detected");
  return query.toString();
}

function canonicalSigningString({
  prefix,
  method,
  canonicalPath,
  timestamp,
  nonce,
  requestId,
  clientId,
  bodySha256,
}) {
  return [
    prefix,
    method.toUpperCase(),
    canonicalPath,
    timestamp,
    nonce,
    requestId,
    clientId,
    bodySha256,
  ].join("\n");
}

function signDeviceHeaders({
  ctx,
  method,
  canonicalPath,
  bodyString,
  requestId,
}) {
  const timestamp = String(Date.now());
  const nonce = uuid();
  const bodySha256 = sha256(bodyString);
  const signingString = canonicalSigningString({
    prefix: "ATHENA-DEVICE-SIGN-V1",
    method,
    canonicalPath,
    timestamp,
    nonce,
    requestId,
    clientId: ctx.clientId,
    bodySha256,
  });
  const signature = crypto.sign("sha256", Buffer.from(signingString), {
    key: ctx.device.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return {
    "X-Athena-Client-Id": ctx.clientId,
    "X-Athena-Request-Id": requestId,
    "X-Athena-Timestamp": timestamp,
    "X-Athena-Nonce": nonce,
    "X-Athena-Body-SHA256": bodySha256,
    "X-Athena-Signature": b64url(signature),
    "X-Athena-Signature-Version": "v2-device-p256",
    "X-Athena-Device-Public-Key": JSON.stringify(ctx.publicJwk),
    "X-Athena-Device-Key-Algorithm": "p256-v1",
  };
}

function signedWebSocketEnvelope({ ctx, socketUrl, payload }) {
  const bodyString = JSON.stringify(payload ?? null);
  const requestId =
    process.env.ATHENA_WS_SIGN_PAYLOAD_REQUEST_ID === "true"
      ? payload.requestId || uuid()
      : uuid();
  const target = new URL(socketUrl);
  let rawCanonicalPath = `${target.pathname}${target.search}`;
  if (process.env.ATHENA_WS_CANONICAL_NO_QUERY === "true") {
    rawCanonicalPath = target.pathname;
  }
  const canonicalPath =
    process.env.ATHENA_WS_CANONICAL_STRIP_API === "true"
      ? rawCanonicalPath.replace(/^\/api(?=\/)/, "")
      : rawCanonicalPath;
  const timestamp = String(Date.now());
  const nonce = uuid();
  const bodySha256 = sha256(bodyString);
  if (ctx.signingSecret) {
    const signingString = canonicalSigningString({
      prefix: "ATHENA-SIGN-V1",
      method: "WS",
      canonicalPath,
      timestamp,
      nonce,
      requestId,
      clientId: ctx.clientId,
      bodySha256,
    });
    return {
      type: "athenaSignedMessage",
      signatureVersion: "v1",
      signed: {
        clientId: ctx.clientId,
        requestId,
        timestamp,
        nonce,
        bodySha256,
        signature: hmac(ctx.signingSecret, signingString),
      },
      payload,
    };
  }

  const headers = signDeviceHeaders({
    ctx,
    method: "WS",
    canonicalPath,
    bodyString,
    requestId,
  });
  return {
    type: "athenaSignedMessage",
    signatureVersion: headers["X-Athena-Signature-Version"],
    signed: {
      clientId: headers["X-Athena-Client-Id"],
      requestId,
      timestamp: headers["X-Athena-Timestamp"],
      nonce: headers["X-Athena-Nonce"],
      bodySha256: headers["X-Athena-Body-SHA256"],
      signature: headers["X-Athena-Signature"],
      devicePublicKey: headers["X-Athena-Device-Public-Key"],
      deviceKeyAlgorithm: headers["X-Athena-Device-Key-Algorithm"],
    },
    payload,
  };
}

function commandSignature({
  session,
  command,
  requestId,
  timestamp,
  nonce,
  scope,
  params,
}) {
  const signingString = [
    "ATHENA-DEV-CONTROL-V1",
    session.sessionId,
    requestId,
    timestamp,
    nonce,
    command,
    sha256(stableJson({ scope, params })),
  ].join("\n");
  return hmac(session.sessionSecret, signingString);
}

async function jsonFetch(path, { method = "GET", body, token, ctx, signed = false } = {}) {
  const requestId = uuid();
  const bodyString = body === undefined ? "" : JSON.stringify(body);
  const headers = {
    "Content-Type": "application/json",
    "X-Athena-Client-Id": ctx?.clientId || `client_codex_http_${uuid()}`,
    "X-Athena-Platform": "web",
    "X-Athena-App-Version": "codex-broadcast-probe",
    "X-Athena-Request-Id": requestId,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  if (signed && ctx) {
    Object.assign(
      headers,
      signDeviceHeaders({
        ctx,
        method,
        canonicalPath: `/api${path}`,
        bodyString,
        requestId,
      })
    );
  }
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : bodyString,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.success === false || data?.valid === false) {
    const error = new Error(data?.message || data?.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function devCommand({ token, session, ctx, command, scope = {}, params = {} }) {
  const requestId = uuid();
  const timestamp = new Date().toISOString();
  const nonce = uuid();
  const body = {
    command,
    scope,
    params,
    requestId,
    sessionId: session.sessionId,
    timestamp,
    nonce,
    signature: commandSignature({
      session,
      command,
      requestId,
      timestamp,
      nonce,
      scope,
      params,
    }),
  };
  return jsonFetch("/dev-control/command", {
    method: "POST",
    body,
    token,
    ctx,
    signed: true,
  });
}

async function attachSigningSecret({ token, ctx }) {
  const data = await jsonFetch("/client-identity/signing-secret", {
    method: "POST",
    body: {},
    token,
    ctx,
  });
  ctx.signingSecret = data.signingSecret;
  return !!ctx.signingSecret;
}

async function connectClient({ name, token, ctx, subscriptions }) {
  const socketUrl = `${WS_BASE}/api/realtime/broadcast?${clientQuery({
    token,
    clientId: ctx.clientId,
  })}`;
  const socket = new WebSocket(socketUrl);
  const state = {
    name,
    clientId: ctx.clientId,
    ready: false,
    hello: false,
    subscribed: false,
    events: [],
    acks: [],
    errors: [],
  };

  function sendSigned(payload) {
    socket.send(
      JSON.stringify(
        signedWebSocketEnvelope({
          ctx,
          socketUrl,
          payload: { requestId: uuid(), ...payload },
        })
      )
    );
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${name} websocket open timeout`)),
      8_000
    );
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", () => {
      reject(new Error(`${name} websocket error before open`));
    }, { once: true });
  });

  socket.addEventListener("message", (raw) => {
    let message = null;
    try {
      message = JSON.parse(raw.data);
    } catch {
      return;
    }
    if (message.type === "broadcast.ready") {
      state.ready = true;
      sendSigned({ type: "hello", subscriptions });
      return;
    }
    if (message.type === "broadcast.hello") {
      state.hello = true;
      sendSigned({ type: "subscribe", subscriptions });
      return;
    }
    if (message.type === "broadcast.subscribed") {
      state.subscribed = true;
      return;
    }
    if (message.type === "broadcast.event") {
      const event = message.event || {};
      state.events.push({
        eventId: event.eventId,
        type: event.broadcastType || `${event.namespace}.${event.type}`,
        priority: event.eventPriority,
        visibility: event.visibility,
        scope: event.scope,
        payloadKeys: Object.keys(event.payload || {}),
      });
      if (event.eventId && event.requiresAck !== false) {
        sendSigned({ type: "ack", eventId: event.eventId });
      }
      return;
    }
    if (message.type === "broadcast.ack") {
      state.acks.push({ eventId: message.eventId, ok: message.ok });
      return;
    }
    if (message.type === "broadcast.error") {
      state.errors.push({ code: message.code || null, error: message.error });
    }
  });

  await new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (state.subscribed || Date.now() - started > 8_000) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
  });

  return {
    socket,
    state,
    close() {
      try {
        socket.close(1000, "probe-complete");
      } catch {}
    },
  };
}

const report = {
  base: BASE.replace(/^https?:\/\//, ""),
  workspace: WORKSPACE,
  ok: false,
  phases: [],
};

const ctxA = deviceContext(`client_codex_broadcast_a_${uuid()}`);
const ctxB = deviceContext(`client_codex_broadcast_b_${uuid()}`);
const ctxDev = deviceContext(`client_codex_broadcast_dev_${uuid()}`);
let clientA = null;
let clientB = null;

try {
  const loginDev = await jsonFetch("/request-token", {
    method: "POST",
    body: { identifier: EMAIL, password: PASSWORD },
    ctx: ctxDev,
  });
  const loginA = await jsonFetch("/request-token", {
    method: "POST",
    body: { identifier: EMAIL, password: PASSWORD },
    ctx: ctxA,
  });
  const loginB = await jsonFetch("/request-token", {
    method: "POST",
    body: { identifier: EMAIL, password: PASSWORD },
    ctx: ctxB,
  });
  const token = loginDev.token;
  const tokenA = loginA.token;
  const tokenB = loginB.token;
  report.phases.push({
    name: "login",
    ok: !!token && !!tokenA && !!tokenB,
    clients: 3,
  });

  const dev = await jsonFetch("/dev-control/codex/session", {
    method: "POST",
    body: { agreementKey: AGREEMENT_KEY },
    token,
    ctx: ctxDev,
  });
  const session = dev.session;
  report.phases.push({ name: "dev-session", ok: !!session?.sessionId });

  const subscriptions = [
    { visibility: "reader", scope: { workspaceSlug: WORKSPACE } },
    { visibility: "workspace", scope: { workspaceSlug: WORKSPACE } },
    { visibility: "user" },
    { channel: "security" },
  ];

  await Promise.all([
    attachSigningSecret({ token: tokenA, ctx: ctxA }),
    attachSigningSecret({ token: tokenB, ctx: ctxB }),
  ]);

  clientA = await connectClient({
    name: "A",
    token: tokenA,
    ctx: ctxA,
    subscriptions,
  });
  clientB = await connectClient({
    name: "B",
    token: tokenB,
    ctx: ctxB,
    subscriptions,
  });
  report.phases.push({
    name: "connect-subscribe",
    clients: [
      { name: "A", ready: clientA.state.ready, subscribed: clientA.state.subscribed },
      { name: "B", ready: clientB.state.ready, subscribed: clientB.state.subscribed },
    ],
  });

  const before = await devCommand({
    token,
    session,
    ctx: ctxDev,
    command: "reader.snapshot",
    scope: { workspaceSlug: WORKSPACE },
  });

  const trigger = await devCommand({
    token,
    session,
    ctx: ctxDev,
    command: "reader.library.reconcile",
    scope: { workspaceSlug: WORKSPACE },
    params: { source: "codex-broadcast-dual-client-probe" },
  });
  report.phases.push({
    name: "trigger-reader-library-event",
    ok: !!trigger?.success,
    beforeBroadcast: before.summary?.broadcast || null,
    resultKeys: Object.keys(trigger.summary || {}),
  });

  await new Promise((resolve) => setTimeout(resolve, 2_000));

  const after = await devCommand({
    token,
    session,
    ctx: ctxDev,
    command: "reader.snapshot",
    scope: { workspaceSlug: WORKSPACE },
  });

  report.clients = [
    {
      name: "A",
      ready: clientA.state.ready,
      hello: clientA.state.hello,
      subscribed: clientA.state.subscribed,
      eventCount: clientA.state.events.length,
      ackCount: clientA.state.acks.filter((ack) => ack.ok).length,
      events: clientA.state.events,
      errors: clientA.state.errors,
    },
    {
      name: "B",
      ready: clientB.state.ready,
      hello: clientB.state.hello,
      subscribed: clientB.state.subscribed,
      eventCount: clientB.state.events.length,
      ackCount: clientB.state.acks.filter((ack) => ack.ok).length,
      events: clientB.state.events,
      errors: clientB.state.errors,
    },
  ];
  report.broadcastAfter = after.summary?.broadcast || null;
  report.ok = report.clients.every(
    (client) =>
      client.subscribed &&
      client.ackCount > 0 &&
      client.events.some(
        (event) =>
          event.type === "reader.document.added" ||
          (event.type === "document.added" && event.visibility === "reader")
      )
  );
} catch (error) {
  report.error = {
    message: error.message,
    status: error.status || null,
    code: error.data?.code || error.data?.error || null,
  };
} finally {
  clientA?.close();
  clientB?.close();
}

console.log(JSON.stringify(report, null, 2));
