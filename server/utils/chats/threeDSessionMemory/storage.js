function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function serialize(value) {
  return canonicalJson(value);
}

async function deserialize(storedValue) {
  let payload = null;
  try {
    payload = JSON.parse(String(storedValue ?? ""));
  } catch {
    const error = new Error("athena_3d_memory_json_invalid");
    error.code = "athena_3d_memory_json_invalid";
    throw error;
  }

  if (payload?.format === "athena.3d-session-memory.ciphertext.v1") {
    const error = new Error("athena_3d_memory_legacy_session_unsupported");
    error.code = "athena_3d_memory_legacy_session_unsupported";
    throw error;
  }
  return payload;
}

module.exports = { canonicalJson, serialize, deserialize };
