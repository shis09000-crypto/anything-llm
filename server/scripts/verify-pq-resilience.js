#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { runPQResilienceValidation } = require("../utils/security/pqResilience");
const {
  publishPQOperationsReport,
  validatePQOperationsIntegration,
} = require("../utils/operations/pqResilience");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function integerArgument(name) {
  const value = argument(name);
  return value === null ? undefined : Number(value);
}

function writeReport(file, report) {
  const target = path.resolve(file);
  if (fs.existsSync(target)) {
    const error = new Error("pq_resilience_output_exists");
    error.code = "PQ_RESILIENCE_OUTPUT_EXISTS";
    throw error;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(temporary, target);
}

async function run() {
  const report = await runPQResilienceValidation({
    profile: argument("--profile") || "all",
    iterations: integerArgument("--iterations"),
    concurrency: integerArgument("--concurrency"),
    payloadBytes: integerArgument("--payload-bytes"),
    ci: process.argv.includes("--ci"),
  });
  const operations = validatePQOperationsIntegration(report);
  const operationsFailureProbe = validatePQOperationsIntegration({
    ...report,
    success: false,
    findings: ["injected_operations_classification_probe"],
    scenarios: {
      ...report.scenarios,
      injectedFailure: {
        success: false,
        findings: ["injected_operations_classification_probe"],
      },
    },
  });
  const result = {
    ...report,
    operations: {
      success: operations.success,
      schemaValid: operations.schemaValid,
      classificationCorrect: operations.classificationCorrect,
      failureDetected: operations.failureDetected,
      automaticActionPossible: operations.automaticActionPossible,
      securityFindingCount: operations.securityFindingCount,
      failurePathClassificationCorrect:
        operationsFailureProbe.classificationCorrect,
      failurePathDetected: operationsFailureProbe.failureDetected,
      failurePathAutomaticActionPossible:
        operationsFailureProbe.automaticActionPossible,
    },
  };
  result.success =
    result.success && operations.success && operationsFailureProbe.success;
  if (process.argv.includes("--emit-operations"))
    result.operations.publication = await publishPQOperationsReport(report);
  const output = argument("--output");
  if (output) writeReport(output, result);
  console.log(JSON.stringify(result, null, 2));
  if (!result.success) process.exitCode = 1;
}

run().catch((error) => {
  console.error(
    JSON.stringify(
      {
        success: false,
        error: String(error?.code || error?.message || "pq_resilience_failed"),
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
