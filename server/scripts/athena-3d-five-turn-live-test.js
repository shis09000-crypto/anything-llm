#!/usr/bin/env node

const path = require("path");
const fs = require("fs");

const serverRoot = path.resolve(__dirname, "..");
require("dotenv").config({
  path: path.join(serverRoot, ".env.development"),
});

const storageBase = String(
  process.env.ATHENA_3D_FIVE_TURN_TEST_STORAGE ||
    "/tmp/athena-3d-five-turn-live"
);
process.env.NODE_ENV = "test";
process.env.APP_ENV = "development";
process.env.ANYTHINGLLM_STORAGE_BASE_DIR = storageBase;
process.env.ATHENA_3D_MEMORY_ENABLED = "true";
process.env.ATHENA_3D_FAST_LANE_ENABLED = "true";
process.env.ATHENA_3D_CONTEXT_FAST_LANE_ENABLED = "true";
process.env.ATHENA_3D_MEMORY_FAST_LANE_URL = `http://127.0.0.1:${Number(
  process.env.ATHENA_3D_FIVE_TURN_MEMORY_PORT || 32116
)}`;
process.env.ATHENA_3D_CONTEXT_FAST_LANE_URL = `http://127.0.0.1:${Number(
  process.env.ATHENA_3D_FIVE_TURN_CONTEXT_PORT || 32118
)}`;
process.env.ATHENA_CHARACTER_PERFORMANCE_RUNTIME_CUTOVER = "false";

const { applyEnvironmentStorage } = require("../utils/environment");
applyEnvironmentStorage();

const prisma = require("../utils/prisma");
const {
  startFastLaneServer,
} = require("../utils/athena3dCenter/fastLane");
const {
  ThreeDSessionMemoryRuntime,
} = require("../utils/chats/threeDSessionMemory/runtime");
const {
  ThreeDSessionMemoryClient,
} = require("../utils/responsesRuntime/character/conversation/sessionMemoryClient");
const {
  GatewayContextClient,
} = require("../utils/responsesRuntime/character/conversation/gatewayContextClient");
const {
  CharacterConversationRuntime,
} = require("../utils/responsesRuntime/character/conversation/runtime");
const {
  ThreeDContextCache,
} = require("../utils/modelGateway/threeDContextCache");
const {
  deepSeekResponsesComplete,
  validateProviderRequest,
} = require("../utils/modelGateway/deepSeekResponses");
const { DeepSeekLLM } = require("../utils/AiProviders/deepseek");
const { PROFILE } = require("../utils/responsesRuntime/character/v2/profile");
const {
  TRACK_ORDER,
} = require("../utils/responsesRuntime/character/v2/constants");

function responsesCompletionRequest(body = {}) {
  return validateProviderRequest({ ...body, stream: false });
}

function speechText(result) {
  const speech = result?.response?.output?.[1]?.tracks?.find(
    (track) => track.name === "speech"
  );
  return (speech?.cues || [])
    .map((cue) => String(cue.text || "").trim())
    .filter(Boolean)
    .join("\n");
}

function compactState(state) {
  const current = state?.current_state || {};
  const previous = state?.previous_state || {};
  const transition = state?.transition || {};
  const changedBlocks = Object.entries(transition.changes || {})
    .filter(([, value]) => value?.changed === true)
    .map(([key]) => key);
  return {
    previous_revision: previous.revision ?? null,
    transition_from_revision: transition.from_revision ?? null,
    transition_to_revision: transition.to_revision ?? null,
    current_revision: current.revision ?? null,
    affect: current.performance_intent?.affect || null,
    gaze: current.gaze || null,
    posture: current.posture || null,
    activity: current.activity || null,
    changed_blocks: changedBlocks,
  };
}

function enabledTrackSummary(response) {
  return (response?.output?.[1]?.tracks || [])
    .filter((track) => track.enabled)
    .map((track) => ({ name: track.name, cues: track.cues?.length || 0 }));
}

function selectOutcome(text) {
  const normalized = String(text || "");
  const explicitScore = normalized.match(/(?:考了|成绩(?:是|有)?|总分(?:是|有)?)?\s*(\d{2,3})\s*分/u);
  const score = explicitScore ? Number(explicitScore[1]) : null;
  const good =
    (score !== null && score >= 80) ||
    /第一|优秀|高分|进步|考得(?:还)?不错|满分|年级前|班级前/u.test(normalized);
  const poor =
    (score !== null && score < 60) ||
    /不及格|没考好|考砸|退步|很差|倒数/u.test(normalized);
  return { score, good, poor };
}

function preferenceFrom(text) {
  const candidates = [
    ["蛋糕", /蛋糕/u],
    ["新书", /新书|书/u],
    ["周末出去玩", /出去玩|周末.*玩|游乐园|逛街/u],
    ["数学", /数学/u],
    ["语文", /语文/u],
    ["英语", /英语/u],
    ["物理", /物理/u],
    ["化学", /化学/u],
  ];
  return candidates.find(([, pattern]) => pattern.test(String(text || "")))?.[0] || null;
}

