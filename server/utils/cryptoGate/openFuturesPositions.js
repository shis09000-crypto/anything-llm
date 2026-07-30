const { GateRestClient } = require("./restClient");
const { getGateCredentials } = require("./secretProvider");
const { cryptoGateWsManager } = require("./wsClient");
const { safeErrorMessage } = require("./sanitizer");

const DEFAULT_SETTLE = "usdt";
const EXIT_FEE_RATE = 0.00075;
const STREAM_BROADCAST_THROTTLE_MS = 500;
const FALLBACK_REST_INTERVAL_MS = 2_000;

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.result)) return value.result;
  if (Array.isArray(value?.positions)) return value.positions;
  if (isRecord(value)) return [value];
  return [];
}

function numberValue(value, fallback = 0) {
  const number = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(number) ? number : fallback;
}

function decimalString(value, digits = 2) {
  const number = numberValue(value);
  return number.toFixed(digits);
}

function trimDecimal(value, digits = 8) {
  const number = numberValue(value);
  if (!number) return "0";
  return number
    .toFixed(digits)
    .replace(/\.?0+$/, "")
    .replace(/\.$/, "");
}

function normalizeContract(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/-/g, "_");
}

function compactSymbol(contract) {
  return normalizeContract(contract).replace(/_/g, "");
}

function splitContract(contract) {
  const normalized = normalizeContract(contract);
  const [baseAsset, quoteAsset] = normalized.split("_");
  return {
    baseAsset: baseAsset || normalized || "FUT",
    quoteAsset: quoteAsset || "USDT",
  };
}

function firstPresent(source, keys, fallback = null) {
  for (const key of keys) {
    if (source?.[key] !== undefined && source?.[key] !== null) {
      return source[key];
    }
  }
  return fallback;
}

function firstPositiveNumber(source, keys, fallback = 0, min = 0) {
  for (const key of keys) {
    const value = numberValue(source?.[key], NaN);
    if (Number.isFinite(value) && Math.abs(value) > min) {
      return Math.abs(value);
    }
  }
  return fallback;
}

function accountEquityUsd(account) {
  if (!isRecord(account)) return "0.00";
  const directEquity = firstPositiveNumber(
    account,
    [
      "cross_available",
      "cross_margin_balance",
      "total_margin_balance",
      "total_equity",
      "equity",
    ],
    0,
    0.01
  );
  if (directEquity > 0) return decimalString(directEquity, 2);

  const available = numberValue(account.available);
  const crossInitialMargin = numberValue(
    firstPresent(account, ["cross_initial_margin", "position_initial_margin"])
  );
  const unrealizedPnl = numberValue(
    firstPresent(account, ["cross_unrealised_pnl", "unrealised_pnl"])
  );
  const derivedEquity = available + crossInitialMargin + unrealizedPnl;
  return decimalString(derivedEquity > 0 ? derivedEquity : available, 2);
}

function hasOpenHolding(raw) {
  if (raw?.holding === false) return false;
  if (String(raw?.holding).toLowerCase() === "false") return false;
  return (
    Math.abs(numberValue(firstPresent(raw, ["size", "position_size"]))) > 0
  );
}

function marginMode(raw) {
  const mode = String(
    firstPresent(raw, ["pos_margin_mode", "margin_mode", "mode"], "")
  ).toLowerCase();
  if (mode.includes("isolated")) return "isolated";
  if (mode.includes("single")) return "isolated";
  return "cross";
}

function contractType(raw) {
  const type = String(firstPresent(raw, ["type", "contract_type"], ""))
    .trim()
    .toLowerCase();
  return type.includes("delivery") || type.includes("quarter")
    ? "delivery"
    : "perpetual";
}

function leverage(raw) {
  const parsed = numberValue(firstPresent(raw, ["lever", "leverage"]), 1);
  return Math.max(1, Math.round(parsed || 1));
}

function positionSide(raw) {
  const explicitSide = String(
    firstPresent(
      raw,
      ["mode", "position_side", "positionSide", "side", "dual_side"],
      ""
    )
  ).toLowerCase();
  if (explicitSide.includes("long")) return "long";
  if (explicitSide.includes("short")) return "short";

  const rawSize = numberValue(firstPresent(raw, ["size", "position_size"]));
  return rawSize >= 0 ? "long" : "short";
}

