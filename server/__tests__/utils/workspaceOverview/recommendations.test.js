const path = require("path");

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR || path.resolve(__dirname, "../../storage");

const {
  FORMULA_VERSION,
  buildRelationSummary,
  buildRelationTitle,
  buildMainlinePath,
  buildNodeSummary,
  buildRecommendationDisplayFields,
  collectHydrationNodeIds,
  relationSnippetMatches,
  recommendationId,
  relationTypeLabel,
  selectStableCurrentFocus,
} = require("../../../utils/workspaceOverview");

function candidate(id, score, category = "focus", extra = {}) {
  return {
    recommendationId: id,
    category,
    score,
    target: { targetType: "concept", targetId: id },
    ...extra,
  };
}

describe("workspace overview recommendations", () => {
  test("recommendationId is stable for the same target and formula version", () => {
    const input = {
      workspaceId: 1,
      type: "current_focus",
      targetType: "concept",
      targetId: "42",
    };

    expect(recommendationId(input)).toEqual(recommendationId(input));
    expect(recommendationId(input)).toHaveLength(64);
    expect(FORMULA_VERSION).toEqual("overview-rec-v1");
  });

  test("recommendationId changes when the stable target identity changes", () => {
    const base = {
      workspaceId: 1,
      type: "current_focus",
      targetType: "concept",
      targetId: "42",
    };

    expect(recommendationId(base)).not.toEqual(
      recommendationId({ ...base, targetId: "43" })
    );
    expect(recommendationId(base)).not.toEqual(
      recommendationId({ ...base, type: "evidence_gap" })
    );
    expect(recommendationId(base)).not.toEqual(
      recommendationId({ ...base, workspaceId: 2 })
    );
  });

  test("keeps the previous focus during dwell when the new lead is small", () => {
    const result = selectStableCurrentFocus({
      candidates: [candidate("new", 70), candidate("old", 62)],
      previousState: { recommendationId: "old", selectedAt: 1_000 },
      now: 2_000,
      minDwellMs: 10_000,
      switchThreshold: 12,
    });

    expect(result.focus[0].recommendationId).toBe("old");
    expect(result.state).toEqual({
      recommendationId: "old",
      selectedAt: 1_000,
    });
  });

  test("switches focus during dwell when the new lead clears the threshold", () => {
    const result = selectStableCurrentFocus({
      candidates: [candidate("new", 78), candidate("old", 62)],
      previousState: { recommendationId: "old", selectedAt: 1_000 },
      now: 2_000,
      minDwellMs: 10_000,
      switchThreshold: 12,
    });

    expect(result.focus[0].recommendationId).toBe("new");
    expect(result.state).toEqual({
      recommendationId: "new",
      selectedAt: 2_000,
    });
  });

  test("switches to the ranked best focus after the minimum dwell time", () => {
    const result = selectStableCurrentFocus({
      candidates: [candidate("new", 70), candidate("old", 62)],
      previousState: { recommendationId: "old", selectedAt: 1_000 },
      now: 12_000,
      minDwellMs: 10_000,
      switchThreshold: 12,
    });

    expect(result.focus[0].recommendationId).toBe("new");
    expect(result.state).toEqual({
      recommendationId: "new",
      selectedAt: 12_000,
    });
  });

  test("chooses the best available focus when the previous focus is absent", () => {
    const result = selectStableCurrentFocus({
      candidates: [
        candidate("gap", 92, "gap"),
        candidate("new", 70),
        candidate("backup", 60, "continue"),
      ],
      previousState: { recommendationId: "old", selectedAt: 1_000 },
      now: 2_000,
      minDwellMs: 10_000,
      switchThreshold: 12,
    });

    expect(result.focus.map((item) => item.recommendationId)).toEqual([
      "new",
      "backup",
    ]);
    expect(result.state).toEqual({
      recommendationId: "new",
      selectedAt: 2_000,
    });
  });

  test("gives supplemented focus candidates a light priority without breaking dwell", () => {
    const result = selectStableCurrentFocus({
      candidates: [
        candidate("plain", 70),
        candidate("supplemented", 68, "focus", { hasSupplement: true }),
      ],
      previousState: null,
      now: 2_000,
      minDwellMs: 10_000,
      switchThreshold: 12,
    });

    expect(result.focus[0].recommendationId).toBe("supplemented");
    expect(result.state).toEqual({
      recommendationId: "supplemented",
      selectedAt: 2_000,
    });
  });

  test("collects node ids without requiring one query per recommendation", () => {
    const ids = collectHydrationNodeIds([
      candidate("1", 80, "continue", {
        target: { targetType: "node", targetId: "1" },
      }),
      candidate("2", 70, "focus", {
        target: { targetType: "concept", nodeId: 2, targetId: "2" },
      }),
      candidate("path", 60, "continue", {
        target: { targetType: "path", targetId: "path-1" },
      }),
      candidate("1-again", 50, "continue", {
        target: { targetType: "node", targetId: "1" },
      }),
    ]);

    expect(ids).toEqual([1, 2]);
  });

  test("uses KnowledgeNode summary before deterministic fallbacks", () => {
    const summary = buildNodeSummary({
      node: {
        canonicalName: "约翰·洛克",
        entityType: "person",
        summary: "英国经验主义哲学家，提出自然权利和政府有限性。",
      },
      evidenceSnippet: "这段证据不应该覆盖已有摘要。",
      neighbors: [{ neighborName: "自然法" }],
    });

    expect(summary).toBe("英国经验主义哲学家，提出自然权利和政府有限性。");
  });

  test("falls back to evidence first sentence or important neighbors", () => {
    expect(
      buildNodeSummary({
        node: { canonicalName: "自然法", entityType: "concept" },
        evidenceSnippet: "自然法被视为高于人定法的普遍原则。第二句不展示。",
      })
    ).toBe("自然法：自然法被视为高于人定法的普遍原则。");

    expect(
      buildNodeSummary({
        node: { canonicalName: "经验主义", entityType: "concept" },
        neighbors: [{ neighborName: "洛克" }, { neighborName: "休谟" }],
      })
    ).toBe("经验主义是当前知识图谱中的概念节点，重点关联 洛克、休谟。");
  });

  test("mainline path is short and capped at three nodes", () => {
    const path = buildMainlinePath({
      node: { canonicalName: "洛克" },
      neighbors: [
        { neighborName: "自然法", confidence: 0.9 },
        { neighborName: "权利", confidence: 0.8 },
        { neighborName: "政府", confidence: 0.7 },
      ],
    });

    expect(path).toBe("主线关联：洛克 → 自然法 → 权利");
  });

  test("display fields hide zero statistics and preserve recommendation identity fields", () => {
    const rec = candidate("node-1", 88, "continue", {
      recommendationId: "stable-id",
      type: "review_node",
      target: { targetType: "node", targetId: "1", nodeId: 1 },
    });
    const fields = buildRecommendationDisplayFields({
      recommendation: rec,
      node: {
        canonicalName: "洛克",
        entityType: "person",
        summary: "经验主义和自由主义传统中的关键人物。",
      },
      neighbors: [{ neighborName: "自然法", confidence: 0.9, weight: 1 }],
      evidenceCount: 0,
      relationCount: 2,
      supplementCount: 0,
    });

    expect(fields).toMatchObject({
      nodeSummary: "经验主义和自由主义传统中的关键人物。",
      mainlinePath: "主线关联：洛克 → 自然法",
      relationCount: 2,
      nodeTypeLabel: "人物",
    });
    expect(fields.evidenceCount).toBeUndefined();
    expect(fields.supplementCount).toBeUndefined();
    expect(rec.recommendationId).toBe("stable-id");
    expect(rec.score).toBe(88);
  });

  test("relation labels and titles preserve direction semantics", () => {
    expect(relationTypeLabel({ relationType: "influences" })).toBe("影响");
    expect(
      relationTypeLabel({
        relationType: "related_to",
        relationLabel: "belongs to school",
      })
    ).toBe("所属学派");
    expect(
      buildRelationTitle({
        relationType: "related_to",
        relationLabel: "proposes",
        sourceDisplayNameZh: "泰勒斯",
        targetDisplayNameZh: "水",
      })
    ).toBe("泰勒斯 → 水：提出");
    expect(
      buildRelationTitle({
        relationType: "contrasts_with",
        relationLabelZh: "变化与不变的对比",
        sourceDisplayNameZh: "赫拉克利特",
        targetDisplayNameZh: "巴门尼德",
      })
    ).toBe("赫拉克利特 ↔ 巴门尼德：变化与不变的对比");
    expect(
      buildRelationTitle({
        relationType: "introduces_concept",
        relationLabelZh: "本原观点",
        sourceDisplayNameZh: "泰勒斯",
        targetDisplayNameZh: "水",
      })
    ).toBe("泰勒斯 → 水：本原观点");
  });

  test("relation summary uses matching evidence and records source", () => {
    const edge = {
      relationType: "introduces_concept",
      relationLabelZh: "本原观点",
      sourceDisplayNameZh: "泰勒斯",
      targetDisplayNameZh: "水",
    };
    const result = buildRelationSummary({
      edge,
      evidenceSnippet:
        "第 12 页\n> 泰勒斯提出水是万物本原，这一观点开启了米利都学派的问题意识。后文不展示。",
    });

    expect(result.summarySource).toBe("edge_evidence");
    expect(result.relationSummary).toBe(
      "泰勒斯提出水是万物本原，这一观点开启了米利都学派的问题意识。"
    );
    expect(result.relationSummary.length).toBeLessThanOrEqual(110);
    expect(relationSnippetMatches(edge, result.relationSummary)).toBe(true);
  });

  test("relation summary rejects mismatched evidence and falls back deterministically", () => {
    const result = buildRelationSummary({
      edge: {
        relationType: "criticizes",
        relationLabelZh: "批判",
        sourceDisplayNameZh: "柏拉图",
        targetDisplayNameZh: "亚里士多德",
        sourceSummary: "理念论传统中的关键哲学家。",
        targetSummary: "发展实体和四因说的哲学家。",
      },
      evidenceSnippet: "笛卡儿提出我思故我在，与这条关系没有直接对应语义。",
    });

    expect(result.summarySource).toBe("edge_description");
    expect(result.relationSummary).toContain("柏拉图");
    expect(result.relationSummary).toContain("亚里士多德");
    expect(result.relationSummary).not.toContain("笛卡儿");
  });

  test("relation summary does not expose raw english extraction labels", () => {
    const result = buildRelationSummary({
      edge: {
        relationType: "related_to",
        relationLabel: "includes",
        sourceDisplayNameZh: "米利都学派",
        targetDisplayNameZh: "泰勒斯",
      },
    });

    expect(result.relationSummary).toContain("包含");
    expect(result.relationSummary).not.toContain("includes");
  });
});
