import { useMemo, useState } from "react";
import { Bell, EnvelopeSimple } from "@phosphor-icons/react";
import useUser from "@/hooks/useUser";
import { userFromStorage } from "@/utils/request";
import paths from "@/utils/paths";
import {
  AUTH_TIMESTAMP,
  AUTH_TOKEN,
  AUTH_USER,
  LAST_USER_ACTION_AT,
  LAST_VISITED_WORKSPACE,
  LAST_VISITED_WORKSPACE_THREADS,
  USER_PROMPT_INPUT_MAP,
} from "@/utils/constants";
import AccountSidebar from "./AccountSidebar";
import ProfileCard from "./ProfileCard";
import ContactMethodsCard from "./ContactMethodsCard";
import LoginSecurityCard from "./LoginSecurityCard";
import PasskeysCard from "./PasskeysCard";
import SessionsDevicesCard from "./SessionsDevicesCard";
import DataPrivacyCard from "./DataPrivacyCard";
import AccountSettingRow from "./AccountSettingRow";
import "./styles.css";

export default function AccountSettings() {
  const { user: contextUser } = useUser();
  const [localUser, setLocalUser] = useState(
    () => contextUser || userFromStorage()
  );
  const user = useMemo(
    () =>
      localUser || {
        username: "Account",
        role: "single-user",
        email: "",
        email_verified_at: null,
      },
    [localUser]
  );

  function signOut() {
    window.localStorage.removeItem(AUTH_USER);
    window.localStorage.removeItem(AUTH_TOKEN);
    window.localStorage.removeItem(AUTH_TIMESTAMP);
    window.localStorage.removeItem(LAST_USER_ACTION_AT);
    window.localStorage.removeItem(LAST_VISITED_WORKSPACE);
    window.localStorage.removeItem(LAST_VISITED_WORKSPACE_THREADS);
    window.localStorage.removeItem(USER_PROMPT_INPUT_MAP);
    window.location.replace(paths.home());
  }

  function returnHome() {
    window.location.assign(paths.home());
  }

  return (
    <div className="account-settings-page">
      <div className="account-settings-shell">
        <AccountSidebar onReturnHome={returnHome} onSignOut={signOut} />
        <main className="account-settings-main">
          <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-5">
            <header className="flex flex-col gap-2 px-1 pt-1">
              <p className="text-sm font-semibold text-slate-500">
                Account Settings
              </p>
              <h1 className="text-4xl font-semibold tracking-normal text-slate-950">
                账户设置
              </h1>
            </header>
            <ProfileCard user={user} onUserUpdated={setLocalUser} />
            <ContactMethodsCard user={user} onUserUpdated={setLocalUser} />
            <LoginSecurityCard
              user={user}
              emailVerified={Boolean(user?.email && user?.email_verified_at)}
            />
            <PasskeysCard />
            <SessionsDevicesCard />
            <section id="notifications" className="account-card">
              <div className="mb-2 px-1 pb-3">
                <h2 className="text-lg font-semibold text-slate-950">
                  邮箱与通知
                </h2>
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
                    <span className="font-semibold text-emerald-600">
                      已开启
                    </span>
                  }
                />
                <AccountSettingRow
                  icon={<Bell className="h-5 w-5" />}
                  title="产品通知"
                  subtitle="第一版先保留入口，后续可接入通知偏好接口。"
                  status={
                    <span className="font-semibold text-slate-400">
                      入口预留
                    </span>
                  }
                />
              </div>
            </section>
            <DataPrivacyCard />
          </div>
        </main>
      </div>
    </div>
  );
}
