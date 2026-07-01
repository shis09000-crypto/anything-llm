import test from "node:test";
import assert from "node:assert/strict";
import {
  clearLocalCacheCryptoKeys,
  createMemoryLocalCacheKeyStore,
  decryptLocalCachePayload,
  encryptLocalCachePayload,
} from "./localCacheCrypto.js";

globalThis.isSecureContext = true;

test("local cache crypto encrypts payloads without plaintext in envelope", async () => {
  const keyStore = createMemoryLocalCacheKeyStore();
  const payload = {
    prompt: "sensitive draft text",
    history: [{ role: "user", content: "private question" }],
  };

  const encryptedPayload = await encryptLocalCachePayload({
    namespace: "thread-history:test",
    payload,
    keyStore,
  });
  const serialized = JSON.stringify(encryptedPayload);

  assert.equal(encryptedPayload.encrypted, true);
  assert.equal(encryptedPayload.cryptoVersion, "athena-local-cache:v1");
  assert.equal(serialized.includes("sensitive draft text"), false);
  assert.deepEqual(
    await decryptLocalCachePayload({
      namespace: "thread-history:test",
      encryptedPayload,
      keyStore,
    }),
    payload
  );
});

test("local cache crypto binds ciphertext to namespace and local key", async () => {
  const firstStore = createMemoryLocalCacheKeyStore();
  const secondStore = createMemoryLocalCacheKeyStore();
  const encryptedPayload = await encryptLocalCachePayload({
    namespace: "chat-draft:one",
    payload: { text: "draft" },
    keyStore: firstStore,
  });

  await assert.rejects(
    decryptLocalCachePayload({
      namespace: "chat-draft:two",
      encryptedPayload,
      keyStore: firstStore,
    }),
    /local_cache_namespace_mismatch/
  );
  await assert.rejects(
    decryptLocalCachePayload({
      namespace: "chat-draft:one",
      encryptedPayload,
      keyStore: secondStore,
    })
  );

  await clearLocalCacheCryptoKeys({ keyStore: firstStore });
  await assert.rejects(
    decryptLocalCachePayload({
      namespace: "chat-draft:one",
      encryptedPayload,
      keyStore: firstStore,
    })
  );
});
