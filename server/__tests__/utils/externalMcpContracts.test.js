const {
  DEFINITIONS,
  ExternalMcpToolRegistry,
  MAX_ARGUMENT_BYTES,
  MAX_RESULT_BYTES,
  principalOwnerUserId,
  validArguments,
  sanitizeResult,
} = require("../../utils/externalMcp/registry");
const {
  issueExternalMcpPrincipal,
  verifyExternalMcpPrincipal,
} = require("../../utils/externalMcp/principal");
const JWT = require("jsonwebtoken");
const {
  _internals: { issueAccessToken, verifyAccessToken },
} = require("../../models/mcpOAuth");

describe("External MCP security contracts", () => {
  const grant = {
    id: "grant-test",
    ownerAuthUserId: "auth-user-test",
    ownerUserId: 7,
    subjectType: "service",
    scopes: ["workspace:list", "documents:read"],
    tools: ["athena_list_workspaces", "athena_read_document"],
    workspaces: [{ id: 12, slug: "docs" }],
  };

  beforeEach(() => {
    process.env.JWT_SECRET = "external-mcp-contract-test-secret";
  });

  test("exports only the fixed side-effect-free allowlist", () => {
    expect(DEFINITIONS.map((tool) => tool.name)).toEqual([
      "athena_list_workspaces",
      "athena_workspace_search",
      "athena_list_documents",
      "athena_read_document",
      "athena_list_threads",
      "athena_read_thread",
      "athena_module_describe",
      "athena_module_self_test",
    ]);
    expect(
      DEFINITIONS.some((tool) =>
        /browser|shell|write|trade|credential|secret/i.test(tool.name)
      )
    ).toBe(false);
    expect(MAX_ARGUMENT_BYTES).toBe(128 * 1024);
    expect(MAX_RESULT_BYTES).toBe(1024 * 1024);
  });

  test("filters tools/list by both grant tool and scope", () => {
    expect(
      ExternalMcpToolRegistry.catalog(grant).map((tool) => tool.name)
    ).toEqual(["athena_list_workspaces", "athena_read_document"]);
    expect(ExternalMcpToolRegistry.catalog({ ...grant, scopes: [] })).toEqual(
      []
    );
  });

  test("uses the grant owner for execution-time workspace authorization", () => {
    expect(principalOwnerUserId(grant)).toBe(7);
    expect(principalOwnerUserId({ ...grant, userId: 99 })).toBe(7);
    expect(principalOwnerUserId({ ownerUserId: null, userId: 99 })).toBeNull();
  });

  test("binds the short-lived principal to tool, arguments and workspace", () => {
    const assertion = issueExternalMcpPrincipal({
      grant,
      clientId: "client-test",
      toolName: "athena_read_document",
      args: { workspace: "docs", documentId: "doc-1" },
      workspaceSlug: "docs",
      correlationId: "request-1",
    });
    const verified = verifyExternalMcpPrincipal(assertion, {
      toolName: "athena_read_document",
      args: { workspace: "docs", documentId: "doc-1" },
      workspaceSlug: "docs",
    });
    expect(verified.valid).toBe(true);
    expect(verified.payload).toMatchObject({
      ownerUserId: 7,
      ownerAuthUserId: "auth-user-test",
    });
    expect(
      verifyExternalMcpPrincipal(assertion, {
        toolName: "athena_read_document",
        args: { workspace: "docs", documentId: "doc-2" },
        workspaceSlug: "docs",
      })
    ).toMatchObject({ valid: false });
  });

  test("rejects malformed or undeclared tool arguments", () => {
    expect(
      validArguments("athena_read_document", {
        workspace: "docs",
        documentId: "doc-1",
      })
    ).toBe(true);
    expect(
      validArguments("athena_read_document", {
        workspace: "docs",
        documentId: "doc-1",
        shell: "whoami",
      })
    ).toBe(false);
    expect(
      validArguments("athena_workspace_search", {
        workspace: "docs",
        query: "x".repeat(4001),
      })
    ).toBe(false);
  });

  test("truncates multi-byte tool results below the protocol limit", () => {
    const result = sanitizeResult({ content: "文".repeat(MAX_RESULT_BYTES) });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      MAX_RESULT_BYTES
    );
  });

  test("keeps development MCP tokens isolated from regular session JWTs", async () => {
    const env = {
      NODE_ENV: "test",
      JWT_SECRET: "shared-root-material",
      PUBLIC_APP_URL: "https://athena.example.com",
    };
    const token = await issueAccessToken(
      { clientId: "client-test" },
      {
        id: "grant-test",
        ownerUserId: 7,
        subjectType: "service",
        authorizationVersion: 1,
        scopes: ["workspace:list"],
      },
      env
    );
    await expect(verifyAccessToken(token, env)).resolves.toMatchObject({
      aud: "athena-external-mcp",
      client_id: "client-test",
      grant_id: "grant-test",
    });
    expect(() => JWT.verify(token, env.JWT_SECRET)).toThrow();
  });

  test("fails closed when production MCP token custody is unavailable", async () => {
    await expect(
      issueAccessToken(
        { clientId: "client-test" },
        {
          id: "grant-test",
          ownerUserId: 7,
          subjectType: "service",
          authorizationVersion: 1,
          scopes: ["workspace:list"],
        },
        {
          NODE_ENV: "production",
          PUBLIC_APP_URL: "https://athena.example.com",
        }
      )
    ).rejects.toMatchObject({ code: "temporarily_unavailable", status: 503 });
  });
});
