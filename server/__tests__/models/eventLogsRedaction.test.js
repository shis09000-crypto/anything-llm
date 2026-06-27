const mockCreate = jest.fn();

jest.mock("../../utils/prisma", () => ({
  event_logs: {
    create: (...args) => mockCreate(...args),
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
});