function nextBrotherLine(turn, history) {
  const last = history.at(-1)?.assistant || "";
  if (turn === 2)
    return "别紧张，哥哥不是来审你的。不管考得怎么样，我都站你这边。告诉哥哥具体结果吧？";
  if (turn === 3) {
    const outcome = selectOutcome(last);
    if (outcome.good)
      return "考得这么好，当然要奖励。你自己选：蛋糕、新书，还是周末哥哥带你出去玩？";
    if (outcome.poor)
      return "没关系，一次考试说明不了什么。告诉哥哥哪一科最难，我们一起把它补上，好不好？";
    return "哥哥听懂了。做得好的地方要奖励，不理想的地方我们一起补。你更想先说奖励，还是先说最难的那科？";
  }
  if (turn === 4) {
    const preference = preferenceFrom(last);
    if (preference)
      return `好，哥哥记住了，是${preference}。奖励不会少，难的地方也不用你一个人扛。还有什么想让哥哥一起准备的吗？`;
    return "好，哥哥记住你刚才说的了。奖励不会少，难的地方也不用你一个人扛。那这周想让哥哥先怎么陪你？";
  }
  if (turn === 5)
    return "那哥哥最后确认一下：你还记得我们刚刚约好的奖励或者学习安排是什么吗？可别又嘴硬说自己没讲过。";
  return "妹妹，上个月考试成绩出来了吗？考得怎么样？";
}

