const crypto = require("crypto");

function positive(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function cacheError(code, status = 400, details = null) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = status;
  if (details) error.details = details;
  return error;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])])
  );
}

function hash(value) {
  return crypto
    .createHash("sha256")
    .update(
      typeof value === "string" ? value : JSON.stringify(canonical(value))
    )
    .digest("hex");
}

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function contextRef(value) {
  if (!value || typeof value !== "object" || !String(value.cursor_id || ""))
    throw cacheError("athena_3d_context_cursor_invalid", 400);
  return {
    cursor_id: String(value.cursor_id),
    memory_revision: Number(value.memory_revision || 0),
    state_revision: Number(value.state_revision || 0),
    checkpoint_revision: Number(value.checkpoint_revision || 0),
    last_turn_ordinal: Number(value.last_turn_ordinal || 0),
    expires_at: Number(value.expires_at || 0),
  };
}

function sameRef(left, right) {
  return (
    left.cursor_id === right.cursor_id &&
    left.memory_revision === right.memory_revision &&
    left.state_revision === right.state_revision &&
    left.checkpoint_revision === right.checkpoint_revision &&
    left.last_turn_ordinal === right.last_turn_ordinal
  );
}

function appendContext(slot) {
  return [
    slot.template.instructions,
    slot.template.contextPrefix,
    JSON.stringify(slot.memoryPoint),
  ].join("\n");
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

class ThreeDContextCache {
  constructor({ env = process.env, now = () => Date.now() } = {}) {
    this.now = now;
    this.ttlMs = positive(env.ATHENA_3D_CONTEXT_CACHE_TTL_MS, 900_000);
    this.maxSlots = positive(env.ATHENA_3D_CONTEXT_CACHE_MAX_SLOTS, 16);
    this.maxBytes = positive(
      env.ATHENA_3D_CONTEXT_CACHE_MAX_BYTES,
      201_326_592
    );
    this.slotMaxBytes = positive(
      env.ATHENA_3D_CONTEXT_CACHE_SLOT_MAX_BYTES,
      33_554_432
    );
    this.slots = new Map();
    this.templates = new Map();
    this.totalBytes = 0;
    this.metrics = {
      installs: 0,
      completions: 0,
      commits: 0,
      hits: 0,
      misses: 0,
      evictions: 0,
      invalidations: 0,
      completion_record_drops: 0,
    };
  }

  sweep() {
    const now = this.now();
    for (const [key, slot] of this.slots)
      if (slot.expiresAt <= now) {
        if (this.remove(key)) this.metrics.evictions += 1;
      }
  }

  remove(key) {
    const slot = this.slots.get(key);
    if (!slot) return false;
    this.totalBytes = Math.max(0, this.totalBytes - slot.bytes);
    this.slots.delete(key);
    return true;
  }

  touch(key, slot) {
    this.slots.delete(key);
    slot.lastAccessAt = this.now();
    slot.expiresAt = slot.lastAccessAt + this.ttlMs;
    this.slots.set(key, slot);
  }

  evict() {
    this.sweep();
    while (this.slots.size > this.maxSlots || this.totalBytes > this.maxBytes) {
      const oldest = this.slots.keys().next().value;
      if (!oldest) break;
      if (this.remove(oldest)) this.metrics.evictions += 1;
    }
  }

  install(payload = {}) {
    const ref = contextRef(payload.context_ref);
    if (!payload.memory_point || typeof payload.memory_point !== "object")
      throw cacheError("athena_3d_context_memory_point_required", 400);
    const instructions = String(payload.stable_instructions || "");
    const contextPrefix = String(payload.context_prefix || "");
    if (!instructions || !contextPrefix)
      throw cacheError("athena_3d_context_template_required", 400);
    const templateHash = String(payload.template_hash || hash(instructions));
    if (templateHash !== hash(instructions))
      throw cacheError("athena_3d_context_template_digest_invalid", 400);
    const template = { instructions, contextPrefix, hash: templateHash };
    this.templates.set(templateHash, template);
    const key = ref.cursor_id;
    this.remove(key);
    const slot = {
      sessionId: String(payload.session_id || ""),
      ref,
      template,
      memoryPoint: payload.memory_point,
      status: String(payload.status || "active"),
      createdAt: this.now(),
      lastCompletion: payload.last_completion || null,
    };
    slot.bytes = bytes({
      ref,
      memoryPoint: slot.memoryPoint,
      templateHash,
      lastCompletion: slot.lastCompletion,
    });
    if (slot.bytes > this.slotMaxBytes)
      throw cacheError("athena_3d_context_slot_too_large", 413, {
        bytes: slot.bytes,
        limit: this.slotMaxBytes,
      });
    this.totalBytes += slot.bytes;
    this.touch(key, slot);
    this.evict();
    this.metrics.installs += 1;
    return { installed: true, context_ref: ref, template_hash: templateHash };
  }

  require(payload = {}) {
    this.sweep();
    const ref = contextRef(payload.context_ref);
    const slot = this.slots.get(ref.cursor_id);
    if (!slot || !sameRef(slot.ref, ref)) {
      this.metrics.misses += 1;
      throw cacheError("athena_3d_context_slot_miss", 409);
    }
    if (
      payload.template_hash &&
      String(payload.template_hash) !== slot.template.hash
    ) {
      this.metrics.misses += 1;
      throw cacheError("athena_3d_context_template_changed", 409);
    }
    this.touch(ref.cursor_id, slot);
    this.metrics.hits += 1;
    return slot;
  }

  completionInput(payload = {}) {
    const slot = this.require(payload);
    this.metrics.completions += 1;
    return {
      slot,
      input: {
        ...(payload.completion || {}),
        input: payload.input,
        instructions: appendContext(slot),
      },
    };
  }

  recordCompletion(contextRefValue, providerInput, result) {
    this.sweep();
    const ref = contextRef(contextRefValue);
    const slot = this.slots.get(ref.cursor_id);
    if (!slot || !sameRef(slot.ref, ref))
      throw cacheError("athena_3d_context_slot_miss", 409);
    const previousBytes = slot.bytes;
    const previousCompletion = slot.lastCompletion;
    const candidateCompletion = {
      provider_input: clone(providerInput),
      assistant_output: String(result?.output_text || ""),
      recorded_at: this.now(),
    };
    const candidateBytes = bytes({
      ref: slot.ref,
      memoryPoint: slot.memoryPoint,
      templateHash: slot.template.hash,
      lastCompletion: candidateCompletion,
    });
    if (candidateBytes > this.slotMaxBytes) {
      slot.lastCompletion = previousCompletion;
      this.metrics.completion_record_drops += 1;
      return {
        recorded: false,
        reason: "slot_too_large",
        bytes: candidateBytes,
        limit: this.slotMaxBytes,
      };
    }
    slot.lastCompletion = candidateCompletion;
    slot.bytes = candidateBytes;
    this.totalBytes += slot.bytes - previousBytes;
    this.touch(ref.cursor_id, slot);
    this.evict();
    return { recorded: true };
  }

  finalizationInput(payload = {}) {
    const slot = this.require(payload);
    if (!slot.lastCompletion?.provider_input)
      throw cacheError("athena_3d_context_finalize_prefix_unavailable", 409);
    const previous = clone(slot.lastCompletion.provider_input);
    const priorInput = Array.isArray(previous.input) ? previous.input : [];
    const source = payload.source || {};
    const instruction = String(payload.finalize_instruction || "").trim();
    if (!instruction || !instruction.toLowerCase().includes("json"))
      throw cacheError("athena_3d_context_finalize_instruction_invalid", 400);
    return {
      slot,
      prefixSha256: hash(previous),
      input: {
        ...previous,
        provider: "deepseek",
        model: "deepseek-v4-flash",
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_output_tokens: Number(payload.max_output_tokens || 16384),
        input: [
          ...priorInput,
          {
            type: "message",
            role: "assistant",
            content: slot.lastCompletion.assistant_output,
          },
          {
            type: "message",
            role: "user",
            content: `${instruction}\n${JSON.stringify(source)}`,
          },
        ],
      },
    };
  }

  commit(payload = {}) {
    const slot = this.require({
      context_ref: payload.previous_context_ref,
      template_hash: payload.template_hash,
    });
    const nextRef = contextRef(payload.context_ref);
    const dialogue = slot.memoryPoint.dialogue_memory || {};
    const turns = Array.isArray(dialogue.turns) ? dialogue.turns.slice() : [];
    if (payload.dialogue_turn) turns.push(payload.dialogue_turn);
    const memoryPoint = {
      ...slot.memoryPoint,
      dialogue_memory: { ...dialogue, turns },
      performance_state_memory:
        payload.performance_state_memory ||
        slot.memoryPoint.performance_state_memory,
    };
    const lastCompletion = slot.lastCompletion;
    this.remove(slot.ref.cursor_id);
    const installed = this.install({
      session_id: slot.sessionId,
      context_ref: nextRef,
      stable_instructions: slot.template.instructions,
      context_prefix: slot.template.contextPrefix,
      template_hash: slot.template.hash,
      memory_point: memoryPoint,
      status: payload.status,
      last_completion: lastCompletion,
    });
    this.metrics.commits += 1;
    return installed;
  }

  invalidate(payload = {}) {
    let removed = 0;
    if (payload.context_ref?.cursor_id)
      removed += this.remove(String(payload.context_ref.cursor_id)) ? 1 : 0;
    if (payload.session_id)
      for (const [key, slot] of [...this.slots])
        if (slot.sessionId === String(payload.session_id))
          removed += this.remove(key) ? 1 : 0;
    this.metrics.invalidations += removed;
    return { invalidated: removed };
  }

  status(payload = {}) {
    this.sweep();
    const key = payload.context_ref?.cursor_id;
    return {
      ready: true,
      slot_hit: key ? this.slots.has(String(key)) : null,
      slots: this.slots.size,
      bytes: this.totalBytes,
      max_slots: this.maxSlots,
      max_bytes: this.maxBytes,
      ttl_ms: this.ttlMs,
      average_slot_bytes:
        this.slots.size > 0 ? Math.round(this.totalBytes / this.slots.size) : 0,
      metrics: { ...this.metrics },
    };
  }
}

module.exports = { ThreeDContextCache, cacheError, contextRef, hash, sameRef };
