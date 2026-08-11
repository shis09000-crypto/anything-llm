const AICP_SCHEMA = "athena.aicp.envelope";
const AICP_VERSION = "1.0";
const AICP_CONTEXT_SCHEMA = "athena.aicp.context";
const AICP_CONTEXT_VERSION = "1.1";
const AICP_CONTEXT_HEADER = "x-athena-aicp-context";
const AICP_RESULT_HEADER = "x-athena-aicp-result";
const MAX_AICP_PAYLOAD_BYTES = 128 * 1024;

const CALL_TYPES = Object.freeze([
  "Call",
  "Task",
  "Event",
  "Stream",
  "Query",
  "Command",
  "SelfTest",
  "Describe",
  "Debug",
]);

const CALL_TYPE_SET = new Set(CALL_TYPES);

const OBSERVABILITY_LEVELS = Object.freeze({
  registry: "L0",
  describe: "L1",
  inspect: "L2",
  debug: "L3",
  control: "L4",
});

const READ_ONLY_CALL_TYPES = new Set(["Query", "SelfTest", "Describe"]);
const CONTROL_CALL_TYPES = new Set(["Command", "Debug"]);
const PRIORITIES = new Set(["P0", "P1", "P2", "P3", "P4"]);
const DATA_CLASSIFICATIONS = new Set([
  "public",
  "internal",
  "confidential",
  "restricted",
]);

module.exports = {
  AICP_SCHEMA,
  AICP_VERSION,
  AICP_CONTEXT_HEADER,
  AICP_CONTEXT_SCHEMA,
  AICP_CONTEXT_VERSION,
  AICP_RESULT_HEADER,
  CALL_TYPES,
  CALL_TYPE_SET,
  CONTROL_CALL_TYPES,
  DATA_CLASSIFICATIONS,
  MAX_AICP_PAYLOAD_BYTES,
  OBSERVABILITY_LEVELS,
  PRIORITIES,
  READ_ONLY_CALL_TYPES,
};