function positionKey(raw) {
  const contract = normalizeContract(
    firstPresent(raw, ["contract", "symbol", "name"])
  );
  if (!contract) return "";
  return `${contract}:${positionSide(raw)}`;
}

function riskLevel({ markPrice, liquidationPrice, side, leverage: lever }) {
  const mark = numberValue(markPrice);
  const liq = numberValue(liquidationPrice);
  if (!mark || !liq) return lever >= 10 ? "watch" : "safe";

  const distancePct = Math.abs(mark - liq) / mark;
  if (distancePct <= 0.05) return "danger";
  if (distancePct <= 0.12 || lever >= 10) return "watch";
  if (side === "long" && liq >= mark) return "danger";
  if (side === "short" && liq <= mark) return "danger";
  return "safe";
}

function liquidationRiskLevelFromDistance(distancePct) {
  if (distancePct === null) return "unavailable";

  const distance = numberValue(distancePct);
  if (distance >= 15) return "safe";
  if (distance >= 10) return "watch";
  if (distance >= 5) return "danger";
  if (distance >= 1) return "critical";
  return "extreme";
}

function liquidationDistancePct({ markPrice, liquidationPrice }) {
  if (liquidationPrice === null || liquidationPrice === undefined) return null;
  if (String(liquidationPrice).trim() === "") return null;

  const mark = numberValue(markPrice, NaN);
  const liq = numberValue(liquidationPrice, NaN);
  if (
    !Number.isFinite(mark) ||
    mark <= 0 ||
    !Number.isFinite(liq) ||
    liq <= 0
  ) {
    return null;
  }

  return decimalString((Math.abs(mark - liq) / mark) * 100, 2);
}

function quantityAmountFromPosition({ rawSize, valueUsd, markPrice }) {
  const mark = numberValue(markPrice);
  const value = Math.abs(numberValue(valueUsd));
  const estimatedBase =
    mark > 0 && value > 0 ? value / mark : Math.abs(rawSize);
  return trimDecimal(estimatedBase, 8);
}

function quantityFromPosition({ rawSize, valueUsd, markPrice, baseAsset }) {
  return `${quantityAmountFromPosition({
    rawSize,
    valueUsd,
    markPrice,
  })} ${baseAsset}`;
}

function positionMarginUsd(raw, { valueUsd, entryPrice, markPrice, lever }) {
  const mode = marginMode(raw);
  const explicitMargin = firstPositiveNumber(raw, [
    "margin",
    "position_margin",
  ]);
  if (mode === "isolated" && explicitMargin > 0) return explicitMargin;

  const initialMargin = firstPositiveNumber(raw, ["initial_margin"]);
  if (initialMargin > 0) return initialMargin;
  if (mode === "cross") return 0;

  const mark = numberValue(markPrice);
  const entry = numberValue(entryPrice);
  const value = Math.abs(numberValue(valueUsd));
  const leverageValue = Math.max(1, numberValue(lever, 1));
  const baseAmount = mark > 0 && value > 0 ? value / mark : 0;
  const entryPositionValue =
    entry > 0 && baseAmount > 0 ? entry * baseAmount : 0;
  const formulaMargin =
    entryPositionValue > 0
      ? entryPositionValue / leverageValue + entryPositionValue * EXIT_FEE_RATE
      : 0;
  if (formulaMargin > 0) return formulaMargin;

  if (value > 0) return value / leverageValue;
  return explicitMargin;
}

