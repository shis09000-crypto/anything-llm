export function resolvePrivateConnectionStatus({
  hasTrustedData,
  requestError,
  upstreamStatus,
}) {
  // A failed refresh means the live private-account connection is offline.
  // Previously cached values may remain visible, but they must not turn a
  // transport outage into the weaker "degraded" status.
  if (requestError) return "disconnected";
  if (upstreamStatus === "disconnected") return "disconnected";
  if (upstreamStatus === "degraded") return "degraded";
  return hasTrustedData ? "connected" : "degraded";
}
