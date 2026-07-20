const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;

function mutationBatchConcurrency(
  value = process.env.ATHENA_SYNC_MUTATION_BATCH_CONCURRENCY
) {
  const parsed = Number(value ?? DEFAULT_CONCURRENCY);
  if (!Number.isInteger(parsed)) return DEFAULT_CONCURRENCY;
  return Math.min(Math.max(parsed, 1), MAX_CONCURRENCY);
}

function mutationLaneKey(mutation = {}, index = 0) {
  const nodeKey = String(mutation?.nodeKey || "").trim();
  return nodeKey || `__invalid_mutation_${index}`;
}

async function runMutationBatch(
  mutations = [],
  worker,
  { concurrency = mutationBatchConcurrency() } = {}
) {
  if (!Array.isArray(mutations) || mutations.length === 0) return [];
  if (typeof worker !== "function")
    throw new TypeError("mutation_batch_worker_required");
  const lanes = new Map();
  mutations.forEach((mutation, index) => {
    const key = mutationLaneKey(mutation, index);
    if (!lanes.has(key)) lanes.set(key, []);
    lanes.get(key).push({ mutation, index });
  });
  const queue = [...lanes.values()];
  const results = new Array(mutations.length);
  let nextLane = 0;
  const workerCount = Math.min(
    mutationBatchConcurrency(concurrency),
    queue.length
  );

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextLane < queue.length) {
        const lane = queue[nextLane];
        nextLane += 1;
        for (const item of lane) {
          try {
            results[item.index] = {
              status: "fulfilled",
              value: await worker(item.mutation, item.index),
            };
          } catch (error) {
            results[item.index] = { status: "rejected", reason: error };
          }
        }
      }
    })
  );
  return results;
}

module.exports = {
  MAX_CONCURRENCY,
  mutationBatchConcurrency,
  mutationLaneKey,
  runMutationBatch,
};