function normalizePosition(raw) {
  if (!isRecord(raw)) return null;
  const id = positionKey(raw);
  if (!id || !hasOpenHolding(raw)) return null;

  const contract = normalizeContract(
    firstPresent(raw, ["contract", "symbol", "name"])
  );
  const { baseAsset, quoteAsset } = splitContract(contract);
  const rawSize = numberValue(firstPresent(raw, ["size", "position_size"]));
  const side = positionSide(raw);
  const markPrice = firstPresent(raw, ["mark_price", "markPrice"], "0");
  const valueUsd = Math.abs(
    numberValue(firstPresent(raw, ["value", "notional", "notional_usd"]))
  );
  const entryPrice = firstPresent(raw, ["entry_price", "entryPrice"], "0");
  const rawLiquidationPrice = firstPresent(
    raw,
    ["liq_price", "liquidation_price", "liquidationPrice"],
    null
  );
  const liquidationPrice =
    numberValue(rawLiquidationPrice, NaN) > 0 ? rawLiquidationPrice : null;
  const unrealizedPnlUsd = numberValue(
    firstPresent(raw, ["unrealised_pnl", "unrealized_pnl", "unrealizedPnl"])
  );
  const lever = leverage(raw);
  const positionMarginMode = marginMode(raw);
  const marginUsd = positionMarginUsd(raw, {
    valueUsd,
    entryPrice,
    markPrice,
    lever,
  });
  const legacyRiskLevel = riskLevel({
    markPrice,
    liquidationPrice,
    side,
    leverage: lever,
  });
  const liquidationDistance = liquidationDistancePct({
    markPrice,
    liquidationPrice,
  });

  const rawContractSize = numberValue(
    firstPresent(raw, ["size", "position_size"])
  );
  const configuredLeverage = lever;
  const effectiveLeverage =
    positionMarginMode === "isolated" ? configuredLeverage : null;
  const initialMarginUsd = firstPositiveNumber(raw, ["initial_margin"]);
  const maintenanceMarginUsd = firstPositiveNumber(raw, [
    "maintenance_margin",
  ]);

  return {
    id,
    symbol: compactSymbol(contract),
    baseAsset,
    quoteAsset: quoteAsset === "USDT" ? "USD" : quoteAsset,
    contractType: contractType(raw),
    side,
    leverage: configuredLeverage,
    configuredLeverage,
    effectiveLeverage,
    leverageScope:
      positionMarginMode === "cross"
        ? "configured_position_leverage_not_effective_account_leverage"
        : "isolated_position_leverage",
    marginMode: positionMarginMode,
    contractSize: trimDecimal(rawContractSize, 8),
    contractSizeUnit: "contracts",
    quantity: quantityFromPosition({
      rawSize,
      valueUsd,
      markPrice,
      baseAsset,
    }),
    quantityAmount: quantityAmountFromPosition({
      rawSize,
      valueUsd,
      markPrice,
    }),
    quantitySemantics: "mark_price_base_equivalent",
    baseEquivalentAmount: quantityAmountFromPosition({
      rawSize,
      valueUsd,
      markPrice,
    }),
    notionalUsd: decimalString(valueUsd, 2),
    positionValueUsd: decimalString(valueUsd, 2),
    entryPrice: decimalString(entryPrice, 8),
    markPrice: decimalString(markPrice, 8),
    liquidationPrice:
      liquidationPrice === null ? null : decimalString(liquidationPrice, 8),
    liquidationPriceReferenceOnly: liquidationPrice !== null,
    liquidationDistancePct: liquidationDistance,
    liquidationRiskLevel:
      liquidationRiskLevelFromDistance(liquidationDistance),
    initialMarginUsd:
      initialMarginUsd > 0 ? decimalString(initialMarginUsd, 2) : null,
    maintenanceMarginUsd:
      maintenanceMarginUsd > 0
        ? decimalString(maintenanceMarginUsd, 2)
        : null,
    marginUsd: decimalString(marginUsd, 2),
    marginSemantics:
      positionMarginMode === "cross"
        ? "gate_position_initial_margin_reference_not_additive"
        : "isolated_position_margin",
    fundingFeeUsd: null,
    unrealizedPnlUsd: decimalString(unrealizedPnlUsd, 2),
    pnlPct:
      positionMarginMode === "isolated" && marginUsd > 0
        ? decimalString((unrealizedPnlUsd / marginUsd) * 100, 2)
        : null,
    pnlPctUnavailableReason:
      positionMarginMode === "cross"
        ? "cross_margin_shared_collateral"
        : null,
    riskLevel: liquidationDistance === null ? "unavailable" : legacyRiskLevel,
    riskAssessment:
      liquidationDistance === null
        ? "unavailable"
        : "liquidation_price_reference_only",
    iconUrl: `/crypto-icons/${baseAsset.toLowerCase()}.png`,
  };
}

