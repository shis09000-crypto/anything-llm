const DIRECT_NETWORK_ALLOWLIST = [
  /frontend\/src\/lib\/communication\/.*Client\.js$/,
  /frontend\/src\/lib\/communication\/requestSigningClient\.js$/,
  /frontend\/src\/components\/WorkspaceChat\/ChatContainer\/DocumentReader\/EpubReader\.jsx$/,
  /frontend\/src\/components\/WorkspaceChat\/ChatContainer\/DocumentReader\/thumbnails\.js$/,
  /frontend\/src\/pages\/OnboardingFlow\/Steps\/Survey\/index\.jsx$/,
  /frontend\/src\/utils\/tasks\/scheduledFetch\.js$/,
];

const DIRECT_NETWORK_PATTERNS = [
  /\bfetch\s*\(/,
  /\bnew\s+WebSocket\s*\(/,
  /\bnew\s+XMLHttpRequest\s*\(/,
  /\bfetchEventSource\s*\(/,
  /\bnavigator\.sendBeacon\s*\(/,
  /\bEventSource\s*\(/,
];

export function isAllowedDirectNetworkUsage(filePath = "") {
  const normalized = String(filePath).replace(/\\/g, "/");
  return DIRECT_NETWORK_ALLOWLIST.some((pattern) => pattern.test(normalized));
}

export function hasDirectNetworkUsage(sourceLine = "") {
  const line = String(sourceLine || "");
  return DIRECT_NETWORK_PATTERNS.some((pattern) => pattern.test(line));
}

export function auditDirectNetworkUsages(entries = []) {
  return entries.filter(
    (entry) =>
      hasDirectNetworkUsage(entry.line) &&
      !isAllowedDirectNetworkUsage(entry.file)
  );
}

export { DIRECT_NETWORK_ALLOWLIST, DIRECT_NETWORK_PATTERNS };
