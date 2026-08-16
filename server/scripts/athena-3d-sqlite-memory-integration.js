#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  writeReport,
} = require("../../scripts/athena-3d-test-lib.cjs");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "athena-3d-memory-int-"));
const databasePath = path.join(temporary, "development", "anythingllm.db");
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
fs.writeFileSync(databasePath, "");
process.env.NODE_ENV = "test";
process.env.APP_ENV = "development";
process.env.ANYTHINGLLM_STORAGE_BASE_DIR = temporary;
process.env.DATABASE_URL = `file:${databasePath}`;
process.env.ATHENA_3D_MEMORY_ENABLED = "true";

function setup() {
  const result = spawnSync(
    "npx",
    ["prisma", "db", "push", "--schema=./prisma/schema.prisma", "--skip-generate"],
    {
      cwd: path.resolve(__dirname, ".."),
      env: process.env,
      encoding: "utf8",
    }
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function nextWindow(previous, revision, turn) {
  const {
    materializePersistentStateWindow,
  } = require("../utils/responsesRuntime/character/conversation/persistentState");
  const next = structuredClone(previous);
  next.revision = revision;
  next.performance_intent.affect = {
    ...next.performance_intent.affect,
    intensity: Number((0.2 + revision * 0.05).toFixed(2)),
  };
  next.face = next.face.map((entry) =>
    entry.region === "lip"
      ? { ...entry, state: "athena.core:face_lip/press", intensity: 0.25 + revision * 0.02 }
      : entry
  );
  return materializePersistentStateWindow({
    previousState: previous,
    transition: {
      from_revision: previous.revision,
      style: "blend",
      duration_ms: 400,
      next_state: next,
    },
    turnId: `turn_${turn}`,
    responseId: `chr_resp_${turn}`,
    sequenceId: `sequence_${turn}`,
    now: 1_786_500_000_000 + turn,
  });
}

async function main() {
  setup();
  const { applyEnvironmentStorage } = require("../utils/environment");
  applyEnvironmentStorage();
  const prisma = require("../utils/prisma");
  const {
    ThreeDSessionMemoryRepository,
  } = require("../utils/chats/threeDSessionMemory/repository");
  const {
    initialPersistentState,
  } = require("../utils/responsesRuntime/character/conversation/persistentState");
  const repository = new ThreeDSessionMemoryRepository({
    client: prisma,
    env: process.env,
  });
  const scope = {
    conversationId: "athena_3d_memory_integration",
    workspaceId: 8001,
    threadId: 8002,
    ownerUserId: 8003,
    agentRunId: null,
  };
  const initial = initialPersistentState({ revision: 0, updated_at: 1_786_500_000_000 });
  const initialWindow = {
    previous_state: initial,
    transition: null,
    current_state: initial,
  };
  try {
    const created = await repository.createSession({
      ...scope,
      characterId: "athena.test.cold_tsundere",
      characterInstanceId: "athena.integration.sister",
      memory: { mode: "persistent" },
      stateWindow: initialWindow,
    });
    const firstRef = repository.contextRef(created);
    const firstWindow = nextWindow(initial, 1, 1);
    const first = await repository.commitTurn({
      ...scope,
      turnId: "turn_1",
      ordinal: 1,
      responseId: "chr_resp_1",
      user: "成绩出来了吗？",
      assistant: "年级第十二。",
      expectedMemoryRevision: 0,
      expectedStateRevision: 0,
      previousContextRef: firstRef,
      stateWindow: firstWindow,
    });
    const replay = await repository.commitTurn({
      ...scope,
      turnId: "turn_1",
      ordinal: 1,
      responseId: "chr_resp_1",
      user: "成绩出来了吗？",
      assistant: "年级第十二。",
      expectedMemoryRevision: 0,
      expectedStateRevision: 0,
      previousContextRef: firstRef,
      stateWindow: firstWindow,
    });
    const stale = await repository.contextPrepare({
      ...scope,
      contextRef: firstRef,
    });
    let revisionConflict = false;
    try {
      await repository.commitTurn({
        ...scope,
        turnId: "turn_conflict",
        ordinal: 2,
        responseId: "chr_resp_conflict",
        user: "冲突",
        assistant: "冲突",
        expectedMemoryRevision: 0,
        expectedStateRevision: 0,
        previousContextRef: firstRef,
        stateWindow: nextWindow(firstWindow.current_state, 2, 2),
      });
    } catch (error) {
      revisionConflict = error.code === "athena_3d_memory_revision_conflict";
    }
    const resolved = await repository.contextResolve(scope);
    const archived = await repository.archiveLongTerm(scope);
    const memorySession = await prisma.athena_3d_character_memory_sessions.findUnique({
      where: { conversationId: scope.conversationId },
    });
    const archivedTurns = await prisma.athena_3d_character_memory_turns.findMany({
      where: { memorySessionId: memorySession.id },
      orderBy: { ordinal: "asc" },
    });
    const checks = {
      persistent_profile_created: created.memoryMode === "persistent" && Boolean(created.longTermProfileId),
      first_commit_advanced: first.memory_revision === 1 && first.state_revision === 1,
      idempotent_replay: replay.replay === true && replay.memory_revision === 1,
      stale_cursor_resyncs: stale.mode === "resynced" && stale.rebuild_reason === "cursor_stale",
      revision_conflict_rejected: revisionConflict,
      dialogue_then_state_layout:
        resolved.memory_point.layout === "dialogue_then_performance_state" &&
        resolved.memory_point.dialogue.turns[0].user === "成绩出来了吗？" &&
        resolved.memory_point.performance_state.state_window.current_state.revision === 1,
      complete_state_preserved:
        resolved.memory_point.performance_state.state_window.current_state.face.length === 8 &&
        resolved.memory_point.performance_state.state_window.transition.changes.left_hand.changed === false,
      raw_archive_exact:
        archived.archived === true &&
        JSON.parse(archivedTurns[0].userJson) === "成绩出来了吗？" &&
        JSON.parse(archivedTurns[0].assistantJson) === "年级第十二。",
      final_state_authoritative:
        memorySession.finalStateHash.length === 64 && memorySession.sourceStateRevision === 1,
      plaintext_json_columns:
        typeof archivedTurns[0].userJson === "string" && !Object.hasOwn(archivedTurns[0], "userCiphertext"),
    };
    const status = Object.values(checks).every(Boolean) ? "passed" : "failed";
    const { destination, report } = writeReport("sqlite-memory-integration", {
      suite: "sqlite_memory_integration",
      status,
      checks,
      cursor: first.context_ref,
      archive: archived,
    });
    console.log(JSON.stringify({ report: destination, ...report }, null, 2));
    if (status !== "passed") process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const { destination } = writeReport("sqlite-memory-integration", {
    suite: "sqlite_memory_integration",
    status: "failed",
    error: { code: error.code || "ATHENA_3D_MEMORY_INTEGRATION_FAILED", message: error.message },
  });
  console.error(`${error.stack || error.message}\nReport: ${destination}`);
  fs.rmSync(temporary, { recursive: true, force: true });
  process.exitCode = 1;
});
