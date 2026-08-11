const fs = require("fs");
const path = require("path");
const { loadManifests } = require("../manifestRegistry");
const { AicpContractRegistry } = require("./contractRegistry");
const { aicpSchemaRegistry } = require("./schemaRegistry");

const SERVER_ROOT = path.resolve(__dirname, "../../../");

function javascriptFiles(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "__tests__", "aicp-schemas"].includes(entry.name))
      continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) javascriptFiles(candidate, output);
    else if (candidate.endsWith(".js")) output.push(candidate);
  }
  return output;
}

function objectCallSlices(source, callName) {
  const slices = [];
  const pattern = new RegExp(`${callName}\\s*\\(\\s*\\{`, "g");
  let match;
  while ((match = pattern.exec(source))) {
    const start = source.indexOf("{", match.index);
    let depth = 0;
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    let end = -1;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      const next = source[index + 1];
      if (lineComment) {
        if (character === "\n") lineComment = false;
        continue;
      }
      if (blockComment) {
        if (character === "*" && next === "/") {
          blockComment = false;
          index += 1;
        }
        continue;
      }
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === "/" && next === "/") {
        lineComment = true;
        index += 1;
        continue;
      }
      if (character === "/" && next === "*") {
        blockComment = true;
        index += 1;
        continue;
      }
      if (["'", '"', "`"].includes(character)) {
        quote = character;
        continue;
      }
      if (character === "{") depth += 1;
      if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end > start) slices.push({ start, body: source.slice(start, end) });
  }
  return slices;
}

function auditSourceCalls(serverRoot = SERVER_ROOT) {
  const findings = [];
  let calls = 0;
  for (const file of javascriptFiles(serverRoot)) {
    const source = fs.readFileSync(file, "utf8");
    for (const callName of ["requestInternalService", "requestInternalStream"])
      for (const call of objectCallSlices(source, callName)) {
        calls += 1;
        const line = source.slice(0, call.start).split("\n").length;
        for (const field of ["callerRole", "targetModule", "capability"])
          if (!new RegExp(`\\b${field}\\s*(?=:|,)`).test(call.body))
            findings.push(
              `call_context_missing:${path.relative(serverRoot, file)}:${line}:${field}`
            );
      }
  }
  return { calls, findings };
}

function auditAicpClosure({ serverRoot = SERVER_ROOT } = {}) {
  const findings = [];
  const manifests = loadManifests({ cache: false, refresh: true });
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const schemas = aicpSchemaRegistry();
  const registry = new AicpContractRegistry({ manifests: () => manifests });
  let contracts = 0;
  let bindings = 0;
  const providedCapabilities = new Set();

  for (const manifest of manifests) {
    if (manifest.schemaVersion !== "1.2")
      findings.push(`manifest_version:${manifest.id}`);
    const provided = new Set(
      (manifest.contracts?.provides || []).map((contract) => contract.id)
    );
    for (const contract of manifest.contracts?.provides || [])
      providedCapabilities.add(contract.id);
    const routeKeys = new Set();
    for (const binding of manifest.routes?.bindings || []) {
      bindings += 1;
      const key = `${binding.method} ${binding.path}`;
      if (routeKeys.has(key))
        findings.push(`route_binding_duplicate:${manifest.id}:${key}`);
      routeKeys.add(key);
      if (!provided.has(binding.capability))
        findings.push(
          `route_capability_not_provided:${manifest.id}:${key}:${binding.capability}`
        );
    }
    for (const direction of ["provides", "consumes"])
      for (const contract of manifest.contracts?.[direction] || []) {
        contracts += 1;
        for (const uri of [contract.requestSchema, contract.responseSchema]) {
          if (!schemas.has(uri))
            findings.push(`schema_missing:${manifest.id}:${contract.id}:${uri}`);
          else schemas.validator(uri);
        }
        const errorUri = `athena://contracts/${contract.id}/error/${contract.version}`;
        if (!schemas.has(errorUri))
          findings.push(
            `error_schema_missing:${manifest.id}:${contract.id}:${errorUri}`
          );
        else schemas.validator(errorUri);
        if (direction === "consumes") {
          if (!byId.has(contract.targetModule))
            findings.push(
              `target_module_missing:${manifest.id}:${contract.id}:${contract.targetModule}`
            );
          else
            try {
              registry.negotiate({
                callerModule: manifest.id,
                targetModule: contract.targetModule,
                capability: contract.id,
                version: contract.version,
                callType: contract.callType,
                protocolVersion: "1.1",
              });
            } catch (error) {
              findings.push(
                `contract_incompatible:${manifest.id}:${contract.id}:${
                  error.code || error.message
                }`
              );
            }
        }
      }
    for (const stream of [
      ...(manifest.streams?.provides || []),
      ...(manifest.streams?.consumes || []),
    ]) {
      if (!schemas.has(stream.frameSchema))
        findings.push(
          `stream_schema_missing:${manifest.id}:${stream.capability}`
        );
      if (!stream.terminalRequired)
        findings.push(
          `stream_terminal_not_required:${manifest.id}:${stream.capability}`
        );
    }
    for (const event of [
      ...(manifest.eventContracts?.publishes || []),
      ...(manifest.eventContracts?.subscribes || []),
    ]) {
      if (!schemas.has(event.payloadSchema))
        findings.push(`event_schema_missing:${manifest.id}:${event.subject}`);
      if (!event.dlq)
        findings.push(`event_dlq_missing:${manifest.id}:${event.subject}`);
    }
  }
  const source = auditSourceCalls(serverRoot);
  findings.push(...source.findings);
  return {
    schema: "athena.aicp.closure-audit",
    schemaVersion: "1.1",
    valid: findings.length === 0,
    summary: {
      modules: manifests.length,
      contractDeclarations: contracts,
      providedCapabilities: providedCapabilities.size,
      routeBindings: bindings,
      schemaArtifacts: schemas.summary().count,
      sourceCalls: source.calls,
      findings: findings.length,
    },
    schemaCatalogDigest: schemas.summary().digest,
    findings,
  };
}

module.exports = { auditAicpClosure, auditSourceCalls, objectCallSlices };
