function envFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function isProduction(env = process.env) {
  return env.NODE_ENV === "production";
}

function secureCookieOptions(options = {}, env = process.env) {
  const sameSite = options.sameSite || "lax";
  const forceSecure =
    isProduction(env) || String(sameSite).toLowerCase() === "none";

  return {
    httpOnly: true,
    sameSite,
    ...options,
    secure: forceSecure || envFlag(options.secure),
  };
}

module.exports = {
  secureCookieOptions,
};
