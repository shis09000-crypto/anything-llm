import React, { useEffect, useRef, useState } from "react";
import {
  CaretDown,
  CircleNotch,
  CurrencyBtc,
  House,
  List,
  NotePencil,
  Plus,
} from "@phosphor-icons/react";
import NewWorkspaceModal, {
  useNewWorkspaceModal,
} from "../Modals/NewWorkspace";
import ActiveWorkspaces from "./ActiveWorkspaces";
import useLogo from "@/hooks/useLogo";
import useUser from "@/hooks/useUser";
import Footer from "../Footer";
import SettingsButton from "../SettingsButton";
import { useNavigate } from "react-router-dom";
import paths from "@/utils/paths";
import { useTranslation } from "react-i18next";
import { useSidebarToggle, ToggleSidebarButton } from "./SidebarToggle";
import SearchBox from "./SearchBox";
import { Tooltip } from "react-tooltip";
import { createPortal } from "react-dom";
import {
  getLastVisitedWorkspace,
  pathForLastVisitedThread,
} from "@/utils/lastVisitedWorkspace";
import UserButton from "../UserMenu/UserButton";
import { canSeeAdmin } from "@/utils/authz";

function homeLinkPath() {
  const lastVisited = getLastVisitedWorkspace();
  return lastVisited?.slug
    ? pathForLastVisitedThread(lastVisited.slug)
    : paths.home();
}

