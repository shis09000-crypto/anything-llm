/* eslint-env jest */

const {
  runShadowAgents,
} = require("../../utils/operations/shadowAgents/analyzers");
const {
  shadowAgentDefinitions,
} = require("../../utils/operations/shadowAgents/definitions");
const {
  corpusManifest,
  evaluateIncidentCorpus,
  loadIncidentCorpus,
} = require("../../utils/operations/shadowAgents/evaluation");
const { registry } = require("../../utils/observability/metrics");
const { serviceById } = require("../../utils/operations/serviceCatalog");

describe("Operations Agents shadow evaluation", () => {
  test("registers exactly five observe-only agents", () => {
    const definitions = shadowAgentDefinitions();

    expect(definitions).toHaveLength(5);
    expect(
      definitions.every(
        (agent) =>
          agent.mode === "shadow" &&
          agent.actionPolicy === "observe_only" &&
          agent.canExecuteActions === false
      )
    ).toBe(true);
    expect(serviceById("operations-shadow-agents")).toMatchObject({
      kind: "diagnostic",
      owner: "sre",
    });
    expect(serviceById("post-quantum-security")).toMatchObject({
      kind: "security-control",
      owner: "security",
      capabilities: expect.arrayContaining([
        "runtime-provider-validation",
        "downgrade-detection",
      ]),
    });
    expect(
      definitions.find((agent) => agent.id === "ops-security-agent")
        .capabilities
    ).toEqual(
      expect.arrayContaining([
        "post-quantum-control-validation",
        "cryptographic-downgrade-detection",
      ])
    );
    expect(
      registry.getSingleMetric("athena_operations_shadow_agent_runs_total")
    ).toBeDefined();
    expect(
      registry.getSingleMetric("athena_operations_shadow_findings_total")
    ).toBeDefined();
    expect(
      registry.getSingleMetric("athena_operations_shadow_evaluation")
    ).toBeDefined();
  });

  test("measures the versioned corpus without exposing observations", () => {
    const report = evaluateIncidentCorpus();
    const manifest = corpusManifest();

    expect(report.canExecuteActions).toBe(false);
    expect(report.metrics).toEqual({
      recall: 1,
      falsePositiveRate: 0,
      rcaTop3HitRate: 1,
      evidenceCompleteness: 1,
    });
    expect(report.counts.historical).toBeGreaterThan(0);
    expect(report.counts.faultInjection).toBeGreaterThan(0);
    expect(
      manifest.cases.every((item) => item.observations === undefined)
    ).toBe(true);
  });

  test("keeps control cases quiet and findings non-executable", () => {
    const controls = loadIncidentCorpus().cases.filter(
      (testCase) => testCase.kind === "control"
    );

    for (const testCase of controls)
      expect(runShadowAgents(testCase.observations).findings).toHaveLength(0);

    const incident = loadIncidentCorpus().cases.find(
      (testCase) => testCase.kind === "incident"
    );
    const result = runShadowAgents(incident.observations);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(
      result.findings.every(
        (finding) =>
          finding.canExecuteActions === false &&
          finding.advisory.executable === false
      )
    ).toBe(true);
  });
});
