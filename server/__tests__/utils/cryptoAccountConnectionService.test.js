describe("crypto account credential envelope", () => {
  const {
    credentialFingerprint,
    openCredentials,
    sealCredentials,
  } = require("../../utils/cryptoAccount/connectionService");

  const metadata = {
    userId: 12,
    authUserId: 34,
    connectionId: "crypto_conn_test",
    provider: "gate",
    environment: "production",
    credentialVersion: 2,
  };

  test("changes the fingerprint when only the secret rotates", () => {
    expect(credentialFingerprint("same-key", "secret-v1")).not.toBe(
      credentialFingerprint("same-key", "secret-v2")
    );
  });

  test("round-trips credentials with owner and version bound AAD", () => {
    const dek = Buffer.alloc(32, 7);
    const encryptedCredentials = sealCredentials({
      credentials: { apiKey: "gate-key", apiSecret: "gate-secret" },
      dek,
      ...metadata,
    });
    const result = openCredentials(
      {
        id: metadata.connectionId,
        userId: metadata.userId,
        authUserId: metadata.authUserId,
        provider: metadata.provider,
        environment: metadata.environment,
        credentialVersion: metadata.credentialVersion,
        encryptedCredentials,
      },
      dek
    );
    expect(result).toEqual({
      apiKey: "gate-key",
      apiSecret: "gate-secret",
      environment: "production",
      readOnly: true,
    });
  });

  test("rejects a credential envelope replayed to another owner", () => {
    const dek = Buffer.alloc(32, 8);
    const encryptedCredentials = sealCredentials({
      credentials: { apiKey: "gate-key", apiSecret: "gate-secret" },
      dek,
      ...metadata,
    });
    expect(() =>
      openCredentials(
        {
          id: metadata.connectionId,
          userId: 99,
          authUserId: metadata.authUserId,
          provider: metadata.provider,
          environment: metadata.environment,
          credentialVersion: metadata.credentialVersion,
          encryptedCredentials,
        },
        dek
      )
    ).toThrow("crypto_account_credentials_invalid");
  });
});
