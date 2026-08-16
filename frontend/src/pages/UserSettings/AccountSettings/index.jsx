import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import useUser from "@/hooks/useUser";
import { userFromStorage } from "@/utils/request";
import paths from "@/utils/paths";
import AccountSidebar from "./AccountSidebar";
import ProfileCard from "./ProfileCard";
import PersonalizationCard from "./PersonalizationCard";
import MemoryBlocksCard from "./MemoryBlocksCard";
import ContactMethodsCard from "./ContactMethodsCard";
import LoginSecurityCard from "./LoginSecurityCard";
import PasskeysCard from "./PasskeysCard";
import SessionsDevicesCard from "./SessionsDevicesCard";
import NotificationsCard from "./NotificationsCard";
import DataPrivacyCard from "./DataPrivacyCard";
import AdminPanel from "./AdminPanel";
import AccountSettingsApi from "./accountSettingsApi";
import { AccountSettingsDataProvider } from "./AccountSettingsDataProvider";
import { detectAuthCapabilityAsync } from "@/utils/authCapability";
import { canSeeAdmin } from "@/utils/authz";
import { clearSensitiveClientSession } from "@/utils/security/clearSensitiveClientState";
import { confirmSignOut } from "@/utils/authSignOutConfirm";
import "./styles.css";

export default function AccountSettings() {
  const { t } = useTranslation();
  const navigate = useNavigate();
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
  const [authCapability, setAuthCapability] = useState({
    status: "checking",
    showPasskey: false,
  });
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
  const activeView =
    showAdmin && isAdminHash(activeHash) ? "admin" : "personal";

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
    const capability = await detectAuthCapabilityAsync();
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
    function refreshVerifiedPasskeys(event) {
      if (event.detail?.kind === "passkeys") refreshPasskeys();
    }
    window.addEventListener(
      "athena-sync-v2-security-refresh",
      refreshVerifiedPasskeys
    );
    return () =>
      window.removeEventListener(
        "athena-sync-v2-security-refresh",
        refreshVerifiedPasskeys
      );
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

  async function signOut() {
    const confirmed = await confirmSignOut({
      title: t("profile_settings.signout_confirm_title"),
      description: t("profile_settings.signout_confirm_description"),
      confirmText: t("profile_settings.signout_confirm_action"),
      cancelText: t("profile_settings.cancel"),
    });
    if (!confirmed) return;

    clearSensitiveClientSession();
    window.location.replace(paths.home());
  }

  function returnHome() {
    navigate(paths.home(), { replace: true });
  }

  return (
    <AccountSettingsDataProvider user={user}>
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
                  <PersonalizationCard
                    user={user}
                    onUserUpdated={setLocalUser}
                  />
                  <ProgressiveAccountSection
                    id="memory-blocks"
                    active={activeHash === "#memory-blocks"}
                    mode="visible"
                    minHeight={260}
                  >
                    <MemoryBlocksCard />
                  </ProgressiveAccountSection>
                  <ProgressiveAccountSection id="contact" delayMs={120}>
                    <ContactMethodsCard
                      user={user}
                      onUserUpdated={setLocalUser}
                    />
                  </ProgressiveAccountSection>
                  <ProgressiveAccountSection id="security" delayMs={240}>
                    <LoginSecurityCard
                      user={user}
                      emailVerified={Boolean(
                        user?.email && user?.email_verified_at
                      )}
                      authCapability={authCapability}
                      passkeys={passkeys}
                      passkeysLoading={passkeysLoading}
                      refreshPasskeys={refreshPasskeys}
                    />
                  </ProgressiveAccountSection>
                  <ProgressiveAccountSection id="passkeys" delayMs={360}>
                    <PasskeysCard
                      authCapability={authCapability}
                      passkeys={passkeys}
                      passkeysLoading={passkeysLoading}
                      refreshPasskeys={refreshPasskeys}
                    />
                  </ProgressiveAccountSection>
                  <ProgressiveAccountSection id="sessions" delayMs={480}>
                    <SessionsDevicesCard />
                  </ProgressiveAccountSection>
                  <ProgressiveAccountSection id="notifications" delayMs={600}>
                    <NotificationsCard />
                  </ProgressiveAccountSection>
                  <ProgressiveAccountSection
                    id="privacy"
                    active={activeHash === "#privacy"}
                    mode="visible"
                    minHeight={220}
                  >
                    <DataPrivacyCard />
                  </ProgressiveAccountSection>
                </>
              ) : (
                <AdminPanel currentUser={user} />
              )}
            </div>
          </main>
        </div>
      </div>
    </AccountSettingsDataProvider>
  );
}

function ProgressiveAccountSection({
  id,
  children,
  active = false,
  delayMs = 0,
  mode = "delay",
  minHeight = 180,
}) {
  const ref = useRef(null);
  const [shouldRender, setShouldRender] = useState(
    active || (mode === "delay" && delayMs === 0)
  );

  useEffect(() => {
    if (shouldRender || mode !== "delay") return;
    const timer = window.setTimeout(() => setShouldRender(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, mode, shouldRender]);

  useEffect(() => {
    if (shouldRender || mode !== "visible") return;
    if (active) {
      setShouldRender(true);
      return;
    }
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setShouldRender(true);
        observer.disconnect();
      },
      { rootMargin: "320px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [active, mode, shouldRender]);

  useEffect(() => {
    if (active && !shouldRender) setShouldRender(true);
  }, [active, shouldRender]);

  if (shouldRender) return children;
  return (
    <section
      ref={ref}
      id={id}
      className="account-card"
      style={{ minHeight }}
      aria-busy="true"
    >
      <div className="h-full min-h-[120px] animate-pulse rounded-2xl bg-slate-100" />
    </section>
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
