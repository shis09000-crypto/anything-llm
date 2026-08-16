import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  connectPerformanceStream,
  createIncrementalPerformanceResponse,
  createPerformanceSession,
  getAthena3DCenter,
} from "@/lib/communication/athena3dCenterClient";
import "./styles.css";

const TRACKS = [
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
];

const FACE_REGIONS = [
  "brow",
  "eyelid",
  "eye_shape",
  "pupil",
  "cheek",
  "nose",
  "lip",
  "jaw",
];

function demoPlan() {
  const motions = {
    face: ["face.region_state", "face.eyelid.both"],
    gaze: ["gaze.target", "gaze.primary"],
    head_neck: ["body.motion", "body.head_neck"],
    shoulders: ["body.motion", "body.shoulders"],
    torso: ["body.motion", "body.torso"],
    left_arm: ["limb.motion", "body.left_arm"],
    right_arm: ["limb.motion", "body.right_arm"],
    left_hand: ["limb.motion", "body.left_hand"],
    right_hand: ["limb.motion", "body.right_hand"],
    left_leg: ["limb.motion", "body.left_leg"],
    right_leg: ["limb.motion", "body.right_leg"],
    action: ["world.action", "world.action"],
    speech: ["speech.text", "voice.primary"],
  };
  return {
    id: "chr_perf_plan_fixture",
    status: "ready",
    pack_ref: {
      id: "athena.mock-anatomy.cold-tsundere",
      version: "1.0.0",
      sha256:
        "8b5282bdeea5432ba437a8d3f3c393b5bd2911c602add6ddfb7f40fc259bef18",
    },
    planned_duration_ms: 5200,
    resolved_duration_ms: 5400,
    commands: TRACKS.map((track, index) => {
      const plannedStart = index < 2 ? 80 : 240 + index * 110;
      const plannedDuration =
        track === "speech" ? 3000 : 520 + (index % 3) * 160;
      const resolvedDuration = plannedDuration + (index % 2 ? 80 : 0);
      return {
        command_id: `fixture_cmd_${track}`,
        cue_id: `fixture_cue_${track}`,
        track,
        start_ms: plannedStart,
        duration_ms: resolvedDuration,
        timing: {
          planned_start_ms: plannedStart,
          planned_duration_ms: plannedDuration,
          resolved_start_ms: plannedStart,
          resolved_duration_ms: resolvedDuration,
          actual_start_ms: null,
          actual_duration_ms: null,
        },
        easing: "ease_out",
        intensity: 0.26 + (index % 4) * 0.08,
        binding_id: `mock_${track}`,
        primitive: motions[track][0],
        target: motions[track][1],
        parameters:
          track === "speech"
            ? { text: "……知道了。路上小心，早点回来。" }
            : { capability_id: `athena.core:${track}_motion/subtle` },
      };
    }),
    suppressed_cues: [],
    warnings: [],
  };
}

function timingFor(command, layer, actual) {
  if (layer === "actual") {
    const evidence = actual[command.command_id];
    return {
      start: evidence?.actual_start_ms ?? command.timing.resolved_start_ms,
      duration:
        evidence?.actual_duration_ms ?? command.timing.resolved_duration_ms,
    };
  }
  return {
    start: command.timing[`${layer}_start_ms`],
    duration: command.timing[`${layer}_duration_ms`],
  };
}

