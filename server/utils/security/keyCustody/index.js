const { createKeyProvider, SERVER_DATA_PURPOSE } = require("./providers");

let provider = null;
let runtimeActiveKey = null;

function keyProvider() {
  if (!provider) provider = createKeyProvider();
  return provider;
}

function resetKeyProviderForTests(next = null) {
  provider = next;
  runtimeActiveKey = null;
}

function resolveActiveKey(purpose = SERVER_DATA_PURPOSE) {
  if (purpose !== SERVER_DATA_PURPOSE) {
    throw new Error(`Unsupported key purpose: ${purpose}`);
  }
  return runtimeActiveKey || keyProvider().resolveActiveKey(purpose);
}

function resolveKey(keyId, purpose = SERVER_DATA_PURPOSE) {
  if (purpose !== SERVER_DATA_PURPOSE) {
    throw new Error(`Unsupported key purpose: ${purpose}`);
  }
  if (runtimeActiveKey?.keyId === keyId) return runtimeActiveKey;
  return keyProvider().resolveKey(keyId, purpose);
}

function setRuntimeActiveKey(descriptor = null) {
  if (
    descriptor &&
    descriptor.purpose &&
    descriptor.purpose !== SERVER_DATA_PURPOSE
  ) {
    throw new Error(`Unsupported key purpose: ${descriptor.purpose}`);
  }
  runtimeActiveKey = descriptor || null;
  return runtimeActiveKey;
}

function clearRuntimeActiveKey() {
  runtimeActiveKey = null;
}

function generatePendingKey(purpose = SERVER_DATA_PURPOSE) {
  const activeProvider = keyProvider();
  if (typeof activeProvider.generatePendingKey !== "function") {
    const error = new Error("key_provider_read_only");
    error.code = "KEY_PROVIDER_READ_ONLY";
    throw error;
  }
  return activeProvider.generatePendingKey(purpose);
}

function activateKey(keyId, purpose = SERVER_DATA_PURPOSE) {
  const activeProvider = keyProvider();
  if (typeof activeProvider.activateKey !== "function") {
    const error = new Error("key_provider_read_only");
    error.code = "KEY_PROVIDER_READ_ONLY";
    throw error;
  }
  const activated = activeProvider.activateKey(keyId, purpose);
  // Rotation changes both the durable provider selection and the runtime write
  // authority. Keeping an older registry-derived override here would make this
  // process continue encrypting new values with the previous key until restart.
  setRuntimeActiveKey(activated);
  return activated;
}

function retireKey(keyId, purpose = SERVER_DATA_PURPOSE) {
  const activeProvider = keyProvider();
  if (typeof activeProvider.retireKey !== "function") {
    const error = new Error("key_provider_read_only");
    error.code = "KEY_PROVIDER_READ_ONLY";
    throw error;
  }
  return activeProvider.retireKey(keyId, purpose);
}

function health() {
  return keyProvider().health();
}

module.exports = {
  activateKey,
  clearRuntimeActiveKey,
  generatePendingKey,
  health,
  keyProvider,
  resetKeyProviderForTests,
  resolveActiveKey,
  resolveKey,
  retireKey,
  setRuntimeActiveKey,
};
