const idle =
  typeof window !== "undefined" && "requestIdleCallback" in window
    ? window.requestIdleCallback.bind(window)
    : (callback) =>
        window.setTimeout(
          () =>
            callback({
              didTimeout: false,
              timeRemaining: () => 8,
            }),
          1
        );

const cancelIdle =
  typeof window !== "undefined" && "cancelIdleCallback" in window
    ? window.cancelIdleCallback.bind(window)
    : window.clearTimeout.bind(window);

export function runIdleTask(task, { timeout = 750 } = {}) {
  let cancelled = false;
  const id = idle(
    (deadline) => {
      if (!cancelled) task(deadline);
    },
    { timeout }
  );
  return () => {
    cancelled = true;
    cancelIdle(id);
  };
}

export function chunkArray(items = [], worker, options = {}) {
  const { chunkSize = 20, timeout = 750, signal = null } = options;
  let index = 0;
  let cancelled = false;

  return new Promise((resolve, reject) => {
    const run = (deadline) => {
      try {
        if (cancelled || signal?.aborted) {
          resolve();
          return;
        }

        const shouldYield = () =>
          deadline?.timeRemaining && deadline.timeRemaining() <= 1;
        let processed = 0;
        while (
          index < items.length &&
          processed < chunkSize &&
          !shouldYield()
        ) {
          worker(items[index], index);
          index += 1;
          processed += 1;
        }

        if (index >= items.length) {
          resolve();
          return;
        }
        idle(run, { timeout });
      } catch (error) {
        reject(error);
      }
    };

    idle(run, { timeout });
  }).finally(() => {
    cancelled = true;
  });
}
