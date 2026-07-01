import test from "node:test";
import assert from "node:assert/strict";
import {
  clearVaultKeyHierarchy,
  createVaultRecoveryKit,
  createMemoryVaultKeyStore,
  decryptVaultItemPayload,
  encryptVaultItemPayload,
  ensureVaultKeyHierarchy,
  expireVaultUnlocks,
  lockVault,
  recoverVaultKeyHierarchy,
  refreshVaultUnlock,
  unlockVault,
  vaultUnlockState,
} from "./vaultCrypto.js";

globalThis.isSecureContext = true;

test("vault crypto encrypts secrets without placing plaintext in payload", async () => {
  const keyStore = createMemoryVaultKeyStore();
  const secretItem = {
    type: "api_key",
    title: "Provider key",
    fields: {
      apiKey: "plain-secret-value",
    },
  };

  const encryptedPayload = await encryptVaultItemPayload({
    userId: 7,
    item: secretItem,
    keyStore,
  });
  const serialized = JSON.stringify(encryptedPayload);

  assert.equal(encryptedPayload.cryptoVersion, "athena-vault-item:v1");
  assert.equal(encryptedPayload.algorithm, "AES-GCM-256+AES-KW");
  assert.equal(serialized.includes("plain-secret-value"), false);
  assert.deepEqual(
    await decryptVaultItemPayload({
      userId: 7,
      encryptedPayload,
      keyStore,
    }),
    secretItem
  );
});

test("vault crypto binds payloads to the local key hierarchy", async () => {
  const firstStore = createMemoryVaultKeyStore();
  const secondStore = createMemoryVaultKeyStore();
  const encryptedPayload = await encryptVaultItemPayload({
    userId: 7,
    item: { password: "local-only" },
    keyStore: firstStore,
  });

  await assert.rejects(
    decryptVaultItemPayload({
      userId: 7,
      encryptedPayload,
      keyStore: secondStore,
    })
  );
});

test("vault key hierarchy stores wrapped UMK and VMK records", async () => {
  const keyStore = createMemoryVaultKeyStore();
  const hierarchy = await ensureVaultKeyHierarchy({ userId: 7, keyStore });
  const snapshot = keyStore.snapshot();

  assert.equal(hierarchy.ready, true);
  assert.equal(hierarchy.deviceWrapKeyId, "device-wrap-key:v1");
  assert.ok(snapshot.keys.includes("device-wrap-key:v1"));
  assert.ok(snapshot.wrappedKeys.some(([id]) => id === "umk:7:v1"));
  assert.ok(snapshot.wrappedKeys.some(([id]) => id === "vmk:7:v1"));

  await clearVaultKeyHierarchy({ userId: 7, keyStore });
  const cleared = keyStore.snapshot();
  assert.equal(cleared.keys.includes("device-wrap-key:v1"), true);
  assert.equal(
    cleared.wrappedKeys.some(([id]) => id === "umk:7:v1"),
    false
  );
  assert.equal(
    cleared.wrappedKeys.some(([id]) => id === "vmk:7:v1"),
    false
  );
});

test("vault lock blocks plaintext recovery until unlocked", async () => {
  const keyStore = createMemoryVaultKeyStore();
  const encryptedPayload = await encryptVaultItemPayload({
    userId: 7,
    item: { password: "locked-secret" },
    keyStore,
  });

  lockVault({ userId: 7 });
  await assert.rejects(
    decryptVaultItemPayload({ userId: 7, encryptedPayload, keyStore }),
    /vault_locked/
  );
  unlockVault({ userId: 7 });
  assert.deepEqual(
    await decryptVaultItemPayload({ userId: 7, encryptedPayload, keyStore }),
    { password: "locked-secret" }
  );
});

test("vault unlock can expire and return to locked state", async () => {
  const keyStore = createMemoryVaultKeyStore();
  const encryptedPayload = await encryptVaultItemPayload({
    userId: 7,
    item: { password: "ttl-secret" },
    keyStore,
  });

  unlockVault({ userId: 7, ttlMs: 25 });
  assert.equal(vaultUnlockState({ userId: 7 }).locked, false);
  assert.deepEqual(
    await decryptVaultItemPayload({ userId: 7, encryptedPayload, keyStore }),
    { password: "ttl-secret" }
  );

  expireVaultUnlocks(Date.now() + 30);
  assert.equal(vaultUnlockState({ userId: 7 }).locked, true);
  await assert.rejects(
    decryptVaultItemPayload({ userId: 7, encryptedPayload, keyStore }),
    /vault_locked/
  );

  refreshVaultUnlock({ userId: 7, ttlMs: 25 });
  assert.equal(vaultUnlockState({ userId: 7 }).locked, true);
});

test("vault recovery kit restores a fresh device key hierarchy", async () => {
  const firstStore = createMemoryVaultKeyStore();
  const secondStore = createMemoryVaultKeyStore();
  const kit = await createVaultRecoveryKit({
    userId: 7,
    recoveryCode: "athena-test-recovery-code-0001",
    keyStore: firstStore,
  });
  const encryptedPayload = await encryptVaultItemPayload({
    userId: 7,
    item: { apiKey: "recoverable-secret" },
    keyStore: firstStore,
  });

  assert.equal(kit.recoveryReady, true);
  assert.equal(
    JSON.stringify(kit.recoveryRecord).includes("recoverable-secret"),
    false
  );
  await assert.rejects(
    decryptVaultItemPayload({
      userId: 7,
      encryptedPayload,
      keyStore: secondStore,
    })
  );

  await recoverVaultKeyHierarchy({
    userId: 7,
    recoveryCode: kit.recoveryCode,
    recoveryRecord: kit.recoveryRecord,
    keyStore: secondStore,
  });
  assert.deepEqual(
    await decryptVaultItemPayload({
      userId: 7,
      encryptedPayload,
      keyStore: secondStore,
    }),
    { apiKey: "recoverable-secret" }
  );
  await assert.rejects(
    recoverVaultKeyHierarchy({
      userId: 7,
      recoveryCode: "athena-test-recovery-code-wrong",
      recoveryRecord: kit.recoveryRecord,
      keyStore: createMemoryVaultKeyStore(),
    })
  );
});

test("vault recovery reports legacy key hierarchies that need rotation", async () => {
  const keyStore = createMemoryVaultKeyStore();
  await ensureVaultKeyHierarchy({ userId: 7, keyStore });
  const kit = await createVaultRecoveryKit({
    userId: 7,
    recoveryCode: "athena-test-recovery-code-0002",
    keyStore,
  });

  assert.equal(kit.recoveryReady, false);
  assert.equal(kit.needsRotation, true);
  assert.equal(kit.reason, "vault_recovery_requires_key_rotation");
});
