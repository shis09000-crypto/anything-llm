const { canonicalJson, sha256 } = require("../canonical");
const { loadManifests } = require("../manifestRegistry");

const LINK_TYPES = Object.freeze([
  "dependency",
  "rpc",
  "event",
  "route",
  "data",
  "object-store",
  "key-domain",
  "allowed-caller",
]);

const TARGET_SCOPED_CAPABILITIES = new Set([
  "module.describe",
  "module.self-test",
  "module.lifecycle.query",
  "module.drain",
  "module.quiesce",
  "module.resume",
]);

function stableLinkId(input) {
  return `aicp-link:${sha256(canonicalJson(input)).slice(0, 24)}`;
}

function patternMatches(pattern, value) {
  const left = String(pattern || "");
  const right = String(value || "");
  if (left === "*" || right === "*") return true;
  if (left === right) return true;
  if (left.endsWith(".*")) return right.startsWith(left.slice(0, -1));
  if (right.endsWith(".*")) return left.startsWith(right.slice(0, -1));
  return false;
}

function declaredLink({
  type,
  from,
  to,
  capability,
  transport,
  metadata = {},
}) {
  const identity = { type, from, to, capability, transport };
  return {
    schema: "athena.aicp.link",
    schemaVersion: "1.0",
    id: stableLinkId(identity),
    type,
    from,
    to,
    capability,
    transport,
    direction: "outbound",
    source: "module-manifest",
    metadata,
    state: {
      status: "declared",
      lastObservedAt: null,
      latencyMs: null,
      errorRate: null,
      evidence: [],
    },
  };
}

function buildDeclaredLinks({ manifests = loadManifests() } = {}) {
  const links = [];
  const providers = new Map();
  const publishers = [];
  for (const manifest of manifests) {
    for (const capability of manifest.rpc.provides) {
      if (!providers.has(capability)) providers.set(capability, []);
      providers.get(capability).push(manifest.id);
    }
    for (const eventType of manifest.events.publishes)
      publishers.push({ moduleId: manifest.id, eventType });
  }

  for (const manifest of manifests) {
    for (const dependency of manifest.dependsOn) {
      links.push(
        declaredLink({
          type: "dependency",
          from: manifest.id,
          to: dependency,
          capability: "depends_on",
          transport: dependency.startsWith("infra:")
            ? "infrastructure"
            : "logical",
        })
      );
    }
    for (const capability of manifest.rpc.consumes) {
      const targets = providers.get(capability) || [];
      if (!targets.length) {
        links.push(
          declaredLink({
            type: "rpc",
            from: manifest.id,
            to: `unresolved:rpc:${capability}`,
            capability,
            transport: "mtls-https",
            metadata: { resolution: "unresolved" },
          })
        );
      }
      for (const target of targets) {
        links.push(
          declaredLink({
            type: "rpc",
            from: manifest.id,
            to: target,
            capability,
            transport: "mtls-https",
            metadata: {
              resolution:
                targets.length === 1
                  ? "unique"
                  : TARGET_SCOPED_CAPABILITIES.has(capability)
                    ? "target-scoped"
                    : "ambiguous",
              providerCount: targets.length,
            },
          })
        );
      }
    }
    for (const subscription of manifest.events.subscribes) {
      const sources = publishers.filter(({ eventType }) =>
        patternMatches(subscription, eventType)
      );
      if (!sources.length) {
        links.push(
          declaredLink({
            type: "event",
            from: manifest.id,
            to: `unresolved:event:${subscription}`,
            capability: subscription,
            transport: "nats-jetstream",
            metadata: { resolution: "unresolved", role: "subscriber" },
          })
        );
      }
      for (const source of sources) {
        links.push(
          declaredLink({
            type: "event",
            from: source.moduleId,
            to: manifest.id,
            capability: subscription,
            transport: "nats-jetstream",
            metadata: {
              resolution: sources.length === 1 ? "unique" : "fan-in",
              publishedPattern: source.eventType,
            },
          })
        );
      }
    }
    for (const route of manifest.routes.public) {
      links.push(
        declaredLink({
          type: "route",
          from: "external:client",
          to: manifest.id,
          capability: route,
          transport: "https",
          metadata: { visibility: "public" },
        })
      );
    }
    for (const schema of manifest.data.schemas) {
      links.push(
        declaredLink({
          type: "data",
          from: manifest.id,
          to: `schema:${schema}`,
          capability: "schema-owner",
          transport: "postgresql",
        })
      );
    }
    for (const prefix of manifest.data.objectPrefixes) {
      links.push(
        declaredLink({
          type: "object-store",
          from: manifest.id,
          to: `object-prefix:${prefix}`,
          capability: "object-prefix-owner",
          transport: "s3-compatible",
        })
      );
    }
    for (const domain of manifest.security.keyDomains) {
      links.push(
        declaredLink({
          type: "key-domain",
          from: manifest.id,
          to: "key-custody",
          capability: domain,
          transport: "mtls-https",
        })
      );
    }
    for (const caller of manifest.security.allowedCallers) {
      links.push(
        declaredLink({
          type: "allowed-caller",
          from: caller,
          to: manifest.id,
          capability: "service-call-policy",
          transport: "mtls",
        })
      );
    }
  }
  const unique = new Map(links.map((link) => [link.id, link]));
  return [...unique.values()].sort((left, right) =>
    `${left.type}:${left.from}:${left.to}:${left.capability}`.localeCompare(
      `${right.type}:${right.from}:${right.to}:${right.capability}`
    )
  );
}

