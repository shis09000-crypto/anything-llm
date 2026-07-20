import React, { useEffect, useMemo, useState } from "react";
import { getJson } from "@/lib/communication/apiClient";
import { syncMutationQueue } from "@/utils/syncV2/syncMutationQueue";
import { syncV2Runtime } from "@/utils/syncV2/syncV2Runtime";

function enabled() {
  try {
    return window.localStorage.getItem("communicationDebugPanel") === "true";
  } catch {
    return false;
  }
}

function formatBytes(value = 0) {
  if (value > 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value > 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value || 0} B`;
}

export default function CommunicationDebugPanel() {
  const [visible] = useState(enabled);
  const [events, setEvents] = useState([]);
  const [encryption, setEncryption] = useState(null);
  const [syncV2, setSyncV2] = useState(null);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    const refresh = () => {
      setEvents(window.__anythingCommunication?.events?.() || []);
      getJson("/debug/communication/encryption?limit=100", {
        task: false,
        communicationScene: "communication-debug",
      })
        .then(({ data }) => {
          if (active) setEncryption(data);
        })
        .catch(() => {
          if (active) setEncryption(null);
        });
      Promise.all([
        getJson("/debug/communication/sync-v2", {
          task: false,
          communicationScene: "communication-debug",
        })
          .then(({ data }) => data)
          .catch(() => null),
        syncMutationQueue.list().catch(() => []),
      ]).then(([server, queue]) => {
        if (!active) return;
        setSyncV2({
          client: syncV2Runtime.snapshot(),
          server,
          queue,
        });
      });
    };
    refresh();
    const interval = setInterval(refresh, 2_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [visible]);

  const summary = useMemo(() => {
    return window.__anythingCommunication?.summary?.()?.slice(0, 8) || [];
  }, [events]);
  const accountSettings = useMemo(() => {
    return window.__anythingCommunication?.accountSettings?.() || null;
  }, [events]);

  if (!visible) return null;
  return (
    <aside className="fixed bottom-3 right-3 z-[9999] max-h-[40vh] w-[360px] overflow-auto rounded-lg border border-white/20 bg-black/85 p-3 text-xs text-white shadow-2xl">
      <div className="mb-2 flex items-center justify-between gap-2">
        <strong>Communication</strong>
        <span className="text-white/60">{events.length} requests</span>
      </div>
      <div className="space-y-1">
        {syncV2 && (
          <div className="mb-2 rounded-md border border-violet-400/30 bg-violet-400/10 p-2">
            <div className="flex items-center justify-between gap-2">
              <strong>Sync V2</strong>
              <span className="text-white/70">
                {syncV2.client.enabled ? "enabled" : "disabled"} · cursor{" "}
                {syncV2.client.cursor || 0}
              </span>
            </div>
            <div className="mt-1 text-white/60">
              client {syncV2.client.nodeCount || 0} nodes · queue{" "}
              {syncV2.queue.length} · conflicts{" "}
              {syncV2.queue.filter((item) => item.status === "conflict").length}
            </div>
            {syncV2.server?.stateTree && (
              <div className="mt-1 text-white/60">
                server {syncV2.server.stateTree.nodes || 0} nodes · seq{" "}
                {syncV2.server.stateTree.latestSeq || 0} · cursors{" "}
                {syncV2.server.stateTree.cursors || 0} · outbox{" "}
                {syncV2.server.stateTree.pendingOutbox || 0}
              </div>
            )}
          </div>
        )}
        {encryption && (
          <div
            className={`mb-2 rounded-md border p-2 ${
              encryption.totalBlocked > 0
                ? "border-red-400/40 bg-red-400/10"
                : "border-emerald-400/30 bg-emerald-400/10"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <strong>Encryption Blocks</strong>
              <span className="text-white/70">
                {encryption.totalBlocked || 0} blocked
              </span>
            </div>
            <div className="mt-1 text-white/60">
              key {encryption.keyState?.fingerprint || "unavailable"} ·{" "}
              {encryption.keyState?.validFormat
                ? "valid config"
                : "invalid config"}
            </div>
            {Object.entries(encryption.aggregate || {})
              .slice(-4)
              .map(([key, count]) => (
                <div
                  key={key}
                  className="mt-1 grid grid-cols-[1fr_auto] gap-2 border-t border-white/10 pt-1"
                >
                  <span className="truncate" title={key}>
                    {key}
                  </span>
                  <span className="text-white/70">{count}x</span>
                </div>
              ))}
          </div>
        )}
        {accountSettings?.total?.count > 0 && (
          <div className="mb-2 rounded-md border border-sky-400/30 bg-sky-400/10 p-2">
            <div className="flex items-center justify-between">
              <strong>Account Settings</strong>
              <span className="text-white/70">
                {accountSettings.total.count}x ·{" "}
                {Math.round(accountSettings.total.totalMs)}ms ·{" "}
                {formatBytes(accountSettings.total.responseBytes)}
              </span>
            </div>
            {accountSettings.cache && (
              <div className="mt-1 text-white/60">
                cache {accountSettings.cache.entries.length} sections ·{" "}
                {formatBytes(accountSettings.cache.totalBytes)}
              </div>
            )}
          </div>
        )}
        {summary.map((item) => (
          <div
            key={item.key}
            className="grid grid-cols-[1fr_auto] gap-2 border-t border-white/10 pt-1"
          >
            <span className="truncate" title={item.key}>
              {item.key}
            </span>
            <span className="text-right text-white/70">
              {item.count}x · {Math.round(item.totalMs)}ms ·{" "}
              {formatBytes(item.responseBytes)}
            </span>
          </div>
        ))}
      </div>
    </aside>
  );
}
