const { CharacterConversationRuntime } =
  require("../../utils/responsesRuntime/character").conversation;
const { PROFILE, compileCharacterV2Response, validateCharacterV2Response } =
  require("../../utils/responsesRuntime/character").v2;
const { plannerPayload } = require("./characterV2Fixtures");
const {
  initialPersistentState,
} = require("../../utils/responsesRuntime/character/conversation/persistentState");

function transition(revision, state = "conversation_idle") {
  return {
    from_revision: revision,
    affect: {
      primary: "athena.core:emotion/neutral",
      secondary: null,
      intensity: 0.2,
      valence: 0,
      arousal: 0.2,
    },
    attention: { target: "player", intensity: 0.5 },
    gaze: { target: "player", style: "soft" },
    posture: "conversation_relaxed",
    activity: { current: "conversation", previous: "reading" },
    performance_state: state,
    decay: { mode: "gradual", target: "reading", duration_ms: 8000 },
  };
}

function controlPayload(call) {
  const question = call === 0;
  const persistent = initialPersistentState(transition(call));
  persistent.revision = call;
  return {
    ...plannerPayload({
      speech: question ? "八点了。你要去干嘛？" : "……路上小心，早点回来。",
    }),
    character_state_transition: transition(call),
    persistent_state_transition: {
      from_revision: call,
      style: "blend",
      duration_ms: 400,
      next_state: persistent,
    },
    conversation_horizon: question
      ? {
          depth: "normal",
          continuation_probability: 0.9,
          closure_readiness: 0.1,
          soft_close_wait_ms: null,
          basis: "question_pending",
        }
      : {
          depth: "brief",
          continuation_probability: 0.15,
          closure_readiness: 0.9,
          soft_close_wait_ms: "invalid",
          basis: "answer_complete",
        },
    handoff: {
      target: "user",
      mode: question ? "question" : "close_ready",
    },
    end_intent: { detected: false, confidence: 0, kind: "none" },
  };
}

class MemoryConversationRepository {
  constructor(now) {
    this.now = now;
    this.conversations = new Map();
    this.states = new Map();
    this.turns = new Map();
    this.eventsByConversation = new Map();
  }

  async createConversation(data, state) {
    const row = {
      ...data,
      conversationType: "character",
      stateRevision: 0,
      currentTurnId: null,
      currentHeadResponseId: null,
      softCloseDueAt: null,
      suspendedAt: null,
      endedAt: null,
      deletedAt: null,
      createdAt: new Date(this.now()),
      lastUpdatedAt: new Date(this.now()),
    };
    this.conversations.set(row.id, row);
    this.states.set(row.id, structuredClone(state));
    return row;
  }

  findConversation(id) {
    return Promise.resolve(this.conversations.get(id) || null);
  }

  readSessionState(row) {
    return Promise.resolve(structuredClone(this.states.get(row.id)));
  }

  async claimTurn(row, turnId) {
    if (row.currentTurnId) return false;
    row.status = row.status === "soft_closed" ? "resuming" : "active";
    row.currentTurnId = turnId;
    row.softCloseDueAt = null;
    return true;
  }

  findTurnByIdempotencyKey(key) {
    return Promise.resolve(
      [...this.turns.values()].find((turn) => turn.idempotencyKey === key) ||
        null
    );
  }

  async nextOrdinal(conversationId) {
    return (
      [...this.turns.values()].filter(
        (turn) => turn.conversationId === conversationId
      ).length + 1
    );
  }

  async createTurn(data, input) {
    const row = {
      ...data,
      input: structuredClone(input),
      control: null,
      responseId: null,
      createdAt: new Date(this.now()),
      completedAt: null,
    };
    this.turns.set(row.id, row);
    return row;
  }

  async completeTurn(id, data, control) {
    const row = this.turns.get(id);
    Object.assign(row, data, {
      control: structuredClone(control),
      completedAt: new Date(this.now()),
    });
    return row;
  }

  async failTurn(id, reason) {
    Object.assign(this.turns.get(id), { status: "failed", endReason: reason });
  }

  hydrateTurn(row) {
    return Promise.resolve(structuredClone(row));
  }

  async recentTurns(conversationId) {
    return [...this.turns.values()]
      .filter(
        (turn) =>
          turn.conversationId === conversationId && turn.status === "completed"
      )
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((turn) => structuredClone(turn));
  }

  async updateSessionState(row, state, options) {
    if (row.stateRevision !== state.character_state.revision - 1) return false;
    this.states.set(row.id, structuredClone(state));
    Object.assign(row, {
      stateRevision: state.character_state.revision,
      status: options.status,
      currentTurnId: options.currentTurnId,
      softCloseDueAt: options.softCloseDueAt,
      ...(options.endedAt ? { endedAt: options.endedAt } : {}),
      lastUpdatedAt: new Date(this.now()),
    });
    return true;
  }

  async updateConversation(id, data) {
    const row = this.conversations.get(id);
    Object.assign(row, data, { lastUpdatedAt: new Date(this.now()) });
    return row;
  }

  async appendEvent({
    conversationId,
    eventType,
    turnId,
    responseId,
    payload,
  }) {
    const events = this.eventsByConversation.get(conversationId) || [];
    const event = {
      type: eventType,
      event_id: `event_${events.length}`,
      sequence_number: events.length,
      created_at: this.now(),
      conversation_id: conversationId,
      ...(turnId ? { turn_id: turnId } : {}),
      ...(responseId ? { response_id: responseId } : {}),
      ...payload,
    };
    events.push(event);
    this.eventsByConversation.set(conversationId, events);
    return event;
  }

