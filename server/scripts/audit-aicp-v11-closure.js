#!/usr/bin/env node
const { auditAicpClosure } = require("../utils/modulePlatform/aicp/closureAudit");

const result = auditAicpClosure();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.valid) process.exitCode = 1;
