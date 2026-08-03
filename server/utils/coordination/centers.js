const { loadManifests } = require("../modulePlatform/manifestRegistry");

const CENTER_IDS = Object.freeze([
  "task",
  "data",
  "cache",
  "recovery",
  "optimistic",
]);

function centerError(code, httpStatus = 400) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = httpStatus;
  return error;
}

function boundedSteps(steps = []) {
  if (!Array.isArray(steps) || steps.length === 0)
    throw centerError("coordination_steps_required");
  if (steps.length > 100)
    throw centerError("coordination_steps_limit_exceeded");
  const ids = new Set();
  return steps.map((step, index) => {
    const moduleId = String(step.moduleId || "");
    const capability = String(step.capability || "");
    if (!moduleId || !capability)
      throw centerError("coordination_step_identity_missing");
    const id = String(step.id || `step-${index + 1}`);
    if (ids.has(id)) throw centerError("coordination_step_duplicate");
    ids.add(id);
    return {
      id,
      moduleId,
      capability,
      dependsOn: Array.isArray(step.dependsOn)
        ? step.dependsOn.map(String)
        : [],
      maxAttempts: Math.max(1, Math.min(Number(step.maxAttempts) || 1, 10)),
    };
  });
}

class TaskCoordinationCenter {
  constructor({ manifests = loadManifests() } = {}) {
    this.id = "task";
    this.modules = new Map(
      manifests.map((manifest) => [manifest.id, manifest])
    );
  }

  plan(input = {}) {
    const steps = boundedSteps(input.steps);
    const stepIds = new Set(steps.map((step) => step.id));
    for (const step of steps) {
      const manifest = this.modules.get(step.moduleId);
      if (!manifest) throw centerError("coordination_step_module_unknown");
      if (!manifest.coordination.centers.includes("task"))
        throw centerError("coordination_step_module_not_task_managed");
      if (
        !manifest.rpc.provides.includes(step.capability) &&
        !manifest.coordination.acceptedCommands.includes(step.capability)
      )
        throw centerError("coordination_step_capability_undeclared");
      if (step.dependsOn.some((id) => !stepIds.has(id)))
        throw centerError("coordination_step_dependency_unknown");
    }
    return { center: this.id, steps };
  }
}

class DataCoordinationCenter {
  constructor({ manifests = loadManifests() } = {}) {
    this.id = "data";
    this.owners = new Map();
    for (const manifest of manifests)
      for (const schema of manifest.ownership.dataSchemas)
        this.owners.set(schema, manifest.id);
  }

  plan(input = {}) {
    const schema = String(input.schema || "");
    const operation = String(input.operation || "read");
    const owner = this.owners.get(schema);
    if (!owner) throw centerError("coordination_data_owner_missing", 404);
    if (operation === "write" && input.moduleId !== owner)
      throw centerError("coordination_cross_schema_write_denied", 403);
    return {
      center: this.id,
      owner,
      schema,
      operation,
      steps: boundedSteps(
        input.steps || [{ moduleId: owner, capability: input.capability }]
      ),
    };
  }
}

class CacheCoordinationCenter {
  constructor() {
    this.id = "cache";
  }

  plan(input = {}) {
    const namespace = String(input.namespace || "");
    if (!/^[a-z0-9][a-z0-9_.:-]{1,159}$/.test(namespace))
      throw centerError("coordination_cache_namespace_invalid");
    return {
      center: this.id,
      namespace,
      action: ["invalidate", "warm", "refresh"].includes(input.action)
        ? input.action
        : "refresh",
      ttlMs: Math.max(0, Math.min(Number(input.ttlMs) || 0, 7 * 86400_000)),
      steps: boundedSteps(input.steps),
      storesValues: false,
    };
  }
}

class RecoveryCoordinationCenter {
  constructor() {
    this.id = "recovery";
  }

  plan(input = {}) {
    if (!String(input.reasonCode || ""))
      throw centerError("coordination_recovery_reason_missing");
    return {
      center: this.id,
      reasonCode: String(input.reasonCode).slice(0, 160),
      requestedLevel: Math.max(
        0,
        Math.min(Number(input.requestedLevel) || 1, 4)
      ),
      steps: boundedSteps(input.steps),
    };
  }
}

class OptimisticCoordinationCenter {
  constructor() {
    this.id = "optimistic";
  }

  plan(input = {}) {
    for (const field of [
      "mutationId",
      "resourceType",
      "resourceId",
      "patchHash",
    ])
      if (!String(input[field] || ""))
        throw centerError(`coordination_optimistic_${field}_missing`);
    if (!/^[a-f0-9]{64}$/.test(String(input.patchHash)))
      throw centerError("coordination_optimistic_patch_hash_invalid");
    return {
      center: this.id,
      mutationId: String(input.mutationId),
      resourceType: String(input.resourceType),
      resourceId: String(input.resourceId),
      patchHash: String(input.patchHash),
      expiresAt: new Date(
        Date.now() +
          Math.max(10_000, Math.min(Number(input.ttlMs) || 300_000, 86400_000))
      ),
      steps: boundedSteps(input.steps),
    };
  }
}

function createCoordinationCenters(options = {}) {
  return new Map([
    ["task", new TaskCoordinationCenter(options)],
    ["data", new DataCoordinationCenter(options)],
    ["cache", new CacheCoordinationCenter(options)],
    ["recovery", new RecoveryCoordinationCenter(options)],
    ["optimistic", new OptimisticCoordinationCenter(options)],
  ]);
}

module.exports = {
  CENTER_IDS,
  CacheCoordinationCenter,
  DataCoordinationCenter,
  OptimisticCoordinationCenter,
  RecoveryCoordinationCenter,
  TaskCoordinationCenter,
  centerError,
  createCoordinationCenters,
};
