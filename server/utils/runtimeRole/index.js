function envFlag(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "")
    return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function runtimeRole() {
  return String(process.env.ATHENA_RUNTIME_ROLE || "monolith").toLowerCase();
}

function apiOnlyMode() {
  return runtimeRole() === "api" || envFlag("ATHENA_API_ONLY", false);
}

function backgroundInlineEnabled() {
  if (process.env.ATHENA_BACKGROUND_INLINE !== undefined) {
    return envFlag("ATHENA_BACKGROUND_INLINE", true);
  }
  return runtimeRole() === "monolith";
}

module.exports = {
  apiOnlyMode,
  backgroundInlineEnabled,
  envFlag,
  runtimeRole,
};