function Anatomy({ active }) {
  const targets = new Set(active.map((command) => command.target));
  const isActive = (part) =>
    [...targets].some((target) => target.includes(part));
  return (
    <div
      className="performance-anatomy"
      aria-label="人体部位执行图"
      data-testid="athena-3d-anatomy"
    >
      <svg viewBox="0 0 260 430" role="img">
        <circle
          className={isActive("face") ? "active" : ""}
          cx="130"
          cy="58"
          r="42"
        />
        <line
          className={isActive("head_neck") ? "active" : ""}
          x1="130"
          y1="100"
          x2="130"
          y2="125"
        />
        <line
          className={isActive("shoulders") ? "active" : ""}
          x1="75"
          y1="135"
          x2="185"
          y2="135"
        />
        <line
          className={isActive("torso") ? "active" : ""}
          x1="130"
          y1="125"
          x2="130"
          y2="275"
        />
        <line
          className={isActive("left_arm") ? "active" : ""}
          x1="80"
          y1="140"
          x2="42"
          y2="245"
        />
        <line
          className={isActive("right_arm") ? "active" : ""}
          x1="180"
          y1="140"
          x2="218"
          y2="245"
        />
        <circle
          className={isActive("left_hand") ? "active" : ""}
          cx="38"
          cy="260"
          r="12"
        />
        <circle
          className={isActive("right_hand") ? "active" : ""}
          cx="222"
          cy="260"
          r="12"
        />
        <line
          className={isActive("left_leg") ? "active" : ""}
          x1="130"
          y1="270"
          x2="88"
          y2="405"
        />
        <line
          className={isActive("right_leg") ? "active" : ""}
          x1="130"
          y1="270"
          x2="172"
          y2="405"
        />
      </svg>
      <div className="face-region-grid">
        {FACE_REGIONS.map((region) => (
          <span
            key={region}
            className={isActive(region) ? "active" : ""}
            data-face-region={region}
          >
            {region}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function CharacterPerformanceLab() {
  const [plan, setPlan] = useState(demoPlan);
  const [layer, setLayer] = useState("resolved");
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [position, setPosition] = useState(0);
  const [actual, setActual] = useState({});
  const [workspaceId, setWorkspaceId] = useState("1");
  const [threadId, setThreadId] = useState("");
  const [prompt, setPrompt] = useState("我出去买瓶水。");
  const [session, setSession] = useState(null);
  const [center, setCenter] = useState(null);
  const [status, setStatus] = useState("默认 Fixture，未调用模型");
  const socketRef = useRef(null);
  const startedRef = useRef(null);
  const executionRef = useRef(new Map());

  const duration = Math.max(
    1,
    ...plan.commands.map((command) => {
      const timing = timingFor(command, layer, actual);
      return timing.start + timing.duration;
    })
  );
  const active = useMemo(
    () =>
      plan.commands.filter((command) => {
        const timing = timingFor(command, layer, actual);
        return (
          position >= timing.start && position < timing.start + timing.duration
        );
      }),
    [actual, layer, plan, position]
  );

  useEffect(() => {
    if (!playing) return undefined;
    startedRef.current = performance.now() - position / speed;
    let frame;
    const tick = (now) => {
      const next = (now - startedRef.current) * speed;
      if (next >= duration) {
        setPosition(duration);
        setPlaying(false);
        return;
      }
      setPosition(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed]);

  useEffect(() => () => socketRef.current?.close(), []);

  useEffect(() => {
    let active = true;
    getAthena3DCenter()
      .then((descriptor) => {
        if (active) setCenter(descriptor);
      })
      .catch(() => {
        if (active) setCenter(null);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const socket = socketRef.current;
    if (!playing || !socket || socket.readyState !== WebSocket.OPEN) return;
    for (const command of plan.commands) {
      const timing = timingFor(command, "resolved", actual);
      const state = executionRef.current.get(command.command_id) || {};
      if (!state.started && position >= timing.start) {
        const eventId = `chr_feedback_${crypto.randomUUID().replaceAll("-", "")}`;
        executionRef.current.set(command.command_id, {
          ...state,
          started: true,
          actualStart: Math.round(position),
        });
        socket.send(
          JSON.stringify({
            type: "athena.3d_center.execution_feedback",
            feedback: {
              plan_id: plan.id,
              events: [
                {
                  event_id: eventId,
                  command_id: command.command_id,
                  status: "started",
                  actual_start_ms: Math.round(position),
                },
              ],
            },
          })
        );
      }
      const latest = executionRef.current.get(command.command_id) || state;
      if (
        latest.started &&
        !latest.completed &&
        position >= timing.start + timing.duration
      ) {
        executionRef.current.set(command.command_id, {
          ...latest,
          completed: true,
        });
        socket.send(
          JSON.stringify({
            type: "athena.3d_center.execution_feedback",
            feedback: {
              plan_id: plan.id,
              events: [
                {
                  event_id: `chr_feedback_${crypto.randomUUID().replaceAll("-", "")}`,
                  command_id: command.command_id,
                  status: "completed",
                  actual_start_ms: latest.actualStart,
                  actual_duration_ms: Math.max(
                    0,
                    Math.round(position - latest.actualStart)
                  ),
                },
              ],
            },
          })
        );
      }
    }
  }, [actual, plan, playing, position]);

  const onEvent = (event) => {
    const payload =
      event.object === "athena.3d_center.event" ? event.payload : event;
    if (payload.type?.startsWith("character.execution."))
      setActual((current) => ({
        ...current,
        [payload.command_id]: {
          ...current[payload.command_id],
          actual_start_ms: payload.actual_start_ms,
          actual_duration_ms: payload.actual_duration_ms,
          status: payload.status,
        },
      }));
    if (payload.plan) setPlan(payload.plan);
  };

  async function runLive() {
    setStatus("正在创建 Session…");
    try {
      let live = session;
      if (!live) {
        const created = await createPerformanceSession({
          workspace_id: Number(workspaceId),
          thread_id: threadId ? Number(threadId) : null,
          adapter: "mock.anatomy.v1",
          runtime_version: "1.0.0",
        });
        live = created.session;
        setSession(live);
        socketRef.current = await connectPerformanceStream({
          sessionId: live.id,
          workspaceId: Number(workspaceId),
          threadId: threadId ? Number(threadId) : null,
          onEvent,
        });
      }
      setStatus("Flash 正在生成严格 JSON，并编译 13 轨计划…");
      const result = await createIncrementalPerformanceResponse(live.id, {
        protocol_version: "1.0",
        context_ref: live.context_ref ?? null,
        input: [
          {
            type: "user_message",
            content: [{ type: "input_text", text: prompt }],
          },
        ],
        idempotency_key: crypto.randomUUID(),
      });
      live = { ...live, context_ref: result.context.current_ref };
      setSession(live);
      setPlan(result.frame.performance_plan);
      setPosition(0);
      setActual({});
      executionRef.current.clear();
      setStatus(
        `已生成 ${result.frame.timeline.time_blocks.length} 个时间区块、${result.frame.performance_plan.commands.length} 条命令`
      );
    } catch (error) {
      setStatus(`失败：${error.message}`);
    }
  }

  return (
    <main className="performance-lab" data-testid="athena-3d-center">
      <header>
        <div>
          <p className="eyebrow">Athena Application Center</p>
          <h1>Athena 3D Center</h1>
          <p>角色协议、持续会话、表演时间轴与 3D 映射的统一控制中心</p>
        </div>
        <div className="digest-card">
          <span>
            {plan.pack_ref.id}@{plan.pack_ref.version}
          </span>
          <code>{plan.pack_ref.sha256.slice(0, 16)}…</code>
        </div>
      </header>

      <section className="center-domains" aria-label="3D 中心职责">
        <article>
          <span>01</span>
          <h2>Character API</h2>
          <p>强制 JSON 的 Performance Intent 与 Sequence，不暴露模型供应商。</p>
          <code>Character Responses v2</code>
        </article>
        <article>
          <span>02</span>
          <h2>Conversation Logic</h2>
          <p>多轮状态、会话深度、Handoff、软结束与 CharacterState 连续性。</p>
          <code>brief · normal · extended</code>
        </article>
        <article>
          <span>03</span>
          <h2>3D Mapping</h2>
          <p>将 resolved cue 编译成13轨 Adapter 命令，并回收实际执行证据。</p>
          <code>planned · resolved · actual</code>
        </article>
        <article className="center-boundary">
          <span>CONTROL PLANE</span>
          <h2>{center?.ownership?.kind || "application_control_center"}</h2>
          <p>
            中心自身不是微模块；后端只编排既有 Responses 与 Performance
            Runtime。
          </p>
          <code>
            {center?.uses_micro_modules?.join(" + ") ||
              "responses-runtime + character-performance-runtime"}
          </code>
        </article>
      </section>

      <section className="center-pipeline" aria-label="3D 中心数据流程">
        {(
          center?.pipeline || [
            "conversation.turn",
            "response.v2",
            "sequence.resolved",
            "performance.plan",
            "adapter.commands",
            "execution.feedback",
          ]
        ).map((stage, index, stages) => (
          <Fragment key={stage}>
            <code>{stage}</code>
            {index < stages.length - 1 ? <span>→</span> : null}
          </Fragment>
        ))}
      </section>

      <section className="lab-controls" data-testid="athena-3d-controls">
        <button
          data-testid="athena-3d-play-pause"
          onClick={() => setPlaying((value) => !value)}
        >
          {playing ? "暂停" : "播放"}
        </button>
        <button
          data-testid="athena-3d-replay"
          onClick={() => {
            executionRef.current.clear();
            setActual({});
            setPosition(0);
            setPlaying(true);
          }}
        >
          重播
        </button>
        {[0.5, 1, 2].map((value) => (
          <button
            className={speed === value ? "selected" : ""}
            key={value}
            data-testid={`athena-3d-speed-${value}`}
            onClick={() => setSpeed(value)}
          >
            {value}x
          </button>
        ))}
        <div className="layer-tabs">
          {["planned", "resolved", "actual"].map((value) => (
            <button
              className={layer === value ? "selected" : ""}
              key={value}
              data-testid={`athena-3d-layer-${value}`}
              onClick={() => setLayer(value)}
            >
              {value}
            </button>
          ))}
        </div>
        <strong>
          {Math.round(position)} / {duration} ms
        </strong>
      </section>

      <input
        className="scrubber"
        data-testid="athena-3d-scrubber"
        type="range"
        min="0"
        max={duration}
        value={position}
        onChange={(event) => {
          setPlaying(false);
          setPosition(Number(event.target.value));
        }}
      />

      <section className="lab-grid">
        <div className="timeline-panel" data-testid="athena-3d-timeline">
          {TRACKS.map((track) => (
            <div
              className="timeline-row"
              key={track}
              data-testid={`athena-3d-track-${track}`}
            >
              <code>{track}</code>
              <div className="timeline-rail">
                {plan.commands
                  .filter((command) => command.track === track)
                  .map((command) => {
                    const timing = timingFor(command, layer, actual);
                    return (
                      <span
                        key={command.command_id}
                        className={`timeline-cue ${active.includes(command) ? "active" : ""}`}
                        style={{
                          left: `${(timing.start / duration) * 100}%`,
                          width: `${Math.max(1.2, (timing.duration / duration) * 100)}%`,
                        }}
                        title={`${command.primitive} · ${timing.start}-${timing.start + timing.duration}ms`}
                      >
                        {command.primitive}
                      </span>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
        <aside>
          <Anatomy active={active} />
          <div className="evidence-panel">
            <h2>当前执行</h2>
            {active.length ? (
              active.map((command) => (
                <div key={command.command_id}>
                  <strong>{command.track}</strong>
                  <span>{command.target}</span>
                  <small>
                    {Math.round(command.intensity * 100)}% · {command.easing}
                  </small>
                </div>
              ))
            ) : (
              <p>当前时间区块无命令。</p>
            )}
          </div>
        </aside>
      </section>

      <section className="live-panel" data-testid="athena-3d-live-panel">
        <h2>真实 Flash（显式触发）</h2>
        <div className="live-fields">
          <input
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
            placeholder="Workspace ID"
          />
          <input
            value={threadId}
            onChange={(event) => setThreadId(event.target.value)}
            placeholder="Thread ID（可选）"
          />
          <input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
          <button data-testid="athena-3d-live-submit" onClick={runLive}>
            生成并编译
          </button>
        </div>
        <p>{status}</p>
      </section>

      <section className="warnings-panel" data-testid="athena-3d-warnings">
        <h2>Fallback / 抑制 / Warning</h2>
        <pre>
          {JSON.stringify(
            { suppressed_cues: plan.suppressed_cues, warnings: plan.warnings },
            null,
            2
          )}
        </pre>
      </section>
    </main>
  );
}
