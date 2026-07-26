const mockPrisma = {
  $transaction: jest.fn(),
  athena_clients: { model: "athena_clients" },
  athena_request_nonces: { model: "athena_request_nonces" },
  vault_device_key_registrations: {
    model: "vault_device_key_registrations",
  },
};

jest.mock("../../utils/prisma", () => mockPrisma);

const {
  RequestSigningRepository,
} = require("../../repositories/requestSigningRepository");

describe("RequestSigningRepository transaction boundary", () => {
  beforeEach(() => jest.clearAllMocks());

  test("exposes every model required by atomic hybrid device-key enrollment", () => {
    expect(RequestSigningRepository.db.athena_clients).toBe(
      mockPrisma.athena_clients
    );
    expect(RequestSigningRepository.db.vault_device_key_registrations).toBe(
      mockPrisma.vault_device_key_registrations
    );
  });

  test("forwards transactions to the owned Prisma client", async () => {
    const callback = jest.fn();
    const options = { timeout: 5_000 };
    mockPrisma.$transaction.mockResolvedValue("committed");

    await expect(
      RequestSigningRepository.db.$transaction(callback, options)
    ).resolves.toBe("committed");
    expect(mockPrisma.$transaction).toHaveBeenCalledWith(callback, options);
  });
});
