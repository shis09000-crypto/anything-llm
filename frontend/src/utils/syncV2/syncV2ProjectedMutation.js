import { syncMutationQueue } from "./syncMutationQueue";
import { syncV2Runtime } from "./syncV2Runtime";
import { syncV2StateStore } from "./syncV2StateStore";

export function projectedSyncMutation({
  nodeKey,
  payload,
  allowedFields = [],
} = {}) {
  if (
    String(import.meta.env?.VITE_SYNC_V2_ENABLED || "false") !== "true" ||
    !syncV2Runtime.enabled() ||
    !nodeKey ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  )
    return null;
  const fields = Object.keys(payload);
  const allowed = new Set(allowedFields);
  if (!fields.length || fields.some((field) => !allowed.has(field)))
    return null;
  const descriptor = syncV2StateStore.descriptor(nodeKey);
  if (!descriptor) return null;
  return {
    mutationId: crypto.randomUUID(),
    nodeKey,
    baseVersion: Number(descriptor.stateVersion || 0),
    operation: "merge",
    changedPaths: fields,
    payload,
  };
}

export async function submitProjectedSyncMutation(
  definition,
  { allowOffline = true, signal = null } = {}
) {
  const mutation = projectedSyncMutation(definition);
  if (!mutation) return null;
  const result = await syncMutationQueue.submit(mutation, {
    allowOffline,
    signal,
  });
  return { mutation, result };
}

export default submitProjectedSyncMutation;
