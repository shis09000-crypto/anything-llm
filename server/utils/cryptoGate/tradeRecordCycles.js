const { DataAccessCenter } = require("../dataAccess");
const { readSecret, saveSecret } = require("../security");

const SystemSettings = DataAccessCenter.adminSystem;

const TRADE_RECORDS_CYCLE_MEMORY_KEY =
  "anythingllm_crypto_trade_records_cycle_memory_v1";
const MAX_CYCLE_MEMORY_ITEMS = 1000;

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.cycles)) return value.cycles;
  return [];
}

function numberValue(value, fallback = 0) {
  const number = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(number) ? number : fallback;
}

function decimalString(value, digits = 2) {
  return numberValue(value).toFixed(digits);
}

function trimDecimal(value, digits = 8) {
  const number = numberValue(value);
  if (Math.abs(number) < 1e-12) return "0";
  return number
    .toFixed(digits)
    .replace(/\.?0+$/, "")
    .replace(/\.$/, "");
}

function normalizeContractType(value) {
  return value === "delivery" ? "delivery" : "perpetual";
}

function normalizeSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/_/g, "");
}

function recordKey(record) {
  return `${record.marketType}:${record.id}:${record.orderId}`;
}

function cycleSideForAction(action) {
  if (action === "futures_open_long" || action === "futures_close_long") {
    return "long";
  }
  if (action === "futures_open_short" || action === "futures_close_short") {
    return "short";
  }
  return null;
}

function isOpenAction(action) {
  return action === "futures_open_long" || action === "futures_open_short";
}

function isCloseAction(action) {
  return action === "futures_close_long" || action === "futures_close_short";
}

function directionPoolKey(record) {
  const side = cycleSideForAction(record.action);
  if (!side) return null;
  return `${normalizeSymbol(record.symbol)}:${normalizeContractType(
    record.contractType
  )}:${side}`;
}

function sortAsc(records) {
  return [...records].sort((left, right) => {
    if (left.ts !== right.ts) return left.ts - right.ts;
    const leftKey = `${left.orderId || ""}:${left.id || ""}`;
    const rightKey = `${right.orderId || ""}:${right.id || ""}`;
    return leftKey.localeCompare(rightKey);
  });
}

