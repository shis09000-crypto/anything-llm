const crypto = require("crypto");
const { FlashCharacterV2Adapter } = require("./flashAdapter");
const { PROFILE } = require("./profile");
const { resolvePerformanceSequence } = require("./manifestResolver");
const { MockPerformanceClient } = require("./mockPerformanceClient");
const { compileCharacterPresentation } = require("./presentationCompiler");
const { PROTOCOL_VERSION } = require("./constants");

function runtimeError(code, status = 500) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = status;
  return error;
}

function eventId() {
  return `chr_evt_${crypto.randomUUID().replace(/-/g, "")}`;
}

function buildEvents(response, resolution, execution) {
  const events = [];
  let sequenceNumber = 0;
  const emit = (type, payload = {}) =>
    events.push({
      type,
      event_id: eventId(),
      sequence_number: sequenceNumber++,
      created_at: Date.now(),
      response_id: response.id,
      ...payload,
    });
  const inProgress = { ...response, status: "in_progress", completed_at: null };
  emit("character.response.created", { response: inProgress });
  emit("character.response.in_progress", { response: inProgress });
  emit("character.response.output_item.added", {
    output_index: 0,
    item_id: response.output[0].id,
    revision: response.output[0].revision,
    item: response.output[0],
  });
  emit("character.response.output_item.done", {
    output_index: 0,
    item_id: response.output[0].id,
    revision: response.output[0].revision,
    item: response.output[0],
  });
  const performanceSequence = response.output[1];
  emit("character.response.output_item.added", {
    output_index: 1,
    item_id: performanceSequence.id,
    revision: performanceSequence.revision,
    item: { ...performanceSequence, status: "in_progress" },
  });
  for (const phase of performanceSequence.phases) {
    emit("character.performance.sequence.phase.added", {
      item_id: performanceSequence.id,
      revision: performanceSequence.revision,
      phase,
    });
    emit("character.performance.sequence.phase.done", {
      item_id: performanceSequence.id,
      revision: performanceSequence.revision,
      phase,
    });
  }
  for (const track of performanceSequence.tracks) {
    emit("character.performance.sequence.track.added", {
      item_id: performanceSequence.id,
      revision: performanceSequence.revision,
      track: { ...track, cues: [] },
    });
    for (const cue of track.cues) {
      const streamedCue = track.name === "speech" ? { ...cue, text: "" } : cue;
      emit("character.performance.sequence.cue.added", {
        item_id: performanceSequence.id,
        revision: performanceSequence.revision,
        track: track.name,
        cue: streamedCue,
      });
      if (track.name === "speech")
        emit("character.performance.sequence.speech_text.append", {
          item_id: performanceSequence.id,
          revision: performanceSequence.revision,
          cue_id: cue.cue_id,
          text: cue.text,
        });
      emit("character.performance.sequence.cue.done", {
        item_id: performanceSequence.id,
        revision: performanceSequence.revision,
        track: track.name,
        cue,
      });
    }
  }
  const {
    type: _resolutionType,
    event_id: _resolutionEventId,
    sequence_number: _resolutionSequence,
    created_at: _resolutionCreatedAt,
    response_id: _resolutionResponseId,
    ...resolutionPayload
  } = resolution.event;
  emit("character.performance.sequence.resolved", resolutionPayload);
  emit("character.response.output_item.done", {
    output_index: 1,
    item_id: performanceSequence.id,
    revision: performanceSequence.revision,
    item: performanceSequence,
  });
  emit("character.response.completed", { response });
  return {
    events,
    execution: {
      ...execution,
      events: execution.events.map((event) => ({
        ...event,
        sequence_number: sequenceNumber++,
      })),
    },
  };
}

function materializeCharacterV2Record({
  generated,
  profile = PROFILE,
  performanceClient = new MockPerformanceClient(),
} = {}) {
  if (!generated?.responseValidation?.ok)
    throw Object.assign(
      runtimeError("character_v2_provider_output_invalid", 502),
      { details: generated?.responseValidation?.errors || [] }
    );
  const response = generated.response;
  const resolution = resolvePerformanceSequence(response, profile.manifest);
  response.warnings.push(...resolution.warnings);
  response.presentation = compileCharacterPresentation(response, resolution);
  const execution = performanceClient.execute(response, resolution);
  const built = buildEvents(response, resolution, execution);
  return {
    response,
    resolution: resolution.event,
    execution: built.execution,
    events: built.events,
    model: generated.model,
    effectiveProtocol: generated.effectiveProtocol,
    payload: generated.payload,
  };
}

class CharacterV2Runtime {
  constructor({
    adapter = new FlashCharacterV2Adapter(),
    profile = PROFILE,
    performanceClient = new MockPerformanceClient(),
    maximumRecords = 100,
  } = {}) {
    this.adapter = adapter;
    this.profile = profile;
    this.performanceClient = performanceClient;
    this.maximumRecords = maximumRecords;
    this.records = new Map();
    this.active = new Map();
  }

  snapshot() {
    return {
      ready: true,
      activeCharacterV2Responses: this.active.size,
      storedCharacterV2Responses: this.records.size,
    };
  }

  trim() {
    while (this.records.size > this.maximumRecords) {
      const oldest = this.records.keys().next().value;
      this.records.delete(oldest);
    }
  }

  async complete(request) {
    const operationId = crypto.randomUUID();
    this.active.set(operationId, { cancelled: false });
    try {
      const generated = await this.adapter.generate(request);
      const active = this.active.get(operationId);
      if (active?.cancelled) throw runtimeError("character_v2_cancelled", 409);
      const record = materializeCharacterV2Record({
        generated,
        profile: this.profile,
        performanceClient: this.performanceClient,
      });
      this.records.set(record.response.id, record);
      this.trim();
      return this.records.get(record.response.id);
    } finally {
      this.active.delete(operationId);
    }
  }

  retrieve(responseId) {
    const record = this.records.get(responseId);
    if (!record) throw runtimeError("character_v2_response_not_found", 404);
    return record;
  }

  cancel(responseId) {
    const record = this.records.get(responseId);
    if (!record) throw runtimeError("character_v2_response_not_found", 404);
    if (
      ["completed", "failed", "cancelled", "incomplete"].includes(
        record.response.status
      )
    )
      return record;
    record.response.status = "cancelled";
    return record;
  }

  eventsAfter(responseId, afterSequence = -1) {
    const record = this.retrieve(responseId);
    return record.events.filter(
      (event) => event.sequence_number > Number(afterSequence || -1)
    );
  }

  capabilities() {
    return {
      protocol_version: PROTOCOL_VERSION,
      character_id: this.profile.characterId,
      performance_profile: this.profile.id,
      capability_manifest: this.profile.manifestRef,
      face_regions: this.profile.manifest.face_regions,
      track_order: this.profile.manifest.track_order,
      capabilities: this.profile.manifest.capabilities,
    };
  }
}

module.exports = {
  CharacterV2Runtime,
  buildCharacterV2Events: buildEvents,
  materializeCharacterV2Record,
};
