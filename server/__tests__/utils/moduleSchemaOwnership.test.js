const path = require("path");
const {
  ownerForTable,
  ownershipRegistry,
  modelTables,
  roleRegistry,
  runtimeSchemaForRole,
  crossSchemaCapabilityFor,
  verifyClientOwnership,
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
      const tableCount = modelTables(schemaFile).length;
      expect(registry).toHaveLength(tableCount);
      expect(new Set(registry.map(({ table }) => table)).size).toBe(tableCount);
      const roles = roleRegistry(database);
      for (const entry of registry) expect(roles[entry.schema]).toBeTruthy();
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
    expect(ownerForTable("security_key_registry", "main")).toBe("key_custody");
    expect(ownerForTable("auth_device_recovery_challenges", "main")).toBe(
      "identity"
    );
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
    expect(runtimeSchemaForRole("key-custody", "main")).toBe("key_custody");
    expect(runtimeSchemaForRole("key-custody", "auth")).toBe("key_custody");
  });

  test("Identity receives only the declared append-only audit capability", () => {
    expect(
      crossSchemaCapabilityFor({
        database: "main",
        role: "identity",
        table: "security_audit_ledger",
      })
    ).toMatchObject({
      capability: "security-audit-append",
      privileges: ["SELECT", "INSERT"],
    });
    expect(
      crossSchemaCapabilityFor({
        database: "main",
        role: "identity",
        table: "workspaces",
      })
    ).toBeNull();
  });

  test("accepts the exact Identity audit append capability", async () => {
    const client = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        {
          tablename: "security_audit_ledger",
          can_select: true,
          can_insert: true,
          can_update: false,
          can_delete: false,
        },
      ]),
    };
    await expect(
      verifyClientOwnership(client, {
        database: "main",
        role: "identity",
      })
    ).resolves.toMatchObject({
      crossSchemaWriteViolations: 0,
      capabilityWrites: 1,
    });
  });

  test("requires complete owner access without requiring cross-domain reads", async () => {
    const client = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        {
          tablename: "security_key_registry",
          can_select: true,
          can_insert: true,
          can_update: true,
          can_delete: true,
        },
        {
          tablename: "workspaces",
          can_select: false,
          can_insert: false,
          can_update: false,
          can_delete: false,
        },
      ]),
    };
    await expect(
      verifyClientOwnership(client, {
        database: "main",
        role: "key-custody",
      })
    ).resolves.toMatchObject({
      expectedSchema: "key_custody",
      crossSchemaWriteViolations: 0,
    });
  });

  test("rejects partial owner ACLs and every cross-domain write", async () => {
    const client = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        {
          tablename: "security_key_registry",
          can_select: true,
          can_insert: true,
          can_update: false,
          can_delete: false,
        },
        {
          tablename: "workspaces",
          can_select: true,
          can_insert: false,
          can_update: true,
          can_delete: false,
        },
      ]),
    };
    await expect(
      verifyClientOwnership(client, {
        database: "main",
        role: "key-custody",
      })
    ).rejects.toThrow(
      /owner_write_denied:security_key_registry:key_custody.*cross_schema_write:workspaces:workspace/
    );
  });
});
