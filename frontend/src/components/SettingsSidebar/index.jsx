import React, { useEffect, useRef, useState } from "react";
import paths from "@/utils/paths";
import useLogo from "@/hooks/useLogo";
import {
  House,
  List,
  Flask,
  Gear,
  FirstAidKit,
  PencilSimpleLine,
  Nut,
  Toolbox,
  Plugs,
  DesktopTower,
} from "@phosphor-icons/react";
import AgentIcon from "@/media/animations/agent-static.png";
import useUser from "@/hooks/useUser";
import { isMobile } from "react-device-detect";
import Footer from "../Footer";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import showToast from "@/utils/toast";
import System from "@/models/system";
import Option from "./MenuOption";
import { CanViewChatHistoryProvider } from "../CanViewChatHistory";
import useAppVersion from "@/hooks/useAppVersion";
import { canSeeAdmin } from "@/utils/authz";
import { useSoftSettingsShell } from "@/components/SoftSettings/context";
import "@/components/SoftSettings/styles.css";

export default function SettingsSidebar() {
  const { t } = useTranslation();
  const { logo } = useLogo();
  const productName = t("common.productName");
  const showTextBrand = Boolean(productName);
  const { user } = useUser();
  const hasPersistentSettingsShell = useSoftSettingsShell();
  const sidebarRef = useRef(null);
  const [showSidebar, setShowSidebar] = useState(false);
  const [showBgOverlay, setShowBgOverlay] = useState(false);

  useEffect(() => {
    function handleBg() {
      if (showSidebar) {
        setTimeout(() => {
          setShowBgOverlay(true);
        }, 300);
      } else {
        setShowBgOverlay(false);
      }
    }
    handleBg();
  }, [showSidebar]);

  if (hasPersistentSettingsShell) return null;

  if (isMobile) {
    return (
      <>
        <div className="settings-soft-mobile-bar fixed top-0 left-0 right-0 z-10 flex justify-between items-center px-4 py-2 text-theme-text-secondary h-16">
          <button
            onClick={() => setShowSidebar(true)}
            className="rounded-md p-2 flex items-center justify-center text-theme-text-secondary"
          >
            <List className="h-6 w-6" />
          </button>
          <div className="flex items-center justify-center flex-grow gap-x-2">
            <img
              src={logo}
              alt="Logo"
              className="block mx-auto h-6 w-auto"
              style={{ maxHeight: "40px", objectFit: "contain" }}
            />
            {showTextBrand && (
              <span className="text-sm font-semibold text-theme-text-primary light:text-slate-700 whitespace-nowrap">
                {productName}
              </span>
            )}
          </div>
          <div className="w-12"></div>
        </div>
        <div
          style={{
            transform: showSidebar ? `translateX(0vw)` : `translateX(-100vw)`,
          }}
          className={`z-99 fixed top-0 left-0 motion-hover w-[100vw] h-[100vh]`}
        >
          <div
            className={`${
              showBgOverlay
                ? "motion-hover opacity-1"
                : "transition-none opacity-0"
            } fixed top-0 left-0 bg-slate-900/35 backdrop-blur-sm w-screen h-screen`}
            onClick={() => setShowSidebar(false)}
          />
          <div ref={sidebarRef} className="settings-soft-mobile-panel">
            <div className="w-full h-full flex flex-col overflow-x-hidden items-between">
              {/* Header Information */}
              <div className="flex w-full items-center justify-between gap-x-4">
                <div className="flex shrink-1 w-fit items-center justify-start gap-x-2">
                  <img
                    src={logo}
                    alt="Logo"
                    className="rounded w-full max-h-[40px]"
                    style={{ objectFit: "contain" }}
                  />
                  {showTextBrand && (
                    <span className="text-sm font-semibold text-theme-text-primary whitespace-nowrap">
                      {productName}
                    </span>
                  )}
                </div>
                <div className="flex gap-x-2 items-center text-slate-500 shrink-0">
                  <Link
                    to={paths.home()}
                    className="motion-hover p-2 rounded-full text-white bg-theme-action-menu-bg hover:bg-theme-action-menu-item-hover hover:border-slate-100 hover:border-opacity-50 border-transparent border"
                  >
                    <House className="h-4 w-4" />
                  </Link>
                </div>
              </div>

              {/* Primary Body */}
              <div className="h-full flex flex-col w-full justify-between pt-4 overflow-y-scroll no-scroll">
                <div className="h-auto md:sidebar-items">
                  <div className="flex flex-col gap-y-4 pb-[60px] overflow-y-scroll no-scroll">
                    <SidebarOptions user={user} t={t} />
                    <div className="settings-soft-sidebar-divider" />
                    <SupportEmail />
                    <Link
                      hidden={
                        user?.hasOwnProperty("role") && !canSeeAdmin(user)
                      }
                      to={paths.settings.privacy()}
                      className="text-theme-text-secondary hover:text-white text-xs leading-[18px] mx-3"
                    >
                      {t("settings.privacy")}
                    </Link>
                    <AppVersion />
                  </div>
                </div>
              </div>
              <div className="absolute bottom-2 left-0 right-0 pt-2 bg-theme-bg-sidebar bg-opacity-80 backdrop-filter backdrop-blur-md">
                <Footer />
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="settings-soft-sidebar-shell">
        <Link
          to={paths.home()}
          className="settings-soft-sidebar-brand flex shrink-0 max-w-[90%] items-center justify-start gap-x-2 mx-[20.5px] my-[18px]"
        >
          <img
            src={logo}
            alt="Logo"
            className="rounded max-h-[24px]"
            style={{ objectFit: "contain" }}
          />
          {showTextBrand && (
            <span className="text-sm font-semibold text-theme-text-primary light:text-slate-700 whitespace-nowrap">
              {productName}
            </span>
          )}
        </Link>
        <div ref={sidebarRef} className="settings-soft-sidebar-card">
          <div className="w-full h-full flex flex-col overflow-x-hidden items-between min-w-[235px]">
            <div className="settings-soft-sidebar-label">
              {t("settings.title")}
            </div>
            <div className="relative h-[calc(100%-60px)] flex flex-col w-full justify-between pt-[10px] overflow-y-scroll no-scroll">
              <div className="h-auto sidebar-items">
                <div className="flex flex-col gap-y-2 pb-[60px] overflow-y-scroll no-scroll">
                  <SidebarOptions user={user} t={t} />
                  <div className="settings-soft-sidebar-divider" />
                  <SupportEmail />
                  <Link
                    hidden={user?.hasOwnProperty("role") && !canSeeAdmin(user)}
                    to={paths.settings.privacy()}
                    className="text-theme-text-secondary hover:text-white hover:light:text-theme-text-primary text-xs leading-[18px] mx-3"
                  >
                    {t("settings.privacy")}
                  </Link>
                  <AppVersion />
                </div>
              </div>
            </div>
            <div className="absolute bottom-0 left-0 right-0 pt-4 pb-3 rounded-b-[24px] bg-[var(--soft-sidebar-bg)] bg-opacity-80 backdrop-filter backdrop-blur-md z-10">
              <Footer />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function SupportEmail() {
  const [supportEmail, setSupportEmail] = useState(paths.mailToMintplex());
  const { t } = useTranslation();

  useEffect(() => {
    const fetchSupportEmail = async () => {
      const supportEmail = await System.fetchSupportEmail();
      setSupportEmail(
        supportEmail?.email
          ? `mailto:${supportEmail.email}`
          : paths.mailToMintplex()
      );
    };
    fetchSupportEmail();
  }, []);

  return (
    <Link
      to={supportEmail}
      className="text-theme-text-secondary hover:text-white hover:light:text-theme-text-primary text-xs leading-[18px] mx-3 mt-1"
    >
      {t("settings.contact")}
    </Link>
  );
}

const SidebarOptions = ({ user = null, t }) => {
  return (
    <CanViewChatHistoryProvider>
      {({ viewable: canViewChatHistory }) => (
        <>
          <Option
            btnText={t("settings.ai-providers")}
            icon={<Gear className="h-5 w-5 flex-shrink-0" />}
            user={user}
            childOptions={[
              {
                btnText: t("settings.llm"),
                href: paths.settings.llmPreference(),
                flex: true,
                roles: ["admin"],
              },
              {
                btnText: t("settings.vector-database"),
                href: paths.settings.vectorDatabase(),
                flex: true,
                roles: ["admin"],
              },
              {
                btnText: t("settings.embedder"),
                href: paths.settings.embedder.modelPreference(),
                flex: true,
                roles: ["admin"],
              },
              {
                btnText: t("settings.reranker"),
                href: paths.settings.rerankPreference(),
                flex: true,
                roles: ["admin"],
              },
              {
                btnText: t("settings.search-model"),
                href: paths.settings.searchModelPreference(),
                flex: true,
                roles: ["admin"],
              },
              {
                btnText: t("settings.ocr"),
                href: paths.settings.ocrPreference(),
                flex: true,
                roles: ["admin"],
              },
              {
                btnText: t("settings.vision"),
                href: paths.settings.visionPreference(),
                flex: true,
                roles: ["admin"],
              },
              {
                btnText: t("settings.text-splitting"),
                href: paths.settings.embedder.chunkingPreference(),
                flex: true,
                roles: ["admin"],
              },
              {
                btnText: t("settings.batch-jobs"),
                href: paths.settings.batchJobs(),
                flex: true,
                roles: ["admin"],
              },
              {
                btnText: t("settings.voice-speech"),
                href: paths.settings.audioPreference(),
                flex: true,
                roles: ["admin"],
              },
              {
                btnText: t("settings.transcription"),
                href: paths.settings.transcriptionPreference(),
                flex: true,
                roles: ["admin"],
              },
            ]}
          />
          <Option
            btnText={t("settings.agent-skills")}
            icon={
              <img
                src={AgentIcon}
                alt="Agent"
                className="h-5 w-5 flex-shrink-0 light:invert"
              />
            }
            href={paths.settings.agentSkills()}
            user={user}
            flex={true}
            roles={["admin"]}
          />
          <Option
            btnText={t("settings.system-patrol")}
            icon={<FirstAidKit className="h-5 w-5 flex-shrink-0" />}
            href={paths.settings.systemPatrol()}
            user={user}
            flex={true}
            roles={["admin"]}
          />
          <Option
            btnText={t("settings.customization")}
            icon={<PencilSimpleLine className="h-5 w-5 flex-shrink-0" />}
            user={user}
            childOptions={[
              {
                btnText: t("settings.interface"),
                href: paths.settings.interface(),
                flex: true,
                roles: ["user", "developer", "admin"],
              },
              {
                btnText: t("settings.branding"),
                href: paths.settings.branding(),
                flex: true,
                roles: ["admin"],
              },
              {
                btnText: t("settings.button-lab"),
                href: paths.settings.buttonLab(),
                flex: true,
                roles: ["admin"],
              },
              {
                btnText: t("settings.mobile-page-experiment"),
                href: paths.settings.mobilePageExperiment(),
                flex: true,
                roles: ["developer", "admin"],
              },
              {
                btnText: t("settings.athena-3d-center"),
                href: paths.settings.athena3dCenter(),
                flex: true,
                roles: ["developer", "admin"],
              },
              {
                btnText: t("settings.crypto-component-experiment"),
                href: paths.settings.cryptoComponentExperiment(),
                flex: true,
                roles: ["developer", "admin"],
              },
              {
                btnText: t("settings.chat"),
                href: paths.settings.chat(),
                flex: true,
                roles: ["admin"],
              },
            ]}
          />
          <Option
            btnText={t("settings.channels")}
            icon={<Plugs className="h-5 w-5 flex-shrink-0" />}
            user={user}
            childOptions={[
              {
                btnText: t("settings.available-channels.telegram"),
                href: paths.settings.telegram(),
                flex: true,
                hidden: !!user,
              },
              {
                btnText: t("settings.available-channels.wechat"),
                href: paths.settings.wechat(),
                flex: true,
                hidden: !!user,
              },
              {
                btnText: t("settings.available-channels.advanced-gateway"),
                href: paths.settings.advancedGateway(),
                flex: true,
                hidden: !!user,
              },
            ]}
          />
          <Option
            btnText={t("settings.tools")}
            icon={<Toolbox className="h-5 w-5 flex-shrink-0" />}
            user={user}
            childOptions={[
              {
                hidden: !canViewChatHistory,
                btnText: t("settings.embeds"),
                href: paths.settings.embedChatWidgets(),
                flex: true,
                roles: ["admin"],
              },
              {
                btnText: t("settings.event-logs"),
                href: paths.settings.logs(),
                flex: true,
                roles: ["admin"],
              },
              {
                btnText: t("settings.image-assets", {
                  defaultValue: "图片资产",
                }),
                href: paths.settings.imageAssets(),
                flex: true,
                roles: ["user", "developer", "admin"],
              },
              {
                btnText: t("settings.local-runtime"),
                href: paths.settings.localRuntime(),
                flex: true,
                roles: ["user", "developer", "admin"],
                icon: <DesktopTower className="h-4 w-4" />,
              },
              {
                btnText: t("settings.scheduled-jobs"),
                href: paths.settings.scheduledJobs(),
                flex: true,
                hidden: !!user,
              },
              {
                btnText: t("settings.api-keys"),
                href: paths.settings.apiKeys(),
                flex: true,
                roles: ["admin"],
              },
              {
                btnText: t("settings.system-prompt-variables"),
                href: paths.settings.systemPromptVariables(),
                flex: true,
                roles: ["admin"],
              },
              {
                btnText: t("settings.browser-extension"),
                href: paths.settings.browserExtension(),
                flex: true,
                roles: ["admin"],
              },
              {
                btnText: t("settings.mobile-app"),
                href: paths.settings.mobile(),
                flex: true,
                roles: ["admin"],
              },
            ]}
          />
          <Option
            btnText={t("settings.security")}
            icon={<Nut className="h-5 w-5 flex-shrink-0" />}
            href={paths.settings.security()}
            user={user}
            flex={true}
            roles={["admin"]}
            hidden={user?.role}
          />
          <HoldToReveal key="exp_features">
            <Option
              btnText={t("settings.experimental-features")}
              icon={<Flask className="h-5 w-5 flex-shrink-0" />}
              href={paths.settings.experimental()}
              user={user}
              flex={true}
              roles={["admin"]}
            />
          </HoldToReveal>
        </>
      )}
    </CanViewChatHistoryProvider>
  );
};

function HoldToReveal({ children, holdForMs = 3_000 }) {
  let timeout = null;
  const [showing, setShowing] = useState(
    window.localStorage.getItem(
      "anythingllm_experimental_feature_preview_unlocked"
    )
  );

  useEffect(() => {
    const onPress = (e) => {
      if (!["Control", "Meta"].includes(e.key) || timeout !== null) return;
      timeout = setTimeout(() => {
        setShowing(true);
        // Setting toastId prevents hook spam from holding control too many times or the event not detaching
        showToast("Experimental feature previews unlocked!");
        window.localStorage.setItem(
          "anythingllm_experimental_feature_preview_unlocked",
          "enabled"
        );
        window.removeEventListener("keypress", onPress);
        window.removeEventListener("keyup", onRelease);
        clearTimeout(timeout);
      }, holdForMs);
    };
    const onRelease = (e) => {
      if (!["Control", "Meta"].includes(e.key)) return;
      if (showing) {
        window.removeEventListener("keypress", onPress);
        window.removeEventListener("keyup", onRelease);
        clearTimeout(timeout);
        return;
      }
      clearTimeout(timeout);
    };

    if (!showing) {
      window.addEventListener("keydown", onPress);
      window.addEventListener("keyup", onRelease);
    }
    return () => {
      window.removeEventListener("keydown", onPress);
      window.removeEventListener("keyup", onRelease);
    };
  }, []);

  if (!showing) return null;
  return children;
}

function AppVersion() {
  const { version, isLoading } = useAppVersion();
  if (isLoading) return null;
  return (
    <Link
      to={`https://github.com/Mintplex-Labs/anything-llm/releases/tag/v${version}`}
      target="_blank"
      rel="noreferrer"
      className="text-theme-text-secondary light:opacity-80 opacity-50 text-xs mx-3"
    >
      v{version}
    </Link>
  );
}
