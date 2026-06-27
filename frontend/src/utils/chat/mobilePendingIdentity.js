export const MOBILE_PENDING_EARLY_TOLERANCE_SEC = 5;
export const MOBILE_PENDING_LATE_TOLERANCE_SEC = 120;

function normalizedText(value = "") {
  return String(value || "").trim();
}

function normalizedClientTurnId(value = null) {
  const turnId = String(value || "").trim();
  return turnId || null;
}

function messageClientTurnId(message = {}) {
  return normalizedClientTurnId(
    message.clientTurnId ||
      message.draftTurnId ||
      message.turnId ||
      message.metadata?.clientTurnId ||
      null
  );
}

function messageHasAttachments(message = {}) {
  return Array.isArray(message.attachments) && message.attachments.length > 0;
}

export function messageWithinSubmittedWindow(message = {}, submittedAt = null) {
  const submitted = Number(submittedAt || 0);
  const sentAt = Number(message.sentAt || 0);
  if (!submitted) return true;
  if (!sentAt) return false;
  return (
    sentAt >= submitted - MOBILE_PENDING_EARLY_TOLERANCE_SEC &&
    sentAt <= submitted + MOBILE_PENDING_LATE_TOLERANCE_SEC
  );
}

export function submittedMessageIndex(
  messages = [],
  submittedText = "",
  submittedAt = null,
  options = {}
) {
  const expected = normalizedText(submittedText);
  const expectedClientTurnId = normalizedClientTurnId(options.clientTurnId);
  const hasSubmittedAttachments = !!options.hasAttachments;
  if (!expected) return -1;

  const candidates = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => {
      if (message.role !== "user") return false;
      if (expectedClientTurnId) {
        const candidateClientTurnId = messageClientTurnId(message);
        if (candidateClientTurnId) {
          return candidateClientTurnId === expectedClientTurnId;
        }
      }
      if (normalizedText(message.text) !== expected) return false;
      return messageWithinSubmittedWindow(message, submittedAt);
    })
    .sort((first, second) => {
      const submitted = Number(submittedAt || 0);
      if (submitted) {
        const firstDistance = Math.abs(
          Number(first.message.sentAt || submitted) - submitted
        );
        const secondDistance = Math.abs(
          Number(second.message.sentAt || submitted) - submitted
        );
        if (firstDistance !== secondDistance)
          return firstDistance - secondDistance;
      }
      return second.index - first.index;
    });

  if (candidates.length > 0) return candidates[0].index;

  if (!hasSubmittedAttachments) return -1;

  const attachmentWindowCandidates = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => {
      if (message.role !== "user") return false;
      if (!messageWithinSubmittedWindow(message, submittedAt)) return false;
      return messageHasAttachments(message) || normalizedText(message.text);
    })
    .sort((first, second) => {
      const submitted = Number(submittedAt || 0);
      if (submitted) {
        const firstDistance = Math.abs(
          Number(first.message.sentAt || submitted) - submitted
        );
        const secondDistance = Math.abs(
          Number(second.message.sentAt || submitted) - submitted
        );
        if (firstDistance !== secondDistance)
          return firstDistance - secondDistance;
      }
      return second.index - first.index;
    });

  return attachmentWindowCandidates[0]?.index ?? -1;
}

export function historyIncludesSubmittedMessage(
  messages = [],
  submittedText = "",
  submittedAt = null,
  options = {}
) {
  return (
    submittedMessageIndex(messages, submittedText, submittedAt, options) >= 0
  );
}

export function hasAssistantAfterSubmitted(
  messages = [],
  submittedText = "",
  submittedAt = null,
  isConfirmedAssistant = () => true,
  options = {}
) {
  const submittedIndex = submittedMessageIndex(
    messages,
    submittedText,
    submittedAt,
    options
  );

  if (submittedIndex < 0) return false;
  return messages.slice(submittedIndex + 1).some((message) => {
    if (message.role !== "assistant") return false;
    return isConfirmedAssistant(message);
  });
}
