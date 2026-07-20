const mockRuntimeSnapshot = jest.fn();
const mockOutboxSnapshot = jest.fn();
const mockReceiptSnapshot = jest.fn();
const mockAuditSnapshot = jest.fn();
const mockAuthSessionSnapshot = jest.fn();
const mockOutboxDispatchEnabled = jest.fn();

jest.mock("../../utils/runtimeCoordinator", () => ({
  runtimeCoordinator: { snapshot: (...args) => mockRuntimeSnapshot(...args) },
}));
jest.mock("../../utils/syncV2/outboxDispatcher", () => ({
  syncV2OutboxSnapshot: (...args) => mockOutboxSnapshot(...args),
}));
jest.mock("../../utils/mutationReceiptSweeper", () => ({
  mutationReceiptSweeperSnapshot: (...args) => mockReceiptSnapshot(...args),
}));
jest.mock("../../utils/security/auditLedgerRuntime", () => ({
  securityAuditMaintenanceSnapshot: (...args) => mockAuditSnapshot(...args),
}));
jest.mock("../../utils/security/authSessionSyncReconciler", () => ({
  authSessionSyncReconcilerSnapshot: (...args) =>
    mockAuthSessionSnapshot(...args),
}));
jest.mock("../../utils/syncV2/config", () => ({
  syncV2OutboxDispatchEnabled: (...args) =>
    mockOutboxDispatchEnabled(...args),
}));

const {
  detailedReadinessSnapshot,
  livenessSnapshot,
  publicReadinessSnapshot,
} = require("../../utils/runtimeReadiness");

describe("runtime readiness disclosure boundaries", () => {
  beforeEach(() => {
    mockRuntimeSnapshot.mockReturnValue({
      status: "running",
      ready: true,
      pid: 1234,
      hostname: "internal-host",
      workerId: "worker-secret",
    });
    mockOutboxSnapshot.mockReturnValue({ running: true, healthy: true });
    mockReceiptSnapshot.mockReturnValue({ running: true, healthy: true });
    mockAuditSnapshot.mockReturnValue({
      running: true,
      healthy: true,
      chainId: "private-chain",
      headHash: "private-head",
    });
    mockAuthSessionSnapshot.mockReturnValue({ running: true, healthy: true });
    mockOutboxDispatchEnabled.mockReturnValue(true);
  });

  it("keeps public liveness and readiness free of internal topology", () => {
    expect(livenessSnapshot()).toEqual({ status: "alive", live: true });
    expect(publicReadinessSnapshot()).toEqual({
      status: "ready",
      ready: true,
      reasonCode: "ready",
    });
  });

  it("retains full control-plane evidence only in detailed diagnostics", () => {
    expect(detailedReadinessSnapshot()).toMatchObject({
      pid: 1234,
      hostname: "internal-host",
      workerId: "worker-secret",
      controlPlane: {
        securityAudit: {
          chainId: "private-chain",
          headHash: "private-head",
        },
      },
    });
  });

  it("fails readiness when the shadow Outbox control plane is not running", () => {
    mockOutboxSnapshot.mockReturnValue({ running: false, healthy: true });
    expect(publicReadinessSnapshot()).toEqual({
      status: "not_ready",
      ready: false,
      reasonCode: "control_plane_unhealthy",
    });
  });
});
