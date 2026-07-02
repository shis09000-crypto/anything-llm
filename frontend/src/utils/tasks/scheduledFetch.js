import { runScheduledTaskRequest } from "./taskRequestMetadata";

function pathFromInput(input) {
  if (typeof input === "string") return input;
  return input?.url || "direct-fetch";
}

export async function scheduledFetch(input, init = {}, schedulerOptions = {}) {
  const { signal, ...fetchInit } = init || {};
  const method = String(fetchInit.method || schedulerOptions.method || "GET");
  return runScheduledTaskRequest(
    ({ signal: scheduledSignal }) =>
      fetch(input, {
        ...fetchInit,
        signal: scheduledSignal,
      }),
    {
      method,
      path: schedulerOptions.path || pathFromInput(input),
      signal,
      communicationScene: schedulerOptions.communicationScene,
      transport: schedulerOptions.transport || "direct-fetch",
      task: schedulerOptions.task,
    }
  );
}