function sortPositions(positions) {
  return [...positions].sort(
    (left, right) =>
      Math.abs(numberValue(right.unrealizedPnlUsd)) -
      Math.abs(numberValue(left.unrealizedPnlUsd))
  );
}

function summarizePositions(positions, account = null) {
  const summedUnrealizedPnlUsd = positions.reduce(
    (sum, position) => sum + numberValue(position.unrealizedPnlUsd),
    0
  );
  const summedPositionMarginUsd = positions.reduce(
    (sum, position) => sum + numberValue(position.marginUsd),
    0
  );
  const totalNotionalUsd = positions.reduce(
    (sum, position) => sum + numberValue(position.notionalUsd),
    0
  );
  const rawAccountUnrealizedPnl = firstPresent(
    account,
    ["cross_unrealised_pnl", "unrealised_pnl"],
    null
  );
  const accountUnrealizedPnlUsd =
    rawAccountUnrealizedPnl === null
      ? NaN
      : numberValue(rawAccountUnrealizedPnl, NaN);
  const totalUnrealizedPnlUsd = Number.isFinite(accountUnrealizedPnlUsd)
    ? accountUnrealizedPnlUsd
    : summedUnrealizedPnlUsd;
  const accountInitialMarginUsd = firstPositiveNumber(account, [
    "cross_initial_margin",
    "position_initial_margin",
  ]);
  const accountMaintenanceMarginUsd = firstPositiveNumber(account, [
    "cross_maintenance_margin",
    "maintenance_margin",
  ]);
  const accountOrderMarginUsd = firstPositiveNumber(account, [
    "cross_order_margin",
    "order_margin",
  ]);
  const crossAvailableUsd = firstPositiveNumber(account, ["cross_available"]);
  const totalMarginUsd =
    accountInitialMarginUsd > 0
      ? accountInitialMarginUsd
      : summedPositionMarginUsd;
  const legacyEquity = numberValue(accountEquityUsd(account));
  const hasCrossPosition = positions.some(
    (position) => position.marginMode === "cross"
  );
  const initialMarginToAvailablePct =
    crossAvailableUsd > 0
      ? decimalString((totalMarginUsd / crossAvailableUsd) * 100, 2)
      : null;

  return {
    totalUnrealizedPnlUsd: decimalString(totalUnrealizedPnlUsd, 2),
    weightedPnlPct:
      !hasCrossPosition && totalMarginUsd > 0
        ? decimalString((totalUnrealizedPnlUsd / totalMarginUsd) * 100, 2)
        : null,
    weightedPnlPctUnavailableReason: hasCrossPosition
      ? "cross_margin_shared_collateral"
      : null,
    totalNotionalUsd: decimalString(totalNotionalUsd, 2),
    accountInitialMarginUsd: decimalString(totalMarginUsd, 2),
    accountMaintenanceMarginUsd: decimalString(
      accountMaintenanceMarginUsd,
      2
    ),
    accountOrderMarginUsd: decimalString(accountOrderMarginUsd, 2),
    crossAvailableUsd: decimalString(crossAvailableUsd, 2),
    initialMarginToCrossAvailablePct: initialMarginToAvailablePct,
    marginMode: hasCrossPosition ? "cross" : "isolated",
    riskAssessment:
      hasCrossPosition && !account?.cross_margin_balance
        ? "insufficient_fields_for_account_liquidation_safety"
        : "reference_only",
    totalMarginUsd: decimalString(totalMarginUsd, 2),
    totalMarginSemantics: accountInitialMarginUsd
      ? "gate_account_initial_margin"
      : "summed_position_margin_fallback",
    accountEquityUsd: decimalString(legacyEquity, 2),
    accountEquitySemantics:
      crossAvailableUsd > 0
        ? "legacy_alias_of_cross_available_not_total_equity"
        : "legacy_fallback_estimate",
    marginRatioPct: initialMarginToAvailablePct,
    marginRatioSemantics:
      initialMarginToAvailablePct === null
        ? "unavailable"
        : "initial_margin_divided_by_cross_available_not_liquidation_safety",
  };
}

