const { TRACK_ORDER } = require("./constants");

function cueIndex(sequence) {
  const index = new Map();
  sequence.tracks.forEach((track, trackIndex) => {
    track.cues.forEach((cue, cueIndexValue) => {
      index.set(cue.cue_id, {
        track: track.name,
        cue,
        ref: `/output/1/tracks/${trackIndex}/cues/${cueIndexValue}`,
      });
    });
  });
  return index;
}

function plannedCues(sequence) {
  const index = cueIndex(sequence);
  return [...index.values()].map((entry) => ({
    cue_id: entry.cue.cue_id,
    track: entry.track,
    start_ms: entry.cue.planned_start_ms,
    duration_ms: entry.cue.planned_duration_ms,
    cue_ref: entry.ref,
  }));
}

function resolvedCues(sequence, resolution) {
  const index = cueIndex(sequence);
  return resolution.resolvedCues.map((cue) => ({
    cue_id: cue.cue_id,
    track: cue.track,
    start_ms: cue.resolved_start_ms,
    duration_ms: cue.resolved_duration_ms,
    cue_ref: index.get(cue.cue_id)?.ref || null,
  }));
}

function blockModules(cues, start, end) {
  return Object.fromEntries(
    TRACK_ORDER.map((track) => {
      const matching = cues.filter(
        (cue) =>
          cue.track === track &&
          cue.start_ms < end &&
          cue.start_ms + cue.duration_ms > start
      );
      const refs = (items) =>
        items.map((cue) => ({
          cue_id: cue.cue_id,
          cue_ref: cue.cue_ref,
        }));
      return [
        track,
        {
          state: matching.length ? "active" : "idle",
          entering: refs(matching.filter((cue) => cue.start_ms === start)),
          active: refs(matching),
          exiting: refs(
            matching.filter((cue) => cue.start_ms + cue.duration_ms === end)
          ),
        },
      ];
    })
  );
}

function phaseIds(sequence, start, end) {
  return sequence.phases
    .filter(
      (phase) =>
        phase.planned_start_ms < end &&
        phase.planned_start_ms + phase.planned_duration_ms > start
    )
    .map((phase) => phase.id);
}

function compileTimeline(sequence, cues, durationMs, prefix) {
  const boundaries = new Set([0, durationMs]);
  for (const phase of sequence.phases) {
    boundaries.add(phase.planned_start_ms);
    boundaries.add(phase.planned_start_ms + phase.planned_duration_ms);
  }
  for (const cue of cues) {
    boundaries.add(cue.start_ms);
    boundaries.add(Math.min(durationMs, cue.start_ms + cue.duration_ms));
  }
  const ordered = [...boundaries]
    .filter(
      (value) => Number.isInteger(value) && value >= 0 && value <= durationMs
    )
    .sort((left, right) => left - right);
  const blocks = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const start = ordered[index];
    const end = ordered[index + 1];
    if (end <= start) continue;
    blocks.push({
      block_id: `${prefix}_${String(index).padStart(4, "0")}`,
      index,
      start_ms: start,
      end_ms: end,
      duration_ms: end - start,
      phase_ids: phaseIds(sequence, start, end),
      modules: blockModules(cues, start, end),
    });
  }
  return { duration_ms: durationMs, time_blocks: blocks };
}

function compileCharacterPresentation(response, resolution = null) {
  const sequence = response.output[1];
  return {
    schema: "athena.character.presentation",
    version: "1.0",
    clock: {
      unit: "ms",
      origin: "response_start",
      planned_authority: "model",
      resolved_authority: "performance_runtime",
    },
    module_order: [...TRACK_ORDER],
    conflict_policy: {
      exclusive_resource: "first_wins",
      planned_evidence: "preserved",
      suppression_evidence: "warnings_and_resolved_event",
    },
    planned: compileTimeline(
      sequence,
      plannedCues(sequence),
      sequence.planned_duration_ms,
      "planned_block"
    ),
    resolved: resolution
      ? compileTimeline(
          sequence,
          resolvedCues(sequence, resolution),
          resolution.resolvedDuration,
          "resolved_block"
        )
      : null,
  };
}

module.exports = { compileCharacterPresentation };
