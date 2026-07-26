#!/usr/bin/env node
const {
  CLASSIFICATION_LEVEL_MAP,
  CONFIDENTIALITY_HORIZONS,
  DATA_ACCESS_CLASSIFICATIONS,
  DATA_HANDLING_POLICIES,
  DATA_SECURITY_LEVELS,
  dataSecurityCatalog,
} = require("../utils/dataAccess/dataAccessPolicy");

const findings = [];
for (const classification of Object.values(DATA_ACCESS_CLASSIFICATIONS)) {
  if (!CLASSIFICATION_LEVEL_MAP[classification])
    findings.push(`classification_without_level:${classification}`);
}
for (const level of Object.values(DATA_SECURITY_LEVELS)) {
  const policy = DATA_HANDLING_POLICIES[level];
  if (!policy) findings.push(`level_without_policy:${level}`);
  if (!policy?.exportPolicy) findings.push(`level_without_export:${level}`);
  if (!policy?.logPolicy) findings.push(`level_without_log_policy:${level}`);
  if (!policy?.defaultRetention)
    findings.push(`level_without_retention:${level}`);
  if (!policy?.residencyPolicy)
    findings.push(`level_without_residency:${level}`);
  if (!policy?.dlpPolicy) findings.push(`level_without_dlp:${level}`);
  if (!policy?.watermarkPolicy)
    findings.push(`level_without_watermark:${level}`);
}
const catalog = dataSecurityCatalog();
for (const entry of catalog) {
  if (!entry.domain || !entry.securityLevel || !entry.classification)
    findings.push(`incomplete_catalog_entry:${entry.domain || "unknown"}`);
  if (
    !Object.values(CONFIDENTIALITY_HORIZONS).includes(
      entry.confidentialityHorizon
    )
  )
    findings.push(
      `invalid_confidentiality_horizon:${entry.domain || "unknown"}`
    );
}

console.log(
  JSON.stringify(
    {
      success: findings.length === 0,
      domains: catalog.length,
      levels: Object.keys(DATA_HANDLING_POLICIES).length,
      findings,
    },
    null,
    2
  )
);
if (findings.length) process.exitCode = 1;
