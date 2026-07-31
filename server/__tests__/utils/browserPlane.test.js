const {
  browserResult,
  compactUrl,
  sha256,
} = require("../../utils/browserPlane/contracts");
const {
  assertBrowserDestination,
  forbiddenAddress,
} = require("../../utils/browserPlane/destinationGuard");
const {
  browserPermissionDecision,
} = require("../../utils/browserPlane/policy");
const {
  BrowserWorkerRuntime,
  memoryAdmission,
} = require("../../utils/browserPlane/workerRuntime");
const {
  profileObjectKey,
  safeId,
} = require("../../utils/browserPlane/profileStore");
const { browserTools } = require("../../utils/agents/aibitat/plugins/browser");

describe("Athena Browser Plane contracts", () => {
  test("result hashes are deterministic and URL query data is redacted", () => {
    const input = {
      runId: "run-1",
      sessionId: "session-1",
      action: "extract",
      observation: { url: "https://example.com/path?secret=value" },
    };
    const first = browserResult(input);
    const second = browserResult(input);
    expect(first.resultSha256).toBe(second.resultSha256);
    expect(compactUrl(input.observation.url)).toBe("https://example.com/path");
    expect(first.schemaVersion).toBe("athena.browser.result.v1");
    expect(sha256({ b: 2, a: 1 })).toBe(sha256({ a: 1, b: 2 }));
  });

  test("permission matrix keeps reads automatic and irreversible work gated", () => {
    expect(
      browserPermissionDecision({ mode: "sandbox", action: "scroll" })
    ).toMatchObject({ allowed: true, approvalRequired: false });
    expect(
      browserPermissionDecision({ mode: "sandbox", action: "input" })
    ).toMatchObject({ allowed: false, approvalRequired: true });
    expect(
      browserPermissionDecision({
        mode: "authorized",
        action: "click",
        url: "https://docs.example.com/page",
        authorizedDomains: ["example.com"],
      })
    ).toMatchObject({ allowed: true, approvalRequired: false });
    expect(
      browserPermissionDecision({
        mode: "open",
        action: "click",
        intent: "payment",
      })
    ).toMatchObject({
      allowed: false,
      approvalRequired: true,
      risk: "critical",
    });
    expect(
      browserPermissionDecision({
        mode: "open",
        action: "navigate",
        url: "https://blocked.example/path",
        administratorDeniedDomains: ["blocked.example"],
      })
    ).toMatchObject({ allowed: false, approvalRequired: false });
  });

  test("cloud destination guard rejects private, metadata, and mixed DNS answers", async () => {
    expect(forbiddenAddress("127.0.0.1")).toBe(true);
    expect(forbiddenAddress("169.254.169.254")).toBe(true);
    expect(forbiddenAddress("8.8.8.8")).toBe(false);
    await expect(
      assertBrowserDestination("http://metadata.google.internal/")
    ).rejects.toMatchObject({ code: "browser_destination_forbidden" });
    await expect(
      assertBrowserDestination("https://example.com", {
        lookup: async () => [
          { address: "203.0.113.10" },
          { address: "10.0.0.5" },
        ],
      })
    ).rejects.toMatchObject({ code: "browser_destination_forbidden" });
    await expect(
      assertBrowserDestination("https://example.com/path", {
        lookup: async () => [{ address: "203.0.113.10" }],
      })
    ).resolves.toMatchObject({
      addresses: ["203.0.113.10"],
    });
  });

  test("stream tickets are scoped, expiring, and one-time", () => {
    const runtime = new BrowserWorkerRuntime({ minAvailableMemoryBytes: 0 });
    const page = { url: () => "https://example.com/" };
    runtime.sessions.set("session-1", {
      sessionId: "session-1",
      userRef: "u-1",
      profileId: "profile-1",
      tabs: new Map([["tab-1", { tabId: "tab-1", page }]]),
      currentTabId: "tab-1",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      closing: null,
    });
    const issued = runtime.issueStreamTicket({
      sessionId: "session-1",
      userRef: "u-1",
      tabId: "tab-1",
    });
    expect(issued.ticket).not.toContain("session-1");
    expect(runtime.consumeStreamTicket(issued.ticket).tab.tabId).toBe("tab-1");
    expect(() => runtime.consumeStreamTicket(issued.ticket)).toThrow(
      "browser_stream_ticket_invalid"
    );
    expect(() =>
      runtime.issueStreamTicket({
        sessionId: "session-1",
        userRef: "u-2",
      })
    ).toThrow("browser_session_scope_denied");
  });

  test("host admission is independent from the smaller worker cgroup limit", () => {
    expect(
      memoryAdmission(
        {
          hostAvailableBytes: 2 * 1024 ** 3,
          cgroupHeadroomBytes: 512 * 1024 ** 2,
        },
        {
          minHostAvailableBytes: 1024 ** 3,
          minCgroupHeadroomBytes: 256 * 1024 ** 2,
        }
      )
    ).toEqual({ allowed: true, hostReady: true, cgroupReady: true });
    expect(
      memoryAdmission(
        {
          hostAvailableBytes: 750 * 1024 ** 2,
          cgroupHeadroomBytes: 512 * 1024 ** 2,
        },
        {
          minHostAvailableBytes: 1024 ** 3,
          minCgroupHeadroomBytes: 256 * 1024 ** 2,
        }
      )
    ).toEqual({ allowed: false, hostReady: false, cgroupReady: true });
    expect(
      memoryAdmission(
        {
          hostAvailableBytes: 2 * 1024 ** 3,
          cgroupHeadroomBytes: 128 * 1024 ** 2,
        },
        {
          minHostAvailableBytes: 1024 ** 3,
          minCgroupHeadroomBytes: 256 * 1024 ** 2,
        }
      )
    ).toEqual({ allowed: false, hostReady: true, cgroupReady: false });
  });

  test("hard-isolated workers use finite cgroup headroom as the authority", () => {
    expect(
      memoryAdmission(
        {
          hostAvailableBytes: 512 * 1024 ** 2,
          cgroupHeadroomBytes: 384 * 1024 ** 2,
        },
        {
          minHostAvailableBytes: 1024 ** 3,
          minCgroupHeadroomBytes: 256 * 1024 ** 2,
          mode: "cgroup-isolated",
        }
      )
    ).toEqual({ allowed: true, hostReady: false, cgroupReady: true });
    expect(
      memoryAdmission(
        {
          hostAvailableBytes: 2 * 1024 ** 3,
          cgroupHeadroomBytes: null,
        },
        {
          minHostAvailableBytes: 1024 ** 3,
          minCgroupHeadroomBytes: 256 * 1024 ** 2,
          mode: "cgroup-isolated",
        }
      )
    ).toEqual({ allowed: false, hostReady: true, cgroupReady: false });
  });

  test("page semantics escalate hidden high-risk writes even in open mode", async () => {
    const runtime = new BrowserWorkerRuntime({ minAvailableMemoryBytes: 0 });
    const page = {
      url: () => "https://example.com/account/security",
      evaluate: jest.fn().mockResolvedValue({
        text: "change password confirm",
        passwordField: true,
      }),
    };
    runtime.sessions.set("session-risk", {
      sessionId: "session-risk",
      userRef: "u-1",
      profileId: "profile-1",
      tabs: new Map([["tab-risk", { tabId: "tab-risk", page }]]),
      currentTabId: "tab-risk",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      closing: null,
    });
    await expect(
      runtime.inspectActionRisk({
        sessionId: "session-risk",
        userRef: "u-1",
        action: "submit",
        args: { selector: "#save" },
      })
    ).resolves.toMatchObject({
      detected: true,
      intent: "password_change",
      source: "page_semantics_v1",
    });
    expect(
      browserPermissionDecision({
        mode: "open",
        action: "submit",
        intent: "password_change",
      })
    ).toMatchObject({
      allowed: false,
      approvalRequired: true,
      risk: "critical",
    });
  });

  test("action arguments and destination sizes are bounded before execution", async () => {
    const runtime = new BrowserWorkerRuntime({ minAvailableMemoryBytes: 0 });
    await expect(
      runtime.action({
        sessionId: "missing",
        action: "input",
        args: { value: "x".repeat(70 * 1024) },
      })
    ).rejects.toMatchObject({ code: "browser_action_arguments_too_large" });
    await expect(
      assertBrowserDestination(`https://example.com/${"x".repeat(5_000)}`)
    ).rejects.toMatchObject({ code: "browser_destination_forbidden" });
  });

  test("profile keys and Agent Browser catalog remain bounded", () => {
    expect(safeId("profile_01")).toBe("profile_01");
    expect(() => safeId("../profile")).toThrow("browser_profile_id_invalid");
    expect(profileObjectKey("profile_01", "abc")).toBe(
      "browser/profiles/v1/profile_01/abc.profile.enc"
    );
    expect(browserTools.map((tool) => tool.name)).toEqual([
      "browser_open",
      "browser_search",
      "browser_read",
      "browser_interact",
      "browser_capture",
      "browser_transfer",
      "browser_workspace",
      "browser_knowledge_save",
      "browser_task",
    ]);
  });
});
