export function emptyDraftFor(question) {
  if (question?.kind === "choice") {
    return {
      skipped: false,
      selected: question.multiSelect ? [] : null,
      otherSelected: false,
      otherText: "",
    };
  }
  return { skipped: false, value: "" };
}

export function answerForDraft(question, draft) {
  if (!draft || draft.skipped) return { skipped: true, answer: null };

  if (question.kind === "input") {
    const trimmed = String(draft.value || "").trim();
    if (!trimmed) return { skipped: true, answer: null };
    return { skipped: false, answer: trimmed };
  }

  if (draft.otherSelected) {
    const trimmed = String(draft.otherText || "").trim();
    if (!trimmed) return { skipped: true, answer: null };
    if (question.multiSelect)
      return {
        skipped: false,
        answer: [...(draft.selected || []), trimmed],
      };
    return { skipped: false, answer: trimmed };
  }

  if (question.multiSelect) {
    const picks = draft.selected || [];
    if (picks.length === 0) return { skipped: true, answer: null };
    return { skipped: false, answer: picks };
  }

  if (!draft.selected) return { skipped: true, answer: null };
  return { skipped: false, answer: draft.selected };
}

export function formatAnswerDisplay(answer, skippedLabel) {
  if (!answer || answer.skipped) return skippedLabel;
  if (Array.isArray(answer.answer)) return answer.answer.join(", ");
  return String(answer.answer ?? "");
}
