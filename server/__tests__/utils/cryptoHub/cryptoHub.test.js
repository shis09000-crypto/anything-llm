const { EventEmitter } = require("events");
const { CryptoDataHub } = require("../../../utils/cryptoHub/CryptoDataHub");
const {
  CryptoHubCache,
} = require("../../../utils/cryptoHub/cache/CryptoHubCache");
const {
  CryptoHubLoadingProgress,
} = require("../../../utils/cryptoHub/hubLoadingProgress");
const {
  CryptoHubSseHub,
} = require("../../../utils/cryptoHub/streams/CryptoHubSseHub");
const {
  CryptoHubWatchdog,
} = require("../../../utils/cryptoHub/streams/CryptoHubWatchdog");

function fakeResponse() {
  const response = new EventEmitter();
  response.chunks = [];
  response.headers = null;
  response.destroyed = false;
  response.writableEnded = false;
  response.writeHead = jest.fn((_status, headers) => {
    response.headers = headers;
  });
  response.flushHeaders = jest.fn();
  response.write = jest.fn((chunk) => {
    response.chunks.push(String(chunk));
  });
  response.end = jest.fn(() => {
    response.writableEnded = true;
    response.emit("close");
  });
  return response;
}

function parseDataEvents(response) {
  return response.chunks
    .join("")
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data:")))
    .filter(Boolean)
    .map((line) => JSON.parse(line.replace(/^data:\s*/, "")));
}

async function dispatchRouteHandlers(handlers, request, response) {
  const stack = handlers.flat();
  let index = -1;
  async function next(error) {
    if (error) throw error;
    index += 1;
    const handler = stack[index];
    if (!handler) return;
    await handler(request, response, next);
  }
  await next();
}

function fakeAdapter() {
  return {
    configStatus: () => ({
      enabled: true,
      readOnly: true,
      hasApiKey: true,
      hasApiSecret: true,
      maskedApiKey: "ga***",
    }),
    wsStatus: () => ({
      spot: { status: "connected" },
      futuresUsdt: { status: "connected" },
    }),
    marketStreamsStatus: () => [{ status: "connected" }],
    startEquityPolling: jest.fn(),
    stopEquityPolling: jest.fn(),
    startPrivateWs: jest.fn(() => ({ spot: { status: "connected" } })),
    stopPrivateWs: jest.fn(),
    equityFreshness: () => ({ latestSnapshotAt: Date.now() }),
    recordEquitySnapshot: jest.fn(async () => ({
      success: true,
      connectionStatus: "connected",
    })),
    equityHistory: jest.fn(async () => ({
      success: true,
      history: {
        success: true,
        connectionStatus: "connected",
        points: [],
      },
    })),
    openFuturesPositions: jest.fn(async () => ({
      success: true,
      connectionStatus: "connected",
      positions: [],
      summary: {},
    })),
    topAssets: jest.fn(async () => ({
      success: true,
      connectionStatus: "connected",
      assets: [],
    })),
    tradeRecords: jest.fn(async () => ({
      success: true,
      connectionStatus: "connected",
      records: [],
      summary: {},
    })),
    tradeRecordsFeeSummary: jest.fn(async () => ({
      success: true,
      totalFeeUsd: "0.00",
    })),
    marketCandles: jest.fn(async () => ({
      success: true,
      connectionStatus: "connected",
      candles: [],
    })),
    tradingPairDetail: jest.fn(async () => ({
      success: true,
      connectionStatus: "connected",
    })),
    btcSummary: jest.fn(async () => ({
      success: true,
      connectionStatus: "connected",
    })),
    subscribeOpenFuturesPositions: jest.fn(),
    subscribeTradeRecords: jest.fn(),
    subscribeMarketCandles: jest.fn(),
  };
}

function fakeHub() {
  const adapter = fakeAdapter();
  const hub = new CryptoDataHub({ adapter });
  hub.services.allocation.snapshot = jest.fn(async () => ({
    success: true,
    connectionStatus: "connected",
    items: [],
    totalValueUsd: "0.00",
  }));
  return { adapter, hub };
}

