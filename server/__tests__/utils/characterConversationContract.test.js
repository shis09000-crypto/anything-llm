const {
  DEFAULT_WAIT_MS,
  initialCharacterState,
  materializeNextState,
  normalizeConversationControl,
} = require("../../utils/responsesRuntime/character").conversation;
const { FlashCharacterV2Adapter, JSON_OUTPUT_FORMAT, PROFILE } =
  require("../../utils/responsesRuntime/character").v2;
const { plannerPayload, request } = require("./characterV2Fixtures");

function stateTransition(revision = 0) {
  return {
    from_revision: revision,
    affect: {
      primary: "athena.core:emotion/neutral",
      secondary: null,
      intensity: 0.2,
      valence: 0,
      arousal: 0.2,
    },
    attention: { target: "player", intensity: 0.5 },
    gaze: { target: "player", style: "soft" },
    posture: "conversation_relaxed",
    activity: { current: "conversation", previous: "reading" },
    performance_state: "conversation_idle",
    decay: { mode: "gradual", target: "soft_neutral", duration_ms: 8000 },
  };
}

function payload({
  depth = "brief",
  wait = 9000,
  continuation = 0.15,
  readiness = 0.9,
  mode = "close_ready",
  end = false,
} = {}) {
  return {
    character_state_transition: stateTransition(),
    conversation_horizon: {
      depth,
      continuation_probability: continuation,
      closure_readiness: readiness,
      soft_close_wait_ms: wait,
      basis: "answer_complete",
    },
    handoff: { target: "user", mode },
    end_intent: {
      detected: end,
      confidence: end ? 0.95 : 0,
      kind: end ? "explicit_departure" : "none",
    },
  };
}

function response(safety = "normal") {
  return { safety_assessment: safety };
}

function responseWithSpeech(text, safety = "normal") {
  return {
    safety_assessment: safety,
    output: [
      { type: "performance_intent" },
      {
        type: "performance_sequence",
        tracks: [
          { name: "face", cues: [] },
          { name: "speech", cues: [{ text }] },
        ],
      },
    ],
  };
}

describe("Athena Character Conversation control contract", () => {
  test("accepts a model-selected soft-close wait", () => {
    const currentState = initialCharacterState("reading");
    const control = normalizeConversationControl(payload(), {
      currentState,
      response: response(),
    });
    expect(control.outcome).toBe("close_ready");
    expect(control.soft_close_timing).toEqual({
      model_wait_ms: 9000,
      effective_wait_ms: 9000,
      source: "model",
      depth: "brief",
    });
    expect(control.warnings).toEqual([]);
  });

  test.each([
    ["brief", undefined, 8000],
    ["normal", "later", 20000],
    ["extended", 120001, 45000],
    ["brief", 2999, 8000],
    ["normal", -1, 20000],
    ["extended", 3.5, 45000],
  ])(
    "falls back to the %s depth default for invalid wait %p",
    (depth, wait, expected) => {
      const currentState = initialCharacterState("reading");
      const value = payload({ depth, wait });
      if (wait === undefined)
        delete value.conversation_horizon.soft_close_wait_ms;
      const control = normalizeConversationControl(value, {
        currentState,
        response: response(),
      });
      expect(control.soft_close_timing).toMatchObject({
        model_wait_ms: wait ?? null,
        effective_wait_ms: expected,
        source: "depth_default",
      });
      expect(control.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "soft_close_wait_defaulted" }),
        ])
      );
      expect(DEFAULT_WAIT_MS[depth]).toBe(expected);
    }
  );

  test("keeps the conversation open when the close-ready gate fails", () => {
    const control = normalizeConversationControl(
      payload({ continuation: 0.8, readiness: 0.4 }),
      { currentState: initialCharacterState(), response: response() }
    );
    expect(control.outcome).toBe("awaiting_user");
    expect(control.model_handoff.mode).toBe("close_ready");
    expect(control.effective_handoff.mode).toBe("passive");
    expect(control.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "close_ready_gate_rejected" }),
      ])
    );
  });

  test("preserves the model handoff but normalizes an explicit final question", () => {
    const control = normalizeConversationControl(
      payload({ mode: "passive", continuation: 0.3, readiness: 0.7 }),
      {
        currentState: initialCharacterState(),
        response: responseWithSpeech("现在是八点。你要去干嘛？"),
      }
    );
    expect(control.model_handoff.mode).toBe("passive");
    expect(control.effective_handoff.mode).toBe("question");
    expect(control.outcome).toBe("awaiting_user");
    expect(control.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "handoff_question_normalized" }),
      ])
    );
  });

  test("does not treat an earlier rhetorical question as an awaiting-user handoff", () => {
    const control = normalizeConversationControl(
      payload({ mode: "passive", continuation: 0.3, readiness: 0.7 }),
      {
        currentState: initialCharacterState(),
        response: responseWithSpeech("上学去？哼，自己路上小心。"),
      }
    );
    expect(control.effective_handoff.mode).toBe("passive");
    expect(control.warnings).toEqual([]);
  });

  test("does not soft-close a safety-sensitive response", () => {
    const control = normalizeConversationControl(payload(), {
      currentState: initialCharacterState(),
      response: response("possible_immediate_danger"),
    });
    expect(control.outcome).toBe("awaiting_user");
    expect(control.effective_handoff.mode).toBe("passive");
  });

  test("explicit end intent produces a formal terminal outcome", () => {
    const currentState = initialCharacterState();
    const control = normalizeConversationControl(payload({ end: true }), {
      currentState,
      response: response(),
    });
    expect(control.outcome).toBe("ended");
    expect(control.effective_handoff).toBeNull();
    const next = materializeNextState(
      control.state_transition,
      currentState,
      "chr_turn_1"
    );
    expect(next.revision).toBe(1);
    expect(next.source_turn_id).toBe("chr_turn_1");
  });

  test("conversation mode keeps JSON Output and returns two performance items", async () => {
    const planned = {
      ...plannerPayload(),
      ...payload({ mode: "question", depth: "normal", wait: null }),
    };
    const modelClient = {
      complete: jest.fn().mockResolvedValue({
        output_text: JSON.stringify(planned),
        effectiveProtocol: "responses",
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      }),
    };
    const adapter = new FlashCharacterV2Adapter({
      modelClient,
      profileResolver: () => PROFILE,
    });
    const generated = await adapter.generate(request(), {
      conversationContext: {
        conversation_id: "ath_conv_1",
        conversation_status: "awaiting_user",
        character_state: initialCharacterState(),
        recent_turns: [],
      },
    });
    expect(modelClient.complete).toHaveBeenCalledWith(
      expect.objectContaining({ responseFormat: JSON_OUTPUT_FORMAT })
    );
    expect(modelClient.complete.mock.calls[0][0].instructions).toContain(
      "conversation_horizon"
    );
    expect(generated.response.output.map((item) => item.type)).toEqual([
      "performance_intent",
      "performance_sequence",
    ]);
    expect(generated.payload.handoff.mode).toBe("question");
  });
});
