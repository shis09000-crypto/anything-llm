const packageJson = require("../../../package.json");

const SHADOW_AGENT_IDS = Object.freeze({
  monitoring: "ops-monitoring-agent",
  rca: "ops-rca-agent",
  performance: "ops-performance-agent",
  security: "ops-security-agent",
  cost: "ops-cost-agent",
});

const DEFINITIONS = Object.freeze([
  {
    id: SHADOW_AGENT_IDS.monitoring,
    name: "Athena Operations Monitoring Agent",
    capabilities: ["anomaly-detection", "incident-candidate-detection"],
  },
  {
    id: SHADOW_AGENT_IDS.rca,
    name: "Athena Operations RCA Agent",
    capabilities: ["root-cause-ranking", "counter-evidence-reporting"],
  },
  {
    id: SHADOW_AGENT_IDS.performance,
    name: "Athena Operations Performance Agent",
    capabilities: ["latency-regression", "throughput-degradation"],
  },
  {
    id: SHADOW_AGENT_IDS.security,
    name: "Athena Operations Security Agent",
    capabilities: ["security-anomaly", "auth-abuse-detection"],
  },
  {
    id: SHADOW_AGENT_IDS.cost,
    name: "Athena Operations Cost Agent",
    capabilities: ["model-cost-regression", "token-budget-monitoring"],
  },
]);

function shadowAgentDefinitions() {
  return DEFINITIONS.map((definition) => ({
    ...definition,
    type: "operations-shadow-agent",
    version: packageJson.version,
    status: "shadow",
    mode: "shadow",
    canExecuteActions: false,
    actionPolicy: "observe_only",
  }));
}

module.exports = { SHADOW_AGENT_IDS, shadowAgentDefinitions };
