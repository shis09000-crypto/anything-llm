export function resolvePrivateConnectionStatus({
  hasTrustedData,
  requestError,
  upstreamStatus,
}) {
  if (requestError) return hasTrustedData ? "degraded" : "disconnected";
  if (upstreamStatus === "disconnected") return "disconnected";
  if (upstreamStatus === "degraded") return "degraded";
  return hasTrustedData ? "connected" : "degraded";
}
