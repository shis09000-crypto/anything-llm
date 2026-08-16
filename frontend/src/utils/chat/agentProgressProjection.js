const PHASE_ORDER = [
  "routing",
  "session_start",
  "tool_selection",
  "tool_execution",
  "retrieval",
  "evidence_ready",
  "synthesis",
  "finalizing",
];

export function formatAgentElapsed(milliseconds = 0) {
  const seconds = Math.max(0, Number(milliseconds) || 0) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function projectAgentProgress(events = [], now = Date.now()) {
  const progress = (Array.isArray(events) ? events : [])
    .filter((event) => event?.type === "agent_progress" && event?.phase)
    .sort((left, right) => {
      const sequenceDiff =
        Number(left.sequence || 0) - Number(right.sequence || 0);
      if (sequenceDiff) return sequenceDiff;
      return Number(left.createdAt || 0) - Number(right.createdAt || 0);
    });
  if (!progress.length) return null;

  const latestByPhase = new Map();
  for (const event of progress) latestByPhase.set(event.phase, event);
  const steps = [...latestByPhase.values()].sort((left, right) => {
    const sequenceDiff =
      Number(left.sequence || 0) - Number(right.sequence || 0);
    if (sequenceDiff) return sequenceDiff;
    return PHASE_ORDER.indexOf(left.phase) - PHASE_ORDER.indexOf(right.phase);
  });
  const completedCount = steps.filter(
    (event) => event.status === "completed"
  ).length;
  const failed =
    [...steps].reverse().find((event) => event.status === "failed") || null;
  const running =
    [...steps].reverse().find((event) => event.status === "running") || null;
  const current = failed || running || steps.at(-1);
  const evidenceCount = Math.max(
    0,
    ...progress.map((event) => Number(event.details?.evidenceCount || 0))
  );
  const startedAt = Math.min(
    ...progress.map((event) => Number(event.createdAt || now))
  );
  const terminal =
    !running &&
    steps.some(
      (event) => event.phase === "finalizing" && event.status === "completed"
    );
  const endedAt = terminal
    ? Math.max(
        ...progress.map((event) =>
          Number(event.updatedAt || event.createdAt || now)
        )
      )
    : now;

  return {
    steps,
    current,
    completedCount,
    evidenceCount,
    failed,
    terminal,
    startedAt,
    elapsedMs: Math.max(0, endedAt - startedAt),
    stagnantMs: current
      ? Math.max(0, now - Number(current.updatedAt || current.createdAt || now))
      : 0,
  };
}

export function agentProgressPhaseLabel(phase, t) {
  return t(`chat_window.toolTimeline.progress.phases.${phase}`, {
    defaultValue: phase,
  });
}
