import React, { useEffect, useMemo, useState } from "react";

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

  useEffect(() => {
    if (!visible) return;
    const interval = setInterval(() => {
      setEvents(window.__anythingCommunication?.events?.() || []);
    }, 1_000);
    return () => clearInterval(interval);
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
