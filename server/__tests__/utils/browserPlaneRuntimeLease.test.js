const mockBrowserData = {
  ensureProfile: jest.fn(),
  activeSession: jest.fn(),
  getSession: jest.fn(),
  getProfile: jest.fn(),
  claimProfileLease: jest.fn(),
  releaseProfileLease: jest.fn(),
  updateSession: jest.fn(),
  createSession: jest.fn(),
  upsertTabs: jest.fn(),
  updateProfileCheckpoint: jest.fn(),
};

jest.mock("../../utils/dataAccess/lazyFacade", () => ({
  lazyDataAccessFacade: () => mockBrowserData,
}));

const mockWorkerClient = {
  workerSession: jest.fn(),
  workerCloseSession: jest.fn(),
};

jest.mock("../../utils/browserPlane/workerClient", () => ({
  workerAction: jest.fn(),
  workerClearCookieSite: jest.fn(),
  workerCloseSession: (...args) => mockWorkerClient.workerCloseSession(...args),
  workerCloseTab: jest.fn(),
  workerCookieSummary: jest.fn(),
  workerCreateSession: jest.fn(),
  workerDeleteProfile: jest.fn(),
  workerDeleteDownload: jest.fn(),
  workerDownloadToFile: jest.fn(),
  workerInspectActionRisk: jest.fn(),
  workerNewTab: jest.fn(),
  workerSession: (...args) => mockWorkerClient.workerSession(...args),
  workerStreamTicket: jest.fn(),
}));

jest.mock("../../utils/observability/metrics", () => ({
  metrics: {
    browserSessions: { inc: jest.fn() },
    browserActions: { inc: jest.fn() },
    browserApprovals: { inc: jest.fn() },
    browserActionDuration: { observe: jest.fn() },
  },
}));

jest.mock("../../utils/observability/semanticEvents", () => ({
  emitSemanticEvent: jest.fn(),
}));

const { BrowserPlaneRuntime } = require("../../utils/browserPlane/runtime");

describe("Browser Plane profile lease lifecycle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBrowserData.claimProfileLease.mockResolvedValue(true);
    mockBrowserData.updateSession.mockResolvedValue({});
    mockBrowserData.releaseProfileLease.mockResolvedValue(true);
  });

  test("session heartbeat renews the profile lease and database heartbeat", async () => {
    mockBrowserData.getSession.mockResolvedValue({
      id: "plane-session",
      ownerUserId: 9,
      profileId: "profile-9",
      workerSessionId: "worker-session",
      executionLocation: "cloud",
      leaseOwner: "plane-owner",
    });
    mockWorkerClient.workerSession.mockResolvedValue({
      sessionId: "worker-session",
      status: "active",
      tabs: [],
    });

    const result = await new BrowserPlaneRuntime().session({
      userId: 9,
      sessionId: "plane-session",
    });

    expect(result).toMatchObject({ id: "plane-session", status: "active" });
    expect(mockBrowserData.claimProfileLease).toHaveBeenCalledWith({
      userId: 9,
      profileId: "profile-9",
      leaseOwner: "plane-owner",
    });
    expect(mockBrowserData.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 9,
        sessionId: "plane-session",
        patch: expect.objectContaining({ status: "active" }),
      })
    );
  });

  test("lost lease stops a session from being reused", async () => {
    mockBrowserData.getSession.mockResolvedValue({
      id: "plane-session",
      profileId: "profile-9",
      workerSessionId: "worker-session",
      executionLocation: "cloud",
      leaseOwner: "stale-owner",
    });
    mockBrowserData.claimProfileLease.mockResolvedValue(false);

    await expect(
      new BrowserPlaneRuntime().session({
        userId: 9,
        sessionId: "plane-session",
      })
    ).rejects.toMatchObject({ code: "browser_profile_lease_lost" });
    expect(mockWorkerClient.workerSession).not.toHaveBeenCalled();
  });

  test("worker close failure marks the session interrupted without releasing the lease", async () => {
    mockBrowserData.getSession.mockResolvedValue({
      id: "plane-session",
      ownerUserId: 9,
      profileId: "profile-9",
      workerSessionId: "worker-session",
      driver: "playwright-chromium",
      executionLocation: "cloud",
      leaseOwner: "plane-owner",
    });
    mockBrowserData.getProfile.mockResolvedValue({ archiveRef: "old-profile" });
    mockWorkerClient.workerCloseSession.mockRejectedValue(
      Object.assign(new Error("worker_unavailable"), {
        code: "worker_unavailable",
      })
    );

    const result = await new BrowserPlaneRuntime().closeSession({
      userId: 9,
      sessionId: "plane-session",
    });

    expect(result).toMatchObject({
      status: "interrupted",
      reasonCode: "worker_unavailable",
    });
    expect(mockBrowserData.releaseProfileLease).not.toHaveBeenCalled();
    expect(mockBrowserData.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({
          status: "interrupted",
          errorCode: "worker_unavailable",
        }),
      })
    );
  });
});
