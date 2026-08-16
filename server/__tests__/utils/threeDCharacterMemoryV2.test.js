const {
  ADAPTIVE_SELF_KEYS,
  RELATIONSHIP_V2_KEYS,
  initialAdaptiveSelf,
  initialRelationshipV2,
  legacyRelationshipProjection,
  validateReflectionV2,
} = require("../../utils/chats/threeDSessionMemory/longTermContract");
const {
  effectiveTransition,
  evaluateCandidate,
} = require("../../utils/chats/threeDSessionMemory/formationPolicy");
const {
  requireCharacterCore,
} = require("../../utils/chats/threeDSessionMemory/characterCoreRegistry");
const {
  MODEL,
  consolidationInstructions,
} = require("../../utils/chats/threeDSessionMemory/longTermModelClient");

const evidenceHash = "a".repeat(64);
const zero = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));

function reflection() {
  const relationshipBefore = initialRelationshipV2();
  const adaptiveBefore = initialAdaptiveSelf();
  return {
    object: "athena.3d_center.character_reflection",
    protocol_version: "2.0",
    session_reflection: {
      summary: "哥哥答应周末陪我去书店。",
      first_person_summary: "他记得奖励，我其实很期待。",
      topics: ["考试", "书店奖励"],
      important_turn_refs: [1],
    },
    memory_candidates: [
      {
        candidate_key: "book_promise",
        type: "promise",
        first_person_memory: "他答应周末陪我去书店。",
        event_summary: "用户承诺周末陪角色去书店。",
        source_turn_refs: [1],
        source_evidence: [{ turn_ordinal: 1, evidence_hash: evidenceHash }],
        values: {
          information_value: 0.8,
          relationship_value: 0.88,
          emotional_value: 0.86,
          future_relevance: 0.9,
          uniqueness: 0.7,
          repetition: 0.1,
          character_impact: 0.86,
        },
        confidence: 0.9,
        tags: ["书店", "奖励"],
        proposed_persistence: "durable",
      },
    ],
    user_model_updates: [],
    relationship_transition: {
      before: relationshipBefore,
      delta: {
        familiarity: 0.1,
        trust: 0.1,
        comfort: 0.08,
        attachment: 0.1,
        openness: 0.09,
        physical_closeness: 0,
      },
      after: {
        familiarity: 0.1,
        trust: 0.1,
        comfort: 0.08,
        attachment: 0.1,
        openness: 0.09,
        physical_closeness: 0,
      },
      narrative: "我更愿意相信他会兑现承诺。",
      confidence: 0.9,
    },
    adaptive_self_transition: {
      before: adaptiveBefore,
      delta: {
        openness_to_user: 0.07,
        playfulness_with_user: 0.02,
        comfort_with_user: 0.06,
        willingness_to_share: 0.05,
      },
      after: {
        openness_to_user: 0.07,
        playfulness_with_user: 0.02,
        comfort_with_user: 0.06,
        willingness_to_share: 0.05,
      },
      narrative: "我愿意稍微多表达期待。",
      confidence: 0.9,
    },
    growth_candidates: [],
    emotional_milestone_candidates: [],
    final_emotion: {
      primary: "proud",
      secondary: "shy",
      intensity: 0.6,
      valence: 0.7,
      arousal: 0.35,
      attitude_toward_user: "亲近但傲娇",
      unresolved_feelings: ["期待周末奖励"],
      persistence: "short",
    },
    state_interpretation: {
      facial_signal: "压住笑意",
      gaze_signal: "短暂移开视线",
      body_signal: "姿态放松",
      action_signal: "没有持续动作",
      social_meaning: "接受关心但维持克制",
      evidence_paths: ["authoritative_final_state.face"],
    },
  };
}

describe("Athena Character Memory v2", () => {
  test("pins an immutable versioned Core and exposes the legacy relationship projection", () => {
    const core = requireCharacterCore("athena.test.cold_tsundere");
    expect(core).toEqual(
      expect.objectContaining({
        id: "athena.core.cold_tsundere",
        version: "2.0.0",
      })
    );
    expect(core.sha256).toHaveLength(64);
    expect(
      legacyRelationshipProjection({
        familiarity: 0.4,
        trust: 0.5,
        comfort: 0.6,
        attachment: 0.7,
        openness: 0.8,
        physical_closeness: 0,
      })
    ).toEqual({
      affection: 0.7,
      trust: 0.5,
      closeness: 0.4,
      comfort: 0.6,
      guardedness: 0.2,
    });
  });

  test("validates true turn hashes and rejects hallucinated evidence", () => {
    const payload = reflection();
    expect(
      validateReflectionV2(payload, {
        relationshipBefore: initialRelationshipV2(),
        adaptiveBefore: initialAdaptiveSelf(),
        turnOrdinals: [1],
        turnEvidence: [{ ordinal: 1, evidence_hash: evidenceHash }],
      })
    ).toEqual(expect.objectContaining({ ok: true }));
    payload.memory_candidates[0].source_evidence[0].evidence_hash = "b".repeat(
      64
    );
    expect(
      validateReflectionV2(payload, {
        relationshipBefore: initialRelationshipV2(),
        adaptiveBefore: initialAdaptiveSelf(),
        turnOrdinals: [1],
        turnEvidence: [{ ordinal: 1, evidence_hash: evidenceHash }],
      })
    ).toEqual(
      expect.objectContaining({
        ok: false,
        code: "athena_3d_character_memory_candidate_invalid",
      })
    );
  });

  test("uses sparse formation and runtime caps instead of trusting model deltas", () => {
    const candidate = reflection().memory_candidates[0];
    expect(evaluateCandidate(candidate)).toEqual({
      accepted: true,
      reason: null,
    });
    const capped = effectiveTransition({
      before: initialRelationshipV2(),
      transition: reflection().relationship_transition,
      keys: RELATIONSHIP_V2_KEYS,
      kind: "relationship",
      accepted: [candidate],
    });
    expect(capped.cap).toBe(0.08);
    expect(capped.delta.trust).toBe(0.08);
    const noMemory = effectiveTransition({
      before: initialAdaptiveSelf(),
      transition: reflection().adaptive_self_transition,
      keys: ADAPTIVE_SELF_KEYS,
      kind: "adaptive",
      accepted: [],
    });
    expect(noMemory.delta).toEqual(zero(ADAPTIVE_SELF_KEYS));
    expect(noMemory.after).toEqual(initialAdaptiveSelf());
  });

  test("pins Reflection text generation to DeepSeek Flash JSON Output", () => {
    expect(MODEL).toBe("deepseek-v4-flash");
    expect(consolidationInstructions()).toMatch(/Character Reflection v2/);
    expect(consolidationInstructions()).toMatch(/evidence_hash/);
  });
});
