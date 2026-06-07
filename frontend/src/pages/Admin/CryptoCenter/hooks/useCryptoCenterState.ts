import { useReducer } from "react";
import type {
  AlertItem,
  CryptoCenterEvent,
  CryptoCenterSnapshot,
  KpiMetric,
  SocketStatus,
} from "../types";

interface CryptoCenterState {
  snapshot: CryptoCenterSnapshot | null;
  socketStatus: SocketStatus;
  lastHeartbeatAt: number | null;
  lastError: string | null;
}

type Action =
  | { type: "event"; event: CryptoCenterEvent }
  | { type: "socket"; status: SocketStatus; error?: string | null };

function mergeKpis(kpis: KpiMetric[], update: Partial<KpiMetric>) {
  if (!update.key) return kpis;
  return kpis.map((kpi) =>
    kpi.key === update.key ? { ...kpi, ...update } : kpi
  );
}

function appendAlert(alerts: AlertItem[], alert: AlertItem) {
  if (alerts.some((item) => item.id === alert.id)) return alerts;
  return [alert, ...alerts].slice(0, 24);
}

function reducer(state: CryptoCenterState, action: Action): CryptoCenterState {
  if (action.type === "socket") {
    return {
      ...state,
      socketStatus: action.status,
      lastError: action.error ?? null,
    };
  }

  const { event } = action;
  if (event.type === "snapshot") {
    return {
      ...state,
      snapshot: event.data,
      lastHeartbeatAt: event.data.asOf,
      socketStatus: "connected",
      lastError: null,
    };
  }

  if (event.type === "heartbeat") {
    return { ...state, lastHeartbeatAt: event.ts, socketStatus: "connected" };
  }

  if (!state.snapshot) return state;

  switch (event.type) {
    case "kpi:update":
      return {
        ...state,
        snapshot: {
          ...state.snapshot,
          asOf: Date.now(),
          kpis: mergeKpis(state.snapshot.kpis, event.data),
        },
      };
    case "asset:update":
      return {
        ...state,
        snapshot: { ...state.snapshot, asOf: Date.now(), assets: event.data },
      };
    case "position:update":
      return {
        ...state,
        snapshot: {
          ...state.snapshot,
          asOf: Date.now(),
          positions: event.data,
        },
      };
    case "order:update":
      return {
        ...state,
        snapshot: { ...state.snapshot, asOf: Date.now(), orders: event.data },
      };
    case "trade:append":
      return {
        ...state,
        snapshot: {
          ...state.snapshot,
          asOf: Date.now(),
          trades: [
            event.data,
            ...state.snapshot.trades.filter(
              (trade) => trade.id !== event.data.id
            ),
          ].slice(0, 40),
        },
      };
    case "risk:update":
      return {
        ...state,
        snapshot: { ...state.snapshot, asOf: Date.now(), risk: event.data },
      };
    case "alert:append":
      return {
        ...state,
        snapshot: {
          ...state.snapshot,
          asOf: Date.now(),
          alerts: appendAlert(state.snapshot.alerts, event.data),
        },
      };
    case "connection:update":
      return {
        ...state,
        snapshot: {
          ...state.snapshot,
          asOf: Date.now(),
          exchanges: event.data,
        },
      };
    default:
      return state;
  }
}

export function useCryptoCenterState() {
  return useReducer(reducer, {
    snapshot: null,
    socketStatus: "connecting",
    lastHeartbeatAt: null,
    lastError: null,
  });
}
