const { BROWSER_ACTIONS } = require("./contracts");

const MODES = Object.freeze(["sandbox", "authorized", "open"]);
const READ_ACTIONS = new Set([
  "navigate",
  "back",
  "forward",
  "reload",
  "stop",
  "scroll",
  "find",
  "zoom",
  "extract",
  "capture",
]);
const WRITE_ACTIONS = new Set([
  "click",
  "input",
  "key",
  "submit",
  "upload",
  "download",
  "fullscreen",
]);
const ALWAYS_APPROVE_INTENTS = new Set([
  "payment",
  "purchase",
  "password_change",
  "security_setting",
  "account_delete",
  "public_publish",
  "external_message",
  "irreversible",
]);

function normalizeMode(value = "sandbox") {
  const mode = String(value || "sandbox")
    .trim()
    .toLowerCase();
  return MODES.includes(mode) ? mode : "sandbox";
}

function normalizeDomain(value = "") {
  try {
    const url = value instanceof URL ? value : new URL(String(value));
    return url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\.$/, "");
  }
}

function domainMatches(hostname, allowedDomain) {
  const host = normalizeDomain(hostname);
  const allowed = normalizeDomain(allowedDomain).replace(/^\*\./, "");
  return Boolean(allowed) && (host === allowed || host.endsWith(`.${allowed}`));
}

function browserPermissionDecision({
  mode = "sandbox",
  action,
  intent = null,
  url = null,
  authorizedDomains = [],
  administratorDeniedDomains = [],
} = {}) {
  const normalizedMode = normalizeMode(mode);
  const normalizedAction = String(action || "")
    .trim()
    .toLowerCase();
  const normalizedIntent = String(intent || "")
    .trim()
    .toLowerCase();
  if (!BROWSER_ACTIONS.includes(normalizedAction)) {
    return {
      allowed: false,
      approvalRequired: false,
      reasonCode: "browser_action_unknown",
      risk: "denied",
    };
  }
  const hostname = normalizeDomain(url);
  if (
    hostname &&
    administratorDeniedDomains.some((domain) => domainMatches(hostname, domain))
  ) {
    return {
      allowed: false,
      approvalRequired: false,
      reasonCode: "browser_domain_denied",
      risk: "denied",
    };
  }
  if (ALWAYS_APPROVE_INTENTS.has(normalizedIntent)) {
    return {
      allowed: false,
      approvalRequired: true,
      reasonCode: "browser_high_risk_approval_required",
      risk: "critical",
    };
  }
  if (READ_ACTIONS.has(normalizedAction)) {
    return {
      allowed: true,
      approvalRequired: false,
      reasonCode: "browser_read_allowed",
      risk: "read",
    };
  }
  if (!WRITE_ACTIONS.has(normalizedAction)) {
    return {
      allowed: false,
      approvalRequired: true,
      reasonCode: "browser_action_approval_required",
      risk: "write",
    };
  }
  if (normalizedMode === "open") {
    return {
      allowed: true,
      approvalRequired: false,
      reasonCode: "browser_open_mode_allowed",
      risk: "write",
    };
  }
  const authorized =
    normalizedMode === "authorized" &&
    hostname &&
    authorizedDomains.some((domain) => domainMatches(hostname, domain));
  if (authorized && ["click", "key", "fullscreen"].includes(normalizedAction)) {
    return {
      allowed: true,
      approvalRequired: false,
      reasonCode: "browser_authorized_navigation_allowed",
      risk: "interaction",
    };
  }
  return {
    allowed: false,
    approvalRequired: true,
    reasonCode: "browser_write_approval_required",
    risk: normalizedAction === "download" ? "transfer" : "write",
  };
}

module.exports = {
  ALWAYS_APPROVE_INTENTS,
  MODES,
  READ_ACTIONS,
  WRITE_ACTIONS,
  browserPermissionDecision,
  domainMatches,
  normalizeDomain,
  normalizeMode,
};
