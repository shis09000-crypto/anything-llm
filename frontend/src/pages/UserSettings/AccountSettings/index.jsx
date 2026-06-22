import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import PersonalizationCard from "./PersonalizationCard";
import MemoryBlocksCard from "./MemoryBlocksCard";
import ContactMethodsCard from "./ContactMethodsCard";
import LoginSecurityCard from "./LoginSecurityCard";
import PasskeysCard from "./PasskeysCard";
import SessionsDevicesCard from "./SessionsDevicesCard";
import DataPrivacyCard from "./DataPrivacyCard";
import AdminPanel from "./AdminPanel";
import AccountSettingRow from "./AccountSettingRow";
import AccountSettingsApi from "./accountSettingsApi";
import { detectAuthCapability } from "@/utils/authCapability";
import { canSeeAdmin } from "@/utils/authz";
import "./styles.css";

export default function AccountSettings() {
  const { user: contextUser } = useUser();
  const mainRef = useRef(null);
  const [localUser, setLocalUser] = useState(
    () => contextUser || userFromStorage()
  );
  const [activeHash, setActiveHash] = useState(() => currentHash());
  const [scrollRequest, setScrollRequest] = useState(() => ({
    hash: currentHash(),
    nonce: 0,
  }));
  const [authCapability, setAuthCapability] = useState(() =>
    detectAuthCapability()
  );
  const [passkeys, setPasskeys] = useState([]);
  const [passkeysLoading, setPasskeysLoading] = useState(false);
  const passkeysRef = useRef([]);
  const activeHashRef = useRef(activeHash);
  const scrollFrameRef = useRef(null);
  const programmaticScrollRef = useRef(false);
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
  const showAdmin = canSeeAdmin(user);
  const activeView = showAdmin && isAdminHash(activeHash) ? "admin" : "personal";

  const requestScrollToHash = useCallback(
    (hash) => {
      const nextHash = normalizeHash(hash, showAdmin);
      replaceLocationHash(nextHash);
      activeHashRef.current = nextHash;
      setActiveHash(nextHash);
      setScrollRequest((prev) => ({
        hash: nextHash,
        nonce: prev.nonce + 1,
      }));
    },
    [showAdmin]
  );

  const refreshPasskeys = useCallback(async () => {
    const capability = detectAuthCapability();
    setAuthCapability(capability);
    if (!capability.showPasskey) {
      passkeysRef.current = [];
      setPasskeys([]);
      return [];
    }

    setPasskeysLoading(true);
    const result = await AccountSettingsApi.fetchPasskeys();
    setPasskeysLoading(false);

    if (result?.success) {
      const nextPasskeys = result.passkeys || [];
      passkeysRef.current = nextPasskeys;
      setPasskeys(nextPasskeys);
      return nextPasskeys;
    }

    return passkeysRef.current;
  }, []);

  useEffect(() => {
    refreshPasskeys();
  }, [refreshPasskeys]);

  useEffect(() => {
    function syncHash() {
      const nextHash = normalizeHash(currentHash(), showAdmin);
      activeHashRef.current = nextHash;
      setActiveHash(nextHash);
      setScrollRequest((prev) => ({
        hash: nextHash,
        nonce: prev.nonce + 1,
      }));
    }

    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, [showAdmin]);

  useEffect(() => {
    const nextHash = normalizeHash(activeHash, showAdmin);
    if (nextHash !== activeHash) {
      replaceLocationHash(nextHash);
      activeHashRef.current = nextHash;
      setActiveHash(nextHash);
      setScrollRequest((prev) => ({
        hash: nextHash,
        nonce: prev.nonce + 1,
      }));
    }
  }, [activeHash, showAdmin]);

  useEffect(() => {
    activeHashRef.current = activeHash;
  }, [activeHash]);

  useEffect(() => {
    function refreshWhenVisible() {
      if (document.visibilityState === "visible") refreshPasskeys();
    }

    window.addEventListener("focus", refreshPasskeys);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshPasskeys);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshPasskeys]);

  useEffect(() => {
    const nextHash = normalizeHash(scrollRequest.hash, showAdmin);
    const targetId =
      nextHash.replace(/^#/, "") ||
      defaultHashForView(activeView).replace(/^#/, "");
    const delays = [0, 80, 300, 700, 1200];
    programmaticScrollRef.current = true;

    const timers = delays.map((delay) =>
      window.setTimeout(() => {
        const target = document.getElementById(targetId);
        if (target) {
          target.scrollIntoView({ block: "start" });
          return;
        }
        scrollToTop(mainRef.current);
      }, delay)
    );
    const releaseTimer = window.setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 1400);

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      window.clearTimeout(releaseTimer);
    };
  }, [activeView, scrollRequest, showAdmin]);

  useEffect(() => {
    const main = mainRef.current;
    const scrollTarget = isMainScrollContainer(main) ? main : window;
    const sectionHashes = hashesForView(activeView);

    function syncActiveSection() {
      scrollFrameRef.current = null;
      if (programmaticScrollRef.current) return;

      const nextHash = findActiveSectionHash(sectionHashes, main);
      if (!nextHash || nextHash === activeHashRef.current) return;

      activeHashRef.current = nextHash;
      setActiveHash(nextHash);
      replaceLocationHash(nextHash);
    }

    function scheduleSync() {
      if (scrollFrameRef.current) return;
      scrollFrameRef.current = window.requestAnimationFrame(syncActiveSection);
    }

    scrollTarget.addEventListener("scroll", scheduleSync, { passive: true });
    window.addEventListener("resize", scheduleSync);
    scheduleSync();

    return () => {
      scrollTarget.removeEventListener("scroll", scheduleSync);
      window.removeEventListener("resize", scheduleSync);
      if (scrollFrameRef.current) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [activeView]);

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
        <AccountSidebar
          user={user}
          activeHash={activeHash}
          onNavigateHash={requestScrollToHash}
          onReturnHome={returnHome}
          onSignOut={signOut}
        />
        <main ref={mainRef} className="account-settings-main">
          <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-5">
            <header className="flex flex-col gap-2 px-1 pt-1">
              <p className="text-sm font-semibold text-slate-500">
                Account Settings
              </p>
              <h1 className="text-4xl font-semibold tracking-normal text-slate-950">
                {activeView === "admin" ? "管理员" : "账户设置"}
              </h1>
              {activeView === "admin" && (
                <p className="max-w-2xl text-sm leading-6 text-slate-500">
                  管理当前实例的账户、工作区、邀请和默认系统提示词。
                </p>
              )}
            </header>
            {activeView === "personal" ? (
              <>
                <AccountSectionHeader
                  title="个人设置"
                  subtitle="管理你的基础资料、个性化偏好、联系方式和安全状态。"
                />
                <ProfileCard user={user} onUserUpdated={setLocalUser} />
                <PersonalizationCard user={user} onUserUpdated={setLocalUser} />
                <MemoryBlocksCard />
                <ContactMethodsCard user={user} onUserUpdated={setLocalUser} />
                <LoginSecurityCard
                  user={user}
                  emailVerified={Boolean(user?.email && user?.email_verified_at)}
                  authCapability={authCapability}
                  passkeys={passkeys}
                  passkeysLoading={passkeysLoading}
                  refreshPasskeys={refreshPasskeys}
                />
                <PasskeysCard
                  authCapability={authCapability}
                  passkeys={passkeys}
                  passkeysLoading={passkeysLoading}
                  refreshPasskeys={refreshPasskeys}
                />
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
              </>
            ) : (
              <AdminPanel currentUser={user} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

const PERSONAL_SECTION_HASHES = [
  "#profile",
  "#personalization",
  "#memory-blocks",
  "#contact",
  "#security",
  "#passkeys",
  "#sessions",
  "#notifications",
  "#privacy",
];

const ADMIN_SECTION_HASHES = [
  "#admin",
  "#admin-users",
  "#admin-workspaces",
  "#admin-chats",
  "#admin-invites",
  "#admin-default-prompt",
];

const ADMIN_HASHES = new Set(ADMIN_SECTION_HASHES);

function currentHash() {
  return window.location.hash || "#profile";
}

function isAdminHash(hash = "") {
  return ADMIN_HASHES.has(hash);
}

function hashesForView(view) {
  return view === "admin" ? ADMIN_SECTION_HASHES : PERSONAL_SECTION_HASHES;
}

function defaultHashForView(view) {
  return view === "admin" ? "#admin" : "#profile";
}

function normalizeHash(hash = "", showAdmin = true) {
  const nextHash = hash?.startsWith("#") ? hash : `#${hash || "profile"}`;
  if (ADMIN_HASHES.has(nextHash)) return showAdmin ? nextHash : "#profile";
  if (PERSONAL_SECTION_HASHES.includes(nextHash)) return nextHash;
  return "#profile";
}

function replaceLocationHash(hash) {
  if (window.location.hash === hash) return;
  window.history.replaceState(null, "", hash);
}

function scrollToTop(main) {
  if (isMainScrollContainer(main)) {
    main.scrollTo({ top: 0 });
    return;
  }
  window.scrollTo({ top: 0 });
}

function isMainScrollContainer(main) {
  if (!main) return false;
  const overflowY = window.getComputedStyle(main).overflowY;
  return overflowY !== "visible";
}

function isAtScrollEnd(main) {
  if (isMainScrollContainer(main)) {
    return main.scrollTop + main.clientHeight >= main.scrollHeight - 8;
  }

  const documentElement = document.documentElement;
  return (
    window.scrollY + window.innerHeight >= documentElement.scrollHeight - 8
  );
}

function findActiveSectionHash(sectionHashes, main) {
  const sections = sectionHashes
    .map((hash) => ({
      hash,
      element: document.getElementById(hash.replace(/^#/, "")),
    }))
    .filter(({ element }) => Boolean(element));

  if (!sections.length) return null;
  if (isAtScrollEnd(main)) return sections[sections.length - 1].hash;

  const rootTop = isMainScrollContainer(main)
    ? main.getBoundingClientRect().top
    : 0;
  const activationOffset = 128;
  let active = sections[0].hash;

  for (const section of sections) {
    const top = section.element.getBoundingClientRect().top - rootTop;
    if (top <= activationOffset) active = section.hash;
  }

  return active;
}

function AccountSectionHeader({ title, subtitle }) {
  return (
    <div className="px-1">
      <h2 className="text-xl font-semibold tracking-normal text-slate-950">
        {title}
      </h2>
      {subtitle && (
        <p className="mt-1 text-sm leading-5 text-slate-500">{subtitle}</p>
      )}
    </div>
  );
}
