const { buildScore, metricsWorkerActive } = require("../../../utils/workspaceHealth/beacon");

function baseGraph(overrides = {}) {
  return {
    failedJobs: 0,
    pendingJobs: 0,
    processingJobs: 0,
    backfillStatus: "complete",
    isSparse: false,
    missingGraphTextDocuments: 0,
    ...overrides,
  };
}

function baseRepair(overrides = {}) {
  return {
    counts: {
      quarantined: 0,
      open: 0,
      needsReembed: 0,
      providerFailures7d: 0,
      ...overrides.counts,
    },
  };
}

function baseCache(overrides = {}) {
  return {
    staleGraphTraversalEntries: 0,
    ...overrides,
  };
}

describe("workspace health beacon scoring", () => {
  it("does not mark stale metrics as actively processing without active worker evidence", () => {
    const score = buildScore({
      graph: baseGraph(),
      repair: baseRepair(),
      cache: baseCache(),
      metrics: {
        stale: 1187,
        warnings: 0,
        staleWarningCount: 6,
        locked: 0,
        latestRun: {
          createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          processed: 50,
          lockedCount: 50,
          succeeded: 50,
        },
      },
    });

    expect(score.processing).toBe(false);
    expect(score.processingMessages).toEqual([]);
    expect(score.scoreBreakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "staleMetrics",
          title: "节点指标待刷新",
        }),
      ])
    );
    expect(score.maintenanceInfo.staleWarningCount).toBe(6);
  });

  it("marks metrics as processing when rows are recently locked", () => {
    const score = buildScore({
      graph: baseGraph(),
      repair: baseRepair(),
      cache: baseCache(),
      metrics: {
        stale: 42,
        warnings: 0,
        staleWarningCount: 0,
        locked: 3,
        latestRun: null,
      },
    });

    expect(score.processing).toBe(true);
    expect(score.processingMessages[0]).toContain("正在重新计算");
  });

  it("does not mark queued KG jobs as active processing", () => {
    const score = buildScore({
      graph: baseGraph({ pendingJobs: 3 }),
      repair: baseRepair(),
      cache: baseCache(),
      metrics: {
        stale: 0,
        warnings: 0,
        staleWarningCount: 0,
        locked: 0,
        latestRun: null,
      },
    });

    expect(score.processing).toBe(false);
    expect(score.processingMessages).toEqual([]);
    expect(score.scoreBreakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "pendingJobs",
          title: "KG extraction 待处理任务较多",
        }),
      ])
    );
  });

  it("only current non-stale warnings should create metrics warning deductions", () => {
    const staleOnly = buildScore({
      graph: baseGraph(),
      repair: baseRepair(),
      cache: baseCache(),
      metrics: {
        stale: 10,
        warnings: 0,
        staleWarningCount: 6,
        locked: 0,
        latestRun: null,
      },
    });
    const currentWarning = buildScore({
      graph: baseGraph(),
      repair: baseRepair(),
      cache: baseCache(),
      metrics: {
        stale: 0,
        warnings: 1,
        staleWarningCount: 0,
        locked: 0,
        latestRun: null,
      },
    });

    expect(
      staleOnly.scoreBreakdown.find((item) => item.key === "metricsWarnings")
    ).toBeUndefined();
    expect(
      currentWarning.scoreBreakdown.find(
        (item) => item.key === "metricsWarnings"
      )
    ).toEqual(
      expect.objectContaining({
        title: "部分节点指标波动异常",
      })
    );
  });

  it("does not treat a completed recent metrics run as active worker evidence", () => {
    expect(
      metricsWorkerActive({
        locked: 0,
        latestRun: {
          createdAt: new Date().toISOString(),
          processed: 50,
          lockedCount: 50,
        },
      })
    ).toBe(false);
    expect(
      metricsWorkerActive({
        locked: 2,
        latestRun: {
          createdAt: new Date().toISOString(),
          processed: 50,
          lockedCount: 50,
        },
      })
    ).toBe(true);
  });
});
