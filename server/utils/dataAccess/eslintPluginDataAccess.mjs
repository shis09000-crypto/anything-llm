import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, "../..");
const baselinePath = path.join(__dirname, "dataAccessBypassBaseline.json");

const DIRECT_ACCESS_ALLOWLIST = Object.freeze([
  /^utils\/prisma\/index\.js$/,
  /^utils\/database\/index\.js$/,
  /^utils\/dataAccess\//,
  /^utils\/security\//,
  /^utils\/authz\/sensitiveSessions\.js$/,
  /^utils\/environment\/index\.js$/,
]);

function relativeServerPath(filePath = "") {
  return path.relative(serverRoot, filePath).replace(/\\/g, "/");
}

function isScopedPath(relativePath = "") {
  return /^(endpoints|services|utils)\//.test(relativePath);
}

function isAllowedPath(relativePath = "") {
  return DIRECT_ACCESS_ALLOWLIST.some((pattern) => pattern.test(relativePath));
}

function compactString(value = "", max = 180) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function domainFromPath(relativePath = "", match = "") {
  const value = `${relativePath} ${match}`.toLowerCase();
  if (value.includes("reader")) return "readerLibrary";
  if (value.includes("workspace_thread") || value.includes("thread"))
    return "workspaceThread";
  if (value.includes("workspace_chat") || value.includes("chat"))
    return "workspaceChat";
  if (value.includes("workspace")) return "workspace";
  if (value.includes("document_vector") || value.includes("vector"))
    return "documentVector";
  if (value.includes("documentindex") || value.includes("indexstatus"))
    return "documentIndexStatus";
  if (value.includes("document")) return "document";
  if (value.includes("vault")) return "vault";
  if (value.includes("crypto")) return "crypto";
  if (value.includes("system") || value.includes("admin")) return "adminSystem";
  if (value.includes("auth") || value.includes("identity"))
    return "authIdentity";
  if (value.includes("userstate") || value.includes("user_state"))
    return "userState";
  if (value.includes("knowledge")) return "knowledgeGraph";
  if (value.includes("quiz")) return "quiz";
  return "unknown";
}

function findingKey(item = {}) {
  return [
    item.type || "",
    item.file || "",
    item.domain || "",
    item.match || "",
    item.detail || "",
  ].join("|");
}

function readBaselineKeys() {
  try {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    return new Set((baseline.findings || []).map((finding) => finding.key));
  } catch {
    return new Set();
  }
}

function literalValue(node) {
  return node?.type === "Literal" && typeof node.value === "string"
    ? node.value
    : null;
}

function requireCallValue(node) {
  if (node?.callee?.type !== "Identifier" || node.callee.name !== "require")
    return null;
  return literalValue(node.arguments?.[0]);
}

function modelDetailFromRequire(value = "") {
  const match = value.match(/(?:^|\/|\.\.\/)models\/(.+)$/);
  return match?.[1] || null;
}

function createFinding(context, node, { type, match, detail = null }) {
  const file = relativeServerPath(context.getFilename());
  if (!isScopedPath(file) || isAllowedPath(file)) return null;
  const compactMatch = compactString(match);
  const compactDetail = detail ? compactString(detail) : null;
  return {
    key: findingKey({
      type,
      file,
      domain: domainFromPath(file, compactDetail || compactMatch),
      match: compactMatch,
      detail: compactDetail,
    }),
    node,
    type,
    file,
  };
}

function reportIfNew(context, baselineKeys, finding) {
  if (!finding || baselineKeys.has(finding.key)) return;
  context.report({
    node: finding.node,
    message:
      "Direct {{type}} access is outside DataAccessCenter. Add a repository/DataAccessCenter wrapper instead of creating a new bypass.",
    data: { type: finding.type },
  });
}

const plugin = {
  rules: {
    "no-direct-data-access": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Prevent new direct model/prisma access outside DataAccessCenter migration baseline.",
        },
        schema: [],
      },
      create(context) {
        const baselineKeys = readBaselineKeys();
        const sourceCode = context.sourceCode || context.getSourceCode();
        return {
          CallExpression(node) {
            const value = requireCallValue(node);
            if (!value) return;

            if (value === "@prisma/client") {
              reportIfNew(
                context,
                baselineKeys,
                createFinding(context, node, {
                  type: "direct-prisma-client-import",
                  match: sourceCode.getText(node),
                  detail: "@prisma/client",
                })
              );
              return;
            }

            const detail = modelDetailFromRequire(value);
            if (!detail) return;
            reportIfNew(
              context,
              baselineKeys,
              createFinding(context, node, {
                type: "direct-model-import",
                match: sourceCode.getText(node),
                detail,
              })
            );
          },
          MemberExpression(node) {
            if (
              node.object?.type !== "Identifier" ||
              node.object.name !== "prisma"
            )
              return;
            if (
              node.property?.type === "Identifier" &&
              node.property.name === "_runtimeDataModel"
            )
              return;

            reportIfNew(
              context,
              baselineKeys,
              createFinding(context, node, {
                type: "direct-prisma-access",
                match: "prisma.",
              })
            );
          },
        };
      },
    },
  },
};

export default plugin;
