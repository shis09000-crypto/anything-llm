#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const DEFAULT_PATTERNS = [
  {
    id: "workspace_chat_id_only_lookup",
    pattern: /WorkspaceChats\.get\(\s*\{\s*id\s*:/,
    message:
      "WorkspaceChats.get by id should include workspace/thread/user scope.",
  },
  {
    id: "workspace_thread_id_only_lookup",
    pattern: /WorkspaceThread\.get\(\s*\{\s*id\s*:/,
    message: "WorkspaceThread.get by id should include workspace/user scope.",
  },
  {
    id: "document_lookup_review",
    pattern: /Document\.get\(\s*\{/,
    message: "Document.get should be reviewed for workspace ownership scope.",
  },
  {
    id: "raw_url_log",
    pattern:
      /console\.(log|warn|error)\([^)]*(\$\{(link|url|baseUrl|pageUrl)\}|,\s*(link|url|baseUrl|pageUrl)\s*[),])/,
    message: "URL-like values in logs should be redacted.",
  },
  {
    id: "raw_sensitive_header_log",
    pattern:
      /console\.(log|warn|error)\([^)]*(\$\{[^}]*(authorization|cookie|apiKey|accessToken|apiToken|secret|token)[^}]*\}|,\s*(authorization|cookie|apiKey|accessToken|apiToken|secret|token)\s*[),])/i,
    message: "Sensitive headers/tokens should not be logged.",
  },
];

const DEFAULT_ALLOWLIST = [
  {
    id: "document_lookup_review",
    file: "server/endpoints/api/workspace/index.js",
    note: "Developer API key route; workspace slug scope is validated inside route.",
  },
  {
    id: "document_lookup_review",
    file: "server/endpoints/experimental/liveSync.js",
    note: "Admin workspace route; validWorkspaceSlug sets workspace scope.",
  },
  {
    id: "document_lookup_review",
    file: "server/endpoints/workspaceReaderDocuments.js",
    note: "Workspace reader route uses valid workspace scope before document lookup.",
  },
  {
    id: "document_lookup_review",
    file: "server/endpoints/workspaces.js",
    note: "Workspace routes use validWorkspaceSlug/getAuthorizedWorkspace around document lookup.",
  },
  {
    id: "document_lookup_review",
    file: "server/utils/files/purgeDocument.js",
    note: "Internal purge helper is called after endpoint-level workspace/document ownership checks.",
  },
  {
    id: "document_lookup_review",
    file: "server/utils/mindMap/index.js",
    note: "Mind map document source lookup includes workspaceId in clause.",
  },
  {
    id: "document_lookup_review",
    file: "server/models/workspaceParsedFiles.js",
    note: "Model helper scopes document lookup by parsed file workspace/docpath context.",
  },
  {
    id: "workspace_chat_id_only_lookup",
    file: "server/models/workspaceChats.js",
    note: "Model implementation owns primitive lookup method.",
  },
  {
    id: "workspace_thread_id_only_lookup",
    file: "server/models/workspaceThread.js",
    note: "Model implementation owns primitive lookup method.",
  },
  {
    id: "workspace_thread_id_only_lookup",
    file: "server/utils/telegramBot/utils/navigation/callbacks/handleThreadSelect.js",
    note: "Telegram bot navigation validates workspace/thread ownership in connector context.",
  },
  {
    id: "raw_sensitive_header_log",
    file: "collector/utils/extensions/RepoLoader/GithubRepo/RepoLoader/index.js",
    note: "Logs token validity state, not token value.",
  },
  {
    id: "raw_sensitive_header_log",
    file: "collector/utils/extensions/RepoLoader/GitlabRepo/RepoLoader/index.js",
    note: "Logs token validity state, not token value.",
  },
];

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(fullPath, files);
    else if (entry.isFile() && fullPath.endsWith(".js")) files.push(fullPath);
  }
  return files;
}

function relativePath(rootDir, file) {
  return path.relative(rootDir, file).split(path.sep).join("/");
}

function isAllowed(finding, allowlist = DEFAULT_ALLOWLIST) {
  return allowlist.some(
    (entry) =>
      entry.id === finding.id &&
      (finding.file === entry.file || finding.file.endsWith(entry.file))
  );
}

function auditResourceCommunicationAccess({
  rootDir = path.resolve(__dirname, "../.."),
  scanDirs = ["server/endpoints", "server/utils", "server/models", "collector"],
  patterns = DEFAULT_PATTERNS,
  allowlist = DEFAULT_ALLOWLIST,
} = {}) {
  const findings = [];
  for (const scanDir of scanDirs) {
    const absDir = path.resolve(rootDir, scanDir);
    for (const file of walk(absDir)) {
      const rel = relativePath(rootDir, file);
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const item of patterns) {
          if (!item.pattern.test(line)) continue;
          const finding = {
            id: item.id,
            file: rel,
            line: index + 1,
            message: item.message,
            snippet: line.trim(),
          };
          if (!isAllowed(finding, allowlist)) findings.push(finding);
        }
      });
    }
  }
  return {
    success: findings.length === 0,
    findings,
    allowlistCount: allowlist.length,
  };
}

function main() {
  const result = auditResourceCommunicationAccess();
  console.log(JSON.stringify(result, null, 2));
  if (!result.success) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  DEFAULT_ALLOWLIST,
  DEFAULT_PATTERNS,
  auditResourceCommunicationAccess,
};