describe("Crypto Data Hub", () => {
  test("cache returns fresh values and drops expired values", () => {
    jest.useFakeTimers();
    const cache = new CryptoHubCache();
    cache.set("x", { ok: true }, { ttlMs: 100 });
    expect(cache.get("x")).toEqual({ ok: true });
    jest.advanceTimersByTime(101);
    expect(cache.get("x")).toBeNull();
    jest.useRealTimers();
  });

  test("loading progress reaches degraded when one item errors after ready data", () => {
    const progress = new CryptoHubLoadingProgress();
    progress.setItem("publicMarket", "ready");
    progress.setItem("privateAccount", "error", {
      safeErrorMessage: "private ws failed",
    });
    const snapshot = progress.snapshot();
    expect(snapshot.phase).toBe("degraded");
    expect(snapshot.overallPct).toBeGreaterThan(0);
  });

  test("SSE hub wraps legacy SSE payloads in a Hub envelope", async () => {
    const sseHub = new CryptoHubSseHub({ heartbeatMs: 60_000 });
    const response = fakeResponse();
    await sseHub.proxyLegacyStream({
      topic: "crypto.test",
      response,
      subscribe: async (legacyResponse) => {
        legacyResponse.write("event: snapshot\n");
        legacyResponse.write('data: {"success":true,"items":[1]}\n\n');
        return jest.fn();
      },
    });

    const events = parseDataEvents(response);
    const snapshot = events.find((event) => event.type === "snapshot");
    expect(snapshot).toMatchObject({
      type: "snapshot",
      topic: "crypto.test",
      data: { success: true, items: [1] },
    });
    sseHub.stopHeartbeat();
  });

  test("watchdog recovers disconnected topics only with active subscribers", async () => {
    jest.useFakeTimers();
    const recover = jest.fn();
    const watchdog = new CryptoHubWatchdog({ autoStart: false });
    const streamId = watchdog.registerStream("crypto.test", { recover });

    watchdog.updateSubscriberCount("crypto.test", 0);
    watchdog.recordDisconnect("crypto.test", streamId, new Error("upstream"));
    jest.advanceTimersByTime(5_000);
    watchdog.checkNow();
    await Promise.resolve();
    expect(recover).not.toHaveBeenCalled();

    watchdog.updateSubscriberCount("crypto.test", 1);
    watchdog.checkNow();
    await Promise.resolve();
    expect(recover).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  test("watchdog clears disconnect state on payload and respects cooldown", async () => {
    jest.useFakeTimers();
    const recover = jest.fn();
    const watchdog = new CryptoHubWatchdog({ autoStart: false });
    const streamId = watchdog.registerStream("crypto.test", { recover });
    watchdog.updateSubscriberCount("crypto.test", 1);

    watchdog.recordDisconnect("crypto.test", streamId, new Error("down"));
    jest.advanceTimersByTime(5_000);
    watchdog.checkNow();
    await Promise.resolve();
    expect(recover).toHaveBeenCalledTimes(1);

    watchdog.recordDisconnect("crypto.test", streamId, new Error("down"));
    jest.advanceTimersByTime(5_000);
    watchdog.checkNow();
    await Promise.resolve();
    expect(recover).toHaveBeenCalledTimes(1);

    watchdog.recordPayload("crypto.test", streamId);
    expect(watchdog.snapshot().topics["crypto.test"]).toMatchObject({
      status: "connected",
      disconnectedSince: null,
      safeErrorMessage: null,
    });
    jest.useRealTimers();
  });

  test("init prewarms only the first trade-record page", async () => {
    const { adapter, hub } = fakeHub();
    await hub.init();
    expect(adapter.tradeRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 50,
      })
    );
    expect(adapter.tradeRecords).toHaveBeenCalledTimes(1);
  });

  test("top assets are served through the hub adapter and init progress", async () => {
    const { adapter, hub } = fakeHub();
    await expect(
      hub.getTopAssets({ limit: 6, exclude: "BTC,ETH", quote: "USDT" })
    ).resolves.toMatchObject({
      success: true,
      assets: [],
    });
    expect(adapter.topAssets).toHaveBeenCalledWith({
      limit: 6,
      exclude: "BTC,ETH",
      quote: "USDT",
    });

    await hub.init();
    expect(adapter.topAssets).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 6,
        quote: "USDT",
      })
    );
    expect(hub.getLoadingProgress().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "topAssets",
          status: "ready",
        }),
      ])
    );
  });

  test("top assets endpoint is registered through the hub", async () => {
    jest.resetModules();
    const cryptoDataHub = {
      getTopAssets: jest.fn(async () => ({
        success: true,
        connectionStatus: "connected",
        assets: [{ asset: "SOL" }],
      })),
    };
    jest.doMock("../../../utils/cryptoHub", () => ({ cryptoDataHub }));
    jest.doMock("../../../utils/cryptoGate", () => ({
      safeErrorMessage: (value) =>
        value instanceof Error ? value.message : String(value || ""),
    }));
    jest.doMock("../../../utils/middleware/multiUserProtected", () => ({
      flexUserRoleValid: () => (_request, _response, next) => next(),
      ROLES: { admin: "admin", manager: "manager" },
    }));
    jest.doMock("../../../utils/middleware/validatedRequest", () => ({
      validatedRequest: (_request, _response, next) => next(),
    }));

    const { cryptoHubEndpoints } = require("../../../endpoints/cryptoHub");
    const routes = [];
    const app = {
      get: jest.fn((path, ...handlers) => {
        routes.push({ path, handlers });
      }),
      post: jest.fn(),
    };
    cryptoHubEndpoints(app);

    const route = routes.find((item) => item.path === "/crypto-hub/top-assets");
    const response = {
      locals: {},
      statusCode: null,
      payload: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.payload = payload;
        return this;
      },
    };
    await dispatchRouteHandlers(
      route.handlers,
      {
        query: {
          limit: "4",
          exclude: "BTC,ETH",
          quote: "USDT",
          cryptoCenterAuthBypass: "true",
        },
        headers: {},
        header: jest.fn(),
      },
      response
    );

    expect(cryptoDataHub.getTopAssets).toHaveBeenCalledWith({
      limit: "4",
      exclude: "BTC,ETH",
      quote: "USDT",
    });
    expect(response.statusCode).toBe(200);
    expect(response.payload.assets).toEqual([{ asset: "SOL" }]);
  });

  test("private pair detail and BTC summary use the resolved account hub", async () => {
    jest.resetModules();
    const globalCryptoDataHub = {
      getTradingPairDetail: jest.fn(),
      getBtcSummary: jest.fn(),
    };
    const accountCryptoDataHub = {
      getTradingPairDetail: jest.fn(async ({ pair, market }) => ({
        success: true,
        gateCurrencyPair: pair,
        marketType: market,
        holdingAmountBase: "0.25000000",
      })),
      getBtcSummary: jest.fn(async ({ range }) => ({
        success: true,
        range,
        holdingAmountBtc: "0.25000000",
      })),
    };
    const resolveCryptoHubForHttp = jest.fn(async (user) => ({
      hub: accountCryptoDataHub,
      mode: "account",
      userId: user.id,
    }));

    jest.doMock("../../../utils/cryptoHub", () => ({
      cryptoDataHub: globalCryptoDataHub,
    }));
    jest.doMock("../../../utils/cryptoAccount", () => ({
      resolveCryptoHubForHttp,
    }));
    jest.doMock("../../../utils/cryptoGate", () => ({
      safeErrorMessage: (value) =>
        value instanceof Error ? value.message : String(value || ""),
    }));
    jest.doMock("../../../utils/middleware/multiUserProtected", () => ({
      flexUserRoleValid: () => (_request, _response, next) => next(),
      ROLES: { admin: "admin", manager: "manager" },
    }));
    jest.doMock("../../../utils/middleware/validatedRequest", () => ({
      validatedRequest: (_request, response, next) => {
        response.locals.user = { id: 42 };
        next();
      },
    }));

    const { cryptoHubEndpoints } = require("../../../endpoints/cryptoHub");
    const routes = [];
    const app = {
      get: jest.fn((path, ...handlers) => {
        routes.push({ path, handlers });
      }),
      post: jest.fn(),
    };
    cryptoHubEndpoints(app);

    const responseFor = () => ({
      locals: {},
      statusCode: null,
      payload: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.payload = payload;
        return this;
      },
    });

    const pairResponse = responseFor();
    await dispatchRouteHandlers(
      routes.find((item) => item.path === "/crypto-hub/trading-pair-detail")
        .handlers,
      {
        query: { pair: "ETH_USDT", market: "spot" },
        headers: {},
        header: jest.fn(),
      },
      pairResponse
    );

    const summaryResponse = responseFor();
    await dispatchRouteHandlers(
      routes.find((item) => item.path === "/crypto-hub/btc-summary").handlers,
      {
        query: { range: "1d" },
        headers: {},
        header: jest.fn(),
      },
      summaryResponse
    );

    expect(resolveCryptoHubForHttp).toHaveBeenCalledTimes(2);
    expect(accountCryptoDataHub.getTradingPairDetail).toHaveBeenCalledWith({
      pair: "ETH_USDT",
      market: "spot",
    });
    expect(accountCryptoDataHub.getBtcSummary).toHaveBeenCalledWith({
      range: "1d",
    });
    expect(globalCryptoDataHub.getTradingPairDetail).not.toHaveBeenCalled();
    expect(globalCryptoDataHub.getBtcSummary).not.toHaveBeenCalled();
    expect(pairResponse).toMatchObject({
      statusCode: 200,
      payload: { success: true, holdingAmountBase: "0.25000000" },
    });
    expect(summaryResponse).toMatchObject({
      statusCode: 200,
      payload: { success: true, holdingAmountBtc: "0.25000000" },
    });
  });

  test("stopIfIdle does not stop the shared private websocket", () => {
    const adapter = fakeAdapter();
    const hub = new CryptoDataHub({ adapter });
    const result = hub.stopIfIdle();
    expect(result.stoppedPrivateWs).toBe(false);
    expect(adapter.stopPrivateWs).not.toHaveBeenCalled();
  });

  test("status exposes safe watchdog metadata", () => {
    const adapter = fakeAdapter();
    const hub = new CryptoDataHub({ adapter });
    const response = fakeResponse();
    hub.sseHub.subscribe("crypto.test", response);
    const status = hub.getStatus();
    expect(status.watchdog).toMatchObject({
      enabled: true,
      thresholdMs: 5_000,
      cooldownMs: 10_000,
    });
    expect(status.watchdog.topics["crypto.test"]).toMatchObject({
      subscriberCount: 1,
      status: "connected",
      recoveryCount: 0,
    });
    expect(JSON.stringify(status.watchdog)).not.toMatch(
      /secret|SIGN|signature|KEY/
    );
    response.end();
    hub.sseHub.stopHeartbeat();
  });
});
