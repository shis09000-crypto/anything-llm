import { useCallback, useEffect, useRef, useState } from "react";
import { cryptoHubFetch } from "./useCryptoHubQuery";
import { requestPriorityQueue } from "@/utils/chat/requestPriorityQueue";
import { cryptoServerStateStore } from "@/utils/serverState/cryptoServerStateStore";

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
const POLL_MS = 1_000;
const READY_PROGRESS_FAST_PATH_MS = 30_000;

function isRecentReadyProgress(progress: CryptoHubLoadingProgress | null) {
  if (!progress || progress.phase !== "ready") return false;
  const updatedAt = Number(progress.updatedAt || 0);
  return (
    Number.isFinite(updatedAt) &&
    Date.now() - updatedAt < READY_PROGRESS_FAST_PATH_MS
  );
}

export function useCryptoHubInit({ enabled = true } = {}) {
  const [progress, setProgress] = useState<CryptoHubLoadingProgress | null>(
    () =>
      (cryptoServerStateStore.getHubProgress({
        allowStale: true,
      }) as CryptoHubLoadingProgress | null) || null
  );
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const startedAtRef = useRef<number | null>(null);
  const retryNonceRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    if (!enabled) {
      setReady(true);
      return;
    }
    retryNonceRef.current += 1;
    const runId = retryNonceRef.current;
    startedAtRef.current = Date.now();
    const cachedProgress = cryptoServerStateStore.getHubProgress({
      allowStale: true,
    }) as CryptoHubLoadingProgress | null;
    if (cachedProgress) {
      setProgress(cachedProgress);
      if (cachedProgress.phase === "ready") setReady(true);
    }
    if (isRecentReadyProgress(cachedProgress)) {
      setReady(true);
      setRunning(false);
      setError(null);
      return;
    }
    setRunning(true);
    setReady(cachedProgress?.phase === "ready");
    setError(null);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    requestPriorityQueue
      .schedule(
        ({ signal }: { signal: AbortSignal }) =>
          cryptoHubFetch("/init", {
            method: "POST",
            signal,
            task: false,
          }),
        {
          priority: "P0",
          label: "crypto:init",
          kind: "crypto",
          scope: { route: "crypto-center", surface: "hub-init" },
          policy: "foreground",
          protected: true,
          signal: controller.signal,
          dedupeKey: "crypto:hub:init",
        }
      )
      .catch((requestError: unknown) => {
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
        const next = await requestPriorityQueue.schedule(
          ({ signal }: { signal: AbortSignal }) =>
            cryptoHubFetch<CryptoHubLoadingProgress>("/loading-progress", {
              signal,
              task: false,
            }),
          {
            priority: "P1",
            label: "crypto:loading-progress",
            kind: "crypto",
            scope: { route: "crypto-center", surface: "hub-loading-progress" },
            policy: "visible",
            protected: true,
            signal: controller.signal,
            dedupeKey: `crypto:hub:loading-progress:${runId}`,
          }
        );
        if (!next) return;
        if (retryNonceRef.current !== runId) return;
        cryptoServerStateStore.setHubProgress(next);
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
      abortRef.current?.abort();
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
