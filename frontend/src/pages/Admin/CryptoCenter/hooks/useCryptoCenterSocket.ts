import { useEffect } from "react";
import { API_BASE, AUTH_TOKEN, fullApiUrl } from "@/utils/constants";
import { baseHeaders, safeJsonParse } from "@/utils/request";
import type { CryptoCenterEvent, TimeRange } from "../types";

function cryptoStreamUrl(range: TimeRange) {
  const token = window.localStorage.getItem(AUTH_TOKEN);
  const url = new URL("crypto-center/stream", `${fullApiUrl()}/`);
  url.searchParams.set("range", range);
  if (token) url.searchParams.set("token", token);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

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
        const response = await fetch(
          `${API_BASE}/crypto-center/snapshot?range=${range}`,
          {
            headers: baseHeaders(),
          }
        );
        if (!response.ok) throw new Error("Snapshot request failed.");
        const payload = await response.json();
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

      socket = new WebSocket(cryptoStreamUrl(range));
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
