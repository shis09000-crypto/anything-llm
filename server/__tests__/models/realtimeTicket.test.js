const mockCreate = jest.fn();
const mockFindUnique = jest.fn();
const mockUpdateMany = jest.fn();
const mockDeleteMany = jest.fn();

jest.mock("../../utils/authPrisma", () => ({
  auth_realtime_tickets: {
    create: (...args) => mockCreate(...args),
    findUnique: (...args) => mockFindUnique(...args),
    updateMany: (...args) => mockUpdateMany(...args),
    deleteMany: (...args) => mockDeleteMany(...args),
  },
}));

const { RealtimeTicket } = require("../../models/realtimeTicket");

describe("RealtimeTicket", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    RealtimeTicket._internals.memoryTickets.clear();
    mockDeleteMany.mockResolvedValue({ count: 0 });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("hashes in-memory ticket handles and consumes them once", async () => {
    process.env.NODE_ENV = "development";
    process.env.ATHENA_REALTIME_TICKET_STORE = "memory";
    const entry = {
      purpose: "broadcast",
      appEnv: "development",
      claims: { sid: "sess-1" },
      multiUser: true,
      expiresAt: Date.now() + 60_000,
    };
    await RealtimeTicket.issue({ ticket: "rt-secret", entry });

    expect(RealtimeTicket._internals.memoryTickets.has("rt-secret")).toBe(
      false
    );
    expect(RealtimeTicket._internals.memoryTickets.size).toBe(1);
    await expect(RealtimeTicket.consume("rt-secret")).resolves.toMatchObject({
      purpose: "broadcast",
    });
    await expect(RealtimeTicket.consume("rt-secret")).resolves.toBeNull();
  });

  it("uses an atomic consumedAt claim for the shared database store", async () => {
    process.env.NODE_ENV = "production";
    process.env.ATHENA_REALTIME_TICKET_STORE = "database";
    const row = {
      ticketHash: RealtimeTicket._internals.ticketHash("rt-shared"),
      purpose: "agent",
      appEnv: "production",
      resourceId: "invocation-1",
      claimsJson: JSON.stringify({ sid: "sess-1", authUserId: 70 }),
      multiUser: true,
      clientId: "client-1",
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    };
    mockFindUnique.mockResolvedValue(row);
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await expect(RealtimeTicket.consume("rt-shared")).resolves.toMatchObject({
      purpose: "agent",
      appEnv: "production",
      claims: { sid: "sess-1", authUserId: 70 },
    });
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ticketHash: row.ticketHash,
          consumedAt: null,
        }),
        data: { consumedAt: expect.any(Date) },
      })
    );
  });

  it("reports a process-local store as unsafe for an independent gateway", () => {
    expect(
      RealtimeTicket.storeSummary({
        NODE_ENV: "production",
        ATHENA_REALTIME_TICKET_STORE: "memory",
      })
    ).toMatchObject({ shared: false, gatewaySafe: false });
    expect(
      RealtimeTicket.storeSummary({ NODE_ENV: "production" })
    ).toMatchObject({ selected: "database", gatewaySafe: true });
  });
});
