/* eslint-env jest */

jest.mock("../../utils/environment", () => ({
  storagePath: (...parts) => `/tmp/athena-test/${parts.join("/")}`,
}));

const {
  assertMCPServerPolicy,
  createPolicyFetch,
  normalizeCapabilityManifest,
  scheduledApprovalDecision,
} = require("../../utils/plugins/securityPolicy");

describe("plugin capability policy", () => {
  const originalMode = process.env.ATHENA_PLUGIN_SECURITY_V2;

  beforeEach(() => {
    process.env.ATHENA_PLUGIN_SECURITY_V2 = "enforce";
  });

  afterAll(() => {
    if (originalMode === undefined)
      delete process.env.ATHENA_PLUGIN_SECURITY_V2;
    else process.env.ATHENA_PLUGIN_SECURITY_V2 = originalMode;
  });

  test("requires hardened isolation for an untrusted local MCP server", () => {
    let error;
    try {
      assertMCPServerPolicy({
        name: "unsafe",
        type: "stdio",
        server: {
          command: "docker",
          args: ["run", "plugin-image"],
          anythingllm: {
            capabilities: { isolation: "container", trustLevel: "untrusted" },
          },
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: "MCP_CAPABILITY_POLICY_DENIED",
      violations: expect.arrayContaining([
        "container_read_only_root_required",
        "container_network_none_required",
      ]),
    });
  });

  test("accepts an untrusted container with no host or network access", () => {
    expect(
      assertMCPServerPolicy({
        name: "isolated",
        type: "stdio",
        server: {
          command: "docker",
          args: [
            "run",
            "--rm",
            "--read-only",
            "--network=none",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--pids-limit=64",
            "--user=65532:65532",
            "plugin-image",
          ],
          anythingllm: {
            capabilities: { isolation: "container", trustLevel: "untrusted" },
          },
        },
      })
    ).toMatchObject({ violations: [] });
  });

  test("revalidates every remote redirect and strips cross-origin credentials", async () => {
    const requests = [];
    const fetchImpl = jest
      .fn()
      .mockImplementationOnce(async (request) => {
        requests.push(request);
        return new Response(null, {
          status: 302,
          headers: { location: "https://backup.example.test/events" },
        });
      })
      .mockImplementationOnce(async (request) => {
        requests.push(request);
        return new Response("ok", { status: 200 });
      });
    const guardedFetch = createPolicyFetch({
      policy: {
        mode: "enforce",
        manifest: normalizeCapabilityManifest({
          networkDomains: ["api.example.test", "backup.example.test"],
        }),
      },
      fetchImpl,
    });

    await expect(
      guardedFetch("https://api.example.test/events", {
        headers: { authorization: "Bearer test-value" },
      })
    ).resolves.toBeInstanceOf(Response);
    expect(requests).toHaveLength(2);
    expect(requests[1].headers.get("authorization")).toBeNull();
  });

  test("denies redirects to undeclared domains", async () => {
    const guardedFetch = createPolicyFetch({
      policy: {
        mode: "enforce",
        manifest: normalizeCapabilityManifest({
          networkDomains: ["api.example.test"],
        }),
      },
      fetchImpl: jest.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://forbidden.example/events" },
          })
      ),
    });

    await expect(
      guardedFetch("https://api.example.test/events")
    ).rejects.toMatchObject({ code: "MCP_REMOTE_DESTINATION_DENIED" });
  });

  test("requires explicit high-risk approval for scheduled tools", () => {
    expect(
      scheduledApprovalDecision({
        job: {
          id: 7,
          capabilityManifest: {
            tools: ["send_email"],
            scheduledAutoApprove: ["send_email"],
            allowHighRisk: false,
          },
        },
        skillName: "send_email",
      })
    ).toMatchObject({ approved: false, highRisk: true });
  });
});
