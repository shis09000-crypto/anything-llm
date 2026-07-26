const fs = require("fs");
const path = require("path");
const { SHADOW_AGENT_IDS } = require("./definitions");
const { runShadowAgents } = require("./analyzers");

const DEFAULT_CORPUS_PATH = path.join(
  __dirname,
  "../evaluation/incidents-v1.json"
);

function loadIncidentCorpus(filePath = DEFAULT_CORPUS_PATH) {
  const corpus = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (
    corpus.schema !== "athena.ops.incident-evaluation-corpus" ||
    corpus.version !== "1.0" ||
    !Array.isArray(corpus.cases)
  )
    throw new Error("operations_incident_corpus_invalid");
  return corpus;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function evaluateIncidentCorpus({
  corpus = loadIncidentCorpus(),
  run = runShadowAgents,
} = {}) {
  const caseResults = corpus.cases.map((testCase) => {
    const result = run(testCase.observations || {});
    const detectedAgents = Object.entries(result.byAgent)
      .filter(([, findings]) => findings.length > 0)
      .map(([agentId]) => agentId);
    const expectedAgents = testCase.expected?.agents || [];
    const expectedEvidence = testCase.expected?.evidenceRefs || [];
    const findings = result.findings;
    const actualEvidence = new Set(
      findings.flatMap((item) => item.evidenceRefs)
    );
    const rcaFindings = result.byAgent[SHADOW_AGENT_IDS.rca] || [];
    const topThreeRootCauses = rcaFindings
      .flatMap((item) => item.hypotheses.slice(0, 3))
      .map((item) => item.component);
    return {
      id: testCase.id,
      kind: testCase.kind,
      provenance: testCase.provenance,
      sourceRef: testCase.sourceRef,
      expectedAgents,
      detectedAgents,
      detected: expectedAgents.some((agentId) =>
        detectedAgents.includes(agentId)
      ),
      falsePositive: testCase.kind === "control" && findings.length > 0,
      rcaTop3Hit: testCase.expected?.rootCause
        ? topThreeRootCauses.includes(testCase.expected.rootCause)
        : null,
      expectedEvidence,
      matchedEvidence: expectedEvidence.filter((ref) =>
        actualEvidence.has(ref)
      ),
    };
  });
  const incidents = caseResults.filter((item) => item.kind === "incident");
  const controls = caseResults.filter((item) => item.kind === "control");
  const rcaCases = incidents.filter((item) => item.rcaTop3Hit !== null);
  const expectedEvidenceCount = incidents.reduce(
    (sum, item) => sum + item.expectedEvidence.length,
    0
  );
  const matchedEvidenceCount = incidents.reduce(
    (sum, item) => sum + item.matchedEvidence.length,
    0
  );
  const agentMetrics = Object.values(SHADOW_AGENT_IDS).map((agentId) => {
    const expected = incidents.filter((item) =>
      item.expectedAgents.includes(agentId)
    );
    const detected = expected.filter((item) =>
      item.detectedAgents.includes(agentId)
    );
    const falsePositives = controls.filter((item) =>
      item.detectedAgents.includes(agentId)
    );
    return {
      agentId,
      recall: ratio(detected.length, expected.length),
      falsePositiveRate: ratio(falsePositives.length, controls.length),
      expectedCases: expected.length,
      detectedCases: detected.length,
      falsePositives: falsePositives.length,
    };
  });
  return {
    schema: "athena.ops.shadow-evaluation-report",
    version: "1.0",
    corpusVersion: corpus.version,
    generatedAt: new Date().toISOString(),
    mode: "offline-shadow-evaluation",
    canExecuteActions: false,
    metrics: {
      recall: ratio(
        incidents.filter((item) => item.detected).length,
        incidents.length
      ),
      falsePositiveRate: ratio(
        controls.filter((item) => item.falsePositive).length,
        controls.length
      ),
      rcaTop3HitRate: ratio(
        rcaCases.filter((item) => item.rcaTop3Hit).length,
        rcaCases.length
      ),
      evidenceCompleteness: ratio(matchedEvidenceCount, expectedEvidenceCount),
    },
    counts: {
      incidents: incidents.length,
      controls: controls.length,
      rcaCases: rcaCases.length,
      historical: caseResults.filter(
        (item) => item.provenance === "historical-defect-ledger"
      ).length,
      faultInjection: caseResults.filter(
        (item) => item.provenance === "fault-injection"
      ).length,
    },
    agentMetrics,
    cases: caseResults,
  };
}

function corpusManifest(corpus = loadIncidentCorpus()) {
  return {
    schema: corpus.schema,
    version: corpus.version,
    createdAt: corpus.createdAt,
    sources: corpus.sources,
    cases: corpus.cases.map(({ id, kind, provenance, sourceRef }) => ({
      id,
      kind,
      provenance,
      sourceRef,
    })),
  };
}

module.exports = {
  corpusManifest,
  evaluateIncidentCorpus,
  loadIncidentCorpus,
};
