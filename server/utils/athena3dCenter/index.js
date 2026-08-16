const crypto = require("crypto");

const THREE_D_CENTER_TRACKS = Object.freeze([
  "face",
  "gaze",
  "head_neck",
  "shoulders",
  "torso",
  "left_arm",
  "right_arm",
  "left_hand",
  "right_hand",
  "left_leg",
  "right_leg",
  "action",
  "speech",
]);

function centerDescriptor() {
  return {
    id: "athena.3d-center",
    object: "athena.application_center",
    version: "1.0",
    ownership: {
      kind: "application_control_center",
      micro_module: false,
      persistence: false,
    },
    wire: {
      encoding: "json",
      payload_encryption: "none",
      payload_compression: "none",
      optimization: "low_latency",
      transport_security: "inherited",
    },
    pipeline: [
      "character.conversation.turn",
      "character.response.v2",
      "character.performance.sequence.resolved",
      "character.performance.plan",
      "frontend.adapter.commands",
      "character.execution.feedback",
    ],
    domains: {
      character_api: {
        protocol_version: "2.0",
        output_items: ["performance_intent", "performance_sequence"],
        provider_visible: false,
      },
      conversation_logic: {
        persistent: true,
        memory_owner: "chat-runtime:3d-center",
        context_strategy: "checkpoint_plus_full_turns_plus_state_window",
        performance_state_window: [
          "previous_state",
          "transition",
          "current_state",
        ],
        horizon: ["brief", "normal", "extended"],
        handoff: ["question", "open", "passive", "close_ready"],
      },
      performance_mapping: {
        protocol_version: "1.0",
        tracks: THREE_D_CENTER_TRACKS,
        timing_evidence: ["planned", "resolved", "actual"],
      },
    },
    uses_micro_modules: [
      "responses-runtime",
      "chat-runtime",
      "character-performance-runtime",
    ],
    routes: {
      sessions: "/api/3d-center/sessions",
      turns: "/api/3d-center/sessions/:sessionId/turns",
      replay: "/api/3d-center/sessions/:sessionId/replay",
      stream: "/api/3d-center/sessions/:sessionId/stream",
    },
  };
}

function centerModule(track) {
  if (track === "face") return "face";
  if (track === "gaze") return "gaze";
  if (track === "action") return "action";
  if (track === "speech") return "speech";
  return "body";
}

function centerCommand(command) {
  return {
    command_id: command.command_id,
    cue_id: command.cue_id,
    track: command.track,
    primitive: command.primitive,
    target: command.target,
    easing: command.easing,
    intensity: command.intensity,
    timing: command.timing,
    binding: {
      id: command.binding_id,
      parameters: command.parameters || {},
    },
  };
}

function centerTimeline(plan) {
  const commands = Array.isArray(plan?.commands) ? plan.commands : [];
  const boundaries = new Set([0]);
  for (const command of commands) {
    const start = Number(command.start_ms || 0);
    const end = start + Number(command.duration_ms || 0);
    boundaries.add(start);
    boundaries.add(end);
  }
  const points = [...boundaries].sort((left, right) => left - right);
  const blocks = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (end <= start) continue;
    const active = commands.filter((command) => {
      const commandStart = Number(command.start_ms || 0);
      const commandEnd = commandStart + Number(command.duration_ms || 0);
      return commandStart < end && commandEnd > start;
    });
    if (!active.length) continue;
    const modules = { face: [], gaze: [], body: [], action: [], speech: [] };
    for (const command of active)
      modules[centerModule(command.track)].push(centerCommand(command));
    blocks.push({
      block_id: `chr_3d_block_${String(blocks.length + 1).padStart(4, "0")}`,
      start_ms: start,
      end_ms: end,
      duration_ms: end - start,
      modules,
    });
  }
  return {
    clock: plan?.clock || { unit: "ms", origin: "plan_dispatch" },
    planned_duration_ms: plan?.planned_duration_ms || 0,
    resolved_duration_ms: plan?.resolved_duration_ms || points.at(-1) || 0,
    time_blocks: blocks,
  };
}

function centerTurnFrame(turn, plan) {
  const output = Array.isArray(turn?.response?.output)
    ? turn.response.output
    : [];
  return {
    object: "athena.3d_center.frame",
    protocol_version: "1.0",
    frame_id: `chr_3d_frame_${String(turn?.turn?.id || crypto.randomUUID()).replace(/[^a-zA-Z0-9_]/g, "")}`,
    center: { id: "athena.3d-center", version: "1.0" },
    conversation: turn.conversation || null,
    turn: turn.turn || null,
    character: {
      response_id: turn?.response?.id || null,
      performance_intent:
        output.find((item) => item.type === "performance_intent") || null,
      conversation_horizon: turn.conversation_horizon || null,
      model_handoff: turn.model_handoff || null,
      effective_handoff: turn.effective_handoff || null,
      state: turn.character_state || null,
      persistent_state_window: turn.persistent_state_window || null,
    },
    memory: {
      status: turn.memory_status || null,
      commit: turn.memory_commit || null,
    },
    timeline: centerTimeline(plan),
    performance_plan: plan,
    warnings: [
      ...(Array.isArray(turn.warnings) ? turn.warnings : []),
      ...(Array.isArray(plan?.warnings) ? plan.warnings : []),
    ],
  };
}

function centerEvent(event) {
  return {
    object: "athena.3d_center.event",
    protocol_version: "1.0",
    type: "athena.3d_center.event",
    event_type: event.type,
    sequence_number: event.sequence_number,
    session_id: event.session_id,
    payload: event,
  };
}

function isCenterRequest(request) {
  return String(request.path || "").startsWith("/3d-center");
}

module.exports = {
  THREE_D_CENTER_TRACKS,
  centerDescriptor,
  centerEvent,
  centerTimeline,
  centerTurnFrame,
  isCenterRequest,
};
