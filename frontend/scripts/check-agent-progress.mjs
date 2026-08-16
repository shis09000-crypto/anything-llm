/* global console, process */
import assert from "node:assert/strict";
import {
  formatAgentElapsed,
  projectAgentProgress,
} from "../src/utils/chat/agentProgressProjection.js";

const startedAt = 1_000;
const projection = projectAgentProgress(
  [
    {
      type: "agent_progress",
      phase: "routing",
      status: "completed",
      sequence: 1,
      createdAt: startedAt,
    },
    {
      type: "agent_progress",
      phase: "retrieval",
      status: "running",
      sequence: 2,
      createdAt: startedAt + 100,
    },
    {
      type: "agent_progress",
      phase: "retrieval",
      status: "completed",
      sequence: 3,
      createdAt: startedAt + 500,
      details: { toolName: "rag-memory", evidenceCount: 5 },
    },
    {
      type: "agent_progress",
      phase: "finalizing",
      status: "completed",
      sequence: 4,
      createdAt: startedAt + 800,
    },
  ],
  startedAt + 1_000
);

assert.equal(projection.completedCount, 3);
assert.equal(projection.evidenceCount, 5);
assert.equal(projection.terminal, true);
assert.equal(projection.current.phase, "finalizing");
assert.equal(formatAgentElapsed(8_400), "8.4s");

console.log("agent progress projection checks passed");
process.exit(0);
