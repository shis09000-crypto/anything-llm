function identityMaintenanceOwnedLocally(env = process.env) {
  if (env.ATHENA_IDENTITY_MAINTENANCE_INLINE !== undefined) {
    return (
      String(env.ATHENA_IDENTITY_MAINTENANCE_INLINE).toLowerCase() === "true"
    );
  }

  const role = String(env.ATHENA_RUNTIME_ROLE || "")
    .trim()
    .toLowerCase();
  if (role === "identity") return true;

  const topology = String(env.ATHENA_RUNTIME_TOPOLOGY || "")
    .trim()
    .toLowerCase();
  return !["distributed", "micro-modules"].includes(topology);
}

module.exports = { identityMaintenanceOwnedLocally };
