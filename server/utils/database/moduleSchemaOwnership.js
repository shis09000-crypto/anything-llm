const fs = require("fs");
const path = require("path");

const MAIN_SCHEMA_ROLES = Object.freeze({
  identity: "athena_identity",
  key_custody: "athena_key_custody",
  workspace: "athena_workspace",
  chat: "athena_chat",
  agent: "athena_agent",
  model_runtime: "athena_model_runtime",
  responses_runtime: "athena_responses_runtime",
  tools: "athena_tools",
  crypto_market: "athena_crypto_market",
  crypto_account: "athena_crypto_account",
  crypto_forecast: "athena_crypto_forecast",
  browser_plane: "athena_browser_plane",
  browser_egress: "athena_browser_egress",
  knowledge_query: "athena_knowledge_query",
  knowledge_ingest: "athena_knowledge_ingest",
  knowledge_reader: "athena_knowledge_reader",
  maintenance: "athena_maintenance",
  scheduler: "athena_scheduler",
  coordination: "athena_coordination",
  sync: "athena_sync",
});

const AUTH_SCHEMA_ROLES = Object.freeze({
  identity: "athena_identity",
  key_custody: "athena_key_custody",
});

// Cross-domain writes stay deny-by-default. The entries below are narrow
// append capabilities required before a producer can hand audit persistence
// to its final physical schema owner. They grant no UPDATE or DELETE access.
const MAIN_CROSS_SCHEMA_CAPABILITIES = Object.freeze([
  ...["event_logs", "security_audit_ledger", "security_audit_checkpoints"].map(
    (table) => ({
      schema: "identity",
      table,
      privileges: Object.freeze(["SELECT", "INSERT"]),
      capability: "security-audit-append",
    })
  ),
]);

// Ownership is intentionally conservative. Tables not yet extracted from the
// Workspace Control API remain owned by `workspace`; this prevents an
// incomplete split from silently granting a specialized runtime write access.
const MAIN_OWNERSHIP_RULES = Object.freeze([
  ["key_custody", /^security_key_/i],
  [
    "identity",
    /^(users|memory_candidates|user_memory_|user_profile_overviews|user_state_preferences|vault_|user_domain_|athena_clients|athena_device_attestation_challenges|athena_request_nonces|auth_device_recovery_challenges)/i,
  ],
  [
    "chat",
    /^(workspace_chats|chat_stream_runs|chat_run_events|chat_attachment_|workspace_chat_)/i,
  ],
  ["agent", /^(agent_runs|agent_run_events|workspace_agent_invocations)$/i],
  ["tools", /^(tool_invocations|plugin_capability_nonces)$/i],
  ["crypto_account", /^crypto_account_/i],
  ["crypto_forecast", /^crypto_forecast_/i],
  [
    "browser_plane",
    /^(browser_profiles|browser_sessions|browser_workspaces|browser_tabs|browser_tasks|browser_artifacts|browser_bookmarks|browser_history)$/i,
  ],
  ["browser_egress", /^browser_egress_/i],
  ["scheduler", /^scheduled_/i],
  [
    "coordination",
    /^(module_instances|module_lifecycle_events|coordination_runs|coordination_steps|optimistic_mutation_receipts)$/i,
  ],
  [
    "sync",
    /^(?:sync_|athena_sync_).+|^(?:athena_ios_push_tokens|athena_mutation_receipts)$/i,
  ],
  ["knowledge_reader", /^reader_/i],
  [
    "knowledge_ingest",
    /^(workspace_documents|document_vectors|embedding_batch_jobs|embedding_batch_job_events|DocumentIndexStatus|KnowledgeNode|KnowledgeEdge|EdgeEvidence|ConceptChunkMap|GraphExtractionJob|GraphLabelTranslationCache|KnowledgeGraphRepair|KnowledgeGraphEvidenceUsage|KnowledgeNodeMetrics)/,
  ],
  ["knowledge_query", /^(GraphRetrievalCache)$/],
  ["model_runtime", /^ai_(price_catalog|budget_|usage_|eval_)/i],
  [
    "responses_runtime",
    /^(responses_conversations|responses|response_items|response_events|response_checkpoints|response_compactions)$/i,
  ],
  [
    "maintenance",
    /^(account_deletion_|system_patrol_|operations_action_|security_audit_)/i,
  ],
]);

const AUTH_OWNERSHIP_RULES = Object.freeze([["identity", /.*/]]);

const MAIN_RUNTIME_SCHEMAS = Object.freeze({
  api: "workspace",
  auth: "identity",
  identity: "identity",
  "key-custody": "key_custody",
  background: "maintenance",
  "background-worker": "maintenance",
  reader: "knowledge_reader",
  "reader-worker": "knowledge_reader",
  gateway: "sync",
  "realtime-gateway": "sync",
  "chat-runtime": "chat",
  "agent-runtime": "agent",
  "model-gateway": "model_runtime",
  "responses-runtime": "responses_runtime",
  "tool-broker": "tools",
  "crypto-market": "crypto_market",
  "crypto-account": "crypto_account",
  "crypto-forecast": "crypto_forecast",
  "browser-plane": "browser_plane",
  "browser-worker": "browser_plane",
  "browser-egress": "browser_egress",
  rag: "knowledge_query",
  "knowledge-ingest": "knowledge_ingest",
  scheduler: "scheduler",
  "coordination-plane": "coordination",
  "operations-plane": "maintenance",
  "operations-shadow-agents": "maintenance",
});

