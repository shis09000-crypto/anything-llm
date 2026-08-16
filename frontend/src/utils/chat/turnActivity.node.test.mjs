import assert from "node:assert/strict";
import test from "node:test";
import {
  completedAssistantTurnReadyForActions,
  hasActiveResponseTurn,
} from "./turnActivity.js";
import { TURN_STATUSES } from "./turns.js";

const assistantTurn = (status) => ({
  type: "assistant_turn",
  role: "assistant",
  turnId: "turn-1",
  status,
});

test("keeps a Responses turn active while agent phases pause text deltas", () => {
  assert.equal(
    hasActiveResponseTurn(
      {
        activeTurnId: "turn-1",
        isStreaming: false,
        isAgentRunning: true,
      },
      [assistantTurn(TURN_STATUSES.running)]
    ),
    true
  );
});

test("keeps a Responses turn active from its running lifecycle status", () => {
  assert.equal(
    hasActiveResponseTurn(
      {
        activeTurnId: "turn-1",
        isStreaming: false,
        isAgentRunning: false,
      },
      [assistantTurn(TURN_STATUSES.running)]
    ),
    true
  );
});

test("releases the composer while an agent session waits for new input", () => {
  assert.equal(
    hasActiveResponseTurn(
      {
        activeTurnId: null,
        isStreaming: false,
        isAgentRunning: true,
      },
      [assistantTurn(TURN_STATUSES.completed)]
    ),
    false
  );
});

test("releases the composer only after the turn is terminal", () => {
  assert.equal(
    hasActiveResponseTurn({ isStreaming: false, isAgentRunning: false }, [
      assistantTurn(TURN_STATUSES.completed),
    ]),
    false
  );
});

test("shows normal message actions only after completion carries a chat id", () => {
  assert.equal(
    completedAssistantTurnReadyForActions({
      ...assistantTurn(TURN_STATUSES.running),
      chatId: 42,
    }),
    false
  );
  assert.equal(
    completedAssistantTurnReadyForActions({
      ...assistantTurn(TURN_STATUSES.completed),
      chatId: null,
    }),
    false
  );
  assert.equal(
    completedAssistantTurnReadyForActions({
      ...assistantTurn(TURN_STATUSES.completed),
      chatId: 42,
    }),
    true
  );
});
