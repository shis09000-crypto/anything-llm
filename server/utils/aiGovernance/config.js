function governanceMode(env = process.env) {
  const mode = String(env.ATHENA_AI_GOVERNANCE || "off").toLowerCase();
  return ["off", "observe", "enforce"].includes(mode) ? mode : "off";
}

module.exports = { governanceMode };
