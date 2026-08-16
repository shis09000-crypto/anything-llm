#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  requiredEnvironment,
  writeReport,
} = require("../../scripts/athena-3d-test-lib.cjs");

const DIMENSIONS = [
  "persona_language_consistency",
  "facial_continuity",
  "gaze_feasibility",
  "body_limb_naturalness",
  "speech_motion_timing",
  "within_session_emotion_continuity",
  "cross_session_recall_accuracy",
];

function main() {
  requiredEnvironment(["ATHENA_3D_MANUAL_ACCEPTANCE_FILE"]);
  const location = path.resolve(process.env.ATHENA_3D_MANUAL_ACCEPTANCE_FILE);
  if (!fs.existsSync(location)) {
    const error = new Error(
      `Manual acceptance file does not exist: ${location}`
    );
    error.code = "ATHENA_3D_MANUAL_ACCEPTANCE_MISSING";
    throw error;
  }
  const payload = JSON.parse(fs.readFileSync(location, "utf8"));
  const reviewers = Array.isArray(payload.reviewers) ? payload.reviewers : [];
  const reviewerRoles = new Set(reviewers.map((reviewer) => reviewer.role));
  const fatalFindings = Array.isArray(payload.fatal_findings)
    ? payload.fatal_findings
    : [];
  const dimensions = DIMENSIONS.map((dimension) => {
    const scores = reviewers
      .map((reviewer) => reviewer.scores?.[dimension])
      .filter((score) => Number.isFinite(score));
    const average =
      scores.length === 0
        ? null
        : scores.reduce((sum, score) => sum + score, 0) / scores.length;
    return {
      dimension,
      scores,
      average,
      passed:
        scores.length === 2 &&
        scores.every((score) => score >= 1 && score <= 5) &&
        average >= 4,
    };
  });
  const checks = {
    two_independent_reviewers: reviewers.length === 2,
    required_roles:
      reviewerRoles.has("product") &&
      reviewerRoles.has("engineering_animation"),
    reviewer_identity_complete: reviewers.every(
      (reviewer) =>
        String(reviewer.name || "").trim().length > 0 &&
        Number.isFinite(Date.parse(reviewer.signed_at || ""))
    ),
    all_dimensions_passed: dimensions.every((result) => result.passed),
    no_fatal_findings: fatalFindings.length === 0,
    evidence_attached:
      Array.isArray(payload.evidence) && payload.evidence.length > 0,
    explicitly_approved: payload.decision === "approved",
  };
  const status = Object.values(checks).every(Boolean) ? "passed" : "failed";
  const { destination, report } = writeReport("manual-acceptance", {
    suite: "manual_acceptance",
    status,
    source_file: location,
    checks,
    dimensions,
    fatal_findings: fatalFindings,
    evidence: payload.evidence || [],
  });
  console.log(JSON.stringify({ report: destination, ...report }, null, 2));
  if (status !== "passed") process.exitCode = 1;
}

try {
  main();
} catch (error) {
  const { destination } = writeReport("manual-acceptance", {
    suite: "manual_acceptance",
    status: "infrastructure_failed",
    error: {
      code: error.code || "ATHENA_3D_MANUAL_ACCEPTANCE_FAILED",
      message: error.message,
      missing: error.missing || [],
    },
  });
  console.error(`${error.stack || error.message}\nReport: ${destination}`);
  process.exitCode = 1;
}