export default function Sidebar() {
  const { t } = useTranslation();
  const { user } = useUser();
  const { logo } = useLogo();
  const navigate = useNavigate();
  const productName = t("common.productName");
  const showTextBrand = Boolean(productName);
  const sidebarRef = useRef(null);
  const brandMenuRef = useRef(null);
  const cryptoEntryTimerRef = useRef(null);
  const { showSidebar, setShowSidebar, canToggleSidebar } = useSidebarToggle();
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [cryptoEntering, setCryptoEntering] = useState(false);
  const [cryptoEntryProgress, setCryptoEntryProgress] = useState(0);
  const {
    showing: showingNewWsModal,
    showModal: showNewWsModal,
    hideModal: hideNewWsModal,
  } = useNewWorkspaceModal();
  const canEnterCryptoCenter = !user || canSeeAdmin(user);

  useEffect(() => {
    if (!brandMenuOpen) return;

    function handlePointerDown(event) {
      if (brandMenuRef.current?.contains(event.target)) return;
      setBrandMenuOpen(false);
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") setBrandMenuOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [brandMenuOpen]);

  useEffect(() => {
    return () => {
      if (cryptoEntryTimerRef.current)
        window.clearTimeout(cryptoEntryTimerRef.current);
    };
  }, []);

  function goHome() {
    setBrandMenuOpen(false);
    navigate(homeLinkPath());
  }

  function enterCryptoCenter() {
    if (cryptoEntering || !canEnterCryptoCenter) return;
    setBrandMenuOpen(false);
    setCryptoEntering(true);
    setCryptoEntryProgress(8);
    window.requestAnimationFrame(() => setCryptoEntryProgress(100));
    cryptoEntryTimerRef.current = window.setTimeout(() => {
      navigate(paths.settings.cryptoCenter());
    }, 260);
  }

  return (
    <>
      {cryptoEntering ? (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-[#050505]/95 px-6 text-white backdrop-blur-md">
          <div className="w-full max-w-[520px] rounded-[28px] border border-[#D6A84F]/20 bg-black/70 p-7 shadow-[0_28px_120px_rgba(214,168,79,.18)]">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-full border border-[#D6A84F]/35 bg-[#D6A84F]/10 text-[#D6A84F]">
                <CurrencyBtc className="h-6 w-6" />
              </div>
              <div>
                <div className="text-lg font-black text-white">
                  正在进入加密货币专区
                </div>
                <div className="mt-1 text-xs font-semibold text-white/45">
                  正在打开页面，真实数据将在专区内同步...
                </div>
              </div>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-[#D6A84F] shadow-[0_0_24px_rgba(214,168,79,.55)]"
                style={{
                  width: `${cryptoEntryProgress}%`,
                  transition: "width 240ms cubic-bezier(.22,1,.36,1)",
                }}
              />
            </div>
          </div>
        </div>
      ) : null}

      <div
        style={{
          width: showSidebar ? "292px" : "0px",
          paddingLeft: showSidebar ? "0px" : "16px",
        }}
        className="relative motion-hover"
      >
        {canToggleSidebar && (
          <ToggleSidebarButton
            showSidebar={showSidebar}
            setShowSidebar={setShowSidebar}
          />
        )}
        <div className="overflow-hidden h-full">
          <div className="flex shrink-0 w-full justify-center my-[18px]">
            <div
              ref={brandMenuRef}
              className="relative flex w-[250px] min-w-[250px] items-center gap-x-2 pr-9"
            >
              <button
                type="button"
                aria-label="Athena navigation menu"
                aria-expanded={brandMenuOpen}
                onClick={() => setBrandMenuOpen((current) => !current)}
                className="flex min-w-0 flex-1 items-center gap-x-2 rounded-md text-left"
              >
                <img
                  src={logo}
                  alt="Logo"
                  className={`rounded max-h-[24px] object-contain motion-hover ${showSidebar ? "opacity-100" : "opacity-0"}`}
                />
                {showTextBrand && (
                  <span
                    className={`text-sm font-semibold text-theme-text-primary light:text-slate-700 whitespace-nowrap motion-hover ${showSidebar ? "opacity-100" : "opacity-0"}`}
                  >
                    {productName}
                  </span>
                )}
                <CaretDown
                  className={`h-3.5 w-3.5 shrink-0 text-theme-text-secondary motion-hover ${showSidebar ? "opacity-100" : "opacity-0"}`}
                />
              </button>

              {brandMenuOpen && showSidebar ? (
                <div className="absolute left-0 top-[calc(100%+10px)] z-40 w-[220px] rounded-[16px] border border-white/10 bg-theme-bg-sidebar/95 p-2 shadow-[0_18px_48px_rgba(0,0,0,.34)] backdrop-blur light:border-slate-200 light:bg-white/95">
                  <button
                    type="button"
                    onClick={goHome}
                    className="flex w-full items-center gap-2 rounded-[12px] px-3 py-2 text-left text-xs font-bold text-theme-text-primary hover:bg-white/10 hover:light:bg-slate-100"
                  >
                    <House className="h-4 w-4 shrink-0" />
                    返回工作区
                  </button>
                  {canEnterCryptoCenter ? (
                    <button
                      type="button"
                      disabled={cryptoEntering}
                      onClick={enterCryptoCenter}
                      className="mt-1 flex w-full items-center gap-2 rounded-[12px] px-3 py-2 text-left text-xs font-bold text-[#D6A84F] hover:bg-[#D6A84F]/10 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <CurrencyBtc className="h-4 w-4 shrink-0" />
                      加密货币专区
                    </button>
                  ) : null}
                </div>
              ) : null}

              <UserButton
                className={`${showSidebar ? "opacity-100" : "pointer-events-none opacity-0"}`}
              />
            </div>
          </div>
          <div
            ref={sidebarRef}
            className="relative m-[16px] rounded-[16px] bg-theme-bg-sidebar light:bg-slate-200 border-[2px] border-theme-sidebar-border light:border-none min-w-[250px] p-[10px] h-[calc(100%-76px)]"
          >
            <div className="flex flex-col h-full overflow-hidden">
              <div className="flex-grow flex flex-col min-w-[235px] min-h-0">
                <div className="relative h-[calc(100%-60px)] flex flex-col w-full justify-between pt-[10px] overflow-y-scroll no-scroll">
                  <div className="flex flex-col gap-y-[14px]">
                    <SearchBox showNewWsModal={showNewWsModal} />
                    <ActiveWorkspaces />
                  </div>
                </div>
                <div className="absolute bottom-0 left-0 right-0 pb-3 rounded-b-[16px] bg-theme-bg-sidebar light:bg-slate-200 bg-opacity-80 backdrop-filter backdrop-blur-md z-10">
                  <Footer />
                </div>
              </div>
            </div>
          </div>
        </div>
        {showingNewWsModal && <NewWorkspaceModal hideModal={hideNewWsModal} />}
      </div>
      <WorkspaceAndThreadTooltips />
    </>
  );
}

export function SidebarMobileHeader({
  onNewThread = null,
  newThreadLoading = false,
}) {
  const { t } = useTranslation();
  const { logo } = useLogo();
  const productName = t("common.productName");
  const showTextBrand = Boolean(productName);
  const sidebarRef = useRef(null);
  const [showSidebar, setShowSidebar] = useState(false);
  const [showBgOverlay, setShowBgOverlay] = useState(false);
  const {
    showing: showingNewWsModal,
    showModal: showNewWsModal,
    hideModal: hideNewWsModal,
  } = useNewWorkspaceModal();

  useEffect(() => {
    // Darkens the rest of the screen
    // when sidebar is open.
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

  return (
    <>
      <div
        aria-label="Show sidebar"
        className="fixed top-0 left-0 right-0 z-10 flex justify-between items-center px-4 py-2 bg-theme-bg-sidebar light:bg-white text-slate-200 shadow-lg h-16"
      >
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
        {onNewThread ? (
          <button
            type="button"
            onClick={onNewThread}
            disabled={newThreadLoading}
            aria-label={t("common.newThread")}
            aria-busy={newThreadLoading}
            className="rounded-md p-2 flex h-10 w-10 items-center justify-center text-theme-text-secondary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {newThreadLoading ? (
              <CircleNotch className="h-6 w-6 animate-spin" />
            ) : (
              <NotePencil className="h-6 w-6" />
            )}
          </button>
        ) : (
          <div className="w-12"></div>
        )}
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
          } fixed top-0 left-0 bg-theme-bg-secondary bg-opacity-75 w-screen h-screen`}
          onClick={() => setShowSidebar(false)}
        />
        <div
          ref={sidebarRef}
          className="relative h-[100vh] fixed top-0 left-0  rounded-r-[26px] bg-theme-bg-sidebar w-[80%] p-[18px] "
        >
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
              <div className="flex gap-x-2 items-center text-slate-500 shink-0">
                <SettingsButton />
              </div>
            </div>

            {/* Primary Body */}
            <div className="h-full flex flex-col w-full justify-between pt-4 ">
              <div className="h-auto md:sidebar-items">
                <div className=" flex flex-col gap-y-4 overflow-y-scroll no-scroll pb-[60px]">
                  <NewWorkspaceButton showNewWsModal={showNewWsModal} />
                  <ActiveWorkspaces />
                </div>
              </div>
              <div className="z-99 absolute bottom-0 left-0 right-0 pt-2 pb-6 rounded-br-[26px] bg-theme-bg-sidebar bg-opacity-80 backdrop-filter backdrop-blur-md">
                <Footer />
              </div>
            </div>
          </div>
        </div>
        {showingNewWsModal && <NewWorkspaceModal hideModal={hideNewWsModal} />}
      </div>
    </>
  );
}

function NewWorkspaceButton({ showNewWsModal }) {
  const { t } = useTranslation();

  return (
    <div className="flex gap-x-2 items-center justify-between">
      <button
        onClick={showNewWsModal}
        className="flex flex-grow w-[75%] h-[44px] gap-x-2 py-[5px] px-4 bg-white rounded-lg text-sidebar justify-center items-center hover:bg-opacity-80 motion-hover"
      >
        <Plus className="h-5 w-5" />
        <p className="text-sidebar text-sm font-semibold">
          {t("new-workspace.title")}
        </p>
      </button>
    </div>
  );
}

function WorkspaceAndThreadTooltips() {
  return createPortal(
    <React.Fragment>
      <Tooltip
        id="workspace-name"
        place="right"
        delayShow={800}
        className="tooltip !text-xs z-99"
      />
      <Tooltip
        id="workspace-thread-name"
        place="right"
        delayShow={800}
        className="tooltip !text-xs z-99"
      />
      <Tooltip
        id="upload-workspace"
        place="top"
        delayShow={300}
        className="tooltip !text-xs z-99"
      />
      <Tooltip
        id="gear-workspace"
        place="top"
        delayShow={300}
        className="tooltip !text-xs z-99"
      />
      <Tooltip
        id="user-account-button"
        place="bottom"
        delayShow={300}
        className="tooltip !text-xs z-99"
      />
    </React.Fragment>,
    document.body
  );
}
