import { Bell, EnvelopeSimple } from "@phosphor-icons/react";
import AccountSettingRow from "./AccountSettingRow";

export default function NotificationsCard() {
  return (
    <section id="notifications" className="account-card">
      <div className="mb-2 px-1 pb-3">
        <h2 className="text-lg font-semibold text-slate-950">邮箱与通知</h2>
        <p className="mt-1 text-sm leading-5 text-slate-500">
          管理账户通知和安全提醒的接收方式。
        </p>
      </div>
      <div className="divide-y divide-slate-100">
        <AccountSettingRow
          icon={<EnvelopeSimple className="h-5 w-5" />}
          title="安全邮件"
          subtitle="登录、密码和邮箱变更会发送安全提醒。"
          status={
            <span className="font-semibold text-emerald-600">已开启</span>
          }
        />
        <AccountSettingRow
          icon={<Bell className="h-5 w-5" />}
          title="产品通知"
          subtitle="第一版先保留入口，后续可接入通知偏好接口。"
          status={
            <span className="font-semibold text-slate-400">入口预留</span>
          }
        />
      </div>
    </section>
  );
}
