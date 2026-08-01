/* global jest, describe, beforeEach, test, expect */

const mockConsumeRemote = jest.fn();
const mockFindUnique = jest.fn();
const mockUpdateMany = jest.fn();

jest.mock("../../utils/authz/identityOperationsClient", () => ({
  remoteIdentityOperationsEnabled: () => true,
  consumeRealtimeTicketViaIdentity: mockConsumeRemote,
}));
jest.mock("../../utils/authPrisma", () => ({
  auth_realtime_tickets: {
    create: jest.fn(),
    findUnique: mockFindUnique,
    updateMany: mockUpdateMany,
    deleteMany: jest.fn(),
  },
}));

const { RealtimeTicket } = require("../../models/realtimeTicket");

describe("RealtimeTicket distributed owner routing", () => {
  beforeEach(() => jest.clearAllMocks());

  test("does not mutate the auth database from Realtime Gateway", async () => {
    mockConsumeRemote.mockResolvedValueOnce({ purpose: "broadcast" });
    await expect(RealtimeTicket.consume("rt-secret")).resolves.toMatchObject({
      purpose: "broadcast",
    });
    expect(mockConsumeRemote).toHaveBeenCalledWith("rt-secret");
    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});
