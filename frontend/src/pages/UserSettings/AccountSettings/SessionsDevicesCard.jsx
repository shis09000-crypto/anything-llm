import { useEffect, useState } from "react";
import { DeviceMobile, SignOut } from "@phosphor-icons/react";
import { showAppConfirm } from "@/components/lib/AppConfirmDialog/confirm";
import AppButton from "@/components/lib/AppButton";
import showToast from "@/utils/toast";
import AccountSettingsApi from "./accountSettingsApi";
import { CardHeader } from "./ContactMethodsCard";

export default function SessionsDevicesCard() {
  const [sessions, setSessions] = useState([]);

  useEffect(() => {
    AccountSettingsApi.fetchSessions().then(setSessions);
  }, []);

  async function signOutOthers() {
    const confirmed = await showAppConfirm({
      tone: "warning",
      title: "退出其它设备？",
      description: "其它设备上的登录会话将被退出，当前设备会保留。",
      confirmText: "退出其它设备",
      cancelText: "取消",
    });
    if (!confirmed) return;
    await AccountSettingsApi.signOutOtherSessions();
    setSessions((current) => current.filter((session) => session.current));
    showToast("其它设备已退出。", "success");
  }

  async function signOutAll() {
    const confirmed = await showAppConfirm({
      tone: "danger",
      title: "退出全部设备？",
      description:
        "所有设备都会退出登录。真实会话接口接入后，当前设备也会被重定向到登录页。",
      confirmText: "退出全部设备",
      cancelText: "取消",
    });
    if (!confirmed) return;
    await AccountSettingsApi.signOutAllSessions();
    showToast("退出全部设备接口已预留。", "info");
  }

  return (
    <section id="sessions" className="account-card">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <CardHeader
          title="会话与设备"
          subtitle="查看当前设备和其它登录设备。"
        />
        <div className="flex flex-wrap gap-2">
          <AppButton
            type="button"
            onClick={signOutOthers}
            size="md"
            variant="secondary"
          >
            退出其它设备
          </AppButton>
          <AppButton
            type="button"
            onClick={signOutAll}
            size="md"
            variant="secondary"
            className="account-button-danger"
          >
            退出全部设备
          </AppButton>
        </div>
      </div>
      <div className="mt-2 grid gap-3">
        {sessions.map((session) => (
          <div
            key={session.id}
            className={[
              "flex flex-col gap-3 rounded-3xl border p-4 sm:flex-row sm:items-center",
              session.current
                ? "border-sky-200 bg-sky-50"
                : "border-slate-200 bg-white",
            ].join(" ")}
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-white/80 bg-white text-slate-600 shadow-sm">
              <DeviceMobile className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-slate-950">
                  {session.deviceName}
                </span>
                {session.current && (
                  <span className="rounded-full bg-sky-600 px-2 py-0.5 text-xs font-semibold text-white">
                    当前设备
                  </span>
                )}
              </div>
              <div className="mt-1 text-sm text-slate-500">
                {session.ip} · {session.browser} ·{" "}
                {formatDateTime(session.lastActiveAt)}
              </div>
            </div>
            {!session.current && (
              <AppButton
                type="button"
                size="sm"
                variant="secondary"
                leftIcon={<SignOut className="h-4 w-4" />}
              >
                退出
              </AppButton>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "待确认";
  return date.toLocaleString();
}