async function main() {
  if (!process.env.DEEPSEEK_API_KEY)
    throw new Error("DEEPSEEK_API_KEY is required for the live test.");
  fs.mkdirSync(process.env.STORAGE_DIR, { recursive: true });
  await prisma.$prismaReady;

  const memoryRuntime = new ThreeDSessionMemoryRuntime({ env: process.env });
  const contextCache = new ThreeDContextCache({ env: process.env });
  const provider = new DeepSeekLLM(null, "deepseek-v4-flash", {
    credentialMode: "local",
  });
  const memoryPort = Number(
    new URL(process.env.ATHENA_3D_MEMORY_FAST_LANE_URL).port
  );
  const contextPort = Number(
    new URL(process.env.ATHENA_3D_CONTEXT_FAST_LANE_URL).port
  );
  const servers = [];
  const memoryDispatch = (operation, payload) => {
    switch (operation) {
      case "memory.session.create":
        return memoryRuntime.createSession(payload);
      case "memory.context.resolve":
        return memoryRuntime.contextResolve(payload);
      case "memory.context.prepare":
        return memoryRuntime.contextPrepare(payload);
      case "memory.turn.commit":
        return memoryRuntime.commitTurn(payload);
      case "memory.status":
        return memoryRuntime.status(payload);
      case "memory.session.delete":
        return memoryRuntime.deleteSession(payload);
      default: {
        const error = new Error("athena_3d_fast_lane_operation_unknown");
        error.code = "athena_3d_fast_lane_operation_unknown";
        error.httpStatus = 404;
        throw error;
      }
    }
  };
  const contextDispatch = async (operation, payload) => {
    switch (operation) {
      case "context.install":
        return contextCache.install(payload);
      case "context.complete": {
        const prepared = contextCache.completionInput(payload);
        const input = responsesCompletionRequest(prepared.input);
        const result = await deepSeekResponsesComplete(input, {
          providerFactory: () => provider,
        });
        return { result, slot_hit: true };
      }
      case "context.commit": {
        const inactive = [
          "soft_closed",
          "suspended",
          "ended",
          "cancelled",
        ].includes(String(payload.status || ""));
        if (inactive) {
          contextCache.invalidate({
            session_id: payload.session_id,
            context_ref: payload.previous_context_ref,
          });
          return { committed: true, retained: false };
        }
        return {
          committed: true,
          retained: true,
          ...contextCache.commit(payload),
        };
      }
      case "context.status":
        return contextCache.status(payload);
      case "context.invalidate":
        return contextCache.invalidate(payload);
      default: {
        const error = new Error("athena_3d_context_operation_unknown");
        error.code = "athena_3d_context_operation_unknown";
        error.httpStatus = 404;
        throw error;
      }
    }
  };

  try {
    servers.push(
      await startFastLaneServer({
        role: "chat-runtime-five-turn-test",
        host: "127.0.0.1",
        port: memoryPort,
        jsonLimit: "48mb",
        handler: memoryDispatch,
      })
    );
    servers.push(
      await startFastLaneServer({
        role: "model-gateway-five-turn-test",
        host: "127.0.0.1",
        port: contextPort,
        jsonLimit: "48mb",
        handler: contextDispatch,
      })
    );

    const runtime = new CharacterConversationRuntime({
      client: prisma,
      sessionMemoryClient: new ThreeDSessionMemoryClient({ env: process.env }),
      gatewayContextClient: new GatewayContextClient({ env: process.env }),
      performanceDeploymentClient: { compile: async () => null },
    });
    const athena = { workspaceId: 910001, threadId: 910002, userId: 910003 };
    const created = await runtime.create({
      protocol_version: "2.0",
      character: {
        character_id: PROFILE.characterId,
        instance_id: "athena_test_tsundere_sister_01",
        capability_manifest: PROFILE.manifestRef,
      },
      generation: {
        mode: "main_agent",
        channels: [
          "performance",
          "face",
          "gaze",
          "body",
          "action",
          "speech",
        ],
        latency_class: "interactive",
        performance_profile: PROFILE.id,
      },
      previous_activity: "reading_at_home",
      metadata: {
        test_scenario: "five_turn_tsundere_sister_exam_memory",
        relationship: "younger_sister_and_gentle_older_brother",
      },
      athena,
    });

    let contextRef = created.context_ref;
    const history = [];
    const results = [];
    console.log(
      JSON.stringify({
        event: "session.created",
        conversation_id: created.id,
        context_ref: contextRef,
        memory_storage: "plaintext_json",
        gateway_slots: contextCache.status(),
      })
    );

    for (let turn = 1; turn <= 5; turn += 1) {
      const user = nextBrotherLine(turn, history);
      const startedAt = Date.now();
      console.log(
        JSON.stringify({ event: "turn.started", turn, user, context_ref: contextRef })
      );
      const result = await runtime.turn(created.id, {
        idempotency_key: `five_turn_live_${turn}`,
        context_ref: contextRef,
        input: [
          {
            type: "user_message",
            content: [{ type: "input_text", text: user }],
          },
        ],
        athena,
      });
      const assistant = speechText(result);
      const state = compactState(result.persistent_state_window);
      const evidence = {
        turn,
        elapsed_ms: Date.now() - startedAt,
        user,
        assistant,
        response_id: result.response.id,
        response_status: result.response.status,
        response_json_object: result.response.object === "character.response",
        handoff: result.effective_handoff,
        horizon: result.conversation_horizon,
        conversation_status: result.conversation.status,
        context: result.context,
        memory_status: result.memory_status,
        memory_commit: {
          memory_revision: result.memory_commit?.memory_revision ?? null,
          state_revision: result.memory_commit?.state_revision ?? null,
          checkpoint_revision:
            result.memory_commit?.checkpoint_revision ?? null,
          turn_ordinal: result.memory_commit?.turn_ordinal ?? null,
          projected_context_tokens:
            result.memory_commit?.projected_context_tokens ?? null,
        },
        state,
        enabled_tracks: enabledTrackSummary(result.response),
        track_order_valid:
          result.response.output?.[1]?.tracks
            ?.map((track) => track.name)
            .join("|") === TRACK_ORDER.join("|"),
        warning_codes: (result.warnings || []).map((warning) => warning.code),
      };
      results.push(evidence);
      history.push({ user, assistant });
      contextRef = result.context.current_ref;
      console.log(JSON.stringify({ event: "turn.completed", ...evidence }));
    }

    const status = await memoryRuntime.status({
      conversationId: created.id,
      workspaceId: athena.workspaceId,
      threadId: athena.threadId,
      ownerUserId: athena.userId,
      agentRunId: null,
    });
    const cacheRates = results.map(
      (entry) => entry.context.provider_cache.hit_rate
    );
    const revisionsContinuous = results.every(
      (entry, index) =>
        entry.memory_commit.memory_revision === index + 1 &&
        entry.memory_commit.state_revision === index + 1 &&
        entry.state.previous_revision === index &&
        entry.state.transition_from_revision === index &&
        entry.state.transition_to_revision === index + 1 &&
        entry.state.current_revision === index + 1
    );
    const cursorAdvanced = results.every(
      (entry, index) =>
        entry.context.current_ref?.last_turn_ordinal === index + 1 &&
        entry.context.current_ref?.cursor_id !==
          (index === 0
            ? created.context_ref?.cursor_id
            : results[index - 1].context.current_ref?.cursor_id)
    );
    const gatewayHits = results.every(
      (entry) => entry.context.gateway_cache.slot_hit === true
    );
    const memoryCommitted = results.every(
      (entry) =>
        entry.memory_status === "committed" &&
        entry.context.advance_status === "committed"
    );
    const cacheImproved =
      cacheRates.slice(1).some((rate) => rate > cacheRates[0]) &&
      cacheRates.at(-1) >= cacheRates[0];

    console.log(
      JSON.stringify({
        event: "test.summary",
        turns: results.length,
        checks: {
          memory_committed_5_of_5: memoryCommitted,
          revisions_continuous: revisionsContinuous,
          cursor_advanced_5_of_5: cursorAdvanced,
          gateway_slot_hit_5_of_5: gatewayHits,
          response_json_object_5_of_5: results.every(
            (entry) => entry.response_json_object
          ),
          track_order_valid_5_of_5: results.every(
            (entry) => entry.track_order_valid
          ),
          provider_cache_improved_from_first_turn: cacheImproved,
        },
        provider_cache_hit_rates: cacheRates,
        final_memory_status: status,
        gateway_cache_status: contextCache.status(),
      })
    );
  } finally {
    for (const server of servers.reverse()) await server.close();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      event: "test.failed",
      code: error?.code || error?.message || "unknown_error",
      message: error?.message || String(error),
      details: error?.details || null,
      stack: error?.stack || null,
    })
  );
  process.exitCode = 1;
});
