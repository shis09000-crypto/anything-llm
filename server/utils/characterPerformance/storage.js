const { canonicalize, digest } = require("./contract");

function serialize(value) {
  return JSON.stringify(canonicalize(value));
}

async function deserialize(storedValue) {
  let payload = null;
  try {
    payload = JSON.parse(String(storedValue ?? ""));
  } catch {
    const error = new Error("performance_state_json_invalid");
    error.code = "performance_state_json_invalid";
    throw error;
  }
  if (payload?.format === "athena.character-performance.ciphertext.v1") {
    const error = new Error("performance_legacy_session_unsupported");
    error.code = "performance_legacy_session_unsupported";
    throw error;
  }
  return payload;
}

module.exports = { deserialize, payloadHash: digest, serialize };
