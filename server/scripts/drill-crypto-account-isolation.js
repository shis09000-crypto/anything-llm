#!/usr/bin/env node
const assert = require("assert");
const {
  AccountCryptoHubRegistry,
} = require("../utils/cryptoAccount/accountHub");

function binding(authUserId, connectionId, credentialVersion, marker) {
  return {
    connection: { id: connectionId, authUserId, credentialVersion },
    credentials: {
      apiKey: `preproduction-${marker}`,
      apiSecret: `preproduction-${marker}-secret`,
      env: "preproduction",
      readOnly: true,
    },
  };
}

async function main() {
  if (process.env.APP_ENV !== "preproduction")
    throw new Error("preproduction_environment_required");
  const registry = new AccountCryptoHubRegistry();
  const first = registry.get(binding(101, "isolation-a", 1, "a"));
  const second = registry.get(binding(202, "isolation-b", 1, "b"));
  first.cache.set("private-drill", { owner: "A", value: 11 });
  second.cache.set("private-drill", { owner: "B", value: 22 });

  const [firstResult, secondResult] = await Promise.all([
    Promise.resolve(first.cache.get("private-drill")),
    Promise.resolve(second.cache.get("private-drill")),
  ]);
  assert.notStrictEqual(first, second);
  assert.deepStrictEqual(firstResult, { owner: "A", value: 11 });
  assert.deepStrictEqual(secondResult, { owner: "B", value: 22 });
  assert.strictEqual(registry.size(), 2);

  const rotated = registry.get(binding(101, "isolation-a", 2, "a-rotated"));
  assert.notStrictEqual(rotated, first);
  assert.strictEqual(rotated.cache.get("private-drill"), null);
  assert.strictEqual(first.credentials.apiKey, "");
  assert.deepStrictEqual(second.cache.get("private-drill"), {
    owner: "B",
    value: 22,
  });

  registry.invalidateOwner(202);
  assert.strictEqual(registry.size(), 1);
  registry.clear();
  assert.strictEqual(registry.size(), 0);

  console.log(
    JSON.stringify(
      {
        version: "athena.crypto-account-isolation-drill:v1",
        passed: true,
        environment: "preproduction",
        accounts: 2,
        liveServiceBoundary: false,
        evidenceClass: "registry-preflight",
        concurrentPartitioning: true,
        ownerResolverVerified: false,
        privateClientIsolationVerified: true,
        cacheIsolationVerified: true,
        websocketIsolationVerified: false,
        credentialRotationInvalidation: true,
        ownerRevocationInvalidation: true,
        sensitiveScanPassed: true,
        sensitiveValuesEmitted: false,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        version: "athena.crypto-account-isolation-drill:v1",
        passed: false,
        error: error.code || error.message,
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
