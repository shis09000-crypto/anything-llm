const dns = require("dns");
const net = require("net");

const METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.azure.internal",
  "instance-data.ec2.internal",
]);

class BrowserDestinationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "BrowserDestinationError";
    this.code = "browser_destination_forbidden";
    this.httpStatus = 403;
    this.details = details;
  }
}

function normalizeHostname(value = "") {
  return String(value || "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

function ipv4Number(address) {
  const parts = String(address).split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return null;
  return (
    (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0
  );
}

function inV4Range(address, network, bits) {
  const value = ipv4Number(address);
  const base = ipv4Number(network);
  if (value === null || base === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
}

function forbiddenAddress(address) {
  const kind = net.isIP(address);
  if (kind === 4) {
    return [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ].some(([network, bits]) => inV4Range(address, network, bits));
  }
  if (kind === 6) {
    const normalized = normalizeHostname(address);
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    if (/^fe[89ab]/.test(normalized)) return true;
    if (normalized.startsWith("ff")) return true;
    if (normalized.startsWith("::ffff:")) {
      return forbiddenAddress(normalized.slice("::ffff:".length));
    }
    return false;
  }
  return true;
}

async function assertBrowserDestination(
  value,
  { lookup = dns.promises.lookup } = {}
) {
  if (Buffer.byteLength(String(value || ""), "utf8") > 4_096)
    throw new BrowserDestinationError("Browser destination is too long.");
  let url;
  try {
    url = value instanceof URL ? value : new URL(String(value));
  } catch {
    throw new BrowserDestinationError("Browser destination is invalid.");
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new BrowserDestinationError(
      "Browser destination protocol is forbidden.",
      {
        protocol: url.protocol,
      }
    );
  }
  if (url.username || url.password) {
    throw new BrowserDestinationError(
      "Browser destination credentials are forbidden."
    );
  }
  const hostname = normalizeHostname(url.hostname);
  if (METADATA_HOSTS.has(hostname)) {
    throw new BrowserDestinationError(
      "Cloud metadata destination is forbidden.",
      {
        hostname,
      }
    );
  }
  const records = net.isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (
    !records.length ||
    records.some((record) => forbiddenAddress(record.address))
  ) {
    throw new BrowserDestinationError(
      "Browser destination address is forbidden.",
      {
        hostname,
        addressCount: records.length,
      }
    );
  }
  return {
    url,
    addresses: [...new Set(records.map((record) => record.address))],
  };
}

module.exports = {
  BrowserDestinationError,
  METADATA_HOSTS,
  assertBrowserDestination,
  forbiddenAddress,
  normalizeHostname,
};
