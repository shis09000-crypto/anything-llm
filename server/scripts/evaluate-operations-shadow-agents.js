#!/usr/bin/env node

const {
  evaluateIncidentCorpus,
} = require("../utils/operations/shadowAgents/evaluation");

const report = evaluateIncidentCorpus();

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}

const percentages = Object.fromEntries(
  Object.entries(report.metrics).map(([key, value]) => [
    key,
    value === null ? "n/a" : `${(value * 100).toFixed(1)}%`,
  ])
);

console.table({
  recall: percentages.recall,
  falsePositiveRate: percentages.falsePositiveRate,
  rcaTop3HitRate: percentages.rcaTop3HitRate,
  evidenceCompleteness: percentages.evidenceCompleteness,
});
console.table(
  report.agentMetrics.map((entry) => ({
    agent: entry.agentId,
    recall:
      entry.recall === null ? "n/a" : `${(entry.recall * 100).toFixed(1)}%`,
    falsePositiveRate:
      entry.falsePositiveRate === null
        ? "n/a"
        : `${(entry.falsePositiveRate * 100).toFixed(1)}%`,
    expectedCases: entry.expectedCases,
    falsePositives: entry.falsePositives,
  }))
);
console.log(
  `Corpus v${report.corpusVersion}: ${report.counts.incidents} incidents, ${report.counts.controls} controls; shadow mode only, no production actions.`
);
