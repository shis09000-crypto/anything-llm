const crypto = require("crypto");
const { requestInternalService } = require("../../microModules");
const { requestFastLane } = require("../../athena3dCenter/fastLane");

const MODEL = "deepseek-v4-flash";

function gatewayUrl(env = process.env) {
  const value = String(env.ATHENA_MODEL_GATEWAY_URL || "").replace(/\/+$/, "");
  if (!value)
    throw Object.assign(new Error("model_gateway_url_missing"), {
      code: "model_gateway_url_missing",
    });
  return value;
}

function consolidationInstructions() {
  return [
    "你是 Athena Character Reflection v2。只输出一个合法 JSON object，禁止 Markdown。",
    "所有生成使用 DeepSeek Flash。Session 原话与 authoritative_final_state 是事实权威；Character Core 只读，绝不能提议修改 Core。",
    "只依据 turns 中真实内容提出候选。每个 memory_candidate 和 user_model_update 必须同时给出 source_turn_refs 以及 source_evidence=[{turn_ordinal,evidence_hash}]，hash 必须逐字复制对应 turn.evidence_hash。",
    "若 finalized_through_ordinal 大于0，关系与 Adaptive Self 变化只能依据 new_turn_ordinals，不能重复累计旧轮次。",
    "relationship_transition.before 必须逐值复制 current_relationship；adaptive_self_transition.before 必须逐值复制 current_adaptive_self；after=before+delta 且保持0到1。Core 不得进入变化字段。",
    "memory_candidates 每项必须且只能使用以下完整字段：candidate_key、type、first_person_memory、event_summary、source_turn_refs、source_evidence、values、confidence、tags、proposed_persistence。严禁使用 content、value_scores 或 persistence 代替这些字段。",
    'memory_candidate 完整 JSON 样例：{"candidate_key":"promise_book_reward","type":"promise","first_person_memory":"他答应奖励我一本新书。","event_summary":"用户承诺以新书作为考试进步奖励。","source_turn_refs":[3],"source_evidence":[{"turn_ordinal":3,"evidence_hash":"逐字复制 turns[ordinal=3].evidence_hash"}],"values":{"information_value":0.8,"relationship_value":0.8,"emotional_value":0.7,"future_relevance":0.9,"uniqueness":0.6,"repetition":0.1,"character_impact":0.7},"confidence":0.9,"tags":["考试","奖励","新书"],"proposed_persistence":"durable"}。所有候选都必须逐字段遵循此结构。',
    "values 内部字段固定为 information_value, relationship_value, emotional_value, future_relevance, uniqueness, repetition, character_impact，均为0到1。模型只提候选，不决定最终落库。普通时间问答应返回空候选和零变化。",
    "memory_candidates 类型只用 user_understanding/shared_event/relationship_event/emotional_event/growth_event/habit/promise/conflict/repair/shared_goal 或第三方 namespace。",
    "user_model_updates 每项必须且只能为 {candidate_key,observation,first_person_interpretation,confidence,mode,source_turn_refs,source_evidence}，mode 仅 observe/reinforce/contradict；candidate_key 必须指向本次 memory_candidates 中真实存在的 user_understanding 或 habit 候选。",
    'user_model_update 完整 JSON 样例：{"candidate_key":"user_understanding_caring_brother","observation":"用户会通过奖励和陪伴表达关心。","first_person_interpretation":"我觉得他确实重视我的感受。","confidence":0.86,"mode":"observe","source_turn_refs":[1,3,4],"source_evidence":[{"turn_ordinal":1,"evidence_hash":"逐字复制对应hash"},{"turn_ordinal":3,"evidence_hash":"逐字复制对应hash"},{"turn_ordinal":4,"evidence_hash":"逐字复制对应hash"}]}。无法完整满足时不要生成该项，输出空数组。',
    'growth_candidates 每项只能为 {"type":"string","first_person_summary":"string","source_memory_candidate_keys":["已存在的candidate_key"],"confidence":0到1}；未达到长期成长条件时输出 []。',
    'emotional_milestone_candidates 每项必须且只能包含 {"type":"first_deep_trust|first_active_expectation|major_conflict|deep_disappointment|meaningful_repair","first_person_memory":"string","source_memory_candidate_keys":["已存在的candidate_key"],"emotional_value":0到1,"relationship_value":0到1,"character_impact":0到1,"confidence":0到1}。普通奖励或一次约定不构成 milestone，必须输出 []；严禁使用 values、value_scores、summary 或 content 替代这些字段。',
    "不要生成新的五官、四肢或动作状态；state_interpretation 只能解释 authoritative_final_state，并用 evidence_paths 指向权威状态字段。",
    "输出固定顶层：object='athena.3d_center.character_reflection', protocol_version='2.0', session_reflection, memory_candidates, user_model_updates, relationship_transition, adaptive_self_transition, growth_candidates, emotional_milestone_candidates, final_emotion, state_interpretation。",
    "session_reflection 必须且只能完整包含 summary:string、first_person_summary:string、topics:string[]、important_turn_refs:integer[]；引用必须是 turns 中真实整数 ordinal，没有重要轮次时用 []，不能省略字段、不能改名、不能用字符串数字。final_emotion.persistence 只能 transient/short/durable。",
    "final_emotion 必须且只能完整包含 primary:string、secondary:string|null、intensity:0..1、valence:-1..1、arousal:0..1、attitude_toward_user:string、unresolved_feelings:string[]、persistence。不能把 primary 改名为 emotion。",
    "state_interpretation 必须且只能完整包含 facial_signal:string、gaze_signal:string、body_signal:string、action_signal:string、social_meaning:string、evidence_paths:string[]；没有信号时使用空字符串，不能缩写成 interpretation。",
    'JSON 骨架示例：{"object":"athena.3d_center.character_reflection","protocol_version":"2.0","session_reflection":{"summary":"","first_person_summary":"","topics":[],"important_turn_refs":[]},"memory_candidates":[],"user_model_updates":[],"relationship_transition":{"before":{"familiarity":0,"trust":0,"comfort":0,"attachment":0,"openness":0,"physical_closeness":0},"delta":{"familiarity":0,"trust":0,"comfort":0,"attachment":0,"openness":0,"physical_closeness":0},"after":{"familiarity":0,"trust":0,"comfort":0,"attachment":0,"openness":0,"physical_closeness":0}},"adaptive_self_transition":{"before":{"openness_to_user":0,"playfulness_with_user":0,"comfort_with_user":0,"willingness_to_share":0},"delta":{"openness_to_user":0,"playfulness_with_user":0,"comfort_with_user":0,"willingness_to_share":0},"after":{"openness_to_user":0,"playfulness_with_user":0,"comfort_with_user":0,"willingness_to_share":0}},"growth_candidates":[],"emotional_milestone_candidates":[],"final_emotion":{"primary":"neutral","secondary":null,"intensity":0,"valence":0,"arousal":0,"attitude_toward_user":"neutral","unresolved_feelings":[],"persistence":"transient"},"state_interpretation":{"facial_signal":"","gaze_signal":"","body_signal":"","action_signal":"","social_meaning":"","evidence_paths":[]}}。实际输出必须按 source 补全真实值。',
  ].join("\n");
}

