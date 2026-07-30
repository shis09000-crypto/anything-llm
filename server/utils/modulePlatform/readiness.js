const { moduleManifest } = require("./manifestRegistry");

function readinessStatus(component = {}) {
  if (component.ready === false) return "not-ready";
  return String(component.status || component.lifecycleStatus || "ready");
}

function moduleReadinessEnvelope(
  moduleId,
  component = {},
  { source = "runtime", ready = undefined } = {}
) {
  const manifest = moduleManifest(moduleId);
  if (!manifest) throw new Error(`module_manifest_missing:${moduleId}`);
  const componentReady =
    ready === undefined
      ? component.ready === undefined
        ? !["failed", "not-ready", "stopped"].includes(
            readinessStatus(component)
          )
        : Boolean(component.ready)
      : Boolean(ready);
  return {
    moduleId: manifest.id,
    role: manifest.runtimeRole,
    version: manifest.version,
    manifestFingerprint: manifest.fingerprint,
    status: componentReady ? "ready" : "not-ready",
    ready: componentReady,
    source,
    component,
  };
}

module.exports = {
  moduleReadinessEnvelope,
  readinessStatus,
};
