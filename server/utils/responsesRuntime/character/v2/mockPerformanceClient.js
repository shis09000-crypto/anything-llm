const crypto = require("crypto");

class MockPerformanceClient {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
  }

  execute(response, resolution) {
    const sequence = response.output[1];
    const startedAt = this.now();
    const events = [];
    let sequenceNumber = 0;
    for (const cue of resolution.resolvedCues) {
      events.push({
        type: "character.execution.started",
        event_id: `chr_evt_${crypto.randomUUID().replace(/-/g, "")}`,
        sequence_number: sequenceNumber++,
        created_at: startedAt + cue.resolved_start_ms,
        response_id: response.id,
        item_id: sequence.id,
        cue_id: cue.cue_id,
        track: cue.track,
        resolved_start_ms: cue.resolved_start_ms,
        resolved_duration_ms: cue.resolved_duration_ms,
      });
      events.push({
        type: "character.execution.completed",
        event_id: `chr_evt_${crypto.randomUUID().replace(/-/g, "")}`,
        sequence_number: sequenceNumber++,
        created_at:
          startedAt + cue.resolved_start_ms + cue.resolved_duration_ms,
        response_id: response.id,
        item_id: sequence.id,
        cue_id: cue.cue_id,
        track: cue.track,
        actual_start_ms: cue.resolved_start_ms,
        actual_duration_ms: cue.resolved_duration_ms,
      });
    }
    return {
      client: "mock.character.v2",
      response_id: response.id,
      planned_duration_ms: sequence.planned_duration_ms,
      resolved_duration_ms: resolution.resolvedDuration,
      actual_duration_ms: resolution.resolvedDuration,
      events,
    };
  }
}

module.exports = { MockPerformanceClient };
