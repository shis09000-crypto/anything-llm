import { useCallback, useEffect, useRef, useState } from "react";
import { cryptoHubFetch } from "./useCryptoHubQuery";

export type CryptoHubLoadingItem = {
  key: string;
  label: string;
  status: "pending" | "loading" | "ready" | "degraded" | "error";
  pct: number;
  message?: string;
  safeErrorMessage?: string | null;
};

export type CryptoHubLoadingProgress = {
  phase:
    | "initializing"
    | "connecting"
    | "loading"
    | "ready"
    | "degraded"
    | "error";
  overallPct: number;
  items: CryptoHubLoadingItem[];
  updatedAt: number;
};

const INIT_TIMEOUT_MS = 10_000;
const POLL_MS = 500;

export function useCryptoHubInit({ enabled = true } = {}) {
  const [progress, setProgress] = useState<CryptoHubLoadingProgress | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const startedAtRef = useRef<number | null>(null);
  const retryNonceRef = useRef(0);

  const run = useCallback(async () => {
    if (!enabled) {
      setReady(true);
      return;
    }
    retryNonceRef.current += 1;
    const runId = retryNonceRef.current;
    startedAtRef.current = Date.now();
    setRunning(true);
    setReady(false);
    setError(null);

    cryptoHubFetch("/init", { method: "POST" }).catch((requestError) => {
      if (retryNonceRef.current !== runId) return;
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Crypto Hub 初始化失败"
      );
    });

    let stopped = false;
    while (!stopped && retryNonceRef.current === runId) {
      try {
        const next =
          await cryptoHubFetch<CryptoHubLoadingProgress>("/loading-progress");
        if (retryNonceRef.current !== runId) return;
        setProgress(next);
        const elapsed = Date.now() - (startedAtRef.current || Date.now());
        if (
          next.phase === "ready" ||
          next.phase === "degraded" ||
          elapsed >= INIT_TIMEOUT_MS
        ) {
          setReady(true);
          setRunning(false);
          stopped = true;
          return;
        }
      } catch (requestError) {
        if (retryNonceRef.current !== runId) return;
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Crypto Hub 初始化状态读取失败"
        );
      }
      await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
    }
  }, [enabled]);

  useEffect(() => {
    run();
    return () => {
      retryNonceRef.current += 1;
    };
  }, [run]);

  return {
    progress,
    error,
    ready,
    running,
    retry: run,
  };
}