  listEvents(conversationId, after) {
    return Promise.resolve(
      (this.eventsByConversation.get(conversationId) || []).filter(
        (event) => event.sequence_number > after
      )
    );
  }

  dueSoftCloses(now) {
    return Promise.resolve(
      [...this.conversations.values()].filter(
        (row) => row.status === "close_ready" && row.softCloseDueAt <= now
      )
    );
  }
}

class MemoryResponsesRepository {
  constructor() {
    this.responses = new Map();
    this.checkpoints = new Map();
    this.items = [];
    this.events = [];
  }
  async createResponse(row) {
    this.responses.set(row.id, row);
    return row;
  }
  async appendItem(item) {
    this.items.push(item);
  }
  async appendEvent(event) {
    this.events.push(event);
  }
  async writeCheckpoint(responseId, state) {
    this.checkpoints.set(responseId, structuredClone(state));
  }
  async readCheckpoint(responseId) {
    const state = this.checkpoints.get(responseId);
    return state ? { state: structuredClone(state) } : null;
  }
}

describe("Athena Character Conversation runtime", () => {
  test("chains two turns, asks a question, then enters recoverable close-ready", async () => {
    let clock = 1_786_500_000_000;
    const repository = new MemoryConversationRepository(() => clock);
    const responsesRepository = new MemoryResponsesRepository();
    let call = 0;
    const adapter = {
      generate: jest.fn(async (request, options) => {
        const payload = controlPayload(call++);
        const response = compileCharacterV2Response(
          request,
          payload,
          {
            usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
            effectiveProtocol: "responses",
          },
          clock,
          clock + 100
        );
        return {
          payload,
          response,
          responseValidation: validateCharacterV2Response(response),
          model: "deepseek-v4-flash",
          effectiveProtocol: "responses",
          context: options.conversationContext,
        };
      }),
    };
    const client = {
      responses_conversations: {
        updateMany: jest.fn(async ({ where, data }) => {
          const row = repository.conversations.get(where.id);
          if (!row || row.status !== where.status) return { count: 0 };
          if (
            where.softCloseDueAt &&
            row.softCloseDueAt?.getTime() !== where.softCloseDueAt.getTime()
          )
            return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
    };
    const runtime = new CharacterConversationRuntime({
      client,
      repository,
      responsesRepository,
      adapter,
      profile: PROFILE,
      now: () => clock,
    });
    const athena = { workspaceId: 1, threadId: 2, userId: 3 };
    const conversation = await runtime.create({
      protocol_version: "2.0",
      character: {
        character_id: PROFILE.characterId,
        instance_id: "char_inst_continuous_test",
        capability_manifest: PROFILE.manifestRef,
      },
      generation: {
        mode: "main_agent",
        channels: ["performance", "face", "gaze", "body", "action", "speech"],
        latency_class: "interactive",
        performance_profile: PROFILE.id,
      },
      previous_activity: "reading",
      athena,
    });
    const first = await runtime.turn(conversation.id, {
      input: [
        {
          id: "chr_input_time",
          type: "user_message",
          content: [{ type: "input_text", text: "现在几点了？" }],
        },
      ],
      idempotency_key: "turn-1",
      athena,
    });
    expect(first.conversation.status).toBe("awaiting_user");
    expect(first.effective_handoff.mode).toBe("question");
    expect(first.character_state.revision).toBe(1);
    expect(first.context.generation_contract).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      response_format: { type: "json_object" },
      raw_output_type: "json_object",
      selection_retries: 0,
    });

    clock += 2_000;
    const second = await runtime.turn(conversation.id, {
      input: [
        {
          id: "chr_input_school",
          type: "user_message",
          content: [{ type: "input_text", text: "上学去。" }],
        },
      ],
      idempotency_key: "turn-2",
      athena,
    });
    expect(second.conversation.status).toBe("close_ready");
    expect(second.effective_handoff.mode).toBe("close_ready");
    expect(second.soft_close_timing).toEqual({
      model_wait_ms: "invalid",
      effective_wait_ms: 8000,
      source: "depth_default",
      depth: "brief",
    });
    expect(second.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "soft_close_wait_defaulted" }),
      ])
    );
    expect(second.character_state.revision).toBe(2);
    expect(
      responsesRepository.responses.get(second.response.id).previousResponseId
    ).toBe(first.response.id);
    expect(adapter.generate.mock.calls[1][1].conversationContext).toMatchObject(
      {
        dialogue_memory: {
          turns: [
            expect.objectContaining({
              ordinal: 1,
              character_speech: "八点了。你要去干嘛？",
            }),
          ],
        },
        performance_state_memory: {
          character_state: { revision: 1 },
        },
      }
    );
    const events = await runtime.events(conversation.id, -1, athena);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "character.turn.handoff",
        "character.conversation.awaiting_user",
        "character.conversation.close_ready",
      ])
    );

    clock += 8_001;
    const maintenance = await runtime.maintain();
    expect(maintenance).toMatchObject({ inspected: 1, softClosed: 1 });
    const softClosed = await runtime.retrieve(conversation.id, athena);
    expect(softClosed.status).toBe("soft_closed");
    expect(softClosed.character_state).toMatchObject({
      revision: 3,
      performance_state: "ambient",
      activity: { current: "reading", previous: "conversation" },
    });
    const finalEvents = await runtime.events(conversation.id, -1, athena);
    expect(finalEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "character.conversation.soft_closing",
        "character.conversation.soft_closed",
        "character.activity.ambient.requested",
      ])
    );
  });
});