const AUTH_RUNTIME_SCHEMAS = Object.freeze({
  api: "identity",
  auth: "identity",
  identity: "identity",
  "key-custody": "key_custody",
});

function modelTables(schemaFile) {
  const source = fs.readFileSync(schemaFile, "utf8");
  const tables = [];
  const pattern = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let match;
  while ((match = pattern.exec(source))) {
    const mapped = match[2].match(/@@map\("([^"]+)"\)/);
    tables.push(mapped ? mapped[1] : match[1]);
  }
  return tables;
}

function ownerForTable(table, database = "main") {
  const rules =
    database === "auth" ? AUTH_OWNERSHIP_RULES : MAIN_OWNERSHIP_RULES;
  const fallback = database === "auth" ? "identity" : "workspace";
  return rules.find(([, pattern]) => pattern.test(table))?.[0] || fallback;
}

function ownershipRegistry({ database = "main", schemaFile } = {}) {
  if (!["main", "auth"].includes(database))
    throw new Error("module_schema_database_invalid");
  const resolved =
    schemaFile ||
    path.resolve(__dirname, "../../prisma/postgresql/schema.prisma");
  return modelTables(resolved).map((table) => ({
    table,
    schema: ownerForTable(table, database),
  }));
}

function roleRegistry(database = "main") {
  return database === "auth" ? AUTH_SCHEMA_ROLES : MAIN_SCHEMA_ROLES;
}

function runtimeSchemaForRole(role, database = "main") {
  const normalized = String(role || "api")
    .trim()
    .toLowerCase();
  const schemas =
    database === "auth" ? AUTH_RUNTIME_SCHEMAS : MAIN_RUNTIME_SCHEMAS;
  return schemas[normalized] || null;
}

function crossSchemaCapabilities(database = "main") {
  return database === "main" ? MAIN_CROSS_SCHEMA_CAPABILITIES : [];
}

function crossSchemaCapabilityFor({ database = "main", role, table } = {}) {
  const schema = runtimeSchemaForRole(role, database) || String(role || "");
  return (
    crossSchemaCapabilities(database).find(
      (entry) => entry.schema === schema && entry.table === table
    ) || null
  );
}

async function verifyClientOwnership(client, { database = "main", role } = {}) {
  const actual = await client.$queryRawUnsafe(`
    SELECT tablename,
           has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'SELECT') AS can_select,
           has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'INSERT') AS can_insert,
           has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'UPDATE') AS can_update,
           has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'DELETE') AS can_delete
      FROM pg_catalog.pg_tables
     WHERE schemaname = 'public'
       AND tablename <> '_prisma_migrations'
     ORDER BY tablename
  `);
  const registry = new Map(
    ownershipRegistry({ database }).map((entry) => [entry.table, entry.schema])
  );
  const expectedSchema = runtimeSchemaForRole(role, database);
  const violations = [];
  let capabilityWrites = 0;
  for (const row of actual) {
    const owner = registry.get(row.tablename);
    if (!owner) {
      violations.push(`unowned:${row.tablename}`);
      continue;
    }
    const canWrite = Boolean(
      row.can_insert || row.can_update || row.can_delete
    );
    const hasCompleteWrite = Boolean(
      row.can_insert && row.can_update && row.can_delete
    );
    const shouldWrite = owner === expectedSchema;
    const capability = crossSchemaCapabilityFor({
      database,
      role,
      table: row.tablename,
    });
    if (shouldWrite && !row.can_select)
      violations.push(`owner_read_denied:${row.tablename}:${owner}`);
    if (shouldWrite && !hasCompleteWrite)
      violations.push(`owner_write_denied:${row.tablename}:${owner}`);
    if (!shouldWrite && canWrite) {
      const allowed = new Set(capability?.privileges || []);
      const outsideCapability =
        (row.can_insert && !allowed.has("INSERT")) ||
        (row.can_update && !allowed.has("UPDATE")) ||
        (row.can_delete && !allowed.has("DELETE"));
      if (!capability || outsideCapability)
        violations.push(`cross_schema_write:${row.tablename}:${owner}`);
      else capabilityWrites += 1;
    }
    if (
      !shouldWrite &&
      capability?.privileges?.includes("INSERT") &&
      !row.can_insert
    )
      violations.push(
        `cross_schema_capability_denied:${row.tablename}:${capability.capability}`
      );
  }
  if (violations.length) {
    const error = new Error(
      `module_schema_acl_invalid:${violations.join(",")}`
    );
    error.code = "MODULE_SCHEMA_ACL_INVALID";
    error.violations = violations;
    throw error;
  }
  return {
    database,
    role,
    expectedSchema,
    tables: actual.length,
    crossSchemaWriteViolations: 0,
    capabilityWrites,
  };
}

module.exports = {
  AUTH_SCHEMA_ROLES,
  MAIN_CROSS_SCHEMA_CAPABILITIES,
  crossSchemaCapabilities,
  crossSchemaCapabilityFor,
  MAIN_SCHEMA_ROLES,
  modelTables,
  ownerForTable,
  ownershipRegistry,
  roleRegistry,
  runtimeSchemaForRole,
  verifyClientOwnership,
};
