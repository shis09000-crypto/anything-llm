const AGENT_PROGRESS_PHASES = Object.freeze([
  "routing",
  "session_start",
  "tool_selection",
  "tool_execution",
  "retrieval",
  "evidence_ready",
  "synthesis",
  "finalizing",
]);

const AGENT_PROGRESS_STATUSES = Object.freeze([
  "running",
  "completed",
  "failed",
]);

const SAFE_DETAIL_KEYS = Object.freeze([
  "toolCategory",
  "toolName",
  "evidenceCount",
  "selectedToolCount",
  "approvalRequired",
  "reconnectAttempt",
  "errorCode",
  "routeKind",
]);

function safeAgentProgressDetails(details = {}) {
  if (!details || typeof details !== "object") return {};
  return SAFE_DETAIL_KEYS.reduce((safe, key) => {
    const value = details[key];
    if (value === undefined || value === null) return safe;
    if (
      ["evidenceCount", "selectedToolCount", "reconnectAttempt"].includes(key)
    ) {
      const count = Number(value);
      if (Number.isFinite(count)) safe[key] = Math.max(0, Math.floor(count));
      return safe;
    }
    safe[key] = String(value)
      .replace(/[^a-zA-Z0-9_.:@/-]/g, "_")
      .slice(0, 96);
    return safe;
  }, {});
}

function sanitizeAgentProgress(progress = {}) {
  const phase = AGENT_PROGRESS_PHASES.includes(progress.phase)
    ? progress.phase
    : null;
  const status = AGENT_PROGRESS_STATUSES.includes(progress.status)
    ? progress.status
    : null;
  if (!phase || !status) return null;
  const sequence = Math.max(1, Math.floor(Number(progress.sequence) || 1));
  return {
    type: "agentProgress",
    uuid: progress.uuid || `agent_progress:${phase}:${sequence}`,
    phase,
    status,
    sequence,
    details: safeAgentProgressDetails(progress.details),
  };
}

module.exports = {
  AGENT_PROGRESS_PHASES,
  AGENT_PROGRESS_STATUSES,
  safeAgentProgressDetails,
  sanitizeAgentProgress,
};
