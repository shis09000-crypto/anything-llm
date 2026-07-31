const path = require("path");
const {
  ownerForTable,
  ownershipRegistry,
  roleRegistry,
  runtimeSchemaForRole,
} = require("../../utils/database/moduleSchemaOwnership");

const schemaFile = path.resolve(
  __dirname,
  "../../prisma/postgresql/schema.prisma"
);

describe("module schema ownership", () => {
  test.each(["main", "auth"])(
    "%s registry covers every Prisma table exactly once",
    (database) => {
      const registry = ownershipRegistry({ database, schemaFile });
      expect(registry).toHaveLength(167);
      expect(new Set(registry.map(({ table }) => table)).size).toBe(167);
      const roles = roleRegistry(database);
      for (const entry of registry)
        expect(roles[entry.schema]).toBeTruthy();
    }
  );

  test("high-value runtimes own their write tables", () => {
    expect(ownerForTable("chat_stream_runs", "main")).toBe("chat");
    expect(ownerForTable("agent_runs", "main")).toBe("agent");
    expect(ownerForTable("tool_invocations", "main")).toBe("tools");
    expect(ownerForTable("crypto_account_connections", "main")).toBe(
      "crypto_account"
    );
    expect(ownerForTable("browser_sessions", "main")).toBe("browser_plane");
    expect(ownerForTable("scheduled_jobs", "main")).toBe("scheduler");
    expect(ownerForTable("sync_outbox", "main")).toBe("sync");
    expect(ownerForTable("user_root_key_envelopes", "auth")).toBe("identity");
    expect(ownerForTable("auth_sessions", "auth")).toBe("identity");
  });

  test("unextracted main tables remain in the workspace control boundary", () => {
    expect(ownerForTable("workspaces", "main")).toBe("workspace");
    expect(ownerForTable("system_settings", "main")).toBe("workspace");
  });

  test("runtime roles cannot inherit writes in their observer database", () => {
    expect(runtimeSchemaForRole("chat-runtime", "main")).toBe("chat");
    expect(runtimeSchemaForRole("chat-runtime", "auth")).toBeNull();
    expect(runtimeSchemaForRole("identity", "main")).toBe("identity");
    expect(runtimeSchemaForRole("identity", "auth")).toBe("identity");
  });
});
