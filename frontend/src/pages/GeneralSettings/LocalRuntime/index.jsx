import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  Copy,
  DesktopTower,
  DownloadSimple,
  PauseCircle,
  ShieldCheck,
  Trash,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import Sidebar from "@/components/SettingsSidebar";
import PreLoader from "@/components/Preloader";
import System from "@/models/system";
import useUser from "@/hooks/useUser";
import showToast from "@/utils/toast";
import { startAuthentication } from "@simplewebauthn/browser";

const DEFAULT_CAPABILITIES = [
  "device.status",
  "desktop.observe",
  "desktop.act",
  "file.read",
  "file.write",
  "command.run",
  "job.cancel",
];

function statusTone(status) {
  if (status === "online") return "bg-emerald-500/15 text-emerald-600";
  if (status === "paused") return "bg-amber-500/15 text-amber-600";
  return "bg-slate-500/15 text-theme-text-secondary";
}

export default function LocalRuntimePage() {
  const { t } = useTranslation();
  const { user } = useUser();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [runtime, setRuntime] = useState(null);
  const [devices, setDevices] = useState([]);
  const [leases, setLeases] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [pairing, setPairing] = useState(null);
  const [allowedRoots, setAllowedRoots] = useState("");
  const [allowedApps, setAllowedApps] = useState("");
  const runtimeDownloadUrl =
    import.meta.env.VITE_ATHENA_RUNTIME_MACOS_DOWNLOAD_URL || null;

  const refresh = useCallback(async () => {
    try {
      const [status, nextLeases, nextJobs] = await Promise.all([
        System.localRuntimeStatus(),
        System.listLocalRuntimeLeases(),
        System.listLocalRuntimeJobs(),
      ]);
      setRuntime(status?.runtime || null);
      setDevices(status?.devices || []);
      setLeases(Array.isArray(nextLeases) ? nextLeases : []);
      setJobs(Array.isArray(nextJobs) ? nextJobs : []);
    } catch (error) {
      showToast(error?.message || t("localRuntime.offline"), "error", {
        clear: true,
      });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const activeLeaseByDevice = useMemo(
    () =>
      new Map(
        leases
          .filter((lease) => lease.status === "active")
          .map((lease) => [lease.deviceId, lease])
      ),
    [leases]
  );

  async function confirmSensitiveSession() {
    const options = await System.localRuntimePasskeyOptions();
    if (!options?.success || !options?.options)
      throw new Error(options?.error || t("localRuntime.sensitiveRequired"));
    const passkeyResponse = await startAuthentication({
      optionsJSON: options.options,
    });
    const verification =
      await System.localRuntimePasskeyVerify(passkeyResponse);
    if (!verification?.success || !verification?.reauthToken)
      throw new Error(
        verification?.error || t("localRuntime.sensitiveRequired")
      );
    await System.createLocalRuntimeSensitiveSession(
      user?.id,
      verification.reauthToken
    );
  }

  async function sensitiveAction(action) {
    setBusy(true);
    try {
      try {
        await action();
      } catch (error) {
        if (
          !String(error?.message || "").includes("sensitive_session_required")
        )
          throw error;
        await confirmSensitiveSession();
        await action();
      }
      await refresh();
    } catch (error) {
      const message = String(error?.message || "");
      showToast(
        message.includes("sensitive_session_required")
          ? t("localRuntime.sensitiveRequired")
          : message || "Operation failed",
        "error",
        { clear: true }
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading)
    return (
      <div className="w-screen h-screen flex items-center justify-center bg-theme-bg-container">
        <PreLoader />
      </div>
    );

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <main className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] light:border light:border-theme-sidebar-border bg-theme-bg-secondary w-full h-full overflow-y-auto p-4 md:p-0">
        <div className="flex flex-col w-full px-1 md:px-8 md:py-7 py-16 gap-6">
          <header className="flex flex-col md:flex-row md:items-end justify-between gap-4 pb-6 border-b border-theme-sidebar-border">
            <div>
              <div className="flex items-center gap-2">
                <DesktopTower className="w-6 h-6 text-blue-500" />
                <h1 className="text-xl font-semibold text-theme-text-primary">
                  {t("localRuntime.title")}
                </h1>
              </div>
              <p className="mt-2 text-sm text-theme-text-secondary">
                {t("localRuntime.description")}
              </p>
              <p className="mt-1 text-xs text-theme-text-secondary">
                {t("localRuntime.pairHelp")}
              </p>
            </div>
            <div className="flex gap-2">
              <a
                href={runtimeDownloadUrl || undefined}
                aria-disabled={!runtimeDownloadUrl}
                title={
                  runtimeDownloadUrl
                    ? undefined
                    : t("localRuntime.downloadUnavailable")
                }
                className={`h-10 px-4 rounded-lg border border-theme-sidebar-border flex items-center gap-2 text-theme-text-primary ${
                  runtimeDownloadUrl ? "" : "opacity-50 pointer-events-none"
                }`}
              >
                <DownloadSimple />
                {t("localRuntime.download")}
              </a>
              <button
                type="button"
                onClick={() => void refresh()}
                className="h-10 px-3 rounded-lg border border-theme-sidebar-border text-theme-text-primary"
              >
                <ArrowClockwise />
              </button>
            </div>
          </header>

          <section className="rounded-2xl border border-theme-sidebar-border bg-theme-bg-primary p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold text-theme-text-primary">
                  {t("localRuntime.pair")}
                </h2>
                <p className="text-xs text-theme-text-secondary mt-1">
                  Protocol {runtime?.protocol || "athena.local-runtime.v1"}
                </p>
              </div>
              <button
                disabled={busy}
                onClick={() =>
                  void sensitiveAction(async () =>
                    setPairing(
                      await System.createLocalRuntimePairingTicket(user?.id)
                    )
                  )
                }
                className="h-10 px-4 rounded-lg bg-blue-600 text-white disabled:opacity-50"
              >
                {t("localRuntime.pair")}
              </button>
            </div>
            {pairing?.token && (
              <div className="mt-4 rounded-xl bg-theme-bg-secondary border border-theme-sidebar-border p-4">
                <p className="text-xs text-theme-text-secondary">
                  {t("localRuntime.pairingCode")}
                </p>
                <div className="flex items-center gap-3 mt-1">
                  <code className="text-sm text-theme-text-primary break-all flex-1">
                    {pairing.token}
                  </code>
                  <button
                    onClick={() => {
                      void navigator.clipboard.writeText(pairing.token);
                      showToast(t("localRuntime.copied"), "success");
                    }}
                    className="p-2 rounded-lg border border-theme-sidebar-border"
                  >
                    <Copy />
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {devices.length === 0 ? (
              <div className="xl:col-span-2 h-40 rounded-2xl border border-dashed border-theme-sidebar-border flex flex-col items-center justify-center text-theme-text-secondary">
                <DesktopTower className="w-9 h-9 mb-2" />
                <p>{t("localRuntime.noDevices")}</p>
              </div>
            ) : (
              devices.map((device) => {
                const lease = activeLeaseByDevice.get(device.id);
                return (
                  <article
                    key={device.id}
                    className="rounded-2xl border border-theme-sidebar-border bg-theme-bg-primary p-5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="font-semibold text-theme-text-primary">
                          {device.name}
                        </h3>
                        <p className="text-xs text-theme-text-secondary mt-1">
                          macOS · {device.version || "unknown"} ·{" "}
                          {device.id.slice(0, 8)}
                        </p>
                      </div>
                      <span
                        className={`px-2 py-1 rounded-full text-xs ${statusTone(device.status)}`}
                      >
                        {t(`localRuntime.${device.status}`, {
                          defaultValue: device.status,
                        })}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 mt-4 text-xs text-theme-text-secondary">
                      <div className="rounded-lg bg-theme-bg-secondary p-3">
                        <ShieldCheck className="mb-1" />
                        {t("localRuntime.permissions")}
                        <p className="text-theme-text-primary mt-1">
                          {
                            Object.values(device.permissions || {}).filter(
                              Boolean
                            ).length
                          }{" "}
                          granted
                        </p>
                      </div>
                      <div className="rounded-lg bg-theme-bg-secondary p-3">
                        <PauseCircle className="mb-1" />
                        Lease
                        <p className="text-theme-text-primary mt-1">
                          {lease
                            ? new Date(lease.expiresAt).toLocaleString()
                            : "—"}
                        </p>
                      </div>
                    </div>
                    <textarea
                      value={allowedRoots}
                      onChange={(event) => setAllowedRoots(event.target.value)}
                      placeholder={t("localRuntime.allowedRoots")}
                      className="mt-4 w-full min-h-20 rounded-lg border border-theme-sidebar-border bg-theme-bg-secondary p-3 text-sm text-theme-text-primary"
                    />
                    <textarea
                      value={allowedApps}
                      onChange={(event) => setAllowedApps(event.target.value)}
                      placeholder={t("localRuntime.allowedApps")}
                      className="mt-2 w-full min-h-16 rounded-lg border border-theme-sidebar-border bg-theme-bg-secondary p-3 text-sm text-theme-text-primary"
                    />
                    <div className="flex gap-2 mt-3">
                      <button
                        disabled={busy || device.status !== "online"}
                        onClick={() =>
                          void sensitiveAction(() =>
                            System.createLocalRuntimeLease(user?.id, {
                              deviceId: device.id,
                              capabilities: DEFAULT_CAPABILITIES,
                              allowedRoots: allowedRoots
                                .split("\n")
                                .map((value) => value.trim())
                                .filter(Boolean),
                              allowedApps: allowedApps
                                .split("\n")
                                .map((value) => value.trim())
                                .filter(Boolean),
                              ttlMs: 86_400_000,
                            })
                          )
                        }
                        className="flex-1 h-10 rounded-lg bg-blue-600 text-white disabled:opacity-50"
                      >
                        {t("localRuntime.lease")}
                      </button>
                      {lease && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void sensitiveAction(() =>
                              System.revokeLocalRuntimeLease(user?.id, lease.id)
                            )
                          }
                          className="h-10 px-3 rounded-lg border border-amber-500 text-amber-600"
                        >
                          {t("localRuntime.revoke")}
                        </button>
                      )}
                      <button
                        disabled={busy}
                        onClick={() =>
                          void sensitiveAction(() =>
                            System.revokeLocalRuntimeDevice(user?.id, device.id)
                          )
                        }
                        className="h-10 px-3 rounded-lg bg-red-600 text-white"
                        title={t("localRuntime.emergencyStop")}
                      >
                        <Trash />
                      </button>
                    </div>
                  </article>
                );
              })
            )}
          </section>

          <section className="rounded-2xl border border-theme-sidebar-border bg-theme-bg-primary p-5">
            <h2 className="font-semibold text-theme-text-primary">
              {t("localRuntime.jobs")}
            </h2>
            <div className="mt-3 divide-y divide-theme-sidebar-border">
              {jobs.length === 0 ? (
                <p className="py-5 text-sm text-theme-text-secondary">—</p>
              ) : (
                jobs.slice(0, 20).map((job) => (
                  <div
                    key={job.id}
                    className="py-3 flex items-center justify-between gap-3"
                  >
                    <div>
                      <p className="text-sm text-theme-text-primary">
                        {job.toolName}
                      </p>
                      <p className="text-xs text-theme-text-secondary">
                        {job.status} ·{" "}
                        {new Date(job.createdAt).toLocaleString()}
                      </p>
                    </div>
                    {![
                      "completed",
                      "failed",
                      "cancelled",
                      "denied",
                      "expired",
                    ].includes(job.status) && (
                      <button
                        onClick={() =>
                          void System.cancelLocalRuntimeJob(job.id).then(
                            refresh
                          )
                        }
                        className="text-xs px-3 h-8 rounded-lg border border-red-500 text-red-500"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
