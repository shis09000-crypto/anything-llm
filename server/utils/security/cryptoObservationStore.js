const fs = require("fs");
const path = require("path");

const CHANNELS = new Set(["edge", "workload", "nats", "collector"]);
const OUTCOMES = new Set([
  "hybrid",
  "classical",
  "downgrade_rejected",
  "failure",
]);

function emptyObservation() {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    tls: {},
    edgeSampleSeq: 0,
    edgeSamples: [],
  };
}

function recordTlsObservation({
  file,
  channel,
  outcome,
  sample = null,
  now = new Date(),
}) {
  if (!file) return { recorded: false, reason: "observation_file_disabled" };
  if (!CHANNELS.has(channel) || !OUTCOMES.has(outcome))
    throw new Error("crypto_tls_observation_invalid");
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  let observation = emptyObservation();
  try {
    observation = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT")
      throw new Error("crypto_tls_observation_file_invalid");
  }
  if (observation?.version !== 1 || typeof observation?.tls !== "object")
    throw new Error("crypto_tls_observation_file_invalid");
  observation.updatedAt = now.toISOString();
  observation.tls[channel] ||= {};
  observation.tls[channel][outcome] =
    Number(observation.tls[channel][outcome] || 0) + 1;
  if (channel === "edge" && sample) {
    const cohort = Number(sample.cohort);
    const clientClass = String(sample.clientClass || "unknown");
    const reason = String(sample.reason || "other");
    const allowedCohorts = new Set([1, 5, 25, 100]);
    const allowedClientClasses = new Set([
      "web_modern",
      "ios26",
      "android_modern",
      "desktop_modern",
      "legacy",
      "unknown",
    ]);
    const allowedReasons = new Set([
      "none",
      "middlebox_blocked",
      "unsupported_group",
      "client_no_pq",
      "certificate",
      "timeout",
      "network",
      "other",
    ]);
    if (
      !allowedCohorts.has(cohort) ||
      !allowedClientClasses.has(clientClass) ||
      !allowedReasons.has(reason)
    )
      throw new Error("crypto_tls_observation_sample_invalid");
    const boundedDuration = (value) => {
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 && number <= 60_000
        ? number
        : null;
    };
    const cpuUtilization = Number(sample.cpuUtilization);
    observation.edgeSampleSeq = Number(observation.edgeSampleSeq || 0) + 1;
    observation.edgeSamples ||= [];
    observation.edgeSamples.push({
      seq: observation.edgeSampleSeq,
      observedAt: now.toISOString(),
      cohort,
      clientClass,
      outcome,
      reason,
      negotiatedGroup:
        String(sample.negotiatedGroup || "") === "X25519MLKEM768"
          ? "X25519MLKEM768"
          : String(sample.negotiatedGroup || "").startsWith("X25519")
            ? "X25519"
            : "unknown",
      certificateVerified: sample.certificateVerified === true,
      handshakeDurationMs: boundedDuration(sample.handshakeDurationMs),
      ttfbMs: boundedDuration(sample.ttfbMs),
      cpuUtilization:
        Number.isFinite(cpuUtilization) &&
        cpuUtilization >= 0 &&
        cpuUtilization <= 1
          ? cpuUtilization
          : null,
    });
    observation.edgeSamples = observation.edgeSamples.slice(-1_000);
  }
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(observation, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(temporary, target);
  return { recorded: true, channel, outcome };
}

module.exports = { recordTlsObservation };
