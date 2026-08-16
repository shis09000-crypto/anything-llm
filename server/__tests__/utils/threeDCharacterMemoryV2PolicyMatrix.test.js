const {
  MEMORY_TYPES,
  MILESTONE_TYPES,
  evaluateCandidate,
  effectiveTransition,
  memoryType,
} = require("../../utils/chats/threeDSessionMemory/formationPolicy");
const {
  ADAPTIVE_SELF_KEYS,
  RELATIONSHIP_V2_KEYS,
  initialAdaptiveSelf,
  initialRelationshipV2,
  validateReflectionV2,
} = require("../../utils/chats/threeDSessionMemory/longTermContract");
const {
  profileNamespace,
} = require("../../utils/chats/threeDSessionMemory/characterMemoryVectorIndex");
const {
  requireCharacterCore,
} = require("../../utils/chats/threeDSessionMemory/characterCoreRegistry");

const evidenceHash = "a".repeat(64);

function values(overrides = {}) {
  return {
    information_value: 0.8,
    relationship_value: 0.66,
    emotional_value: 0.2,
    future_relevance: 0.71,
    uniqueness: 0.5,
    repetition: 0.1,
    character_impact: 0.2,
    ...overrides,
  };
}

function candidate(type = "shared_event", overrides = {}) {
  return {
    candidate_key: `candidate_${type}`,
    type,
    first_person_memory: "他答应周末陪我去书店。",
    event_summary: "用户作出了周末书店约定。",
    source_turn_refs: [1],
    source_evidence: [{ turn_ordinal: 1, evidence_hash: evidenceHash }],
    values: values(),
    confidence: 0.8,
    tags: ["书店"],
    proposed_persistence: "durable",
    ...overrides,
  };
}

function transition(before, keys, deltaValue) {
  const delta = Object.fromEntries(keys.map((key) => [key, deltaValue]));
  return {
    before,
    delta,
    after: Object.fromEntries(
      keys.map((key) => [key, Number((before[key] + deltaValue).toFixed(6))])
    ),
    narrative: "关系发生了小幅变化。",
    confidence: 0.9,
  };
}

function reflection(memoryCandidates = []) {
  const relationshipBefore = initialRelationshipV2();
  const adaptiveBefore = initialAdaptiveSelf();
  return {
    object: "athena.3d_center.character_reflection",
    protocol_version: "2.0",
    session_reflection: {
      summary: "本轮交流已归档。",
      first_person_summary: "我记得这次交流。",
      topics: ["日常"],
      important_turn_refs: [1],
    },
    memory_candidates: memoryCandidates,
    user_model_updates: [],
    relationship_transition: transition(
      relationshipBefore,
      RELATIONSHIP_V2_KEYS,
      memoryCandidates.length ? 0.01 : 0
    ),
    adaptive_self_transition: transition(
      adaptiveBefore,
      ADAPTIVE_SELF_KEYS,
      memoryCandidates.length ? 0.01 : 0
    ),
    growth_candidates: [],
    emotional_milestone_candidates: [],
    final_emotion: {
      primary: "neutral",
      secondary: null,
      intensity: 0.2,
      valence: 0,
      arousal: 0.2,
      attitude_toward_user: "平静",
      unresolved_feelings: [],
      persistence: "transient",
    },
    state_interpretation: {
      facial_signal: "表情平静",
      gaze_signal: "自然注视",
      body_signal: "姿势稳定",
      action_signal: "无持续动作",
      social_meaning: "普通交流",
      evidence_paths: ["authoritative_final_state.face"],
    },
  };
}

