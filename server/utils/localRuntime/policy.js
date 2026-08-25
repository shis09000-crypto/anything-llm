const path = require("path");
const { LOCAL_RUNTIME_CAPABILITIES, boundedString } = require("./contracts");

const TOOL_CAPABILITY = Object.freeze({
  local_device_status: "device.status",
  local_desktop_observe: "desktop.observe",
  local_desktop_act: "desktop.act",
  local_file_read: "file.read",
  local_file_write: "file.write",
  local_command_run: "command.run",
  local_job_cancel: "job.cancel",
});

const L4_PATTERNS = [
  /(?:password|passkey|one[- ]?time|otp|2fa|verification code)/i,
  /(?:keychain|security find-generic-password|security dump-keychain)/i,
  /(?:payment|purchase|checkout|bank|wallet|crypto.*transfer)/i,
  /(?:disable.*(?:firewall|gatekeeper|sip)|csrutil|spctl\s+--master-disable)/i,
  /(?:camera|microphone|avcapturedevice)/i,
];
const L3_PATTERNS = [
  /(?:sudo|installer|softwareupdate|launchctl\s+(?:load|bootstrap))/i,
  /(?:system settings|system preferences|osascript.*send)/i,
  /(?:curl|wget).*(?:-x\s+post|--data|--upload-file)/i,
];

function normalizeCapabilities(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(String))].filter(
    (value) => LOCAL_RUNTIME_CAPABILITIES.includes(value)
  );
}

function normalizeRoots(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(String))]
    .map((value) => path.resolve(value))
    .filter((value) => path.isAbsolute(value))
    .slice(0, 32);
}

function pathWithinRoots(candidate, roots = []) {
  const target = path.resolve(String(candidate || ""));
  return roots.some(
    (root) => target === root || target.startsWith(`${root}${path.sep}`)
  );
}

function riskFor(toolName, args = {}) {
  const text = JSON.stringify({ toolName, args }).slice(0, 128 * 1024);
  if (L4_PATTERNS.some((pattern) => pattern.test(text)))
    return {
      level: "L4",
      allowed: false,
      approvalRequired: false,
      reasonCode: "local_runtime_permanently_forbidden",
    };
  if (L3_PATTERNS.some((pattern) => pattern.test(text)))
    return {
      level: "L3",
      allowed: false,
      approvalRequired: true,
      reasonCode: "local_runtime_step_up_required",
    };
  if (
    ["local_desktop_act", "local_file_write", "local_command_run"].includes(
      toolName
    )
  )
    return {
      level: "L2",
      allowed: true,
      approvalRequired: false,
      reasonCode: "local_runtime_lease_authorized",
    };
  if (["local_desktop_observe", "local_file_read"].includes(toolName))
    return {
      level: "L1",
      allowed: true,
      approvalRequired: false,
      reasonCode: "local_runtime_lease_authorized",
    };
  return {
    level: "L0",
    allowed: true,
    approvalRequired: false,
    reasonCode: "local_runtime_lease_authorized",
  };
}

function authorizeLocalRuntime({
  toolName,
  args = {},
  lease,
  stepUpApproved = false,
} = {}) {
  const capability = TOOL_CAPABILITY[String(toolName || "")];
  if (!capability)
    return {
      allowed: false,
      approvalRequired: false,
      reasonCode: "local_runtime_tool_unknown",
      capability: null,
      risk: "L4",
    };
  if (
    !lease ||
    lease.status !== "active" ||
    new Date(lease.expiresAt).getTime() <= Date.now()
  )
    return {
      allowed: false,
      approvalRequired: false,
      reasonCode: "local_runtime_lease_inactive",
      capability,
      risk: "L4",
    };
  if (!normalizeCapabilities(lease.capabilities).includes(capability))
    return {
      allowed: false,
      approvalRequired: false,
      reasonCode: "local_runtime_capability_denied",
      capability,
      risk: "L4",
    };

  const risk = riskFor(toolName, args);
  if (!risk.allowed) {
    if (!(risk.approvalRequired && stepUpApproved))
      return { ...risk, capability, risk: risk.level };
  }
  const roots = normalizeRoots(lease.allowedRoots);
  const requestedPath = args.path || args.cwd || null;
  if (requestedPath && !pathWithinRoots(requestedPath, roots))
    return {
      allowed: false,
      approvalRequired: false,
      reasonCode: "local_runtime_path_outside_lease",
      capability,
      risk: "L4",
    };

  if (toolName === "local_desktop_act") {
    const action = boundedString(args.action, 64);
    if (
      ![
        "click",
        "double_click",
        "move",
        "scroll",
        "key",
        "type",
        "open_app",
      ].includes(action)
    )
      return {
        allowed: false,
        approvalRequired: false,
        reasonCode: "local_runtime_desktop_action_denied",
        capability,
        risk: "L4",
      };
  }
  return {
    allowed: true,
    approvalRequired: false,
    reasonCode:
      risk.level === "L3"
        ? "local_runtime_step_up_authorized"
        : risk.reasonCode,
    capability,
    risk: risk.level,
  };
}

module.exports = {
  TOOL_CAPABILITY,
  authorizeLocalRuntime,
  normalizeCapabilities,
  normalizeRoots,
  pathWithinRoots,
  riskFor,
};
