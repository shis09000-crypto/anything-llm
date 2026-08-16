const { PHASE_ORDER, TRACK_ORDER } = require("./constants");

function emptyState() {
  return {
    response: null,
    intent: null,
    sequence: null,
    phases: new Map(),
    tracks: new Map(),
    resolution: null,
    executions: new Map(),
    lastSequenceNumber: -1,
    terminal: false,
  };
}

function reducerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function applyCharacterV2Event(state = emptyState(), event) {
  if (!event || !Number.isInteger(event.sequence_number))
    throw reducerError("character_v2_event_sequence_required");
  if (event.sequence_number <= state.lastSequenceNumber) return state;
  if (state.terminal) throw reducerError("character_v2_event_after_terminal");
  const next = {
    ...state,
    phases: new Map(state.phases),
    tracks: new Map(state.tracks),
    executions: new Map(state.executions),
    lastSequenceNumber: event.sequence_number,
  };
  switch (event.type) {
    case "character.response.created":
    case "character.response.in_progress":
      next.response = event.response;
      break;
    case "character.response.output_item.added":
    case "character.response.output_item.done":
      if (event.item?.type === "performance_intent") next.intent = event.item;
      if (event.item?.type === "performance_sequence")
        next.sequence = event.item;
      break;
    case "character.performance.sequence.phase.added":
    case "character.performance.sequence.phase.done":
      next.phases.set(event.phase.id, event.phase);
      break;
    case "character.performance.sequence.track.added":
      next.tracks.set(event.track.name, event.track);
      break;
    case "character.performance.sequence.cue.added":
    case "character.performance.sequence.cue.updated":
    case "character.performance.sequence.cue.done": {
      const track = next.tracks.get(event.track) || {
        name: event.track,
        enabled: true,
        cues: [],
      };
      const cues = [...track.cues];
      const index = cues.findIndex((cue) => cue.cue_id === event.cue.cue_id);
      if (index >= 0) cues[index] = event.cue;
      else cues.push(event.cue);
      next.tracks.set(event.track, { ...track, cues });
      break;
    }
    case "character.performance.sequence.speech_text.append": {
      const track = next.tracks.get("speech");
      if (!track) throw reducerError("character_v2_speech_track_missing");
      const cues = track.cues.map((cue) =>
        cue.cue_id === event.cue_id
          ? { ...cue, text: `${cue.text || ""}${event.text || ""}` }
          : cue
      );
      next.tracks.set("speech", { ...track, cues });
      break;
    }
    case "character.performance.sequence.resolved":
      next.resolution = event;
      break;
    case "character.execution.started":
    case "character.execution.completed":
    case "character.execution.failed":
    case "character.execution.cancelled":
      next.executions.set(event.cue_id, event);
      break;
    case "character.response.completed":
    case "character.response.incomplete":
    case "character.response.failed":
    case "character.response.cancelled":
      next.response = event.response;
      next.terminal = true;
      break;
    case "character.stream.ping":
      break;
    default:
      throw reducerError("character_v2_event_type_unsupported");
  }
  return next;
}

function normalizedSequence(state) {
  if (!state.sequence) return null;
  return {
    ...state.sequence,
    phases: PHASE_ORDER.map((id) => state.phases.get(id)).filter(Boolean),
    tracks: TRACK_ORDER.map((name) => state.tracks.get(name)).filter(Boolean),
  };
}

module.exports = {
  applyCharacterV2Event,
  emptyCharacterV2State: emptyState,
  normalizedCharacterV2Sequence: normalizedSequence,
};
