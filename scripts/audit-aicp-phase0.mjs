import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  ".."
);
const {
  AicpCapabilityRegistry,
  createAicpEnvelope,
  createModuleHealth,
  validateAicpEnvelope,
  validateModuleDescription,
  validateModuleHealth,
  validateModuleLink,
} = require(path.join(root, "server/utils/modulePlatform/aicp"));
const { validateManifest } = require(
  path.join(root, "server/utils/modulePlatform/manifestRegistry")
);

async function main() {
  const registry = new AicpCapabilityRegistry();
  const manifests = registry.manifests();
  const topology = registry.topology();
  const schemaDir = path.join(root, "server/utils/modulePlatform/aicp/schemas");
  const schemaFiles = fs
    .readdirSync(schemaDir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  const schemas = schemaFiles.map((file) => ({
    file,
    value: JSON.parse(fs.readFileSync(path.join(schemaDir, file), "utf8")),
  }));
  const manifestFindings = manifests.flatMap((manifest) =>
    validateManifest(manifest).findings.map((finding) => ({
      moduleId: manifest.id,
      finding,
    }))
  );
  const duplicateLinks =
    topology.links.length - new Set(topology.links.map((link) => link.id)).size;
  const probeEnvelope = createAicpEnvelope({
    callType: "Describe",
    capability: "module.describe",
    producer: "aicp-audit",
    target: "operations-plane",
    auth: {
      principalAssertionId: "principal:aicp-audit",
      scopes: ["module:describe"],
    },
    payload: {},
  });
  const envelopeValidation = validateAicpEnvelope(probeEnvelope);
  const descriptions = await Promise.all(
    manifests.map((manifest) => registry.describe(manifest.id))
  );
  const descriptionFindings = descriptions.flatMap((description) =>
    validateModuleDescription(description).findings.map((finding) => ({
      moduleId: description.module.id,
      finding,
    }))
  );
  const healthFindings = manifests.flatMap((manifest) => {
    const health = createModuleHealth({
      moduleId: manifest.id,
      source: "none",
      runtime: {},
    });
    return validateModuleHealth(health).findings.map((finding) => ({
      moduleId: manifest.id,
      finding,
    }));
  });
  const linkFindings = topology.links.flatMap((link) =>
    validateModuleLink(link).findings.map((finding) => ({
      linkId: link.id,
      finding,
    }))
  );
  const unresolved = topology.links
    .filter((link) => String(link.to).startsWith("unresolved:"))
    .map((link) => ({
      from: link.from,
      capability: link.capability,
      type: link.type,
    }));
  const result = {
    success:
      manifestFindings.length === 0 &&
      duplicateLinks === 0 &&
      envelopeValidation.valid &&
      descriptionFindings.length === 0 &&
      healthFindings.length === 0 &&
      linkFindings.length === 0 &&
      schemas.length === 5,
    generatedAt: new Date().toISOString(),
    phase: registry.catalog().protocol.phase,
    modules: manifests.length,
    capabilities: registry.catalog().capabilities.length,
    schemas: schemas.map(({ file, value }) => ({
      file,
      id: value.$id,
      title: value.title,
    })),
    topology: topology.summary,
    linkTypes: Object.fromEntries(
      [...new Set(topology.links.map((link) => link.type))].map((type) => [
        type,
        topology.links.filter((link) => link.type === type).length,
      ])
    ),
    unresolved,
    hardFindings: {
      manifestFindings,
      duplicateLinks,
      envelopeFindings: envelopeValidation.findings,
      descriptionFindings,
      healthFindings,
      linkFindings,
    },
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.success) process.exitCode = 1;
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      success: false,
      error: error?.code || "aicp_audit_failed",
    })
  );
  process.exitCode = 1;
});
