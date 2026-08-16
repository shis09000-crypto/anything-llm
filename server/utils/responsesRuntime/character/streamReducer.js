const {
  RESPONSE_EVENT_TYPES,
  TERMINAL_ITEM_STATUSES,
  TERMINAL_RESPONSE_STATUSES,
} = require("./contract");

function reducerError(code, message, details = {}) {
  const error = new Error(message || code);
  error.code = code;
  error.details = details;
  return error;
}

function createCharacterStreamState(responseId = null) {
  return {
    response_id: responseId,
    status: null,
    response: null,
    items: [],
    last_sequence_number: -1,
    seen_event_ids: new Set(),
    event_sequences: new Map(),
    errors: [],
  };
}

function cloneState(state) {
  return {
    ...state,
    items: state.items.map((item) => (item ? { ...item } : item)),
    seen_event_ids: new Set(state.seen_event_ids),
    event_sequences: new Map(state.event_sequences),
    errors: [...state.errors],
  };
}

function assertEventEnvelope(state, event) {
  if (!event || typeof event !== "object" || Array.isArray(event))
    throw reducerError("character_event_invalid", "Event must be an object.");
  if (!RESPONSE_EVENT_TYPES.includes(event.type))
    throw reducerError(
      "character_event_type_invalid",
      `Unsupported Character event: ${String(event.type)}.`
    );
  if (!Number.isInteger(event.sequence_number) || event.sequence_number < 0)
    throw reducerError(
      "character_event_sequence_invalid",
      "sequence_number must be a non-negative integer."
    );
  if (!event.event_id)
    throw reducerError("character_event_id_required", "event_id is required.");
  if (
    state.response_id &&
    event.response_id &&
    state.response_id !== event.response_id
  )
    throw reducerError(
      "character_event_response_mismatch",
      "Event response_id does not match the reducer state."
    );
}

function applyDelta(item, delta) {
  if (!delta || typeof delta !== "object")
    throw reducerError("character_item_delta_invalid", "delta is required.");
  if (delta.kind === "speech_text_append") {
    if (item.type !== "speech")
      throw reducerError(
        "character_item_delta_type_mismatch",
        "speech_text_append can only target speech items."
      );
    return { ...item, text: `${item.text || ""}${delta.text || ""}` };
  }
  if (delta.kind === "performance_intent_patch") {
    if (item.type !== "performance_intent")
      throw reducerError(
        "character_item_delta_type_mismatch",
        "performance_intent_patch can only target performance_intent."
      );
    return {
      ...item,
      ...(delta.affect ? { affect: delta.affect } : {}),
      ...(delta.channel_modulation
        ? { channel_modulation: delta.channel_modulation }
        : {}),
      ...(delta.transition ? { transition: delta.transition } : {}),
    };
  }
  if (delta.kind === "speech_delivery_patch") {
    if (item.type !== "speech")
      throw reducerError(
        "character_item_delta_type_mismatch",
        "speech_delivery_patch can only target speech items."
      );
    return { ...item, delivery: delta.delivery };
  }
  if (delta.kind?.endsWith("_patch") && delta.item) {
    if (delta.item.id !== item.id || delta.item.type !== item.type)
      throw reducerError(
        "character_item_delta_identity_changed",
        "A patch cannot change item id or type."
      );
    return { ...delta.item };
  }
  throw reducerError(
    "character_item_delta_kind_invalid",
    `Unsupported delta kind: ${String(delta.kind)}.`
  );
}

function assertItemIndex(state, event) {
  if (!Number.isInteger(event.output_index) || event.output_index < 0)
    throw reducerError(
      "character_output_index_invalid",
      "output_index must be a non-negative integer."
    );
  const item = state.items[event.output_index];
  if (!item)
    throw reducerError(
      "character_item_not_found",
      `No item exists at output_index ${event.output_index}.`
    );
  if (item.id !== event.item_id)
    throw reducerError(
      "character_item_identity_mismatch",
      "item_id does not match output_index."
    );
  return item;
}

function assertAllItemsTerminal(state) {
  const active = state.items.filter(
    (item) => item && !TERMINAL_ITEM_STATUSES.has(item.status)
  );
  if (active.length)
    throw reducerError(
      "character_response_terminal_with_active_items",
      "Response cannot terminate while output items are active.",
      { itemIds: active.map((item) => item.id) }
    );
}

