#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const {
  planPromotion,
  planRollback,
  readRolloutState,
  writeRolloutState,
} = require("../utils/security/hybridTlsRollout");

function argument(name) {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function readEvidence(file) {
  if (!file) throw new Error("edge_tls_evidence_file_required");
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

const command = String(process.argv[2] || "status");
const stateFile =
  argument("--state-file") ||
  process.env.ATHENA_EDGE_TLS_ROLLOUT_STATE_FILE ||
  path.join(process.cwd(), "storage", "edge-tls-rollout.json");
const execute = process.argv.includes("--execute");

try {
  const current = readRolloutState(stateFile);
  let planned = current;
  if (command === "promote") {
    planned = planPromotion({
      state: current,
      targetPercent: argument("--to"),
      evidence: readEvidence(argument("--evidence")),
    });
  } else if (command === "rollback") {
    planned = planRollback({
      state: current,
      targetPercent: argument("--to") || 0,
      reason: argument("--reason") || "operator_rollback",
    });
  } else if (command !== "status") {
    throw new Error("edge_tls_rollout_command_invalid");
  }

  const changed =
    JSON.stringify(current) !== JSON.stringify(planned) && command !== "status";
  if (changed && execute) writeRolloutState(stateFile, planned);
  console.log(
    JSON.stringify(
      {
        success: true,
        command,
        dryRun: changed && !execute,
        applicationPolicyModified: false,
        enforcementOwner: "cdn-load-balancer-envoy",
        stateFile: path.resolve(stateFile),
        current,
        planned,
        edgeWeights: {
          strictHybridPercent: planned.cohortPercent,
          classicalCompatibilityPercent: 100 - planned.cohortPercent,
        },
      },
      null,
      2
    )
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        success: false,
        error: error?.message || "edge_tls_rollout_failed",
        failures: error?.failures || [],
      },
      null,
      2
    )
  );
  process.exitCode = 1;
}
