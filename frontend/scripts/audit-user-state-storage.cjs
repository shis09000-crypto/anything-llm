#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "src");

const classifiedPatterns = [
  { pattern: /anythingllm_last_visited_workspace/, category: "sync" },
  { pattern: /anythingllm_last_visited_workspace_threads/, category: "sync" },
  { pattern: /anythingllm_user_prompt_input_map/, category: "sync_sensitive" },
  { pattern: /anythingllm_appearance_settings/, category: "sync" },
  { pattern: /anythingllm_text_size/, category: "sync" },
  { pattern: /theme/, category: "sync" },
  { pattern: /anythingllm-workspace-order/, category: "sync" },
  { pattern: /anythingllm_workspace_layout_intent/, category: "sync" },
  {
    pattern: /anythingllm_sidebar_collapsed_by_workspace/,
    category: "sync",
  },
  { pattern: /anythingllm_reader_split_percent/, category: "sync" },
  { pattern: /anythingllm_document_reader/, category: "sync_sanitized" },
  { pattern: /anythingllm\.cryptoCandlestickIndicators/, category: "sync" },
  {
    pattern: /anythingllm_crypto_trading_pair_detail_config/,
    category: "sync_existing_crypto",
  },
  { pattern: /anythingllm_authToken/, category: "sensitive_session" },
  { pattern: /athena_signing_secret/, category: "sensitive_session" },
  { pattern: /athena_client_id/, category: "local_identity" },
  { pattern: /threadHistoryCache|thread_history_cache/, category: "local_cache" },
  { pattern: /Scroll|scroll/, category: "local_transient" },
  { pattern: /Debug|debug/, category: "local_debug" },
  { pattern: /AUTH_USER|anythingllm_user/, category: "auth_profile_cache" },
  { pattern: /AUTH_TIMESTAMP|anythingllm_authTimestamp/, category: "auth_session" },
  { pattern: /LAST_USER_ACTION_AT|athena_lastUserActionAt/, category: "auth_session" },
  {
    pattern: /ZK_LOGIN|zkLogin|trusted-devices|resetToken/,
    category: "security_sensitive",
  },
  { pattern: /dev.*bypass|DevAuthBypass/i, category: "dev_only_sensitive" },
];

const fileClassifications = [
  { pattern: /\.node\.test\.mjs$/, category: "test_fixture" },
  { pattern: /\/__tests__\//, category: "test_fixture" },
  { pattern: /\/DocumentReader\//, category: "reader_state_boundary" },
  { pattern: /\/utils\/userStateSync\.js$/, category: "sync_helper" },
  { pattern: /\/utils\/authTokenStorage\.js$/, category: "sensitive_session" },
  { pattern: /\/utils\/zkLoginStorage\.js$/, category: "security_sensitive" },
  { pattern: /\/utils\/chat\/threadHistoryCache\.js$/, category: "local_cache" },
  { pattern: /\/utils\/chat\/chatScrollMemory\.js$/, category: "local_transient" },
  { pattern: /\/utils\/chat\/readerDrawerState\.js$/, category: "sync_sanitized" },
  { pattern: /\/utils\/chat\/memoryDiagnostics\.js$/, category: "debug" },
  { pattern: /\/utils\/layout\/workspaceLayoutState\.js$/, category: "sync" },
  { pattern: /\/utils\/lastVisitedWorkspace\.js$/, category: "sync" },
  { pattern: /\/utils\/textSize\.js$/, category: "sync" },
  { pattern: /\/models\/appearance\.js$/, category: "sync" },
  { pattern: /\/models\/workspace\.js$/, category: "sync" },
  { pattern: /\/hooks\/usePromptInputStorage\.js$/, category: "sync_sensitive" },
  { pattern: /\/contexts\/ChatThreadDraftProvider\.jsx$/, category: "session_draft_runtime" },
  { pattern: /\/components\/DefaultChat\//, category: "sync" },
  { pattern: /\/lib\/communication\/clientIdentity\.js$/, category: "local_identity" },
  {
    pattern: /\/lib\/communication\/requestSigningClient\.js$/,
    category: "sensitive_session",
  },
  { pattern: /\/AuthContext\.jsx$/, category: "auth_cleanup" },
  { pattern: /\/PrivateRoute\//, category: "auth_cleanup" },
  { pattern: /\/UserSettings\/AccountSettings\//, category: "auth_profile_cache" },
  { pattern: /\/UserMenu\/AccountModal\//, category: "auth_profile_cache" },
  { pattern: /\/Modals\/Password\//, category: "auth_flow" },
  { pattern: /\/SettingsSidebar\//, category: "local_ui_prefs" },
  { pattern: /\/ExperimentalFeatures\//, category: "local_ack" },
  { pattern: /\/OnboardingFlow\/Steps\/Survey\//, category: "local_ack" },
  { pattern: /\/ManageWorkspace\/Documents\//, category: "local_ack" },
  { pattern: /\/CryptoComponentExperiment\//, category: "crypto_ui_state" },
  { pattern: /\/pages\/Main\/Home\//, category: "transient_session" },
  { pattern: /\/components\/WorkspaceChat\//, category: "chat_ui_boundary" },
  { pattern: /\/models\/system\.js$/, category: "system_cache" },
  { pattern: /\/models\/fileAccessPolicy\.js$/, category: "local_device_policy" },
  { pattern: /\/utils\/userAction\.js$/, category: "auth_session" },
  { pattern: /\/GeneralSettings\/Settings\/components\//, category: "system_cache" },
];

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (/\.(js|jsx|ts|tsx|mjs)$/.test(entry.name)) files.push(full);
  }
  return files;
}

function classify(line, file) {
  const hit = classifiedPatterns.find((item) => item.pattern.test(line));
  if (hit?.category) return hit.category;
  const normalizedFile = file.split(path.sep).join("/");
  const fileHit = fileClassifications.find((item) =>
    item.pattern.test(normalizedFile)
  );
  return fileHit?.category || null;
}

const findings = [];
for (const file of walk(root)) {
  const rel = path.relative(process.cwd(), file);
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!/(localStorage|sessionStorage|IndexedDB|window\.caches|globalThis\.caches)/.test(line))
      return;
    if (/^\s*(\/\/|\*)/.test(line)) return;
    const category = classify(line, file);
    if (!category) {
      findings.push({
        file: rel,
        line: index + 1,
        category: "unclassified",
        source: line.trim().slice(0, 240),
      });
    }
  });
}

console.log(
  JSON.stringify(
    {
      success: findings.length === 0,
      findingCount: findings.length,
      findings,
      classifiedPatternCount: classifiedPatterns.length,
    },
    null,
    2
  )
);

process.exit(findings.length === 0 ? 0 : 1);