function applyCharacterStreamEvent(inputState, event) {
  const state = cloneState(inputState || createCharacterStreamState());
  assertEventEnvelope(state, event);

  if (state.seen_event_ids.has(event.event_id)) {
    const previousSequence = state.event_sequences.get(event.event_id);
    if (previousSequence !== event.sequence_number)
      throw reducerError(
        "character_event_replay_conflict",
        "Replayed event_id changed sequence_number."
      );
    return state;
  }

  const expected = state.last_sequence_number + 1;
  if (event.sequence_number !== expected)
    throw reducerError(
      "character_event_sequence_gap",
      `Expected sequence_number ${expected}, received ${event.sequence_number}.`
    );

  state.seen_event_ids.add(event.event_id);
  state.event_sequences.set(event.event_id, event.sequence_number);
  state.last_sequence_number = event.sequence_number;
  state.response_id ||= event.response_id || event.response?.id || null;

  if (event.type === "character.stream.ping") return state;
  if (event.type === "character.error") {
    state.errors.push(event.error);
    return state;
  }
  if (
    event.type === "character.response.created" ||
    event.type === "character.response.in_progress"
  ) {
    if (state.response && event.type === "character.response.created")
      throw reducerError(
        "character_response_created_twice",
        "response.created may only occur once."
      );
    state.response = event.response;
    state.status =
      event.response?.status ||
      (event.type.endsWith("in_progress") ? "in_progress" : "queued");
    return state;
  }
  if (event.type === "character.response.output_item.added") {
    if (state.items[event.output_index])
      throw reducerError(
        "character_output_index_reused",
        `output_index ${event.output_index} is already occupied.`
      );
    if (event.item?.id !== event.item_id)
      throw reducerError(
        "character_item_identity_mismatch",
        "Added item id must match item_id."
      );
    if (state.items.some((item) => item?.id === event.item_id))
      throw reducerError(
        "character_item_id_reused",
        `item_id ${event.item_id} is already present.`
      );
    state.items[event.output_index] = {
      ...event.item,
      _revision: event.revision,
    };
    return state;
  }
  if (event.type === "character.response.output_item.delta") {
    const item = assertItemIndex(state, event);
    if (TERMINAL_ITEM_STATUSES.has(item.status))
      throw reducerError(
        "character_item_delta_after_terminal",
        "Terminal items cannot receive deltas."
      );
    if (event.revision <= (item._revision ?? -1))
      throw reducerError(
        "character_item_revision_not_monotonic",
        "Item revision must increase."
      );
    state.items[event.output_index] = {
      ...applyDelta(item, event.delta),
      _revision: event.revision,
    };
    return state;
  }
  if (
    event.type === "character.response.output_item.updated" ||
    event.type === "character.response.output_item.done"
  ) {
    const item = assertItemIndex(state, event);
    if (TERMINAL_ITEM_STATUSES.has(item.status))
      throw reducerError(
        "character_item_updated_after_terminal",
        "Terminal items cannot be updated."
      );
    if (
      event.item?.id !== item.id ||
      event.item?.type !== item.type ||
      event.revision <= (item._revision ?? -1)
    )
      throw reducerError(
        "character_item_update_invalid",
        "Item update must preserve identity and increase revision."
      );
    state.items[event.output_index] = {
      ...event.item,
      ...(event.type.endsWith(".done") ? { status: "completed" } : {}),
      _revision: event.revision,
    };
    return state;
  }
  if (
    event.type === "character.response.output_item.failed" ||
    event.type === "character.response.output_item.cancelled"
  ) {
    const item = assertItemIndex(state, event);
    if (TERMINAL_ITEM_STATUSES.has(item.status))
      throw reducerError(
        "character_item_terminal_twice",
        "Item already reached a terminal state."
      );
    state.items[event.output_index] = {
      ...item,
      status: event.type.endsWith(".failed") ? "failed" : "cancelled",
      error: event.error,
      _revision: event.revision,
    };
    return state;
  }
  if (
    [
      "character.response.completed",
      "character.response.incomplete",
      "character.response.failed",
      "character.response.cancelled",
    ].includes(event.type)
  ) {
    assertAllItemsTerminal(state);
    if (TERMINAL_RESPONSE_STATUSES.has(state.status))
      throw reducerError(
        "character_response_terminal_twice",
        "Response already reached a terminal state."
      );
    state.response = event.response;
    state.status = event.response?.status || event.type.split(".").at(-1);
    return state;
  }

  return state;
}

function projectCharacterResponse(state) {
  if (!state?.response) return null;
  return {
    ...state.response,
    status: state.status || state.response.status,
    output: state.items
      .filter(Boolean)
      .map(({ _revision: _internalRevision, ...item }) => item),
  };
}

module.exports = {
  applyCharacterStreamEvent,
  createCharacterStreamState,
  projectCharacterResponse,
  reducerError,
};
