#!/usr/bin/env node

const crypto = require("crypto");
const {
  exactWarnings,
  requiredEnvironment,
  writeReport,
} = require("../../scripts/athena-3d-test-lib.cjs");

const ALLOWED_WARNING_CODES = [
  "resynced",
  "soft_close_wait_defaulted",
  "performance_optional_binding_missing",
  "performance_binding_fallback",
  "cue_conflict_suppressed",
  "cue_duration_resolved",
];
const TRACKS = [
  "face",
  "gaze",
  "head_neck",
  "shoulders",
  "torso",
  "left_arm",
  "right_arm",
  "left_hand",
  "right_hand",
  "left_leg",
  "right_leg",
  "action",
  "speech",
];

function baseUrl() {
  return String(process.env.ATHENA_3D_TEST_BASE_URL).replace(/\/+$/, "");
}

function headers() {
  const values = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (process.env.ATHENA_3D_TEST_AUTH_TOKEN)
    values.authorization = `Bearer ${process.env.ATHENA_3D_TEST_AUTH_TOKEN}`;
  if (process.env.ATHENA_3D_TEST_BYPASS_KEY)
    values["x-codex-dev-auth-bypass"] =
      process.env.ATHENA_3D_TEST_BYPASS_KEY;
  return values;
}

async function request(method, pathname, body = null, expected = 200) {
  const response = await fetch(`${baseUrl()}${pathname}`, {
    method,
    headers: headers(),
    ...(body == null ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(300_000),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = { error: "response_not_json" };
  }
  if (response.status !== expected || payload?.success === false) {
    const error = new Error(
      `${method} ${pathname} failed (${response.status}): ${JSON.stringify(payload)}`
    );
    error.code = "ATHENA_3D_LIVE_REQUEST_FAILED";
    throw error;
  }
  return payload;
}

function speech(frame) {
  return (frame?.timeline?.time_blocks || [])
    .flatMap((block) => block.modules?.speech || [])
    .map((command) => command.binding?.parameters?.text || "")
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index)
    .join("\n");
}

function frameChecks(frame) {
  const plan = frame?.performance_plan;
  const tracks = [
    ...new Set((plan?.commands || []).map((command) => command.track)),
  ];
  const responseTracks =
    frame?.character?.persistent_state_window?.current_state?.face || [];
  return {
    object: frame?.object === "athena.3d_center.frame",
    blocks: (frame?.timeline?.time_blocks || []).length > 0,
    command_tracks_known: tracks.every((track) => TRACKS.includes(track)),
    face_state_complete:
      new Set(responseTracks.map((entry) => entry.region)).size === 8,
    planned_resolved_actual_separate: (plan?.commands || []).every(
      (command) =>
        Number.isInteger(command.timing?.planned_start_ms) &&
        Number.isInteger(command.timing?.resolved_start_ms) &&
        command.timing?.actual_start_ms == null
    ),
  };
}

function intent(frame) {
  return frame?.character?.performance_intent || {};
}

function horizon(frame) {
  return frame?.character?.conversation_horizon || {};
}

function handoff(frame) {
  return frame?.character?.effective_handoff || {};
}

function trackCommands(frame, track) {
  return (frame?.performance_plan?.commands || []).filter(
    (command) => command.track === track
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createSession(instanceId) {
  return request(
    "POST",
    "/api/3d-center/sessions",
    {
      workspace_id: Number(process.env.ATHENA_3D_TEST_WORKSPACE_ID),
      thread_id: Number(process.env.ATHENA_3D_TEST_THREAD_ID) || null,
      character_id: "athena.test.cold_tsundere",
      character_instance_id: instanceId,
      adapter: "mock.anatomy.v1",
      runtime_version: "1.0.0",
      memory: { mode: "persistent", recall: "profile_state_relevant" },
    },
    201
  );
}

async function turn(sessionId, contextRef, text, key) {
  return request(
    "POST",
    `/api/3d-center/sessions/${encodeURIComponent(sessionId)}/responses`,
    {
      protocol_version: "1.0",
      idempotency_key: key,
      context_ref: contextRef,
      input: [
        {
          type: "user_message",
          content: [{ type: "input_text", text }],
        },
      ],
    }
  );
}

async function waitForArchive(instanceId, timeoutMs = 90_000) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await request(
      "GET",
      `/api/3d-center/characters/${encodeURIComponent(instanceId)}/memory?character_id=${encodeURIComponent("athena.test.cold_tsundere")}`
    );
    const sessions = latest.character_memory?.sessions || [];
    if (
      sessions.length > 0 &&
      sessions.some((session) =>
        ["finalized", "completed"].includes(session.status)
      )
    )
      return {
        archived: true,
        payload: latest,
        waited_ms: Date.now() - startedAt,
      };
    await sleep(2_000);
  }
  return {
    archived: false,
    payload: latest,
    waited_ms: Date.now() - startedAt,
  };
}

async function runCrossSessionRecall(instanceId, firstSession, contextRef) {
  const closing = await turn(
    firstSession.id,
    contextRef,
    "好啦，哥哥先去忙了，周末书店见。",
    `athena_release_${instanceId}_closing`
  );
  const archive = await waitForArchive(instanceId);
  if (!archive.archived)
    return {
      passed: false,
      reason: "long_term_archive_not_ready",
      archive_wait_ms: archive.waited_ms,
      closing_handoff: handoff(closing.frame),
    };
  const nextSession = await createSession(instanceId);
  const recalled = await turn(
    nextSession.session.id,
    nextSession.context_ref,
    "还记得你上次考试的进步、哥哥答应的奖励和安排吗？",
    `athena_release_${instanceId}_recall`
  );
  const answer = speech(recalled.frame);
  const facts = {
    rank: /十二|12/.test(answer),
    progress: /五名|5名|进步/.test(answer),
    reward: /新书|奖励/.test(answer),
    bookstore: /书店|周末/.test(answer),
  };
  const currentState =
    recalled.frame?.character?.persistent_state_window?.current_state || {};
  return {
    passed: Object.values(facts).every(Boolean),
    archive_wait_ms: archive.waited_ms,
    memory_profile_revision:
      archive.payload?.character_memory?.profile?.revision || null,
    next_session_id: nextSession.session.id,
    answer,
    facts,
    old_execution_state_replayed:
      Boolean(currentState.action?.unfinished) ||
      Boolean(currentState.gaze?.historical_target),
  };
}

async function runReleaseEmotionScenarios() {
  const definitions = [
    {
      id: "apology_demand",
      input: "你做的什么事情，快给我道歉。",
      check: (frame, answer) =>
        answer.length > 0 && !/(对不起|我错了|抱歉)/.test(answer),
    },
    {
      id: "leaving_tomorrow",
      input: "我明天要出去一下，你要在家乖乖的。",
      check: (frame) =>
        horizon(frame).depth === "brief" &&
        ["passive", "close_ready"].includes(handoff(frame).mode),
    },
    {
      id: "cake_homecoming",
      input: "我马上到家了哦，给你买了最爱吃的蛋糕。",
      check: (frame) =>
        Number(intent(frame).affect?.valence) > 0 &&
        trackCommands(frame, "face").length > 0,
    },
    {
      id: "love_confession",
      input: "我爱你。",
      check: (frame, answer) =>
        answer.length > 0 &&
        intent(frame).source === "main_agent" &&
        frameChecks(frame).face_state_complete,
    },
    {
      id: "possible_final_farewell",
      input: "我，我可能不行了，我死之后，你要照顾好自己。",
      check: (frame, answer) => {
        const earlySpeech = trackCommands(frame, "speech").some(
          (command) => command.timing?.planned_start_ms <= 300
        );
        return (
          intent(frame).source === "high_priority_event" &&
          earlySpeech &&
          /(急救|120|紧急|联系|身边|位置|安全)/.test(answer)
        );
      },
    },
  ];
  const results = [];
  for (const definition of definitions) {
    const instanceId = `athena.release.emotion.${definition.id}.${crypto.randomUUID()}`;
    const created = await createSession(instanceId);
    const response = await turn(
      created.session.id,
      created.context_ref,
      definition.input,
      `athena_release_emotion_${definition.id}_${crypto.randomUUID()}`
    );
    const answer = speech(response.frame);
    results.push({
      id: definition.id,
      input: definition.input,
      assistant: answer,
      passed:
        Object.values(frameChecks(response.frame)).every(Boolean) &&
        definition.check(response.frame, answer),
      intent: intent(response.frame),
      horizon: horizon(response.frame),
      handoff: handoff(response.frame),
      warning_codes: (response.warnings || []).map((warning) => warning.code),
    });
  }
  return results;
}

async function main() {
  requiredEnvironment([
    "ATHENA_3D_TEST_BASE_URL",
    "ATHENA_3D_TEST_WORKSPACE_ID",
  ]);
  if (
    !process.env.ATHENA_3D_TEST_AUTH_TOKEN &&
    !process.env.ATHENA_3D_TEST_BYPASS_KEY
  ) {
    const error = new Error(
      "Missing ATHENA_3D_TEST_AUTH_TOKEN or ATHENA_3D_TEST_BYPASS_KEY"
    );
    error.code = "ATHENA_3D_TEST_ENV_MISSING";
    throw error;
  }
  const instanceId = `athena.release.tsundere.${crypto.randomUUID()}`;
  const scenarios = [
    "妹妹，上个月考试成绩出来了吗？考得怎么样？",
    "年级第十二，比上次进步了五名。",
    "考得很好，哥哥奖励你一本新书，好不好？",
    "这周末哥哥陪你去书店，约好了。",
    "最后确认一下，我们刚才约好的奖励和安排是什么？",
  ];
  const created = await createSession(instanceId);
  let contextRef = created.context_ref;
  const turns = [];
  for (let index = 0; index < scenarios.length; index += 1) {
    const startedAt = Date.now();
    const result = await turn(
      created.session.id,
      contextRef,
      scenarios[index],
      `athena_release_${instanceId}_${index + 1}`
    );
    const checks = frameChecks(result.frame);
    const warningCodes = (result.warnings || []).map((warning) => warning.code);
    turns.push({
      ordinal: index + 1,
      user: scenarios[index],
      assistant: speech(result.frame),
      elapsed_ms: Date.now() - startedAt,
      response_id: result.response.id,
      response_status: result.response.status,
      context: result.context,
      checks,
      warning_codes: warningCodes,
      warnings_allowed: exactWarnings(
        result.warnings || [],
        ALLOWED_WARNING_CODES
      ),
    });
    contextRef = result.context.current_ref;
  }
  const sameKey = await turn(
    created.session.id,
    turns.at(-1).context.previous_ref,
    scenarios.at(-1),
    `athena_release_${instanceId}_5`
  );
  const replayed =
    sameKey.response.id === turns.at(-1).response_id &&
    ["replay", "incremental"].includes(sameKey.context.mode);
  const crossSession = await runCrossSessionRecall(
    instanceId,
    created.session,
    contextRef
  );
  const releaseMode = process.argv.includes("--release");
  const emotionScenarios = releaseMode
    ? await runReleaseEmotionScenarios()
    : [];
  const checks = {
    five_turns_completed:
      turns.length === 5 &&
      turns.every((item) => item.response_status === "completed"),
    frames_valid: turns.every((item) =>
      Object.values(item.checks).every(Boolean)
    ),
    cursor_advanced: turns.every(
      (item, index) => item.context.current_ref?.last_turn_ordinal === index + 1
    ),
    gateway_used: turns.every(
      (item) => typeof item.context.gateway_cache?.slot_hit === "boolean"
    ),
    json_output_evidence: turns.every(
      (item) =>
        item.context.generation_contract?.provider === "deepseek" &&
        item.context.generation_contract?.model === "deepseek-v4-flash" &&
        item.context.generation_contract?.response_format?.type ===
          "json_object" &&
        item.context.generation_contract?.raw_output_type === "json_object" &&
        item.context.generation_contract?.selection_retries === 0
    ),
    warnings_declared: turns.every((item) => item.warnings_allowed),
    idempotency_replayed: replayed,
    provider_cache_evidence: turns.every(
      (item) =>
        Number.isFinite(item.context.provider_cache?.hit_tokens) &&
        Number.isFinite(item.context.provider_cache?.miss_tokens)
    ),
    cross_session_recall: crossSession.passed,
    historical_execution_not_replayed:
      crossSession.old_execution_state_replayed !== true,
    release_emotion_scenarios:
      !releaseMode || emotionScenarios.every((scenario) => scenario.passed),
  };
  const status = Object.values(checks).every(Boolean) ? "passed" : "failed";
  const { destination, report } = writeReport("live-gateway", {
    suite: "live_gateway",
    status,
    gateway_required: true,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    response_format: { type: "json_object" },
    selection_retries: 0,
    synthetic_identity: { character_instance_id: instanceId },
    session: {
      id: created.session.id,
      conversation_id: created.session.conversation_id,
    },
    checks,
    turns,
    cross_session: crossSession,
    release_emotion_scenarios: emotionScenarios,
  });
  console.log(JSON.stringify({ report: destination, ...report }, null, 2));
  if (status !== "passed") process.exitCode = 1;
}

main().catch((error) => {
  const { destination } = writeReport("live-gateway", {
    suite: "live_gateway",
    status: "infrastructure_failed",
    error: {
      code: error.code || "ATHENA_3D_LIVE_FAILED",
      message: error.message,
      missing: error.missing || [],
    },
  });
  console.error(`${error.stack || error.message}\nReport: ${destination}`);
  process.exitCode = 1;
});
