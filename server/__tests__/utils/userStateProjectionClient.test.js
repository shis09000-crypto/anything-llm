/* global jest, describe, beforeEach, test, expect */

const mockRequestInternalService = jest.fn();
const mockDistributedTopology = jest.fn();
const mockParseEndpointMap = jest.fn();
const mockReconcileUserStateProjection = jest.fn();

jest.mock("../../utils/microModules/internalClient", () => ({
  requestInternalService: (...args) => mockRequestInternalService(...args),
}));

jest.mock("../../utils/microModules/serviceHost", () => ({
  distributedTopology: (...args) => mockDistributedTopology(...args),
}));

jest.mock("../../utils/operations/moduleHealthMonitor", () => ({
  parseEndpointMap: (...args) => mockParseEndpointMap(...args),
}));

jest.mock("../../utils/syncV2/userStateProjection", () => ({
  reconcileUserStateProjection: (...args) =>
    mockReconcileUserStateProjection(...args),
}));

const {
  reconcileUserStateProjectionViaCapability,
} = require("../../utils/syncV2/userStateProjectionClient");

describe("user-state projection capability routing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDistributedTopology.mockReturnValue(true);
    mockParseEndpointMap.mockReturnValue({});
    mockReconcileUserStateProjection.mockResolvedValue({
      status: "reconciled",
      states: [],
    });
  });

  test("falls back locally when a distributed deployment has no Sync V2 endpoint", async () => {
    const options = { userId: 4, operation: "upsert", states: [] };

    await expect(
      reconcileUserStateProjectionViaCapability(options, {
        ATHENA_RUNTIME_TOPOLOGY: "micro-modules",
      })
    ).resolves.toEqual({ status: "reconciled", states: [] });

    expect(mockReconcileUserStateProjection).toHaveBeenCalledWith(options);
    expect(mockRequestInternalService).not.toHaveBeenCalled();
  });

  test("keeps using the remote capability when an endpoint is declared", async () => {
    mockParseEndpointMap.mockReturnValue({
      "sync-v2": "https://sync-v2.internal:3443",
    });
    mockRequestInternalService.mockResolvedValue({ status: "reconciled" });

    await reconcileUserStateProjectionViaCapability(
      { userId: 4, operation: "delete", namespace: "chat.draft" },
      { ATHENA_RUNTIME_TOPOLOGY: "micro-modules" }
    );

    expect(mockRequestInternalService).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://sync-v2.internal:3443/internal/v1/sync/user-state/reconcile",
        targetModule: "sync-v2",
        capability: "sync.user-state.reconcile",
      })
    );
    expect(mockReconcileUserStateProjection).not.toHaveBeenCalled();
  });
});