function applyLinkObservations(links = [], observations = []) {
  const byId = new Map(observations.map((item) => [item.linkId, item]));
  return links.map((link) => {
    const observed = byId.get(link.id);
    if (!observed) return link;
    return {
      ...link,
      state: {
        status: String(observed.status || "observed"),
        lastObservedAt: observed.observedAt || null,
        latencyMs: Number.isFinite(observed.latencyMs)
          ? observed.latencyMs
          : null,
        errorRate: Number.isFinite(observed.errorRate)
          ? observed.errorRate
          : null,
        evidence: Array.isArray(observed.evidence)
          ? observed.evidence.slice(0, 20)
          : [],
      },
    };
  });
}

function validateModuleLink(value = {}) {
  const findings = [];
  if (value.schema !== "athena.aicp.link") findings.push("schema_invalid");
  if (value.schemaVersion !== "1.0") findings.push("schema_version_invalid");
  if (!String(value.id || "")) findings.push("id_missing");
  if (!LINK_TYPES.includes(value.type)) findings.push("type_invalid");
  for (const field of ["from", "to", "capability", "transport"])
    if (!String(value[field] || "")) findings.push(`${field}_missing`);
  if (value.direction !== "outbound") findings.push("direction_invalid");
  if (!value.state || typeof value.state !== "object")
    findings.push("state_invalid");
  return { valid: findings.length === 0, findings };
}

function buildRuntimeTopology({
  manifests = loadManifests(),
  observations = [],
  runtimeLinks = [],
} = {}) {
  const declaredLinks = applyLinkObservations(
    buildDeclaredLinks({ manifests }),
    observations
  );
  const links = [
    ...new Map(
      [...declaredLinks, ...runtimeLinks].map((link) => [link.id, link])
    ).values(),
  ];
  const nodes = new Map(
    manifests.map((manifest) => [
      manifest.id,
      {
        id: manifest.id,
        type: "module",
        label: manifest.name,
        owner: manifest.owner,
        criticality: manifest.criticality,
      },
    ])
  );
  for (const link of links) {
    for (const id of [link.from, link.to]) {
      if (!nodes.has(id))
        nodes.set(id, {
          id,
          type: id.startsWith("schema:")
            ? "data-schema"
            : id.startsWith("object-prefix:")
              ? "object-prefix"
              : id.startsWith("infra:")
                ? "infrastructure"
                : id.startsWith("unresolved:")
                  ? "unresolved"
                  : "external",
          label: id,
          owner: null,
          criticality: null,
        });
    }
  }
  const unresolved = links.filter((link) =>
    String(link.to).startsWith("unresolved:")
  );
  const observed = links.filter((link) => link.state.status !== "declared");
  return {
    schema: "athena.aicp.runtime-topology",
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    nodes: [...nodes.values()],
    links,
    summary: {
      modules: manifests.length,
      nodes: nodes.size,
      links: links.length,
      declaredLinks: declaredLinks.length,
      runtimeLinks: links.filter(
        (link) => link.source === "runtime-observation"
      ).length,
      observedLinks: observed.length,
      unresolvedLinks: unresolved.length,
      observationCoverage: links.length ? observed.length / links.length : 0,
    },
  };
}

module.exports = {
  LINK_TYPES,
  applyLinkObservations,
  buildDeclaredLinks,
  buildRuntimeTopology,
  patternMatches,
  stableLinkId,
  validateModuleLink,
};
