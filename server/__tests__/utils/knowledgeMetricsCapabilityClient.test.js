/* global jest, describe, beforeEach, test, expect */

const mockRequestInternalService = jest.fn();

jest.mock("../../utils/microModules/internalClient", () => ({
  requestInternalService: (...args) => mockRequestInternalService(...args),
}));

const {
  recomputeKnowledgeMetrics,
  remoteMetricsRecomputeEnabled,
} = require("../../utils/knowledgeGraph/metricsCapabilityClient");

describe("Knowledge metrics owner capability", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequestInternalService.mockResolvedValue({
      success: true,
      result: { processed: 7 },
    });
  });

  test("routes background recomputation to Knowledge Ingest", async () => {
    const env = {
      NODE_ENV: "production",
      ATHENA_RUNTIME_TOPOLOGY: "micro-modules",
      ATHENA_RUNTIME_ROLE: "background-worker",
      ATHENA_KNOWLEDGE_INGEST_URL: "https://knowledge-ingest:3027/",
    };

    await expect(
      recomputeKnowledgeMetrics(
        { trigger: "scheduled", batchSize: 25, lockTtlMs: 30_000 },
        env
      )
    ).resolves.toEqual({ processed: 7 });

    expect(mockRequestInternalService).toHaveBeenCalledWith(
      expect.objectContaining({
        callerModule: "background-worker",
        targetModule: "knowledge-ingest",
        capability: "knowledge.metrics.recompute",
        url: "https://knowledge-ingest:3027/internal/v1/knowledge/metrics/recompute",
        body: {
          trigger: "scheduled",
          batchSize: 25,
          lockTtlMs: 30_000,
        },
      })
    );
  });

  test("keeps the owner local inside Knowledge Ingest", () => {
    expect(
      remoteMetricsRecomputeEnabled({
        NODE_ENV: "production",
        ATHENA_RUNTIME_TOPOLOGY: "micro-modules",
        ATHENA_RUNTIME_ROLE: "knowledge-ingest",
      })
    ).toBe(false);
  });
});