function sseWrite(response, event, payload) {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

class GateOpenFuturesPositionsService {
  constructor({
    restClientFactory = () => new GateRestClient(),
    wsManager = cryptoGateWsManager,
  } = {}) {
    this.restClientFactory = restClientFactory;
    this.wsManager = wsManager;
    this.positionsMap = new Map();
    this.rawPositionsMap = new Map();
    this.account = null;
    this.lastRestFetchAt = null;
    this.lastWsMessageAt = null;
    this.lastError = null;
    this.subscribers = new Map();
    this.unsubscribePrivateEvents = null;
    this.broadcastTimer = null;
    this.pendingBroadcast = null;
    this.lastBroadcastAt = 0;
    this.fallbackTimer = null;
  }

  responsePayload(overrides = {}) {
    const positions = sortPositions(Array.from(this.positionsMap.values()));
    const wsStatus = this.wsManager.status?.()?.futuresUsdt?.status || "idle";
    const hasHealthyWs = wsStatus === "connected" && !this.lastError;
    return {
      success: true,
      asOf: Date.now(),
      exchange: "gate",
      marketType: "futures",
      settle: DEFAULT_SETTLE,
      positions,
      summary: summarizePositions(positions, this.account),
      connectionStatus: hasHealthyWs ? "connected" : "degraded",
      wsStatus,
      lastRestFetchAt: this.lastRestFetchAt,
      lastWsMessageAt: this.lastWsMessageAt,
      partialFailures: this.lastError
        ? [{ source: "futures_positions", message: this.lastError }]
        : [],
      ...overrides,
    };
  }

  applyRestSnapshot(rawPositions, account = null) {
    const nextMap = new Map();
    const nextRawMap = new Map();
    for (const raw of asArray(rawPositions)) {
      const normalized = normalizePosition(raw);
      if (normalized) {
        nextMap.set(normalized.id, normalized);
        nextRawMap.set(normalized.id, { ...raw });
      }
    }
    this.positionsMap = nextMap;
    this.rawPositionsMap = nextRawMap;
    this.account = account;
    this.lastRestFetchAt = Date.now();
    this.lastError = null;
    return this.responsePayload();
  }

  applyWsPositionUpdate(rawPayload) {
    const updates = asArray(rawPayload?.result ?? rawPayload);
    if (!updates.length) return this.responsePayload();

    for (const raw of updates) {
      const id = positionKey(raw);
      if (!id) continue;
      const mergedRaw = { ...(this.rawPositionsMap.get(id) || {}), ...raw };
      const normalized = normalizePosition(mergedRaw);
      if (normalized) {
        this.positionsMap.set(normalized.id, normalized);
        this.rawPositionsMap.set(normalized.id, mergedRaw);
      } else {
        this.positionsMap.delete(id);
        this.rawPositionsMap.delete(id);
      }
    }

    this.lastWsMessageAt = Date.now();
    this.lastError = null;
    return this.responsePayload();
  }

  handlePrivateEvent(event) {
    if (event?.source !== "futures_usdt") return;
    if (event?.eventType !== "position") return;
    const payload = this.applyWsPositionUpdate(event.payload);
    this.scheduleBroadcast("update", payload);
  }

  async snapshot() {
    const client = this.restClientFactory();
    const [accountResult, positionsResult] = await Promise.allSettled([
      client.getFuturesUsdtAccountRaw(),
      client.getFuturesUsdtPositionsRaw({ holding: true }),
    ]);

    if (
      positionsResult.status !== "fulfilled" ||
      !positionsResult.value?.success
    ) {
      const message =
        positionsResult.status === "fulfilled"
          ? positionsResult.value.safeErrorMessage ||
            "Gate futures positions failed."
          : safeErrorMessage(positionsResult.reason);
      throw new Error(message);
    }

    let account = null;
    const partialFailures = [];
    if (accountResult.status === "fulfilled" && accountResult.value?.success) {
      account = accountResult.value.data;
    } else {
      partialFailures.push({
        source: "futures_account",
        message:
          accountResult.status === "fulfilled"
            ? accountResult.value.safeErrorMessage ||
              "Gate futures account failed."
            : safeErrorMessage(accountResult.reason),
      });
    }

    const payload = this.applyRestSnapshot(positionsResult.value.data, account);
    return {
      ...payload,
      connectionStatus: partialFailures.length ? "degraded" : "connected",
      partialFailures,
    };
  }

  ensurePrivateWs() {
    if (!this.unsubscribePrivateEvents) {
      this.unsubscribePrivateEvents = this.wsManager.addPrivateEventListener(
        (event) => this.handlePrivateEvent(event)
      );
    }
    this.wsManager.start(getGateCredentials());
  }

  startFallbackScheduler() {
    if (this.fallbackTimer) return;
    this.fallbackTimer = setInterval(() => {
      this.runFallbackRefresh().catch(() => {});
    }, FALLBACK_REST_INTERVAL_MS);
  }

  stopFallbackScheduler() {
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.fallbackTimer = null;
  }

  async runFallbackRefresh() {
    if (!this.subscribers.size) return;
    try {
      const payload = await this.snapshot();
      this.scheduleBroadcast("snapshot", {
        ...payload,
        connectionStatus:
          payload.wsStatus === "connected" && !payload.partialFailures?.length
            ? "connected"
            : "degraded",
      });
    } catch (error) {
      this.lastError = safeErrorMessage(error);
      this.scheduleBroadcast("error", {
        success: false,
        asOf: Date.now(),
        exchange: "gate",
        marketType: "futures",
        settle: DEFAULT_SETTLE,
        connectionStatus: "disconnected",
        wsStatus: this.wsManager.status?.()?.futuresUsdt?.status || "idle",
        safeErrorMessage: this.lastError,
        positions: sortPositions(Array.from(this.positionsMap.values())),
        summary: summarizePositions(
          sortPositions(Array.from(this.positionsMap.values())),
          this.account
        ),
        lastRestFetchAt: this.lastRestFetchAt,
        lastWsMessageAt: this.lastWsMessageAt,
      });
    }
  }

  prepareSseResponse(response) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders?.();
  }

  async subscribe(response) {
    const id = `${Date.now()}:${Math.random().toString(16).slice(2)}`;
    this.prepareSseResponse(response);
    this.subscribers.set(id, response);
    const unsubscribe = () => {
      this.subscribers.delete(id);
      if (!this.subscribers.size) this.stopFallbackScheduler();
    };
    response.on("close", unsubscribe);
    response.on("error", unsubscribe);

    try {
      const snapshot = await this.snapshot();
      sseWrite(response, "snapshot", snapshot);
      this.ensurePrivateWs();
      this.startFallbackScheduler();
    } catch (error) {
      this.lastError = safeErrorMessage(error);
      sseWrite(response, "error", {
        success: false,
        asOf: Date.now(),
        exchange: "gate",
        marketType: "futures",
        settle: DEFAULT_SETTLE,
        connectionStatus: "disconnected",
        safeErrorMessage: this.lastError,
        positions: [],
        summary: summarizePositions([]),
      });
      response.end();
    }
    return unsubscribe;
  }

  scheduleBroadcast(event, payload) {
    this.pendingBroadcast = { event, payload };
    if (this.broadcastTimer) return;
    const delay = Math.max(
      0,
      STREAM_BROADCAST_THROTTLE_MS - (Date.now() - this.lastBroadcastAt)
    );
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      const pending = this.pendingBroadcast;
      this.pendingBroadcast = null;
      if (!pending) return;
      this.broadcast(pending.event, pending.payload);
    }, delay);
  }

  broadcast(event, payload) {
    this.lastBroadcastAt = Date.now();
    for (const response of this.subscribers.values()) {
      sseWrite(response, event, payload);
    }
  }
}

const cryptoGateOpenFuturesPositionsService =
  new GateOpenFuturesPositionsService();

module.exports = {
  GateOpenFuturesPositionsService,
  cryptoGateOpenFuturesPositionsService,
  normalizePosition,
  summarizePositions,
};
