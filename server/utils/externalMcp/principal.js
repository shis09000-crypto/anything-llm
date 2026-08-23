const crypto = require("crypto");
const JWT = require("jsonwebtoken");
const { SESSION_JWT_ALGORITHMS, jwtVerificationSecrets } = require("../http");

const FORMAT = "athena-external-mcp-principal:v1";
const AUDIENCE = "tool-runtime";

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function requestHash({ toolName, args, workspaceSlug }) {
  return crypto
    .createHash("sha256")
    .update(
      canonicalJson({
        toolName: String(toolName || ""),
        args: args && typeof args === "object" ? args : {},
        workspaceSlug: String(workspaceSlug || ""),
      })
    )
    .digest("hex");
}

function issueExternalMcpPrincipal({
  grant,
  clientId,
  toolName,
  args = {},
  workspaceSlug = null,
  correlationId,
}) {
  if (!process.env.JWT_SECRET)
    throw new Error("external_mcp_signing_key_unavailable");
  const payload = {
    format: FORMAT,
    iss: "external-mcp-gateway",
    aud: AUDIENCE,
    grantId: String(grant.id),
    ownerAuthUserId: String(grant.ownerAuthUserId || "single-user"),
    ownerUserId: Number(grant.ownerUserId),
    sessionId: `mcp-${grant.subjectType}:${grant.id}`,
    clientId: String(clientId),
    scopes: [...new Set(grant.scopes || [])].sort(),
    tools: [...new Set(grant.tools || [])].sort(),
    workspaces: (grant.workspaces || []).map((workspace) => ({
      id: Number(workspace.id),
      slug: String(workspace.slug),
    })),
    toolName: String(toolName),
    workspaceSlug: workspaceSlug ? String(workspaceSlug) : null,
    requestHash: requestHash({ toolName, args, workspaceSlug }),
    correlationId: String(correlationId || crypto.randomUUID()),
  };
  return {
    format: FORMAT,
    token: JWT.sign(payload, process.env.JWT_SECRET, {
      algorithm: SESSION_JWT_ALGORITHMS[0],
      expiresIn: 30,
    }),
  };
}

function verifyExternalMcpPrincipal(
  assertion,
  { toolName, args = {}, workspaceSlug = null } = {}
) {
  if (assertion?.format !== FORMAT || !assertion?.token)
    return { valid: false, findings: ["format_invalid"] };
  let payload = null;
  for (const secret of jwtVerificationSecrets()) {
    try {
      payload = JWT.verify(assertion.token, secret, {
        algorithms: SESSION_JWT_ALGORITHMS,
        audience: AUDIENCE,
        issuer: "external-mcp-gateway",
      });
      break;
    } catch {}
  }
  if (!payload) return { valid: false, findings: ["signature_invalid"] };
  const findings = [];
  if (payload.format !== FORMAT) findings.push("payload_format_invalid");
  if (toolName) {
    if (payload.toolName !== String(toolName)) findings.push("tool_mismatch");
    if (payload.requestHash !== requestHash({ toolName, args, workspaceSlug }))
      findings.push("request_hash_mismatch");
    if (
      !Array.isArray(payload.tools) ||
      !payload.tools.includes(String(toolName))
    )
      findings.push("tool_not_granted");
  }
  if (toolName && workspaceSlug) {
    const allowed = (payload.workspaces || []).some(
      (workspace) => String(workspace.slug) === String(workspaceSlug)
    );
    if (!allowed) findings.push("workspace_not_granted");
  }
  return { valid: findings.length === 0, findings, payload };
}

module.exports = {
  AUDIENCE,
  canonicalJson,
  FORMAT,
  issueExternalMcpPrincipal,
  requestHash,
  verifyExternalMcpPrincipal,
};