describe("Athena Character Memory v2 formation and isolation matrix", () => {
  test.each(MEMORY_TYPES)("accepts the core memory type %s", (type) => {
    expect(memoryType(type)).toBe(true);
  });

  test("accepts namespaced extensions and rejects an unnamespaced override", () => {
    expect(memoryType("com.example.story:shared_ritual")).toBe(true);
    expect(memoryType("invented_core_type")).toBe(false);
  });

  test.each([
    ["confidence", candidate("shared_event", { confidence: 0.74 }), "confidence_below_policy"],
    [
      "dimensions",
      candidate("shared_event", {
        values: values({
          information_value: 0.4,
          relationship_value: 0.4,
          future_relevance: 0.4,
          uniqueness: 0.5,
        }),
      }),
      "insufficient_value_dimensions",
    ],
    [
      "distinctiveness",
      candidate("shared_event", {
        values: values({ uniqueness: 0.44, repetition: 0.59 }),
      }),
      "uniqueness_or_repetition_below_policy",
    ],
  ])("rejects a candidate below the %s boundary", (_name, input, reason) => {
    expect(evaluateCandidate(input)).toEqual({ accepted: false, reason });
  });

  test("strong semantic types still require evidence, confidence and distinctiveness", () => {
    for (const type of ["promise", "conflict", "repair", "shared_goal"])
      expect(evaluateCandidate(candidate(type))).toEqual({
        accepted: true,
        reason: null,
      });
    expect(
      evaluateCandidate(
        candidate("promise", {
          values: values({ uniqueness: 0.1, repetition: 0.1 }),
        })
      )
    ).toMatchObject({ accepted: false });
  });

  test("applies normal, high-impact, negative and no-memory delta caps", () => {
    const before = Object.fromEntries(RELATIONSHIP_V2_KEYS.map((key) => [key, 0.5]));
    const modelTransition = transition(before, RELATIONSHIP_V2_KEYS, 0.5);
    const normal = effectiveTransition({
      before,
      transition: modelTransition,
      keys: RELATIONSHIP_V2_KEYS,
      kind: "relationship",
      accepted: [candidate()],
    });
    expect(normal.cap).toBe(0.03);
    expect(normal.delta.trust).toBe(0.03);
    const high = candidate("emotional_event", {
      confidence: 0.9,
      values: values({ emotional_value: 0.9 }),
    });
    expect(
      effectiveTransition({
        before,
        transition: modelTransition,
        keys: RELATIONSHIP_V2_KEYS,
        kind: "relationship",
        accepted: [high],
      }).delta.trust
    ).toBe(0.08);
    const negative = transition(before, RELATIONSHIP_V2_KEYS, -0.5);
    expect(
      effectiveTransition({
        before,
        transition: negative,
        keys: RELATIONSHIP_V2_KEYS,
        kind: "relationship",
        accepted: [high],
      }).delta.trust
    ).toBe(-0.08);
    expect(
      effectiveTransition({
        before,
        transition: modelTransition,
        keys: RELATIONSHIP_V2_KEYS,
        kind: "relationship",
        accepted: [],
      }).delta.trust
    ).toBe(0);
  });

  test("caps Adaptive Self more tightly than Relationship", () => {
    const before = initialAdaptiveSelf();
    const proposed = transition(before, ADAPTIVE_SELF_KEYS, 0.5);
    expect(
      effectiveTransition({
        before,
        transition: proposed,
        keys: ADAPTIVE_SELF_KEYS,
        kind: "adaptive",
        accepted: [candidate()],
      }).cap
    ).toBe(0.02);
    expect(
      effectiveTransition({
        before,
        transition: proposed,
        keys: ADAPTIVE_SELF_KEYS,
        kind: "adaptive",
        accepted: [
          candidate("relationship_event", {
            confidence: 0.9,
            values: values({ relationship_value: 0.9 }),
          }),
        ],
      }).cap
    ).toBe(0.05);
  });

  test("validates a no-memory time exchange without changing relationship", () => {
    expect(
      validateReflectionV2(reflection([]), {
        relationshipBefore: initialRelationshipV2(),
        adaptiveBefore: initialAdaptiveSelf(),
        turnOrdinals: [1],
        turnEvidence: [{ ordinal: 1, evidence_hash: evidenceHash }],
      })
    ).toMatchObject({ ok: true });
  });

  test("rejects hallucinated evidence and mathematically inconsistent transitions", () => {
    const hallucinated = reflection([candidate()]);
    hallucinated.memory_candidates[0].source_evidence[0].evidence_hash = "b".repeat(64);
    expect(
      validateReflectionV2(hallucinated, {
        relationshipBefore: initialRelationshipV2(),
        adaptiveBefore: initialAdaptiveSelf(),
        turnOrdinals: [1],
        turnEvidence: [{ ordinal: 1, evidence_hash: evidenceHash }],
      })
    ).toMatchObject({ ok: false });
    const invalidMath = reflection([candidate()]);
    invalidMath.relationship_transition.after.trust = 0.9;
    expect(
      validateReflectionV2(invalidMath, {
        relationshipBefore: initialRelationshipV2(),
        adaptiveBefore: initialAdaptiveSelf(),
        turnOrdinals: [1],
        turnEvidence: [{ ordinal: 1, evidence_hash: evidenceHash }],
      })
    ).toMatchObject({
      ok: false,
      code: "athena_3d_character_relationship_v2_invalid",
    });
  });

  test("pins Core and uses a SHA-256-derived identity-free vector namespace", () => {
    const core = requireCharacterCore("athena.test.cold_tsundere");
    expect(core.sha256).toHaveLength(64);
    const namespace = profileNamespace("profile_user_99_character_01");
    expect(namespace).toMatch(/^athena-character-memory-[a-f0-9]{64}$/);
    expect(namespace).not.toContain("user_99");
    expect(new Set(MILESTONE_TYPES).size).toBe(5);
  });
});
