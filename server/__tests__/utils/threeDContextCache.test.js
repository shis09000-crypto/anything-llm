const {
  ThreeDContextCache,
  hash,
} = require("../../utils/modelGateway/threeDContextCache");

function ref(
  cursor = "chr_ctx_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  revision = 0
) {
  return {
    cursor_id: cursor,
    memory_revision: revision,
    state_revision: revision,
    checkpoint_revision: 0,
    last_turn_ordinal: revision,
    expires_at: Date.now() + 900_000,
  };
}

function install(cache, contextRef = ref()) {
  return cache.install({
    session_id: "ath_conv_01",
    context_ref: contextRef,
    stable_instructions: "json schema and protocol",
    context_prefix: "readonly context:",
    template_hash: hash("json schema and protocol"),
    memory_point: {
      conversation_id: "ath_conv_01",
      dialogue_memory: { checkpoint: null, turns: [] },
      performance_state_memory: { state_revision: 0 },
    },
    status: "active",
  });
}

describe("Athena 3D Model Gateway hot context", () => {
  test("rebuilds a complete provider request while hit traffic only supplies cursor and input", () => {
    const cache = new ThreeDContextCache();
    install(cache);
    const prepared = cache.completionInput({
      context_ref: ref(),
      template_hash: hash("json schema and protocol"),
      input: [{ type: "message", role: "user", content: "现在几点了？" }],
      completion: {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        response_format: { type: "json_object" },
      },
    });
    expect(prepared.input.input).toHaveLength(1);
    expect(prepared.input.instructions).toContain("dialogue_memory");
    expect(prepared.input.response_format).toEqual({ type: "json_object" });
  });

  test("commit appends one language turn, replaces state, and rotates cursor", () => {
    const cache = new ThreeDContextCache();
    install(cache);
    const next = ref("chr_ctx_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 1);
    cache.commit({
      previous_context_ref: ref(),
      context_ref: next,
      dialogue_turn: { ordinal: 1, user: "8点了", assistant: "要去干嘛？" },
      performance_state_memory: { state_revision: 1 },
      status: "awaiting_user",
    });
    expect(cache.status({ context_ref: ref() }).slot_hit).toBe(false);
    const prepared = cache.completionInput({ context_ref: next });
    expect(prepared.slot.memoryPoint.dialogue_memory.turns).toHaveLength(1);
    expect(
      prepared.slot.memoryPoint.performance_state_memory.state_revision
    ).toBe(1);
  });

  test("rejects stale cursors without invoking any provider", () => {
    const cache = new ThreeDContextCache();
    install(cache);
    expect(() =>
      cache.completionInput({ context_ref: ref(undefined, 1) })
    ).toThrow("athena_3d_context_slot_miss");
  });

  test("reuses the exact last provider input prefix for Flash memory finalization", () => {
    const cache = new ThreeDContextCache();
    install(cache);
    const prepared = cache.completionInput({
      context_ref: ref(),
      input: [{ type: "message", role: "user", content: "成绩出来了吗？" }],
      completion: {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        response_format: { type: "json_object" },
      },
    });
    cache.recordCompletion(ref(), prepared.input, {
      output_text: '{"speech":"年级十二。"}',
    });
    const finalized = cache.finalizationInput({
      context_ref: ref(),
      finalize_instruction: "memory_finalize: output one JSON object",
      source: { turns: [{ ordinal: 1 }] },
    });
    expect(finalized.prefixSha256).toBe(hash(prepared.input));
    expect(finalized.input).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      response_format: { type: "json_object" },
    });
    expect(finalized.input.instructions).toBe(prepared.input.instructions);
    expect(finalized.input.input.slice(0, prepared.input.input.length)).toEqual(
      prepared.input.input
    );
    expect(finalized.input.input.at(-2)).toEqual({
      type: "message",
      role: "assistant",
      content: '{"speech":"年级十二。"}',
    });
  });

  test("an oversized finalization snapshot degrades without failing the completed turn", () => {
    const cache = new ThreeDContextCache({
      env: { ATHENA_3D_CONTEXT_CACHE_SLOT_MAX_BYTES: "512" },
    });
    install(cache);
    const result = cache.recordCompletion(
      ref(),
      { input: [{ type: "message", role: "user", content: "成绩？" }] },
      { output_text: "x".repeat(1_000) }
    );
    expect(result).toMatchObject({
      recorded: false,
      reason: "slot_too_large",
    });
    expect(cache.status({ context_ref: ref() }).metrics).toMatchObject({
      completion_record_drops: 1,
    });
    expect(() =>
      cache.finalizationInput({
        context_ref: ref(),
        finalize_instruction: "memory_finalize: output one JSON object",
      })
    ).toThrow("athena_3d_context_finalize_prefix_unavailable");
  });
});
