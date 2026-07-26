#!/usr/bin/env node
const { spawnSync } = require("child_process");
const {
  recordTlsObservation,
} = require("../utils/security/cryptoObservationStore");

function argument(name) {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const host =
  argument("--host") || process.env.ATHENA_EDGE_HYBRID_TLS_EVALUATION_HOST;
const port = Number(argument("--port") || 443);
const group = argument("--group") || "X25519MLKEM768";
const cohort = Number(argument("--cohort") || 1);
const clientClass = argument("--client-class") || "unknown";
const cpuUtilization = Number(argument("--edge-cpu-utilization"));
const requireHybrid = process.argv.includes("--require-hybrid");
const findings = [];
let negotiation = null;
let observationOutcome = null;
let compatibilityReason = "none";
let ttfbMs = null;

if (host) {
  if (
    !/^[A-Za-z0-9.-]+$/.test(host) ||
    !Number.isSafeInteger(port) ||
    ![1, 5, 25, 100].includes(cohort)
  ) {
    findings.push("invalid_edge_target");
  } else {
    const handshakeStartedAt = process.hrtime.bigint();
    const result = spawnSync(
      "openssl",
      [
        "s_client",
        "-connect",
        `${host}:${port}`,
        "-servername",
        host,
        "-tls1_3",
        "-groups",
        group,
        "-brief",
      ],
      { encoding: "utf8", input: "", timeout: 15_000 }
    );
    const handshakeDurationMs =
      Number(process.hrtime.bigint() - handshakeStartedAt) / 1_000_000;
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    negotiation = {
      attempted: true,
      success: result.status === 0,
      protocol:
        output.match(/Protocol version:\s*([^\n]+)/i)?.[1]?.trim() || null,
      negotiatedGroup:
        output
          .match(
            /(?:Negotiated TLS1\.3 group|Server Temp Key):\s*([^\n]+)/i
          )?.[1]
          ?.trim() || null,
      certificateVerified: /Verification:\s*OK/i.test(output),
      diagnostic:
        result.status === 0
          ? null
          : "hybrid_group_not_negotiated_or_local_openssl_unsupported",
      handshakeDurationMs,
    };
    const hybridNegotiated =
      negotiation.success &&
      String(negotiation.negotiatedGroup || "")
        .toUpperCase()
        .includes("X25519MLKEM768");
    observationOutcome = hybridNegotiated
      ? "hybrid"
      : negotiation.success
        ? requireHybrid
          ? "downgrade_rejected"
          : "classical"
        : "failure";
    if (requireHybrid && !hybridNegotiated)
      findings.push("hybrid_tls_edge_probe_failed");
    if (requireHybrid && !negotiation.certificateVerified)
      findings.push("hybrid_tls_certificate_verification_failed");
    if (!negotiation.certificateVerified) compatibilityReason = "certificate";
    else if (observationOutcome === "classical")
      compatibilityReason = "client_no_pq";
    else if (/timeout|timed out/i.test(output)) compatibilityReason = "timeout";
    else if (/unsupported|no suitable|no groups/i.test(output))
      compatibilityReason = "unsupported_group";
    else if (/reset|closed|eof|handshake failure/i.test(output))
      compatibilityReason = "middlebox_blocked";
    else if (!negotiation.success) compatibilityReason = "network";

    const ttfb = spawnSync(
      "curl",
      [
        "--silent",
        "--show-error",
        "--output",
        "/dev/null",
        "--max-time",
        "15",
        "--write-out",
        "%{time_starttransfer}",
        `https://${host}:${port}/api/ping`,
      ],
      { encoding: "utf8", timeout: 20_000 }
    );
    const seconds = Number(String(ttfb.stdout || "").trim());
    if (ttfb.status === 0 && Number.isFinite(seconds)) ttfbMs = seconds * 1000;
  }
}

let metricsObservation = { recorded: false, reason: "target_not_probed" };
if (observationOutcome) {
  try {
    metricsObservation = recordTlsObservation({
      file:
        argument("--observation-file") ||
        process.env.ATHENA_CRYPTO_OBSERVATION_FILE,
      channel: "edge",
      outcome: observationOutcome,
      sample: {
        cohort,
        clientClass,
        reason: compatibilityReason,
        negotiatedGroup: negotiation?.negotiatedGroup,
        certificateVerified: negotiation?.certificateVerified,
        handshakeDurationMs: negotiation?.handshakeDurationMs,
        ttfbMs,
        cpuUtilization,
      },
    });
  } catch {
    findings.push("crypto_observation_write_failed");
    metricsObservation = {
      recorded: false,
      reason: "crypto_observation_write_failed",
    };
  }
}

console.log(
  JSON.stringify(
    {
      success: findings.length === 0,
      scope: requireHybrid ? "production-edge-release-gate" : "edge-evaluation",
      applicationTLSModified: false,
      target: host ? { host, port } : null,
      group,
      negotiation,
      cohort,
      clientClass,
      compatibilityReason,
      ttfbMs,
      metricsObservation,
      nextAction: host
        ? "Review edge-provider telemetry and client compatibility before any rollout."
        : "Set ATHENA_EDGE_HYBRID_TLS_EVALUATION_HOST to probe a non-production edge cohort.",
      findings,
    },
    null,
    2
  )
);
if (findings.length) process.exitCode = 1;
