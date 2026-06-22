function envFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function isProduction(env = process.env) {
  return env.NODE_ENV === "production";
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function allowedOrigins(env = process.env) {
  const origins = new Set();
  const configured = String(env.ATHENA_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  for (const origin of configured) origins.add(origin.replace(/\/+$/, ""));
  if (isHttpsUrl(env.PUBLIC_APP_URL)) {
    origins.add(String(env.PUBLIC_APP_URL).replace(/\/+$/, ""));
  }
  return origins;
}

function parseTrustProxy(value) {
  if (envFlag(value)) return true;
  if (/^\d+$/.test(String(value || ""))) return Number(value);
  return value || false;
}

function productionTransportMode(env = process.env) {
  if (!isProduction(env)) return { required: false, mode: "development" };
  if (envFlag(env.ENABLE_HTTPS)) {
    return { required: true, mode: "direct_https" };
  }
  if (
    envFlag(env.TRUST_PROXY) &&
    envFlag(env.FORCE_HTTPS) &&
    isHttpsUrl(env.PUBLIC_APP_URL)
  ) {
    return { required: true, mode: "trusted_proxy" };
  }
  return { required: true, mode: "invalid" };
}

function assertProductionTransportConfig(env = process.env) {
  const mode = productionTransportMode(env);
  if (!mode.required || mode.mode !== "invalid") return mode;

  throw new Error(
    "Production transport requires ENABLE_HTTPS=true or TRUST_PROXY=true, FORCE_HTTPS=true, and PUBLIC_APP_URL=https://..."
  );
}

function isSecureRequest(request) {
  if (request?.secure) return true;
  if (request?.socket?.encrypted) return true;
  const forwardedProto = String(
    request?.headers?.["x-forwarded-proto"] ||
      request?.get?.("x-forwarded-proto") ||
      ""
  )
    .split(",")[0]
    .trim()
    .toLowerCase();
  return forwardedProto === "https";
}

function productionHstsValue(env = process.env) {
  return env.ATHENA_HSTS_HEADER || "max-age=15552000; includeSubDomains";
}

function transportSecurityMiddleware(env = process.env) {
  return function enforceTransportSecurity(request, response, next) {
    if (!isProduction(env)) return next();

    if (isSecureRequest(request)) {
      response.setHeader("Strict-Transport-Security", productionHstsValue(env));
      return next();
    }

    if (request.path?.startsWith("/api")) {
      return response.status(426).json({
        success: false,
        error: "https_required",
      });
    }

    if (env.PUBLIC_APP_URL && ["GET", "HEAD"].includes(request.method)) {
      const redirectUrl = new URL(
        request.originalUrl || "/",
        env.PUBLIC_APP_URL
      );
      return response.redirect(301, redirectUrl.toString());
    }

    return response.status(426).send("HTTPS required");
  };
}

function applyTransportSecurity(app, env = process.env) {
  const mode = assertProductionTransportConfig(env);
  if (envFlag(env.TRUST_PROXY)) {
    app.set("trust proxy", parseTrustProxy(env.TRUST_PROXY));
  }
  app.use(transportSecurityMiddleware(env));
  return mode;
}

function corsOptionsForEnvironment(env = process.env) {
  if (!isProduction(env)) return { origin: true };
  const origins = allowedOrigins(env);

  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      const normalized = String(origin).replace(/\/+$/, "");
      if (origins.has(normalized)) return callback(null, true);
      return callback(new Error("Origin not allowed by CORS"));
    },
    credentials: true,
  };
}

function ensureSecureWebSocketRequest(request, socket, env = process.env) {
  if (!isProduction(env) || isSecureRequest(request)) return true;
  try {
    socket?.close?.(1008, "secure_transport_required");
  } catch {}
  return false;
}

module.exports = {
  allowedOrigins,
  applyTransportSecurity,
  assertProductionTransportConfig,
  corsOptionsForEnvironment,
  ensureSecureWebSocketRequest,
  envFlag,
  isSecureRequest,
  productionTransportMode,
  transportSecurityMiddleware,
};
