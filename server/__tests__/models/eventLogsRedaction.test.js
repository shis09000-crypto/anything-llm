const mockCreate = jest.fn();
const mockFindMany = jest.fn();

jest.mock("../../utils/prisma", () => ({
  event_logs: {
    create: (...args) => mockCreate(...args),
    findMany: (...args) => mockFindMany(...args),
  },
}));

const { EventLogs } = require("../../models/eventLogs");

describe("EventLogs redaction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreate.mockResolvedValue({ id: 1 });
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
});
