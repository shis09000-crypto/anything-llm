const {
  pqResilienceSemanticEvent,
  publishPQOperationsReport,
  validatePQOperationsIntegration,
} = require("../../utils/operations/pqResilience");

function report(success) {
  return {
    success,
    runId: "pq-resilience-test",
    durationMs: 123,
    scenarios: {
      normal: { success },
      fault: { success },
      extreme: { success },
    },
    findings: success ? [] : ["fault:corrupted_signature_not_rejected"],
  };
}

describe("post-quantum resilience operations integration", () => {
  test("publishes a metadata-only healthy event without an automatic action", () => {
    const result = validatePQOperationsIntegration(report(true));

    expect(result).toMatchObject({
      success: true,
      schemaValid: true,
      classificationCorrect: true,
      failureDetected: false,
      automaticActionPossible: false,
      securityFindingCount: 0,
    });
    expect(result.event).toMatchObject({
      eventType: "security.crypto.pq_resilience.completed",
      category: "security",
      severity: "info",
      outcome: "passed",
      sensitivity: "metadata_only",
    });
    expect(JSON.stringify(result.event)).not.toMatch(
      /PRIVATE KEY|PUBLIC KEY|sharedKey|ciphertext/
    );
  });

  test("routes a failed control through the security shadow agent", () => {
    const result = validatePQOperationsIntegration(report(false));

    expect(result).toMatchObject({
      success: true,
      schemaValid: true,
      classificationCorrect: true,
      failureDetected: true,
      automaticActionPossible: false,
      securityFindingCount: 1,
    });
    expect(result.event).toMatchObject({
      eventType: "security.crypto.pq_resilience.failed",
      severity: "critical",
      outcome: "failed",
      recommendation: {
        actionId: "investigate:post-quantum-security",
        permission: "human_review",
      },
    });
  });

  test("keeps the event compatible with the registered operations schema", () => {
    const event = pqResilienceSemanticEvent(report(true));
    expect(event.schema).toBe("athena.ops.event");
    expect(event.schemaVersion).toBe("1.0");
    expect(event.correlation.operationId).toBe("pq-resilience-test");
  });

  test("publishes through the durable Operations Plane contract", async () => {
    const ingested = [];
    const plane = {
      start: jest.fn(async () => ({ ready: true })),
      ingest: jest.fn(async (event) => {
        ingested.push(event);
        return { accepted: true };
      }),
      stop: jest.fn(async () => undefined),
    };

    await expect(
      publishPQOperationsReport(report(true), { plane })
    ).resolves.toMatchObject({
      success: true,
      eventType: "security.crypto.pq_resilience.completed",
    });
    expect(ingested).toHaveLength(1);
    expect(plane.stop).toHaveBeenCalledTimes(1);
  });

  test("fails closed when Operations Plane cannot persist the event", async () => {
    const plane = {
      start: jest.fn(async () => ({ ready: true })),
      ingest: jest.fn(async () => ({ accepted: false, queued: true })),
      stop: jest.fn(async () => undefined),
    };

    await expect(
      publishPQOperationsReport(report(false), { plane })
    ).rejects.toMatchObject({
      code: "PQ_RESILIENCE_OPERATIONS_EVENT_NOT_DURABLE",
    });
    expect(plane.stop).toHaveBeenCalledTimes(1);
  });
});
