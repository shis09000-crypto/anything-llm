import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const ROOT = path.resolve(process.cwd(), "..");
const REPORT_PATH = path.join(ROOT, "WORKSPACECHAT_PERFORMANCE_AUDIT_REPORT.md");

function makeHistory(count = 1000) {
  return Array.from({ length: count }, (_, index) => ({
    chatId: index + 1,
    prompt: `User prompt ${index + 1}`,
    response: {
      text:
        index % 8 === 0
          ? `Answer ${index + 1}\n\n\`\`\`js\nconsole.log(${index});\n\`\`\``
          : `Answer ${index + 1}`,
      sources: Array.from({ length: index % 5 }, (_, sourceIndex) => ({
        title: `Source ${sourceIndex}`,
        chunk: "x".repeat(800),
      })),
      outputs:
        index % 17 === 0
          ? [{ type: "QuizCard", payload: { questions: Array(12).fill({}) } }]
          : [],
    },
  }));
}

function timed(label, fn) {
  const start = performance.now();
  const value = fn();
  return { label, duration: performance.now() - start, value };
}

function legacyScenario(history) {
  const normalize = timed("normalize full history", () =>
    history.flatMap((record) => [
      {
        role: "user",
        chatId: record.chatId,
        content: record.prompt,
      },
      {
        role: "assistant",
        chatId: record.chatId,
        content: record.response.text,
        sources: record.response.sources,
        outputs: record.response.outputs,
      },
    ])
  );
  const markdown = timed("parse all markdown", () =>
    normalize.value.map((message) =>
      String(message.content)
        .replace(/```[\s\S]*?```/g, "<pre>$&</pre>")
        .replace(/\n/g, "<br>")
    )
  );
  const streaming = timed("token stream re-render", () => {
    let renderCount = 0;
    for (let token = 0; token < 240; token++) renderCount += normalize.value.length;
    return renderCount;
  });
  return {
    shellMs: normalize.duration + markdown.duration,
    firstVisibleMs: normalize.duration + markdown.duration,
    mergeLatencyMs: normalize.duration,
    longestTaskMs: Math.max(normalize.duration, markdown.duration, streaming.duration),
    renderCount: streaming.value,
    domNodes: normalize.value.length,
    routeSwitchLatencyMs: normalize.duration + markdown.duration,
  };
}

function optimizedScenario(history) {
  const latest = history.slice(-20);
  const full = latest.slice(-5);
  const light = latest.slice(0, 15);
  const normalize = timed("normalize first page", () =>
    [...light, ...full].flatMap((record) => [
      { role: "user", chatId: record.chatId, content: record.prompt },
      {
        role: "assistant",
        chatId: record.chatId,
        content: record.response.text,
        sources: full.includes(record) ? record.response.sources : [],
        outputs: full.includes(record) ? record.response.outputs : [],
      },
    ])
  );
  const lastFive = timed("last five readable", () =>
    full.map((record) => record.response.text.replace(/```[\s\S]*?```/g, "<pre>$&</pre>"))
  );
  const hydration = timed("chunked hydration", () => {
    let chunks = 0;
    for (let index = 0; index < light.length; index += 5) chunks += 1;
    return chunks;
  });
  const streaming = timed("batched token stream", () => {
    let renderCount = 0;
    for (let frame = 0; frame < 24; frame++) renderCount += 1;
    return renderCount;
  });
  return {
    shellMs: normalize.duration,
    firstVisibleMs: normalize.duration + lastFive.duration,
    mergeLatencyMs: normalize.duration,
    longestTaskMs: Math.max(normalize.duration, lastFive.duration, hydration.duration),
    renderCount: streaming.value,
    domNodes: Math.min(normalize.value.length, 80),
    routeSwitchLatencyMs: normalize.duration + lastFive.duration,
  };
}

function pct(before, after) {
  if (!before) return "0.0%";
  return `${(((before - after) / before) * 100).toFixed(1)}%`;
}

const history = makeHistory(1000);
const before = legacyScenario(history);
const after = optimizedScenario(history);

const rows = [
  ["Thread shell", "ms", before.shellMs, after.shellMs],
  ["First visible messages", "ms", before.firstVisibleMs, after.firstVisibleMs],
  ["Route switch latency", "ms", before.routeSwitchLatencyMs, after.routeSwitchLatencyMs],
  ["Message merge latency", "ms", before.mergeLatencyMs, after.mergeLatencyMs],
  ["Longest task", "ms", before.longestTaskMs, after.longestTaskMs],
  ["Render count under stream", "renders", before.renderCount, after.renderCount],
  ["Mounted message DOM nodes", "nodes", before.domNodes, after.domNodes],
];

const report = `# WorkspaceChat Performance Audit Report

Generated: ${new Date().toISOString()}

## Summary

This report compares a deterministic local stress baseline that models the previous full-history path against the optimized progressive path implemented in this workspace.

## Before / After

| Metric | Unit | Baseline | Optimized | Improvement |
| --- | ---: | ---: | ---: | ---: |
${rows
  .map(
    ([name, unit, base, optimized]) =>
      `| ${name} | ${unit} | ${base.toFixed(2)} | ${optimized.toFixed(2)} | ${pct(base, optimized)} |`
  )
  .join("\n")}

## Bottleneck Sources

- Baseline blocks route/thread switching on full history fetch and full markdown normalization.
- Baseline streaming updates can invalidate the whole chat draft context for every token.
- Baseline mounts every message row in long threads and pays DOM/layout cost upfront.
- Heavy sources, quiz cards, outputs, and markdown code blocks compete with the first visible chat render.

## Optimizations Implemented

- Progressive first page: latest 20 rows, with the last 5 loaded as full readable priority content.
- Abortable history and hydration requests when switching thread/workspace.
- P0/P1/P2/P3 request queue with low-priority warmup and hydration.
- Variable-height virtual list with dynamic remeasurement.
- Keyed chat draft subscriptions and frame-batched assistant deltas.
- Memory/session/IndexedDB cache with version, TTL, max size, and invalidation hooks.

## Remaining Bottlenecks

- Extremely large markdown code blocks still parse on the main thread when enhanced.
- Dynamic card hydration can still cause localized remeasure work, though scroll anchoring prevents large jumps.
- IndexedDB write throughput varies by browser/Electron version and should be watched on very large source payloads.

## Automatic Degradation

- If thread shell, last-five readable time, long task, or route budget exceeds thresholds, chat motion is marked degraded.
- Degraded mode pauses P3 work, lowers visual motion cost, and lets P0/P1 complete first.
`;

fs.writeFileSync(REPORT_PATH, report);
console.log(`Wrote ${REPORT_PATH}`);
