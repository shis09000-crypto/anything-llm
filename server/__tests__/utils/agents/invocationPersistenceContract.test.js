const {
  generatedModelFields,
  inspectAgentPersistenceContract,
} = require("../../../utils/agents/invocationPersistenceContract");

function prismaFixture({ clientFields, databaseFields, provider = "postgresql" }) {
  return {
    $databaseProvider: provider,
    $prismaReady: Promise.resolve(true),
    _runtimeDataModel: {
      models: {
        workspace_agent_invocations: {
          fields: clientFields.map((name) => ({ name })),
        },
      },
    },
    $queryRawUnsafe: jest.fn(async () =>
      provider === "postgresql"
        ? databaseFields.map((column_name) => ({ column_name }))
        : databaseFields.map((name) => ({ name }))
    ),
  };
}

const registry = {
  negotiate: jest.fn(({ capability, targetModule }) => ({
    version: "1.0",
    contractFingerprint: `${targetModule}:${capability}:fingerprint`,
  })),
};

describe("Agent invocation persistence contract", () => {
  beforeEach(() => registry.negotiate.mockClear());

  test("reports generated Prisma fields", () => {
    const prismaClient = prismaFixture({
      clientFields: ["id", "requestedProvider", "requestedModel"],
      databaseFields: [],
    });
    expect(generatedModelFields(prismaClient)).toEqual([
      "id",
      "requestedProvider",
      "requestedModel",
    ]);
  });

  test("fails closed when the generated client is stale", async () => {
    const prismaClient = prismaFixture({
      clientFields: ["id", "prompt"],
      databaseFields: ["requestedProvider", "requestedModel"],
    });
    const result = await inspectAgentPersistenceContract({
      prismaClient,
      registry,
    });
    expect(result.ready).toBe(false);
    expect(result.reasonCode).toBe(
      "agent_persistence_contract_incompatible"
    );
    expect(result.missingFields).toEqual([
      "requestedProvider",
      "requestedModel",
    ]);
    expect(prismaClient.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test("fails closed when PostgreSQL is missing a required field", async () => {
    const prismaClient = prismaFixture({
      clientFields: ["requestedProvider", "requestedModel"],
      databaseFields: ["requestedProvider"],
    });
    const result = await inspectAgentPersistenceContract({
      prismaClient,
      registry,
    });
    expect(result.ready).toBe(false);
    expect(result.missingFields).toEqual(["requestedModel"]);
  });

  test("requires compatible Agent, RAG and Tool AICP links", async () => {
    const prismaClient = prismaFixture({
      clientFields: ["requestedProvider", "requestedModel"],
      databaseFields: ["requestedProvider", "requestedModel"],
    });
    const result = await inspectAgentPersistenceContract({
      prismaClient,
      registry,
    });
    expect(result.ready).toBe(true);
    expect(result.aicpLinks.map((link) => link.capability)).toEqual([
      "agent.submit",
      "rag.retrieve",
      "tool.invoke",
    ]);
  });
});