function collectUnique(values) {
  return Array.from(
    new Set(
      values
        .flat()
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

function weightedAvg(records) {
  const quantity = records.reduce(
    (sum, record) => sum + Math.abs(numberValue(record.quantity)),
    0
  );
  const weighted = records.reduce(
    (sum, record) =>
      sum + Math.abs(numberValue(record.quantity)) * numberValue(record.price),
    0
  );
  return quantity > 0 && weighted > 0
    ? trimDecimal(weighted / quantity, 8)
    : null;
}

function memorySignatureForParts({
  symbol,
  contractType,
  side,
  openOrderIds,
  closeOrderIds,
}) {
  return [
    normalizeSymbol(symbol),
    normalizeContractType(contractType),
    side,
    collectUnique(openOrderIds).sort().join("|"),
    collectUnique(closeOrderIds).sort().join("|"),
  ].join(":");
}

function memorySignatureForCycle(cycle) {
  return memorySignatureForParts({
    symbol: cycle.symbol,
    contractType: cycle.contractType,
    side: cycle.side,
    openOrderIds: cycle.openOrderIds || [],
    closeOrderIds: cycle.closeOrderIds || [],
  });
}

function memoryMapBySignature(memoryItems) {
  const map = new Map();
  for (const item of asArray(memoryItems)) {
    if (!isRecord(item) || !item.cycleId) continue;
    const signature = item.signature || memorySignatureForCycle(item);
    if (signature) map.set(signature, item);
  }
  return map;
}

function memoryOrderKey({ symbol, contractType, side, role, orderId }) {
  const id = String(orderId || "").trim();
  if (!id || id === "--") return "";
  return [
    normalizeSymbol(symbol),
    normalizeContractType(contractType),
    side,
    role,
    id,
  ].join(":");
}

function setMemoryIndex(map, key, memory, role) {
  if (!key || map.has(key)) return;
  map.set(key, { memory, role });
}

function memoryRecordIndex(memoryItems) {
  const recordKeys = new Map();
  const orderKeys = new Map();
  const tradeIds = new Map();

  for (const item of asArray(memoryItems)) {
    if (!isRecord(item) || !item.cycleId) continue;
    for (const key of collectUnique(item.openRecordKeys || [])) {
      setMemoryIndex(recordKeys, key, item, "open");
    }
    for (const key of collectUnique(item.closeRecordKeys || [])) {
      setMemoryIndex(recordKeys, key, item, "close");
    }
    for (const orderId of collectUnique(item.openOrderIds || [])) {
      setMemoryIndex(
        orderKeys,
        memoryOrderKey({
          symbol: item.symbol,
          contractType: item.contractType,
          side: item.side,
          role: "open",
          orderId,
        }),
        item,
        "open"
      );
    }
    for (const orderId of collectUnique(item.closeOrderIds || [])) {
      setMemoryIndex(
        orderKeys,
        memoryOrderKey({
          symbol: item.symbol,
          contractType: item.contractType,
          side: item.side,
          role: "close",
          orderId,
        }),
        item,
        "close"
      );
    }
    for (const tradeId of collectUnique(item.openTradeIds || [])) {
      setMemoryIndex(tradeIds, tradeId, item, "open");
    }
    for (const tradeId of collectUnique(item.closeTradeIds || [])) {
      setMemoryIndex(tradeIds, tradeId, item, "close");
    }
  }

  return { recordKeys, orderKeys, tradeIds };
}

function createCycleId({
  symbol,
  contractType,
  side,
  openedAt,
  sequence,
  memory,
}) {
  if (memory?.cycleId) return memory.cycleId;
  const normalizedSymbol = normalizeSymbol(symbol);
  const type = normalizeContractType(contractType);
  const timePart = openedAt ? String(openedAt) : "boundary";
  return `cycle:${normalizedSymbol}:${type}:${side}:${timePart}:${sequence}`;
}

function createEmptyCycle({
  record,
  side,
  status = "open",
  confidence = "partial_history",
  openedAt = record?.ts ?? null,
  closedAt = null,
  sequence,
  memory,
  historyCoverage,
  hasBoundaryOpen = false,
  boundaryReason,
}) {
  return {
    id: createCycleId({
      symbol: record?.symbol || memory?.symbol || "UNKNOWN",
      contractType: record?.contractType || memory?.contractType || "perpetual",
      side,
      openedAt,
      sequence,
      memory,
    }),
    symbol: normalizeSymbol(record?.symbol || memory?.symbol || "UNKNOWN"),
    contractType: normalizeContractType(
      record?.contractType || memory?.contractType || "perpetual"
    ),
    side,
    status,
    openedAt,
    closedAt,
    openRecordKeys: [],
    closeRecordKeys: [],
    openTradeIds: [],
    closeTradeIds: [],
    openOrderIds: [],
    closeOrderIds: [],
    matches: [],
    totalOpenedQty: "0",
    totalClosedQty: "0",
    remainingQty: "0",
    avgOpenPrice: null,
    avgClosePrice: null,
    realizedPnlUsd: "0.00",
    totalFeeUsd: "0.00",
    durationMs: null,
    hasUnmatchedClose: false,
    unmatchedCloseQty: undefined,
    historyWindowStartAt: historyCoverage.loadedFrom * 1000,
    historyWindowEndAt: historyCoverage.loadedTo * 1000,
    hasBoundaryOpen,
    boundaryReason,
    cycleConfidence: confidence,
  };
}

function annotateRecord(record, cycle, matchRole, extra = {}) {
  return {
    ...record,
    cycleId: cycle.id,
    cycleStatus: cycle.status,
    cycleConfidence: cycle.cycleConfidence,
    matchRole,
    ...extra,
  };
}

function createMemoryBackedCycle(memory, historyCoverage) {
  return {
    id: memory.cycleId,
    symbol: normalizeSymbol(memory.symbol || "UNKNOWN"),
    contractType: normalizeContractType(memory.contractType),
    side: memory.side === "short" ? "short" : "long",
    status: "closed",
    openedAt: memory.openedAt || null,
    closedAt: memory.closedAt || null,
    openRecordKeys: memory.openRecordKeys || [],
    closeRecordKeys: memory.closeRecordKeys || [],
    openTradeIds: memory.openTradeIds || [],
    closeTradeIds: memory.closeTradeIds || [],
    openOrderIds: memory.openOrderIds || [],
    closeOrderIds: memory.closeOrderIds || [],
    matches: memory.matches || [],
    totalOpenedQty: memory.totalOpenedQty || "0",
    totalClosedQty: memory.totalClosedQty || "0",
    remainingQty: memory.remainingQty || "0",
    avgOpenPrice: memory.avgOpenPrice || null,
    avgClosePrice: memory.avgClosePrice || null,
    realizedPnlUsd: memory.realizedPnlUsd || "0.00",
    totalFeeUsd: memory.totalFeeUsd || "0.00",
    durationMs:
      memory.openedAt && memory.closedAt
        ? memory.closedAt - memory.openedAt
        : null,
    hasUnmatchedClose: false,
    unmatchedCloseQty: undefined,
    historyWindowStartAt: historyCoverage.loadedFrom * 1000,
    historyWindowEndAt: historyCoverage.loadedTo * 1000,
    hasBoundaryOpen: false,
    boundaryReason: "restored_from_complete_cycle_memory",
    cycleConfidence: "complete",
    isMemoryBacked: true,
    isPartialInWindow: true,
  };
}

function finalizeCycle(cycle, openRecords, closeRecords) {
  const openedQty = openRecords.reduce(
    (sum, record) => sum + Math.abs(numberValue(record.quantity)),
    0
  );
  const closedQty = closeRecords.reduce(
    (sum, record) => sum + Math.abs(numberValue(record.quantity)),
    0
  );
  const feeUsd = [...openRecords, ...closeRecords].reduce(
    (sum, record) => sum + Math.abs(numberValue(record.feeUsd)),
    0
  );
  const realizedPnl = closeRecords.reduce(
    (sum, record) => sum + numberValue(record.realizedPnlUsd),
    0
  );
  const remainingQty = Math.max(0, openedQty - closedQty);
  const status = cycle.hasUnmatchedClose
    ? cycle.openTradeIds.length
      ? "partial"
      : "unmatched"
    : remainingQty <= 1e-8 && openRecords.length && closeRecords.length
      ? "closed"
      : openRecords.length
        ? "open"
        : cycle.status;
  const confidence =
    status === "closed" && !cycle.hasBoundaryOpen && !cycle.hasUnmatchedClose
      ? "complete"
      : cycle.cycleConfidence === "unmatched"
        ? "unmatched"
        : "partial_history";

  cycle.status = status;
  cycle.totalOpenedQty = trimDecimal(openedQty, 8);
  cycle.totalClosedQty = trimDecimal(closedQty, 8);
  cycle.remainingQty = trimDecimal(remainingQty, 8);
  cycle.avgOpenPrice = weightedAvg(openRecords);
  cycle.avgClosePrice = weightedAvg(closeRecords);
  cycle.realizedPnlUsd = decimalString(realizedPnl, 2);
  cycle.totalFeeUsd = decimalString(feeUsd, 4);
  cycle.openedAt = openRecords.length ? openRecords[0].ts : cycle.openedAt;
  cycle.closedAt =
    status === "closed" && closeRecords.length
      ? closeRecords[closeRecords.length - 1].ts
      : cycle.closedAt;
  cycle.durationMs =
    cycle.openedAt && cycle.closedAt ? cycle.closedAt - cycle.openedAt : null;
  cycle.cycleConfidence = confidence;
  cycle.openRecordKeys = collectUnique(openRecords.map(recordKey));
  cycle.closeRecordKeys = collectUnique(closeRecords.map(recordKey));
  cycle.openOrderIds = collectUnique(
    openRecords.map((record) => record.orderId)
  );
  cycle.closeOrderIds = collectUnique(
    closeRecords.map((record) => record.orderId)
  );
}

class FuturesTradeCycleBuilder {
  constructor({
    records = [],
    historyCoverage,
    openPositions = [],
    cycleMemory = [],
  } = {}) {
    this.records = records;
    this.historyCoverage = historyCoverage;
    this.openPositions = openPositions;
    this.memoryBySignature = memoryMapBySignature(cycleMemory);
    this.memoryRecordIndex = memoryRecordIndex(cycleMemory);
    this.annotatedByKey = new Map();
    this.cycles = [];
    this.sequenceByPool = new Map();
  }

  nextSequence(poolKey) {
    const next = (this.sequenceByPool.get(poolKey) || 0) + 1;
    this.sequenceByPool.set(poolKey, next);
    return next;
  }

  build() {
    const futuresRecords = sortAsc(
      this.records.filter((record) => record.marketType === "futures")
    );
    const pools = new Map();

    for (const record of futuresRecords) {
      const side = cycleSideForAction(record.action);
      const poolKey = directionPoolKey(record);
      if (!side || !poolKey) continue;
      if (!pools.has(poolKey)) {
        pools.set(poolKey, {
          currentCycle: null,
          openLots: [],
          openRecords: [],
          closeRecords: [],
        });
      }
      const pool = pools.get(poolKey);
      if (isOpenAction(record.action)) {
        this.handleOpenRecord(record, side, poolKey, pool);
      } else if (isCloseAction(record.action)) {
        this.handleCloseRecord(record, side, poolKey, pool);
      }
    }

    for (const pool of pools.values()) {
      if (pool.currentCycle) {
        finalizeCycle(pool.currentCycle, pool.openRecords, pool.closeRecords);
      }
    }

    this.applyBoundaryPositions();
    this.applyMemoryIds();
    this.syncAnnotatedCycleMetadata();
    this.applyMemoryRecordRestoration(futuresRecords);
    this.pruneUnusedCycles();
    this.syncAnnotatedCycleMetadata();

    const annotatedRecords = this.records.map((record) => {
      const annotated = this.annotatedByKey.get(recordKey(record));
      return annotated || record;
    });

    return {
      records: annotatedRecords,
      cycles: this.cycles.sort((left, right) => {
        const leftTs =
          left.closedAt || left.openedAt || left.historyWindowStartAt;
        const rightTs =
          right.closedAt || right.openedAt || right.historyWindowStartAt;
        return rightTs - leftTs;
      }),
      memoryUpdates: this.cycles.filter(
        (cycle) =>
          cycle.cycleConfidence === "complete" && cycle.status === "closed"
      ),
    };
  }

  handleOpenRecord(record, side, poolKey, pool) {
    if (!pool.currentCycle) {
      pool.currentCycle = createEmptyCycle({
        record,
        side,
        status: "open",
        confidence: "partial_history",
        sequence: this.nextSequence(poolKey),
        historyCoverage: this.historyCoverage,
      });
      this.cycles.push(pool.currentCycle);
    }

    const quantity = Math.abs(numberValue(record.quantity));
    const lot = {
      id: `lot:${record.id}`,
      tradeId: record.id,
      orderId: record.orderId,
      symbol: record.symbol,
      side,
      openedAt: record.ts,
      price: record.price,
      qtyOriginal: trimDecimal(quantity, 8),
      qtyRemaining: trimDecimal(quantity, 8),
      feeUsd: record.feeUsd,
    };
    pool.openLots.push(lot);
    pool.openRecords.push(record);
    pool.currentCycle.openTradeIds = collectUnique([
      pool.currentCycle.openTradeIds,
      record.fillIds || [record.id],
    ]);
    this.annotatedByKey.set(
      recordKey(record),
      annotateRecord(record, pool.currentCycle, "open", {
        matchedQty: trimDecimal(quantity, 8),
      })
    );
  }

  handleCloseRecord(record, side, poolKey, pool) {
    const closeQtyOriginal = Math.abs(numberValue(record.quantity));
    let closeQtyRemaining = closeQtyOriginal;

    if (!pool.currentCycle || !pool.openLots.length) {
      const cycle = createEmptyCycle({
        record,
        side,
        status: "unmatched",
        confidence: "unmatched",
        openedAt: null,
        closedAt: record.ts,
        sequence: this.nextSequence(poolKey),
        historyCoverage: this.historyCoverage,
        hasBoundaryOpen: true,
        boundaryReason: "loaded_window_started_with_close",
      });
      cycle.closeTradeIds = collectUnique([record.fillIds || [record.id]]);
      cycle.closeRecordKeys = collectUnique([recordKey(record)]);
      cycle.closeOrderIds = collectUnique([record.orderId]);
      cycle.totalClosedQty = trimDecimal(closeQtyOriginal, 8);
      cycle.unmatchedCloseQty = trimDecimal(closeQtyOriginal, 8);
      cycle.hasUnmatchedClose = true;
      cycle.avgClosePrice = record.price;
      cycle.totalFeeUsd = decimalString(record.feeUsd, 4);
      cycle.realizedPnlUsd = decimalString(record.realizedPnlUsd, 2);
      this.cycles.push(cycle);
      this.annotatedByKey.set(
        recordKey(record),
        annotateRecord(record, cycle, "unmatched_close", {
          matchedQty: "0",
          matchWarning: "missing_open_before_window",
        })
      );
      return;
    }

    const cycle = pool.currentCycle;
    const matches = [];
    for (const lot of [...pool.openLots]) {
      if (closeQtyRemaining <= 1e-8) break;
      const lotRemaining = numberValue(lot.qtyRemaining);
      if (lotRemaining <= 1e-8) {
        pool.openLots.shift();
        continue;
      }
      const matchedQty = Math.min(closeQtyRemaining, lotRemaining);
      const openPrice = numberValue(lot.price);
      const closePrice = numberValue(record.price);
      const pnlUsd =
        side === "long"
          ? (closePrice - openPrice) * matchedQty
          : (openPrice - closePrice) * matchedQty;
      matches.push({
        id: `match:${lot.id}:${record.id}:${matches.length + 1}`,
        cycleId: cycle.id,
        openLotId: lot.id,
        closeTradeId: record.id,
        matchedQty: trimDecimal(matchedQty, 8),
        openPrice: trimDecimal(openPrice, 8),
        closePrice: trimDecimal(closePrice, 8),
        pnlUsd: decimalString(pnlUsd, 2),
        pnlSource: record.realizedPnlUsd === null ? "estimated" : "gate",
      });
      lot.qtyRemaining = trimDecimal(lotRemaining - matchedQty, 8);
      closeQtyRemaining -= matchedQty;
      if (numberValue(lot.qtyRemaining) <= 1e-8) pool.openLots.shift();
    }

    cycle.matches.push(...matches);
    cycle.closeTradeIds = collectUnique([
      cycle.closeTradeIds,
      record.fillIds || [record.id],
    ]);
    pool.closeRecords.push(record);

    let matchWarning;
    if (closeQtyRemaining > 1e-8) {
      cycle.hasUnmatchedClose = true;
      cycle.unmatchedCloseQty = trimDecimal(
        numberValue(cycle.unmatchedCloseQty) + closeQtyRemaining,
        8
      );
      cycle.cycleConfidence = "partial_history";
      matchWarning = "unmatched_close";
    }

    const matchedQty = Math.max(0, closeQtyOriginal - closeQtyRemaining);
    this.annotatedByKey.set(
      recordKey(record),
      annotateRecord(
        record,
        cycle,
        closeQtyRemaining > 1e-8 ? "unmatched_close" : "close",
        {
          matchedQty: trimDecimal(matchedQty, 8),
          ...(matchWarning ? { matchWarning } : {}),
        }
      )
    );

    if (!pool.openLots.length) {
      finalizeCycle(cycle, pool.openRecords, pool.closeRecords);
      pool.currentCycle = null;
      pool.openRecords = [];
      pool.closeRecords = [];
    }
  }

  applyBoundaryPositions() {
    for (const position of this.openPositions) {
      if (!isRecord(position)) continue;
      const symbol = normalizeSymbol(position.symbol);
      const side = position.side === "short" ? "short" : "long";
      const contractType = normalizeContractType(position.contractType);
      const poolKey = `${symbol}:${contractType}:${side}`;
      const existingOpenCycle = this.cycles.some(
        (cycle) =>
          normalizeSymbol(cycle.symbol) === symbol &&
          normalizeContractType(cycle.contractType) === contractType &&
          cycle.side === side &&
          numberValue(cycle.remainingQty) > 0
      );
      if (existingOpenCycle) continue;
      const quantity = numberValue(
        position.quantityAmount || position.quantity
      );
      if (quantity <= 0) continue;
      const cycle = createEmptyCycle({
        record: {
          symbol,
          contractType,
          ts: this.historyCoverage.loadedFrom * 1000,
        },
        side,
        status: "partial",
        confidence: "partial_history",
        openedAt: null,
        sequence: this.nextSequence(poolKey),
        historyCoverage: this.historyCoverage,
        hasBoundaryOpen: true,
        boundaryReason: "position_existed_before_window",
      });
      cycle.remainingQty = trimDecimal(quantity, 8);
      cycle.avgOpenPrice =
        numberValue(position.entryPrice) > 0
          ? trimDecimal(position.entryPrice, 8)
          : null;
      this.cycles.push(cycle);
    }
  }

  applyMemoryIds() {
    for (const cycle of this.cycles) {
      if (!cycle.openOrderIds?.length || !cycle.closeOrderIds?.length) continue;
      const signature = memorySignatureForCycle(cycle);
      const memory = this.memoryBySignature.get(signature);
      if (!memory?.cycleId || memory.cycleId === cycle.id) continue;
      const oldId = cycle.id;
      cycle.id = memory.cycleId;
      cycle.matches = cycle.matches.map((match) => ({
        ...match,
        cycleId: cycle.id,
      }));
      for (const [key, record] of this.annotatedByKey.entries()) {
        if (record.cycleId !== oldId) continue;
        this.annotatedByKey.set(key, { ...record, cycleId: cycle.id });
      }
    }
  }

  memoryCycle(memory) {
    const existing = this.cycles.find((cycle) => cycle.id === memory.cycleId);
    if (existing) return existing;
    const cycle = createMemoryBackedCycle(memory, this.historyCoverage);
    this.cycles.push(cycle);
    return cycle;
  }

  memoryForRecord(record) {
    const key = recordKey(record);
    const direct = this.memoryRecordIndex.recordKeys.get(key);
    if (direct) return direct;

    const side = cycleSideForAction(record.action);
    const role = isOpenAction(record.action)
      ? "open"
      : isCloseAction(record.action)
        ? "close"
        : null;
    if (!side || !role) return null;

    const orderMatch = this.memoryRecordIndex.orderKeys.get(
      memoryOrderKey({
        symbol: record.symbol,
        contractType: record.contractType,
        side,
        role,
        orderId: record.orderId,
      })
    );
    if (orderMatch) return orderMatch;

    for (const tradeId of collectUnique(record.fillIds || [record.id])) {
      const tradeMatch = this.memoryRecordIndex.tradeIds.get(tradeId);
      if (tradeMatch) return tradeMatch;
    }

    return null;
  }

  applyMemoryRecordRestoration(futuresRecords) {
    for (const record of futuresRecords) {
      const memoryMatch = this.memoryForRecord(record);
      if (!memoryMatch?.memory?.cycleId) continue;

      const existing = this.annotatedByKey.get(recordKey(record));
      if (
        existing?.cycleId === memoryMatch.memory.cycleId &&
        existing.cycleConfidence === "complete"
      ) {
        continue;
      }

      const cycle = this.memoryCycle(memoryMatch.memory);
      const role =
        memoryMatch.role === "close"
          ? "close"
          : memoryMatch.role === "open"
            ? "open"
            : isCloseAction(record.action)
              ? "close"
              : "open";
      this.annotatedByKey.set(
        recordKey(record),
        annotateRecord(record, cycle, role, {
          matchedQty:
            existing?.matchedQty ||
            trimDecimal(Math.abs(numberValue(record.quantity)), 8),
          matchWarning:
            existing?.matchWarning === "missing_open_before_window"
              ? "window_boundary"
              : existing?.matchWarning || "window_boundary",
        })
      );
    }
  }

  pruneUnusedCycles() {
    const usedCycleIds = new Set(
      Array.from(this.annotatedByKey.values())
        .map((record) => record.cycleId)
        .filter(Boolean)
    );
    this.cycles = this.cycles.filter(
      (cycle) =>
        usedCycleIds.has(cycle.id) ||
        cycle.boundaryReason === "position_existed_before_window"
    );
  }

  syncAnnotatedCycleMetadata() {
    const cycleById = new Map(this.cycles.map((cycle) => [cycle.id, cycle]));
    for (const [key, record] of this.annotatedByKey.entries()) {
      const cycle = cycleById.get(record.cycleId);
      if (!cycle) continue;
      this.annotatedByKey.set(key, {
        ...record,
        cycleStatus: cycle.status,
        cycleConfidence: cycle.cycleConfidence,
      });
    }
  }
}

function serializeCycleForMemory(cycle) {
  const signature = memorySignatureForCycle(cycle);
  return {
    version: 1,
    cycleId: cycle.id,
    signature,
    symbol: cycle.symbol,
    contractType: cycle.contractType,
    side: cycle.side,
    status: cycle.status,
    openedAt: cycle.openedAt,
    closedAt: cycle.closedAt,
    openRecordKeys: cycle.openRecordKeys || [],
    closeRecordKeys: cycle.closeRecordKeys || [],
    openTradeIds: cycle.openTradeIds || [],
    closeTradeIds: cycle.closeTradeIds || [],
    openOrderIds: cycle.openOrderIds || [],
    closeOrderIds: cycle.closeOrderIds || [],
    totalOpenedQty: cycle.totalOpenedQty,
    totalClosedQty: cycle.totalClosedQty,
    remainingQty: cycle.remainingQty,
    avgOpenPrice: cycle.avgOpenPrice,
    avgClosePrice: cycle.avgClosePrice,
    realizedPnlUsd: cycle.realizedPnlUsd,
    totalFeeUsd: cycle.totalFeeUsd,
    updatedAt: Date.now(),
  };
}

class SystemSettingsTradeCycleMemoryStore {
  constructor({
    settings = SystemSettings,
    key = TRADE_RECORDS_CYCLE_MEMORY_KEY,
    maxItems = MAX_CYCLE_MEMORY_ITEMS,
  } = {}) {
    this.settings = settings;
    this.key = key;
    this.maxItems = maxItems;
  }

  async load() {
    try {
      const setting = await this.settings.get({ label: this.key });
      const rawValue = setting?.value ? readSecret(setting.value) : null;
      const parsed = rawValue ? JSON.parse(rawValue) : null;
      return asArray(parsed);
    } catch {
      return [];
    }
  }

  async saveCompleteCycles(cycles = []) {
    const completeCycles = cycles.filter(
      (cycle) =>
        cycle?.cycleConfidence === "complete" && cycle?.status === "closed"
    );
    if (!completeCycles.length) return [];
    const existing = await this.load();
    const bySignature = new Map();
    for (const item of existing) {
      if (!isRecord(item)) continue;
      const signature = item.signature || memorySignatureForCycle(item);
      if (signature) bySignature.set(signature, item);
    }
    for (const cycle of completeCycles) {
      const item = serializeCycleForMemory(cycle);
      bySignature.set(item.signature, item);
    }
    const next = Array.from(bySignature.values())
      .sort(
        (left, right) =>
          numberValue(right.closedAt) - numberValue(left.closedAt)
      )
      .slice(0, this.maxItems);
    const payload = {
      version: 1,
      updatedAt: Date.now(),
      cycles: next,
    };
    await this.settings._updateSettings({
      [this.key]: saveSecret(JSON.stringify(payload)),
    });
    return next;
  }
}

function buildTradeCycles({
  records,
  historyCoverage,
  openPositions,
  cycleMemory,
}) {
  const builder = new FuturesTradeCycleBuilder({
    records,
    historyCoverage,
    openPositions,
    cycleMemory,
  });
  return builder.build();
}

module.exports = {
  TRADE_RECORDS_CYCLE_MEMORY_KEY,
  FuturesTradeCycleBuilder,
  SystemSettingsTradeCycleMemoryStore,
  buildTradeCycles,
  memorySignatureForCycle,
  serializeCycleForMemory,
};
