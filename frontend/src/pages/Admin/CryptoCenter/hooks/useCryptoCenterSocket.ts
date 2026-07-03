import { useEffect } from "react";
import {
  createCryptoCenterSocket,
  fetchCryptoCenterSnapshot,
} from "@/lib/communication/crypto/cryptoCenterClient";
import { safeJsonParse } from "@/utils/request";
import { requestPriorityQueue } from "@/utils/chat/requestPriorityQueue";
import { cryptoServerStateStore } from "@/utils/serverState/cryptoServerStateStore";
import type { CryptoCenterEvent, TimeRange } from "../types";

export function useCryptoCenterSocket(
  range: TimeRange,
  onEvent: (event: CryptoCenterEvent) => void,
  onStatus: (
    status: "connecting" | "connected" | "degraded" | "disconnected",
    error?: string | null
  ) => void
) {
  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let cancelled = false;
    let attempts = 0;

    async function loadSnapshot() {
      onStatus("connecting");
      const cachedSnapshot = cryptoServerStateStore.getSnapshot(range, {
        allowStale: true,
      });
      if (cachedSnapshot && !cancelled) {
        onEvent({ type: "snapshot", data: cachedSnapshot });
      }
      try {
        const snapshot = await cryptoServerStateStore.ensureSnapshot(
          range,
          async ({ signal }: { signal: AbortSignal }) => {
            const result = await fetchCryptoCenterSnapshot(range, {
              signal,
              task: false,
              writeCache: false,
            });
            return result.data?.snapshot || null;
          },
          {
            priority: "P1",
            label: "crypto:snapshot",
            intentRank: 3,
            dedupeKey: `server-state:crypto.snapshot:${range}`,
          }
        );
        if (!snapshot || cancelled) return;
        onEvent({ type: "snapshot", data: snapshot });
      } catch (error) {
        onStatus(
          "degraded",
          error instanceof Error ? error.message : "Snapshot request failed."
        );
      }
    }

    function connect() {
      if (cancelled) return;
      onStatus(attempts === 0 ? "connecting" : "degraded");

      socket = createCryptoCenterSocket(range);
      socket.onopen = () => {
        attempts = 0;
        onStatus("connected");
      };
      socket.onmessage = (message) => {
        const event = safeJsonParse(
          message.data,
          null
        ) as CryptoCenterEvent | null;
        if (event?.type) onEvent(event);
      };
      socket.onerror = () => {
        onStatus("degraded", "Crypto stream connection error.");
      };
      socket.onclose = () => {
        if (cancelled) return;
        attempts += 1;
        onStatus("disconnected", "Crypto stream disconnected.");
        const delay = Math.min(15000, 1000 * 2 ** Math.min(attempts, 4));
        reconnectTimer = window.setTimeout(connect, delay);
      };
    }

    loadSnapshot().finally(connect);

    return () => {
      cancelled = true;
      requestPriorityQueue.cancelScope(
        { route: "crypto-center", surface: "snapshot" },
        "crypto-socket-unmount"
      );
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (socket) socket.close();
    };
  }, [range, onEvent, onStatus]);
}
