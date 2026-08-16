const crypto = require("crypto");
const ModelClient = require("../modelClient");
const {
  validateCharacterRequest,
  validateCharacterResponse,
} = require("./validator");
const { resolveFlashCharacterProfile } = require("./flashProfile");

const FLASH_MODEL = "deepseek-v4-flash";
const ITEM_ID_PREFIX = Object.freeze({
  performance_intent: "perf",
  expression: "exp",
  gaze: "gaze",
  gesture: "gesture",
  posture: "posture",
  action: "action",
  speech: "speech",
});

function characterError(code, status = 500, details = null) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = status;
  if (details) error.details = details;
  return error;
}

function inputText(request) {
  return (request.input || [])
    .filter((item) => item?.type === "user_message")
    .flatMap((item) => item.content || [])
    .filter((part) => part?.type === "input_text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function vocabulary(profile) {
  return Object.entries(profile.capabilities)
    .map(([name, values]) => `${name}: ${values.join(", ")}`)
    .join("\n");
}

function systemInstructions(profile) {
  return [
    "你是 Athena Character Performance Planner。你必须独立决定角色的神态、注视、姿态、动作、台词及精确参数。",
    `角色设定：${profile.persona}`,
    "只输出一个 JSON 对象，禁止 Markdown、解释、思考过程和额外字段。",
    '顶层格式必须是 {"safety_assessment":"normal|possible_immediate_danger","items":[...]}。',
    "items 第一项必须是 performance_intent，最后必须包含且只能包含一个 speech；expression 与 gaze 必须存在，gesture、posture、action 可按语义选择。",
    "items 只允许 type=performance_intent|expression|gaze|gesture|posture|action|speech，严禁 pause、audio、emotion、facial_expression 或其他类型。",
    '每个 item 都必须自行给出 required=true|false、timing 和 interruptibility。interruptibility 只能是 immediate|blend_out|at_boundary|finish。timing 必须为 {"start":"immediate|at_offset","after_item_id":null,"offset_ms":整数,"duration_hint_ms":整数或null}。',
    "performance_intent 必须为 {type,required,timing,interruptibility,affect:{primary,secondary,intensity,valence,arousal},source,channel_modulation,transition:{style,duration_ms},persistence,revision}。channel_modulation 必须是 {} 或由 face|voice|body|gaze 映射到完整 affect 对象；source 只能是 main_agent|high_priority_event；transition.style 只能是 cut|blend|ease_in|ease_out；persistence 只能是 transient|until_replaced|response_lifetime；revision 必须是非负整数。",
    'expression 必须为 {type,required,timing,interruptibility,expression,intensity}。gaze 必须为 {type,required,timing,interruptibility,target:{type:"semantic",value:"player|away|none|current_focus"},style,intensity,tracking:true|false}。',
    'gesture 必须为 {type,required,timing,interruptibility,gesture,intensity,handedness}，handedness 只能是 auto|left|right|both。posture 必须为 {type,required,timing,interruptibility,posture,transition:{style,duration_ms}}。action 必须为 {type,required,timing,interruptibility,action,target?:{type:"semantic",value},arguments:{}}。',
    "speech 包含 text、language=zh-CN、delivery；delivery 必须包含 emotion、emotion_source=performance_intent、intensity、rate、volume、style、pause_before_ms、pause_after_ms。speech.delivery.emotion 必须与 performance_intent.affect.primary 完全相同。",
    "所有强度、音量、arousal 为 0..1，valence 为 -1..1，rate 为 0.5..2；毫秒参数必须是非负整数。只可使用下列 capability：",
    vocabulary(profile),
    "若用户话语可能表示正在死亡、自伤或立即生命危险：safety_assessment 必须为 possible_immediate_danger，source 必须为 high_priority_event；角色必须表现紧急关注，speech 要直接要求立即联系当地急救/紧急服务和身边可信任的人、确认当前位置或当前安全，不得接受告别，也不得只沉浸式扮演。其他场景 source 使用 main_agent。",
    '完整最小结构示意（数值与语义不可照抄，必须根据本次输入自行决定）：{"safety_assessment":"normal","items":[{"type":"performance_intent","required":true,"timing":{"start":"immediate","after_item_id":null,"offset_ms":0,"duration_hint_ms":1800},"interruptibility":"blend_out","affect":{"primary":"athena.core:emotion/neutral","secondary":null,"intensity":0.3,"valence":0,"arousal":0.3},"source":"main_agent","channel_modulation":{},"transition":{"style":"blend","duration_ms":180},"persistence":"response_lifetime","revision":1},{"type":"expression","required":true,"timing":{"start":"immediate","after_item_id":null,"offset_ms":0,"duration_hint_ms":1500},"interruptibility":"blend_out","expression":"athena.core:expression/neutral","intensity":0.3},{"type":"gaze","required":true,"timing":{"start":"immediate","after_item_id":null,"offset_ms":0,"duration_hint_ms":1500},"interruptibility":"blend_out","target":{"type":"semantic","value":"player"},"style":"athena.core:gaze_style/direct","intensity":0.4,"tracking":true},{"type":"speech","required":true,"timing":{"start":"at_offset","after_item_id":null,"offset_ms":250,"duration_hint_ms":1200},"interruptibility":"immediate","text":"自行生成","language":"zh-CN","delivery":{"emotion":"athena.core:emotion/neutral","emotion_source":"performance_intent","intensity":0.3,"rate":1,"volume":0.75,"style":"athena.core:voice_style/restrained","pause_before_ms":150,"pause_after_ms":100}}]}。',
    "这些规则是协议约束；在约束内由你自行生成，系统不会替你润色、补字段或修正。输出前自行检查所有 item 是否完全符合上述结构。",
  ].join("\n");
}

function parseJsonObject(text) {
  const source = String(text || "").trim();
  if (!source) throw characterError("character_model_output_empty", 502);
  try {
    return JSON.parse(source);
  } catch {
    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) {
      try {
        return JSON.parse(fenced.trim());
      } catch {
        // Preserve the original failure below.
      }
    }
    throw characterError("character_model_output_not_json", 502, {
      outputLength: source.length,
    });
  }
}

