import { isAssistantTurn, TURN_STATUSES } from "./turns.js";

/**
 * A Responses API turn stays active across planning, tool, agent socket and
 * text-delta phases. Provider flags may change between those phases, but the
 * running assistant turn is the lifecycle authority until it becomes terminal.
 */
export function hasActiveResponseTurn(draft, items = []) {
  const activeTurn = items.find(
    (item) =>
      isAssistantTurn(item) &&
      !!draft?.activeTurnId &&
      item.turnId === draft.activeTurnId
  );

  return !!(
    draft?.isStreaming ||
    (draft?.activeTurnId && draft?.isAgentRunning) ||
    activeTurn?.status === TURN_STATUSES.running
  );
}

/**
 * Completed-message actions mutate or re-read persisted history, so they must
 * not be exposed for the transient streaming shell. response.completed ends
 * the turn and its chat identity makes the normal operation bar actionable.
 */
export function completedAssistantTurnReadyForActions(turn = {}) {
  return (
    isAssistantTurn(turn) &&
    turn.status === TURN_STATUSES.completed &&
    Number.isFinite(Number(turn.chatId)) &&
    Number(turn.chatId) > 0
  );
}
