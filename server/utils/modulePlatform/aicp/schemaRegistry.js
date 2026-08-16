const fs = require("fs");
const path = require("path");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const { canonicalJson, sha256 } = require("../canonical");
const { metrics } = require("../../observability/metrics");

const DEFAULT_CATALOG = path.resolve(
  __dirname,
  "../../../aicp-schemas/catalog.json"
);

function schemaRegistryError(code, details = {}) {
  const error = new Error(code);
  error.code = code.toUpperCase();
  error.details = details;
  return error;
}

class AicpSchemaRegistry {
  constructor({ catalogPath = DEFAULT_CATALOG, catalog = null } = {}) {
    this.catalogPath = catalogPath;
    this.catalog = catalog || JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    this.schemas = new Map(
      Object.entries(this.catalog.schemas || {}).map(([uri, schema]) => [
        uri,
        schema,
      ])
    );
    this.ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      validateFormats: true,
      allowUnionTypes: true,
    });
    addFormats(this.ajv);
    this.validators = new Map();
    for (const [uri, schema] of this.schemas) {
      if (schema.$id !== uri)
        throw schemaRegistryError("aicp_schema_id_mismatch", { uri });
      this.ajv.addSchema(schema, uri);
    }
    const actualDigest = sha256(canonicalJson(this.catalog.schemas || {}));
    if (actualDigest !== this.catalog.digest)
      throw schemaRegistryError("aicp_schema_catalog_digest_mismatch", {
        expected: this.catalog.digest,
        actual: actualDigest,
      });
  }

  has(uri) {
    return this.schemas.has(String(uri));
  }

  fingerprint(uri) {
    const schema = this.schemas.get(String(uri));
    if (!schema) return null;
    return sha256(canonicalJson(schema));
  }

  validator(uri) {
    const key = String(uri);
    if (!this.schemas.has(key))
      throw schemaRegistryError("aicp_schema_missing", { uri: key });
    if (!this.validators.has(key))
      this.validators.set(key, this.ajv.getSchema(key) || this.ajv.compile(this.schemas.get(key)));
    return this.validators.get(key);
  }

  validate(uri, value, { direction = "unknown" } = {}) {
    const startedAt = process.hrtime.bigint();
    const validate = this.validator(uri);
    const valid = validate(value);
    metrics.aicpSchemaValidationDuration.observe(
      { direction, outcome: valid ? "accepted" : "rejected" },
      Number(process.hrtime.bigint() - startedAt) / 1e9
    );
    return {
      valid: Boolean(valid),
      findings: valid
        ? []
        : (validate.errors || []).map(
            (entry) => `${entry.instancePath || "/"}:${entry.keyword}`
          ),
    };
  }

  summary() {
    return {
      schema: this.catalog.schema,
      schemaVersion: this.catalog.schemaVersion,
      digest: this.catalog.digest,
      count: this.schemas.size,
      generatedAt: this.catalog.generatedAt,
    };
  }
}

let defaultRegistry = null;

function aicpSchemaRegistry() {
  if (!defaultRegistry) defaultRegistry = new AicpSchemaRegistry();
  return defaultRegistry;
}

module.exports = {
  AicpSchemaRegistry,
  DEFAULT_CATALOG,
  aicpSchemaRegistry,
  schemaRegistryError,
};
