/* eslint-disable data-access/no-direct-data-access -- Installs telemetry middleware on the centrally-owned Prisma clients; it does not execute business data access. */
const api = require("@opentelemetry/api");
const {
  withOperationSpan,
  correlationCoverage,
  currentOperationContext,
} = require("./operationContext");
const { requirementsForJourney } = require("./goldenJourneys");
const { emitSemanticEvent } = require("./semanticEvents");
const { metrics } = require("./metrics");

const INSTRUMENTED = Symbol.for("athena.database.instrumented");

function databaseSystem(provider) {
  return provider === "postgresql" ? "postgresql" : "sqlite";
}

function instrumentPrismaClient(prisma, { provider, database = "main" } = {}) {
  if (!prisma || prisma[INSTRUMENTED]) return prisma;
  Object.defineProperty(prisma, INSTRUMENTED, { value: true });
  const system = databaseSystem(provider);
  prisma["$use"](async (params, next) => {
    const operation = String(params?.action || "unknown").slice(0, 48);
    const model = String(params?.model || "raw").slice(0, 96);
    const startedAt = Date.now();
    let outcome = "success";
    try {
      return await withOperationSpan(
        `db.${operation}`,
        {
          kind: api.SpanKind.CLIENT,
          attributes: {
            "db.system.name": system,
            "db.namespace": database,
            "db.operation.name": operation,
            "db.collection.name": model,
          },
        },
        () => next(params)
      );
    } catch (error) {
      outcome = "failure";
      emitSemanticEvent({
        eventType: "database.operation.failed",
        category: "database",
        severity: "error",
        outcome,
        subject: { type: "database", component: database, operation },
        impact: { userEffect: "request_data_unavailable" },
        evidence: [
          {
            type: "trace",
            ref: currentOperationContext()?.traceId || "unavailable",
          },
        ],
        metadata: { errorCode: error?.code || "database_operation_failed" },
      });
      throw error;
    } finally {
      const labels = { system, operation, outcome };
      metrics.databaseOperations.inc(labels);
      metrics.databaseDuration.observe(labels, (Date.now() - startedAt) / 1000);
      const journey = currentOperationContext()?.journey || "background";
      const coverage = correlationCoverage(requirementsForJourney(journey));
      metrics.operationCorrelation.inc({
        component: "database",
        journey,
        coverage: coverage.complete ? "complete" : "incomplete",
      });
    }
  });
  return prisma;
}

module.exports = { instrumentPrismaClient };
