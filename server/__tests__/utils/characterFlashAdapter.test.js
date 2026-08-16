const {
  FLASH_CHARACTER_PROFILE,
  FlashCharacterAdapter,
} = require("../../utils/responsesRuntime/character");

function request() {
  return {
    protocol_version: "1.0",
    character: {
      character_id: FLASH_CHARACTER_PROFILE.characterId,
      instance_id: "char_inst_test",
      capability_manifest: FLASH_CHARACTER_PROFILE.manifest,
    },
    input: [
      {
        id: "input_test",
        type: "user_message",
        content: [{ type: "input_text", text: "我爱你。" }],
      },
    ],
    generation: {
      mode: "main_agent",
      channels: ["performance", "expression", "gaze", "speech"],
      latency_class: "interactive",
    },
  };
}

function modelPayload() {
  return {
    safety_assessment: "normal",
    items: [
      {
        type: "performance_intent",
        required: true,
        timing: {
          start: "immediate",
          after_item_id: null,
          offset_ms: 0,
          duration_hint_ms: 1800,
        },
        interruptibility: "blend_out",
        affect: {
          primary: "athena.core:emotion/embarrassed",
          secondary: "athena.core:emotion/tender",
          intensity: 0.55,
          valence: 0.45,
          arousal: 0.5,
        },
        source: "main_agent",
        channel_modulation: {},
        transition: { style: "blend", duration_ms: 180 },
        persistence: "response_lifetime",
        revision: 1,
      },
      {
        type: "expression",
        required: true,
        timing: {
          start: "immediate",
          after_item_id: null,
          offset_ms: 0,
          duration_hint_ms: 1500,
        },
        interruptibility: "blend_out",
        expression: "athena.core:expression/embarrassed",
        intensity: 0.5,
      },
      {
        type: "gaze",
        required: true,
        timing: {
          start: "immediate",
          after_item_id: null,
          offset_ms: 0,
          duration_hint_ms: 1200,
        },
        interruptibility: "blend_out",
        target: { type: "semantic", value: "away" },
        style: "athena.core:gaze_style/averted",
        intensity: 0.65,
        tracking: false,
      },
      {
        type: "speech",
        required: true,
        timing: {
          start: "at_offset",
          after_item_id: null,
          offset_ms: 260,
          duration_hint_ms: 1400,
        },
        interruptibility: "immediate",
        text: "……这种话，不要突然说。",
        language: "zh-CN",
        delivery: {
          emotion: "athena.core:emotion/embarrassed",
          emotion_source: "performance_intent",
          intensity: 0.5,
          rate: 0.92,
          volume: 0.75,
          style: "athena.core:voice_style/restrained",
          pause_before_ms: 220,
          pause_after_ms: 100,
        },
      },
    ],
  };
}

describe("FlashCharacterAdapter", () => {
  test("binds the internal adapter to DeepSeek Flash without changing the public request", async () => {
    const complete = jest.fn().mockResolvedValue({
      output_text: JSON.stringify(modelPayload()),
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      effectiveProtocol: "mock",
    });
    const generated = await new FlashCharacterAdapter({
      modelClient: { complete },
    }).generate(request());

    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deepseek",
        model: "deepseek-v4-flash",
      })
    );
    expect(request()).not.toHaveProperty("provider");
    expect(generated.responseValidation).toEqual(
      expect.objectContaining({ ok: true })
    );
    expect(generated.response.output[0].type).toBe("performance_intent");
    expect(generated.response.output[3].intent_id).toBe(
      generated.response.output[0].id
    );
  });

  test("does not repair a conflicting model-generated speech emotion", async () => {
    const payload = modelPayload();
    payload.items[3].delivery.emotion = "athena.core:emotion/happy";
    const adapter = new FlashCharacterAdapter({
      modelClient: {
        complete: jest.fn().mockResolvedValue({
          output_text: JSON.stringify(payload),
        }),
      },
    });
    const generated = await adapter.generate(request());
    expect(generated.responseValidation.ok).toBe(false);
    expect(generated.responseValidation.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "speech_emotion_conflict" }),
      ])
    );
    await expect(adapter.complete(request())).rejects.toMatchObject({
      code: "character_provider_output_invalid",
    });
  });
});
