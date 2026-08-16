const mockCreate = jest.fn();
const mockFindMany = jest.fn();
const mockRemoteIdentityOperationsEnabled = jest.fn(() => false);
const mockAppendIdentityEvent = jest.fn();

jest.mock("../../utils/prisma", () => ({
  event_logs: {
    create: (...args) => mockCreate(...args),
    findMany: (...args) => mockFindMany(...args),
  },
}));

jest.mock("../../utils/authz/identityOperationsClient", () => ({
  appendIdentityEventViaIdentity: (...args) => mockAppendIdentityEvent(...args),
  remoteIdentityOperationsEnabled: (...args) =>
    mockRemoteIdentityOperationsEnabled(...args),
}));

const { EventLogs } = require("../../models/eventLogs");

describe("EventLogs redaction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreate.mockResolvedValue({ id: 1 });
    mockRemoteIdentityOperationsEnabled.mockReturnValue(false);
    mockAppendIdentityEvent.mockResolvedValue({
      eventLog: { id: 2 },
      securityAudit: null,
    });
  });

  it("redacts sensitive metadata before persisting event logs", async () => {
    await EventLogs.logEvent(
      "api_key_created",
      {
        apiKey: "sk-secret",
        filename: "private-plan.pdf",
        localPath: "/Users/alice/private/source.pdf",
        title: "Sensitive title",
        url: "https://example.com/doc?token=secret#frag",
      },
      7
    );

    const data = mockCreate.mock.calls[0][0].data;
    const metadata = JSON.parse(data.metadata);

    expect(metadata.apiKey).toBe("[redacted]");
    expect(metadata.filename).toMatch(/^\[redacted-file:[a-f0-9]{12}:\.pdf\]$/);
    expect(metadata.localPath).toMatch(
      /^\[redacted-path\]\/\[redacted-file:[a-f0-9]{12}:\.pdf\]$/
    );
    expect(metadata.title).toMatch(/^\[redacted-title:[a-f0-9]{12}\]$/);
    expect(metadata.url).toBe("https://example.com/doc?[redacted]#[redacted]");
  });

  it("propagates data-access failures from enriched listings", async () => {
    mockFindMany.mockRejectedValueOnce(new Error("database offline"));

    await expect(EventLogs.whereWithData({})).rejects.toMatchObject({
      code: "database_operation_failed",
      operation: "eventLogs.where",
    });
  });

  it("routes event writes to Identity in distributed runtimes", async () => {
    mockRemoteIdentityOperationsEnabled.mockReturnValue(true);

    await expect(
      EventLogs.logEvent("workspace_updated", { requestId: "req-remote" }, 7)
    ).resolves.toMatchObject({ eventLog: { id: 2 }, message: null });

    expect(mockAppendIdentityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "workspace_updated",
        userId: 7,
        metadata: expect.objectContaining({ requestId: "req-remote" }),
      })
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
