import { requestPriorityQueue } from "./requestPriorityQueue";

const BUDGETS = {
  threadShellMs: 200,
  lastFiveReadableMs: 500,
  droppedFrames: 8,
  longTaskMs: 80,
};

const state = {
  marks: new Map(),
  measures: [],
  degraded: false,
  longTasks: [],
};

function setDegraded(reason) {
  if (state.degraded) return;
  state.degraded = true;
  document.documentElement.dataset.motionBudget = "degraded";
  document.documentElement.classList.add("motion-budget-degraded");
  requestPriorityQueue.setPaused("P3", true);
  window.dispatchEvent(
    new CustomEvent("workspacechat-performance-degraded", {
      detail: { reason },
    })
  );
}

export const WorkspaceChatPerfMarks = {
  mark(name) {
    state.marks.set(name, performance.now());
  },
  measure(name, startName, budgetName = null) {
    const start = state.marks.get(startName);
    if (!start) return null;
    const duration = performance.now() - start;
    const measure = { name, duration, createdAt: Date.now(), budgetName };
    state.measures.push(measure);
    const budget = budgetName ? BUDGETS[budgetName] : null;
    if (budget && duration > budget) {
      setDegraded(`${name} exceeded ${budget}ms (${Math.round(duration)}ms)`);
    }
    return measure;
  },
  recordLongTask(duration, label = "long-task") {
    state.longTasks.push({ duration, label, createdAt: Date.now() });
    if (duration > BUDGETS.longTaskMs) setDegraded(`${label} long task`);
  },
  snapshot() {
    return {
      budgets: BUDGETS,
      degraded: state.degraded,
      measures: [...state.measures],
      longTasks: [...state.longTasks],
      memory:
        performance?.memory && typeof performance.memory === "object"
          ? {
              usedJSHeapSize: performance.memory.usedJSHeapSize,
              totalJSHeapSize: performance.memory.totalJSHeapSize,
            }
          : null,
    };
  },
};

export function usePerformanceBudget() {
  return WorkspaceChatPerfMarks;
}
