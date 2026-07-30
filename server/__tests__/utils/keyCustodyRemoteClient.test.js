/* global jest, describe, beforeEach, test, expect */

const mockRequestInternalService = jest.fn();

jest.mock("../../utils/microModules/internalClient", () => ({
  requestInternalService: mockRequestInternalService,
}));

const {
  unwrapMaterial,
  wrapMaterial,
} = require("../../utils/security/keyCustody/remoteClient");

describe("remote Key Custody client", () => {
  const env = {
    NODE_ENV: "test",
    ATHENA_RUNTIME_TOPOLOGY: "local",
    ATHENA_RUNTIME_ROLE: "crypto-account",
    ATHENA_KEY_CUSTODY_CUTOVER: "true",
    ATHENA_KEY_CUSTODY_URL: "http://key-custody.test",
  };
  const context = {
    purpose: "crypto-account-dek",
    domain: "crypto-account",
    resource: "connection-1",
  };

  beforeEach(() => jest.clearAllMocks());

  test("sends plaintext only to the mTLS custody RPC and returns its envelope", async () => {
    mockRequestInternalService.mockResolvedValueOnce({
      success: true,
      wrapped: "enc:v2:key:purpose:iv:tag:ciphertext",
    });
    await expect(
      wrapMaterial("dek-material", context, env)
    ).resolves.toMatch(/^enc:v2:/);
    expect(mockRequestInternalService).toHaveBeenCalledWith(
      expect.objectContaining({
        callerRole: "crypto-account",
        url: "http://key-custody.test/internal/v1/keys/wrap",
        body: {
          plaintext: "dek-material",
          context: expect.objectContaining({
            purpose: "crypto-account-dek",
          }),
        },
        idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
    );
  });

  test("does not accept an unwrap response without plaintext", async () => {
    mockRequestInternalService.mockResolvedValueOnce({ success: true });
    await expect(
      unwrapMaterial(
        "enc:v2:key:purpose:iv:tag:ciphertext",
        context,
        env
      )
    ).rejects.toMatchObject({
      code: "key_custody_unwrap_response_invalid",
    });
  });
});
