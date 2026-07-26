const {
  AccountCryptoHubRegistry,
} = require("../../utils/cryptoAccount/accountHub");

function binding(authUserId, connectionId, credentialVersion, apiKey) {
  return {
    connection: {
      id: connectionId,
      authUserId,
      credentialVersion,
    },
    credentials: {
      apiKey,
      apiSecret: `${apiKey}-secret`,
      env: "production",
    },
  };
}

describe("account crypto hub isolation", () => {
  test("partitions clients and private caches by auth user and connection", () => {
    const registry = new AccountCryptoHubRegistry();
    const first = registry.get(binding(10, "connection-a", 1, "key-a"));
    const second = registry.get(binding(20, "connection-b", 1, "key-b"));
    first.cache.set("overview", { owner: "a" });
    second.cache.set("overview", { owner: "b" });
    expect(first).not.toBe(second);
    expect(first.credentials.apiKey).toBe("key-a");
    expect(second.credentials.apiKey).toBe("key-b");
    expect(first.cache.get("overview")).toEqual({ owner: "a" });
    expect(second.cache.get("overview")).toEqual({ owner: "b" });
    expect(registry.size()).toBe(2);
  });

  test("credential rotation destroys the old connection instance", () => {
    const registry = new AccountCryptoHubRegistry();
    const first = registry.get(binding(10, "connection-a", 1, "key-a"));
    first.cache.set("private", { value: "old" });
    const rotated = registry.get(
      binding(10, "connection-a", 2, "key-a-rotated")
    );
    expect(rotated).not.toBe(first);
    expect(rotated.credentials.apiKey).toBe("key-a-rotated");
    expect(rotated.cache.get("private")).toBeNull();
    expect(first.credentials.apiKey).toBe("");
  });
});
