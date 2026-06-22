import { useEffect } from "react";
import {
  createCryptoCenterSocket,
  fetchCryptoCenterSnapshot,
} from "@/lib/communication/crypto/cryptoCenterClient";
import { safeJsonParse } from "@/utils/request";
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
      try {
        const { data: payload } = await fetchCryptoCenterSnapshot(range);
        if (payload?.snapshot)
          onEvent({ type: "snapshot", data: payload.snapshot });
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
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (socket) socket.close();
    };
  }, [range, onEvent, onStatus]);
}