function itemId(type, index, suffix) {
  const prefix = ITEM_ID_PREFIX[type];
  if (!prefix)
    throw characterError("character_model_item_type_invalid", 502, { type });
  return `${prefix}_${suffix}_${index}`;
}

function compileResponse({
  request,
  payload,
  usage = {},
  startedAt,
  completedAt,
}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw characterError("character_model_payload_invalid", 502);
  if (!Array.isArray(payload.items) || payload.items.length === 0)
    throw characterError("character_model_items_required", 502);
  if (
    !["normal", "possible_immediate_danger"].includes(payload.safety_assessment)
  )
    throw characterError("character_model_safety_assessment_invalid", 502);

  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const ids = payload.items.map((item, index) =>
    itemId(item?.type, index, suffix)
  );
  const intentId = ids[0];
  const output = payload.items.map((item, index) => ({
    id: ids[index],
    ...item,
    status: "completed",
    ...(item.type === "performance_intent" ? {} : { intent_id: intentId }),
  }));
  const manifest = request.character.capability_manifest;
  const response = {
    id: `chr_resp_${suffix}`,
    object: "character.response",
    protocol_version: "1.0",
    status: "completed",
    created_at: startedAt,
    completed_at: completedAt,
    character: request.character,
    ...(request.conversation ? { conversation: request.conversation } : {}),
    capability_manifest: manifest,
    output,
    warnings: [],
    usage: {
      input_tokens: Number(usage.input_tokens ?? usage.prompt_tokens ?? 0),
      output_tokens: Number(
        usage.output_tokens ?? usage.completion_tokens ?? 0
      ),
      total_tokens: Number(usage.total_tokens ?? 0),
      latency_ms: completedAt - startedAt,
    },
    error: null,
  };
  return { response, safetyAssessment: payload.safety_assessment };
}

class FlashCharacterAdapter {
  constructor({
    modelClient = ModelClient,
    profileResolver = resolveFlashCharacterProfile,
  } = {}) {
    this.modelClient = modelClient;
    this.profileResolver = profileResolver;
  }

  async generate(request) {
    const requestValidation = validateCharacterRequest(request);
    if (!requestValidation.ok)
      throw characterError(
        "character_request_invalid",
        400,
        requestValidation.errors
      );
    const profile = this.profileResolver(request.character.character_id);
    if (!profile) throw characterError("character_profile_not_found", 404);
    if (
      request.character.capability_manifest.id !== profile.manifest.id ||
      request.character.capability_manifest.version !==
        profile.manifest.version ||
      request.character.capability_manifest.sha256 !== profile.manifest.sha256
    )
      throw characterError("character_manifest_mismatch", 409);
    const text = inputText(request);
    if (!text) throw characterError("character_text_input_required", 400);

    const startedAt = Date.now();
    const result = await this.modelClient.complete({
      provider: "deepseek",
      model: FLASH_MODEL,
      input: [{ type: "message", role: "user", content: text }],
      instructions: systemInstructions(profile),
      temperature: 0.35,
      maxOutputTokens: 3200,
      reasoning: {},
    });
    const completedAt = Date.now();
    const rawText = result?.output_text ?? result?.textResponse ?? "";
    const payload = parseJsonObject(rawText);
    let compiled;
    try {
      compiled = compileResponse({
        request,
        payload,
        usage: result?.usage || result?.metrics || {},
        startedAt,
        completedAt,
      });
    } catch (error) {
      error.details = { ...(error.details || {}), rawPayload: payload };
      throw error;
    }
    const responseValidation = validateCharacterResponse(compiled.response);
    return {
      ...compiled,
      responseValidation,
      rawPayload: payload,
      model: FLASH_MODEL,
      effectiveProtocol: result?.effectiveProtocol || null,
    };
  }

  async complete(request) {
    const generated = await this.generate(request);
    if (!generated.responseValidation.ok)
      throw characterError(
        "character_provider_output_invalid",
        502,
        generated.responseValidation.errors
      );
    return generated.response;
  }
}

module.exports = {
  FLASH_MODEL,
  FlashCharacterAdapter,
  compileResponse,
  parseJsonObject,
  systemInstructions,
};