async function finalizeFromHotContext(
  { contextRef, source },
  env = process.env
) {
  const url = String(
    env.ATHENA_3D_CONTEXT_FAST_LANE_URL || "http://127.0.0.1:3118"
  ).replace(/\/+$/, "");
  const completed = await requestFastLane({
    url: `${url}/v1/dispatch`,
    operation: "context.finalize",
    payload: {
      context_ref: contextRef,
      source,
      finalize_instruction: `${consolidationInstructions()}\n请基于前一条角色JSON输出和以下权威归档数据生成长期记忆JSON。`,
      max_output_tokens: 32768,
    },
    timeoutMs: 300_000,
  });
  const result = completed?.result || {};
  const content = String(result.output_text || "").trim();
  if (!content)
    throw Object.assign(new Error("athena_3d_long_term_memory_empty"), {
      code: "athena_3d_long_term_memory_empty",
    });
  return {
    payload: JSON.parse(content),
    provider: "deepseek",
    model: MODEL,
    usage: result.usage || {},
    cacheMode: completed.cache_mode || "exact_prefix",
    prefixSha256: completed.prefix_sha256 || null,
  };
}

async function consolidateLongTermMemory(source, env = process.env) {
  const body = {
    provider: "deepseek",
    model: MODEL,
    input: [{ type: "message", role: "user", content: JSON.stringify(source) }],
    instructions: consolidationInstructions(),
    response_format: { type: "json_object" },
    temperature: 0.1,
    max_output_tokens: 32768,
    stream: false,
  };
  const response = await requestInternalService({
    callerRole: "chat-runtime",
    targetModule: "model-gateway",
    capability: "model.responses.complete",
    contractVersion: "1.0",
    url: `${gatewayUrl(env)}/internal/v1/models/responses/complete`,
    body,
    idempotencyKey: crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          task: "character_reflection_v2",
          model: MODEL,
          instructions: consolidationInstructions(),
          source,
        })
      )
      .digest("hex"),
    env,
    timeoutMs: Number(env.ATHENA_MODEL_GATEWAY_TIMEOUT_MS || 300_000),
  });
  const result = response?.result || {};
  const content = String(result.output_text || "").trim();
  if (!content)
    throw Object.assign(new Error("athena_3d_long_term_memory_empty"), {
      code: "athena_3d_long_term_memory_empty",
    });
  let payload;
  try {
    payload = JSON.parse(content);
  } catch {
    throw Object.assign(new Error("athena_3d_long_term_memory_json_invalid"), {
      code: "athena_3d_long_term_memory_json_invalid",
    });
  }
  return {
    payload,
    provider: "deepseek",
    model: MODEL,
    usage: result.usage || {},
  };
}

module.exports = {
  MODEL,
  consolidateLongTermMemory,
  consolidationInstructions,
  finalizeFromHotContext,
};
