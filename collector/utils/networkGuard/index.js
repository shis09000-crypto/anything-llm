const dns = require("dns");
const net = require("net");
const ipaddr = require("ipaddr.js");
const { Agent } = require("undici");
const { currentTaskSignal } = require("../taskContext");

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_REDIRECTS = 5;
const DNS_CACHE_MS = 5_000;
const resolutionCache = new Map();
const CROSS_ORIGIN_SENSITIVE_HEADERS = [
  "authorization",
  "cookie",
  "proxy-authorization",
  "private-token",
  "x-api-key",
  "x-auth-token",
];
const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.azure.internal",
  "instance-data.ec2.internal",
]);

class CollectorDestinationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CollectorDestinationError";
    this.code = "collector_destination_forbidden";
    this.details = details;
  }
}

function guardEnabled() {
  return process.env.ATHENA_COLLECTOR_GUARD_V2 !== "false";
}

function normalizedHost(value = "") {
  return String(value || "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

function privateRange(address) {
  try {
    const parsed = ipaddr.process(normalizedHost(address));
    const range = parsed.range();
    if (parsed.kind() === "ipv4") {
      return [
        "unspecified",
        "broadcast",
        "multicast",
        "linkLocal",
        "loopback",
        "private",
        "carrierGradeNat",
        "reserved",
        "benchmarking",
      ].includes(range);
    }
    return [
      "unspecified",
      "linkLocal",
      "loopback",
      "uniqueLocal",
      "multicast",
      "reserved",
    ].includes(range);
  } catch {
    return true;
  }
}

function allowlistEntries() {
  return String(process.env.COLLECTOR_PRIVATE_NETWORK_ALLOWLIST || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function hostnameAllowlisted(hostname) {
  const host = normalizedHost(hostname);
  return allowlistEntries().some((entry) => {
    if (entry.includes("/")) return false;
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1);
      return host.endsWith(suffix) && host !== suffix.slice(1);
    }
    return host === normalizedHost(entry);
  });
}

function addressAllowlisted(address) {
  let parsed;
  try {
    parsed = ipaddr.process(normalizedHost(address));
  } catch {
    return false;
  }
  return allowlistEntries().some((entry) => {
    if (!entry.includes("/")) return false;
    try {
      const [range, prefix] = ipaddr.parseCIDR(entry);
      const comparable = ipaddr.process(range.toString());
      return (
        comparable.kind() === parsed.kind() && parsed.match(comparable, prefix)
      );
    } catch {
      return false;
    }
  });
}

function isAddressAllowed(address, hostname = null) {
  if (!guardEnabled()) return true;
  if (!privateRange(address)) return true;
  return hostnameAllowlisted(hostname) || addressAllowlisted(address);
}

function isLiteralDestinationAllowed(hostname) {
  const host = normalizedHost(hostname);
  if (!net.isIP(host)) return true;
  return isAddressAllowed(host, host);
}

async function resolveHostname(hostname) {
  const host = normalizedHost(hostname);
  const cached = resolutionCache.get(host);
  if (cached?.expiresAt > Date.now()) return cached.addresses;
  const records = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : await dns.promises.lookup(host, { all: true, verbatim: true });
  const addresses = [...new Set(records.map((record) => record.address))];
  resolutionCache.set(host, {
    addresses,
    expiresAt: Date.now() + DNS_CACHE_MS,
  });
  return addresses;
}

async function assertSafeDestination(value) {
  let destination;
  try {
    destination = value instanceof URL ? value : new URL(String(value));
  } catch {
    throw new CollectorDestinationError("Destination URL is invalid.");
  }
  if (!["http:", "https:"].includes(destination.protocol)) {
    throw new CollectorDestinationError("Destination protocol is forbidden.", {
      protocol: destination.protocol,
    });
  }
  const hostname = normalizedHost(destination.hostname);
  if (METADATA_HOSTS.has(hostname) || hostname === "metadata") {
    throw new CollectorDestinationError(
      "Cloud metadata destinations are forbidden.",
      { hostname }
    );
  }
  if (!guardEnabled()) return { destination, addresses: [] };
  const addresses = await resolveHostname(hostname);
  if (addresses.length === 0) {
    throw new CollectorDestinationError("Destination did not resolve.", {
      hostname,
    });
  }
  const forbidden = addresses.filter(
    (address) => !isAddressAllowed(address, hostname)
  );
  if (forbidden.length > 0) {
    throw new CollectorDestinationError("Destination address is forbidden.", {
      hostname,
      addressCount: addresses.length,
    });
  }
  return { destination, addresses };
}

function guardedLookup(hostname, options, callback) {
  const lookupOptions =
    options && typeof options === "object" ? options : { family: options };
  dns.lookup(hostname, lookupOptions, (error, address, family) => {
    if (error) return callback(error);
    const records = lookupOptions.all ? address : [{ address, family }];
    if (
      !Array.isArray(records) ||
      records.length === 0 ||
      records.some((record) => !isAddressAllowed(record.address, hostname))
    ) {
      return callback(
        new CollectorDestinationError(
          "Destination changed to a forbidden address during connection.",
          { hostname }
        )
      );
    }
    return lookupOptions.all
      ? callback(null, records)
      : callback(null, address, family);
  });
}

const safeDispatcher = new Agent({ connect: { lookup: guardedLookup } });
const insecureTlsDispatcher = new Agent({
  connect: { lookup: guardedLookup, rejectUnauthorized: false },
});

function combinedSignal(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(
    Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS
  );
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function redirectFetchOptions(options, status, from, to) {
  const next = { ...options };
  const headers = new Headers(options.headers || {});
  if (from.origin !== to.origin) {
    for (const header of CROSS_ORIGIN_SENSITIVE_HEADERS) headers.delete(header);
  }
  const method = String(options.method || "GET").toUpperCase();
  if (
    (status === 303 && !["GET", "HEAD"].includes(method)) ||
    ([301, 302].includes(status) && method === "POST")
  ) {
    next.method = "GET";
    delete next.body;
    headers.delete("content-length");
    headers.delete("content-type");
  }
  next.headers = headers;
  return next;
}

async function safeFetch(value, options = {}) {
  const {
    maxRedirects = MAX_REDIRECTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal = null,
    allowInsecureTls = false,
    ...fetchOptions
  } = options;
  const activeSignal = signal || currentTaskSignal();
  const timeoutBudgetMs =
    Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const deadlineAt = Date.now() + timeoutBudgetMs;
  let destination = value instanceof URL ? value : new URL(String(value));
  let requestOptions = fetchOptions;
  for (
    let redirectCount = 0;
    redirectCount <= maxRedirects;
    redirectCount += 1
  ) {
    await assertSafeDestination(destination);
    const response = await fetch(destination, {
      ...requestOptions,
      redirect: "manual",
      dispatcher: allowInsecureTls ? insecureTlsDispatcher : safeDispatcher,
      signal: combinedSignal(
        activeSignal,
        Math.max(deadlineAt - Date.now(), 1)
      ),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (redirectCount === maxRedirects) {
      await response.body?.cancel().catch(() => null);
      throw new CollectorDestinationError("Too many redirects.");
    }
    const nextDestination = new URL(location, destination);
    requestOptions = redirectFetchOptions(
      requestOptions,
      response.status,
      destination,
      nextDestination
    );
    destination = nextDestination;
    await response.body?.cancel().catch(() => null);
  }
  throw new CollectorDestinationError("Too many redirects.");
}

async function readResponseBufferLimited(response, maxBytes) {
  const limit = Number(maxBytes);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => null);
    throw Object.assign(new Error("Response exceeds configured byte limit."), {
      code: "collector_response_too_large",
    });
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel().catch(() => null);
      throw Object.assign(
        new Error("Response exceeds configured byte limit."),
        { code: "collector_response_too_large" }
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, bytes);
}

async function readResponseTextLimited(response, maxBytes) {
  return (await readResponseBufferLimited(response, maxBytes)).toString("utf8");
}

async function readResponseJsonLimited(response, maxBytes) {
  return JSON.parse(await readResponseTextLimited(response, maxBytes));
}

module.exports = {
  CollectorDestinationError,
  assertSafeDestination,
  guardEnabled,
  isAddressAllowed,
  isLiteralDestinationAllowed,
  readResponseBufferLimited,
  readResponseJsonLimited,
  readResponseTextLimited,
  safeFetch,
  _private: {
    addressAllowlisted,
    hostnameAllowlisted,
    normalizedHost,
    privateRange,
    redirectFetchOptions,
    resolutionCache,
  },
};
