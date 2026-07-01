const { envFlag } = require("./transportSecurity");

function normalizeOrigin(value = "") {
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return null;
  }
}

function splitValues(value = "") {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function cspSourceList(values = []) {
  return [...new Set(values.filter(Boolean))].join(" ");
}

function configuredConnectSources(env = process.env) {
  const sources = new Set(["'self'"]);
  const urlEnvKeys = [
    "PUBLIC_APP_URL",
    "PUBLIC_API_URL",
    "SERVER_URL",
    "API_BASE",
    "COLLECTOR_URL",
  ];

  for (const key of urlEnvKeys) {
    const origin = normalizeOrigin(env[key]);
    if (!origin) continue;
    sources.add(origin);
    if (origin.startsWith("https://")) {
      sources.add(origin.replace(/^https:/, "wss:"));
    }
  }

  for (const origin of splitValues(env.ATHENA_ALLOWED_ORIGINS)) {
    const normalized = normalizeOrigin(origin);
    if (normalized) sources.add(normalized);
  }

  for (const source of splitValues(env.ATHENA_CSP_CONNECT_SRC)) {
    sources.add(source);
  }

  return [...sources];
}

function buildContentSecurityPolicy(env = process.env) {
  const scriptSources = ["'self'", "'wasm-unsafe-eval'"];
  if (envFlag(env.ATHENA_CSP_ALLOW_UNSAFE_EVAL)) {
    scriptSources.push("'unsafe-eval'");
  }

  const styleSources = ["'self'"];
  if (!envFlag(env.ATHENA_CSP_STRICT_STYLE)) {
    styleSources.push("'unsafe-inline'");
  }

  const directives = [
    ["default-src", ["'self'"]],
    ["base-uri", ["'self'"]],
    ["object-src", ["'none'"]],
    ["frame-ancestors", ["'none'"]],
    ["script-src", scriptSources],
    ["style-src", styleSources],
    ["img-src", ["'self'", "data:", "blob:", "https:"]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", configuredConnectSources(env)],
    ["worker-src", ["'self'", "blob:"]],
    ["manifest-src", ["'self'"]],
  ];

  if (envFlag(env.ATHENA_TRUSTED_TYPES)) {
    directives.push(["require-trusted-types-for", ["'script'"]]);
  }

  return directives
    .map(([name, sources]) => `${name} ${cspSourceList(sources)}`)
    .join("; ");
}

function setBrowserSecurityHeaders(response, env = process.env) {
  response.removeHeader("X-Powered-By");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader(
    "Permissions-Policy",
    "camera=(self), microphone=(self), geolocation=(), payment=()"
  );
  response.setHeader(
    "Content-Security-Policy",
    buildContentSecurityPolicy(env)
  );
}

module.exports = {
  buildContentSecurityPolicy,
  configuredConnectSources,
  setBrowserSecurityHeaders,
};
