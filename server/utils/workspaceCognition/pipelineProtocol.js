const ASSERTION_TYPES = new Set([
  "document_fact",
  "user_position",
  "conclusion",
  "decision",
  "hypothesis",
  "risk",
  "constraint",
  "open_question",
]);
const RELATION_TYPES = new Set([
  "confirms",
  "extends",
  "qualifies",
  "contradicts",
  "supersedes",
  "withdraws",
  "duplicates",
]);
const RETENTION_REASONS = new Set([
  "explicit_position",
  "confirmed_decision",
  "persistent_goal",
  "unresolved_question",
  "source_backed_fact",
  "relevant_inference",
]);
const SEGMENT_MAX_CHARS = 1_200;
const MAX_ROUGH_SEGMENTS = 32;
const MAX_REFINED_ITEMS = 18;

function createWorkspaceCognitionPipelineProtocol({
  responsePayload,
  cleanText,
  sha,
  json,
}) {
  function sourceCatalog(chats = []) {
    return chats.flatMap((chat) => {
      const response = responsePayload(chat);
      return (Array.isArray(response.sources) ? response.sources : []).map(
        (source, index) => {
          const metadata = source?.metadata || {};
          const documentId = source?.docId || metadata.docId || null;
          const chunkId =
            source?.chunkId ||
            source?.vectorId ||
            source?.id ||
            metadata.chunkId ||
            metadata.vectorId ||
            metadata.id ||
            null;
          const graphEdgeId =
            source?.graphEdgeId || metadata.graphEdgeId || null;
          return {
            ref: `chat:${chat.id}:source:${index}`,
            chatId: chat.id,
            sourceIndex: index,
            sourceType: graphEdgeId
              ? "knowledge_graph_edge"
              : documentId && chunkId
                ? "document_chunk"
                : "external_reference",
            documentId: documentId ? String(documentId) : null,
            chunkId: chunkId ? String(chunkId) : null,
            graphEdgeId: graphEdgeId ? String(graphEdgeId) : null,
            title:
              source?.title ||
              source?.documentName ||
              metadata.title ||
              metadata.documentName ||
              null,
            excerpt: cleanText(
              source?.text || metadata.text || source?.excerpt || "",
              2_000
            ),
            metadata,
          };
        }
      );
    });
  }

  function splitMechanicalSegments(value = "") {
    const text = String(value || "")
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .trim();
    if (!text) return [];
    const units = text.split(/(?<=\n)\s*\n+|(?<=[。！？.!?])\s+/u);
    const segments = [];
    for (const raw of units) {
      let remaining = raw.trim();
      while (remaining) {
        if (remaining.length <= SEGMENT_MAX_CHARS) {
          segments.push(remaining);
          break;
        }
        let cut = remaining.lastIndexOf("\n", SEGMENT_MAX_CHARS);
        if (cut < SEGMENT_MAX_CHARS * 0.5)
          cut = remaining.lastIndexOf(" ", SEGMENT_MAX_CHARS);
        if (cut < SEGMENT_MAX_CHARS * 0.5) cut = SEGMENT_MAX_CHARS;
        segments.push(remaining.slice(0, cut).trim());
        remaining = remaining.slice(cut).trim();
      }
    }
    return segments.filter(Boolean);
  }

  function dedupedSourceCatalog(chats = []) {
    const sources = sourceCatalog(chats);
    const seen = new Set();
    return sources.filter((source) => {
      const key =
        source.sourceType === "external_reference"
          ? source.ref
          : [
              source.sourceType,
              source.documentId || "",
              source.chunkId || "",
              source.graphEdgeId || "",
            ].join(":");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function segmentCatalog(chats = []) {
    const catalog = [];
    for (const chat of chats) {
      const response = responsePayload(chat);
      const speakers = [
        ["user", chat.user_id || null, chat.prompt],
        ["assistant", null, response.text],
      ];
      for (const [speaker, userId, text] of speakers) {
        splitMechanicalSegments(text).forEach((segment, index) => {
          const segmentId = `c${chat.id}${speaker === "user" ? "u" : "a"}${index}-${sha(segment).slice(0, 10)}`;
          catalog.push({
            segmentId,
            chatId: Number(chat.id),
            threadId: chat.thread_id ? Number(chat.thread_id) : null,
            speaker,
            userId,
            text: segment,
          });
        });
      }
    }
    return catalog;
  }

  function validateScreening(payload, segments) {
    if (!Array.isArray(payload?.keep))
      throw Object.assign(new Error("screening_schema_invalid"), {
        code: "screening_schema_invalid",
      });
    const byId = new Map(
      segments.map((segment) => [segment.segmentId, segment])
    );
    return [...new Set(payload.keep.map((id) => String(id || "")))]
      .slice(0, MAX_ROUGH_SEGMENTS)
      .map((segmentId) => {
        const segment = byId.get(segmentId);
        if (!segment) {
          const error = new Error("screening_reference_invalid");
          error.code = "screening_reference_invalid";
          throw error;
        }
        return segment;
      });
  }

  function userGatePrompt(segments, scope) {
    return [
      {
        role: "system",
        content:
          '你是工作区长期认知的用户信号初筛器。只输出一行严格 JSON：{"keep":["segment-id"],"assistantChatIds":[1]}。\n优先保留用户明确表达的观点、目标、判断、决定、约束、持续风险和仍未解决的问题。删除寒暄、确认词、格式修改、一次性操作、与工作区目标无关的系统使用问题和无长期价值内容。\nkeep 只能引用输入中的用户 segmentId；assistantChatIds 只能引用输入中的 chatId，且只在对应 AI 回答可能包含资料证据、与已保留用户信号直接相关的推论或风险时选择。不要因为用户提出普通一次性知识问答就保存整段 AI 回答。允许两个数组都为空。',
      },
      {
        role: "user",
        content: json({
          workspace: scope,
          userSegments: segments.map(({ segmentId, chatId, text }) => ({
            segmentId,
            chatId,
            text,
          })),
        }),
      },
    ];
  }

  function validateUserGate(payload, segments) {
    if (
      !Array.isArray(payload?.keep) ||
      !Array.isArray(payload?.assistantChatIds)
    )
      throw Object.assign(new Error("user_gate_schema_invalid"), {
        code: "user_gate_schema_invalid",
      });
    const kept = validateScreening({ keep: payload.keep }, segments);
    const chatIds = new Set(segments.map((segment) => Number(segment.chatId)));
    const assistantChatIds = [
      ...new Set(payload.assistantChatIds.map(Number).filter(Number.isInteger)),
    ];
    if (assistantChatIds.some((chatId) => !chatIds.has(chatId)))
      throw Object.assign(new Error("user_gate_chat_reference_invalid"), {
        code: "user_gate_chat_reference_invalid",
      });
    return { kept, assistantChatIds: kept.length ? assistantChatIds : [] };
  }

  function assistantEvidencePrompt({ userSegments, assistantSegments, scope }) {
    return [
      {
        role: "system",
        content:
          '你是工作区长期认知的 AI 证据初筛器。只输出一行严格 JSON：{"keep":["segment-id"]}。\nAI 内容不是用户观点，也不能仅因像知识而进入长期记忆。只保留与给定用户信号直接相关的资料事实线索、明确推论、风险或约束。删除软件使用说明、寒暄、泛化扩写、重复内容和与工作区目标无关的信息。只能引用 assistantSegments 中存在的 segmentId，允许空数组。',
      },
      {
        role: "user",
        content: json({
          workspace: scope,
          userSignals: userSegments.map(({ segmentId, chatId, text }) => ({
            segmentId,
            chatId,
            text,
          })),
          assistantSegments: assistantSegments.map(
            ({ segmentId, chatId, text }) => ({ segmentId, chatId, text })
          ),
        }),
      },
    ];
  }

  function refinePrompt({ episodes, sources, activeItems, pendingItems }) {
    return [
      {
        role: "system",
        content: `你是 Workspace Cognitive Refiner。复核三个粗筛结果，并保持每个 Episode 的用户、AI 与资料来源边界。只输出一行紧凑 JSON：
{"items":[{"assertionType":"类型","statement":"单一命题","origin":"user|assistant|document","confidence":0.0,"retentionReason":"保留原因","workspaceRelevance":0.0,"durability":0.0,"userCentrality":0.0,"evidenceSegmentIds":["id"],"sourceRefs":["ref"]}]}。
类型只能是 document_fact|user_position|conclusion|decision|hypothesis|risk|constraint|open_question；保留原因只能是 explicit_position|confirmed_decision|persistent_goal|unresolved_question|source_backed_fact|relevant_inference。最多 ${MAX_REFINED_ITEMS} 项，但只保留真正长期、相关且不重复的命题，通常应少于 8 项，允许空数组。没有值时不要输出 stance、suggestedRelation、possibleDuplicateCandidateId、rationale 或 conditions；不要复述证据，不要解释。
长期记忆优先代表用户，而不是复述 AI 回答。user_position、decision、conclusion、constraint、open_question 必须由用户原话明确支撑；用户提出问题不等于已经认可答案。AI 单方面陈述不得成为 conclusion；AI 只能形成与用户目标直接相关的 hypothesis 或 risk，并同时引用关联用户和 AI segment。document_fact 必须引用 document_chunk 或 knowledge_graph_edge。无来源的通用教材知识不要保存。一次性的权限排查、上传方法和工具教学是噪声；但用户明确用“记住、以后、必须、禁止”等方式规定当前工作区的资料处理、知识入库、认知或 Delegate 行为时，这是长期工作区治理 constraint/decision，视为与工作区直接相关。对照 activeItems 可建议正式关系；pendingItems 只用于 possibleDuplicateCandidateId，不能作为事实证据。不要使用 Conversation State Capsule。`,
      },
      {
        role: "user",
        content: json({
          episodes,
          sources: sources.map(
            ({
              ref,
              chatId,
              sourceType,
              documentId,
              chunkId,
              graphEdgeId,
              title,
              excerpt,
            }) => ({
              ref,
              chatId,
              sourceType,
              documentId,
              chunkId,
              graphEdgeId,
              title,
              excerpt: cleanText(excerpt, 300),
            })
          ),
          activeItems,
          pendingItems,
        }),
      },
    ];
  }

  function validateRefinement(
    payload,
    { segments = [], turns = [], sources, activeItems, pendingItems = [] }
  ) {
    if (!Array.isArray(payload?.items))
      throw Object.assign(new Error("refinement_schema_invalid"), {
        code: "refinement_schema_invalid",
      });
    const segmentMap = new Map(
      segments.map((segment) => [segment.segmentId, segment])
    );
    const turnMap = new Map(
      turns.map((turn) => [`${turn.chatId}:${turn.speaker}`, turn])
    );
    const sourceMap = new Map(sources.map((source) => [source.ref, source]));
    const itemIds = new Set(activeItems.map((item) => Number(item.id)));
    const pendingIds = new Set(pendingItems.map((item) => Number(item.id)));
    return payload.items
      .slice(0, MAX_REFINED_ITEMS)
      .map((item) => {
        const assertionType = String(item?.assertionType || "");
        const statement = cleanText(item?.statement, 8_000);
        const origin = item?.origin;
        if (!ASSERTION_TYPES.has(assertionType) || !statement)
          throw Object.assign(new Error("candidate_schema_invalid"), {
            code: "candidate_schema_invalid",
          });
        const evidenceRefs = Array.isArray(item.evidenceSegmentIds)
          ? item.evidenceSegmentIds.map((id) => {
              const segment = segmentMap.get(String(id));
              if (!segment)
                throw Object.assign(new Error("candidate_evidence_invalid"), {
                  code: "candidate_evidence_invalid",
                });
              return {
                segmentId: segment.stableSegmentId || segment.segmentId,
                chatId: segment.chatId,
                threadId: segment.threadId,
                speaker: segment.speaker,
                excerpt: segment.text,
                userId: segment.userId || null,
              };
            })
          : Array.isArray(item.evidenceRefs)
            ? item.evidenceRefs.map((ref) => {
                const chatId = Number(ref?.chatId);
                const speaker = ref?.speaker;
                const excerpt = cleanText(ref?.excerpt, 4_000);
                const turn = turnMap.get(`${chatId}:${speaker}`);
                if (!turn || !excerpt || !turn.text.includes(excerpt))
                  throw Object.assign(new Error("candidate_evidence_invalid"), {
                    code: "candidate_evidence_invalid",
                  });
                return {
                  chatId,
                  speaker,
                  excerpt,
                  userId: turn.userId || null,
                };
              })
            : [];
        if (!evidenceRefs.length)
          throw Object.assign(new Error("candidate_evidence_required"), {
            code: "candidate_evidence_required",
          });
        const userEvidence = evidenceRefs.filter(
          (ref) => ref.speaker === "user"
        );
        const assistantEvidence = evidenceRefs.filter(
          (ref) => ref.speaker === "assistant"
        );
        if (assertionType === "user_position") {
          const owners = new Set(
            userEvidence
              .filter((ref) => ref.userId)
              .map((ref) => Number(ref.userId))
          );
          if (origin !== "user" || !userEvidence.length || owners.size !== 1)
            return null;
        } else if (origin === "user" && !userEvidence.length) {
          return null;
        }
        if (origin === "assistant" && !assistantEvidence.length) return null;
        const sourceRefs = Array.isArray(item.sourceRefs)
          ? item.sourceRefs.filter((ref) => sourceMap.has(ref))
          : [];
        if (
          assertionType === "document_fact" &&
          !sourceRefs.some((ref) =>
            ["document_chunk", "knowledge_graph_edge"].includes(
              sourceMap.get(ref)?.sourceType
            )
          )
        )
          return null;
        if (
          [
            "user_position",
            "decision",
            "conclusion",
            "constraint",
            "open_question",
          ].includes(assertionType) &&
          !userEvidence.length
        )
          return null;
        if (
          origin === "assistant" &&
          (!new Set(["hypothesis", "risk"]).has(assertionType) ||
            !userEvidence.length ||
            !assistantEvidence.length)
        )
          return null;
        const retentionReason = String(item?.retentionReason || "");
        const workspaceRelevance = Number(item?.workspaceRelevance);
        const durability = Number(item?.durability);
        const userCentrality = Number(item?.userCentrality);
        if (
          !RETENTION_REASONS.has(retentionReason) ||
          !Number.isFinite(workspaceRelevance) ||
          !Number.isFinite(durability) ||
          !Number.isFinite(userCentrality) ||
          workspaceRelevance < 0.75 ||
          durability < 0.7 ||
          (assertionType !== "document_fact" && userCentrality < 0.6)
        )
          return null;
        const proposed = item?.suggestedRelation || {};
        const relationType = RELATION_TYPES.has(proposed.relationType)
          ? proposed.relationType
          : null;
        const targetItemId = Number(proposed.targetItemId) || null;
        return {
          assertionType,
          statement,
          origin:
            assertionType === "document_fact"
              ? "document"
              : origin === "user"
                ? "user"
                : "assistant",
          subjectUserId:
            origin === "user"
              ? evidenceRefs.find((ref) => ref.speaker === "user")?.userId ||
                null
              : null,
          stance: item?.stance || null,
          rationale: cleanText(item?.rationale, 4_000) || null,
          conditions:
            item?.conditions && typeof item.conditions === "object"
              ? item.conditions
              : {},
          confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0)),
          evidenceRefs,
          sourceRefs,
          suggestedRelation: {
            relationType:
              relationType && itemIds.has(targetItemId) ? relationType : null,
            targetItemId:
              relationType && itemIds.has(targetItemId) ? targetItemId : null,
            rationale: cleanText(proposed.rationale, 2_000) || null,
          },
          quality: {
            retentionReason,
            workspaceRelevance: Math.min(1, workspaceRelevance),
            durability: Math.min(1, durability),
            userCentrality: Math.min(1, userCentrality),
            possibleDuplicateCandidateId: pendingIds.has(
              Number(item?.possibleDuplicateCandidateId)
            )
              ? Number(item.possibleDuplicateCandidateId)
              : null,
          },
          raw: item,
        };
      })
      .filter(Boolean);
  }

  return {
    ASSERTION_TYPES,
    MAX_ROUGH_SEGMENTS,
    RELATION_TYPES,
    assistantEvidencePrompt,
    dedupedSourceCatalog,
    refinePrompt,
    segmentCatalog,
    sourceCatalog,
    userGatePrompt,
    validateRefinement,
    validateScreening,
    validateUserGate,
  };
}

module.exports = { createWorkspaceCognitionPipelineProtocol };
