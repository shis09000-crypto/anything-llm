import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import Sidebar from "@/components/Sidebar";
import Workspace from "@/models/workspace";
import PasswordModal, { usePasswordModal } from "@/components/Modals/Password";
import { isMobile } from "react-device-detect";
import { FullScreenLoader } from "@/components/Preloader";
import {
  ArrowUUpLeft,
  ChatText,
  Database,
  Heartbeat,
  Robot,
  TextAa,
  Wrench,
} from "@phosphor-icons/react";
import paths from "@/utils/paths";
import { Link, Navigate, NavLink } from "react-router-dom";
import GeneralAppearance from "./GeneralAppearance";
import ChatSettings from "./ChatSettings";
import VectorDatabase from "./VectorDatabase";
import WorkspaceAgentConfiguration from "./AgentConfig";
import HealthCenter from "./HealthCenter";
import ReadingTools from "./ReadingTools";
import { useTranslation } from "react-i18next";
import { WorkspaceHealthProvider } from "@/contexts/WorkspaceHealthProvider";
import { useSettingsSection } from "@/pages/GeneralSettings/useSettingsSection";

const TABS = {
  "general-appearance": GeneralAppearance,
  "chat-settings": ChatSettings,
  "vector-database": VectorDatabase,
  "health-center": HealthCenter,
  "reading-tools": ReadingTools,
  "agent-config": WorkspaceAgentConfiguration,
};

export default function WorkspaceSettings() {
  const { loading, requiresAuth, mode } = usePasswordModal();

  if (loading) return <FullScreenLoader />;
  if (requiresAuth !== false) {
    return <>{requiresAuth !== null && <PasswordModal mode={mode} />}</>;
  }

  return <ShowWorkspaceChat />;
}

function ShowWorkspaceChat() {
  const { t } = useTranslation();
  const { slug, tab } = useParams();
  const [workspace, setWorkspace] = useState(null);
  const [loading, setLoading] = useState(true);
  const loadVectorSettings = useSettingsSection("vector");

  useEffect(() => {
    const controller = new AbortController();
    async function getWorkspace() {
      if (!slug) return;
      setLoading(true);
      const [_workspace, _settings, suggestedMessages] = await Promise.all([
        Workspace.bySlug(slug),
        loadVectorSettings({ priority: "P0" }),
        Workspace.getSuggestedMessages(slug),
      ]);
      if (controller.signal.aborted) return;
      if (!_workspace) {
        setLoading(false);
        return;
      }

      setWorkspace({
        ..._workspace,
        vectorDB: _settings?.VectorDB,
        suggestedMessages,
      });
      setLoading(false);
    }
    getWorkspace();
    return () => controller.abort();
  }, [loadVectorSettings, slug]);

  if (loading) return <WorkspaceSettingsSkeleton />;

  const TabContent = TABS[tab];
  if (!TabContent) {
    return (
      <Navigate to={paths.workspace.settings.generalAppearance(slug)} replace />
    );
  }

  return (
    <WorkspaceHealthProvider workspaceSlug={slug}>
      <div className="w-screen h-screen overflow-hidden bg-zinc-950 light:bg-slate-50 flex">
        {!isMobile && <Sidebar />}
        <div
          style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
          className="motion-hover relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll"
        >
          <div className="flex flex-wrap gap-x-8 gap-y-3 pt-6 pb-4 ml-16 mr-8 border-b-2 border-white light:border-theme-chat-input-border border-opacity-10">
            <Link
              to={paths.workspace.chat(slug)}
              className="absolute top-2 left-2 md:top-4 md:left-4 motion-hover p-2 rounded-full text-white bg-theme-sidebar-footer-icon hover:bg-theme-sidebar-footer-icon-hover z-10"
            >
              <ArrowUUpLeft className="h-5 w-5" weight="fill" />
            </Link>
            <TabItem
              title={t("workspaces—settings.general")}
              icon={<Wrench className="h-6 w-6" />}
              to={paths.workspace.settings.generalAppearance(slug)}
            />
            <TabItem
              title={t("workspaces—settings.chat")}
              icon={<ChatText className="h-6 w-6" />}
              to={paths.workspace.settings.chatSettings(slug)}
            />
            <TabItem
              title={t("workspaces—settings.vector")}
              icon={<Database className="h-6 w-6" />}
              to={paths.workspace.settings.vectorDatabase(slug)}
            />
            <TabItem
              title={t("workspaces—settings.health")}
              icon={<Heartbeat className="h-6 w-6" />}
              to={paths.workspace.settings.healthCenter(slug)}
            />
            <TabItem
              title={t("workspaces—settings.reading")}
              icon={<TextAa className="h-6 w-6" />}
              to={paths.workspace.settings.readingTools(slug)}
            />
            <TabItem
              title={t("workspaces—settings.agent")}
              icon={<Robot className="h-6 w-6" />}
              to={paths.workspace.settings.agentConfig(slug)}
            />
          </div>
          <div className="px-16 py-6">
            <TabContent slug={slug} workspace={workspace} />
          </div>
        </div>
      </div>
    </WorkspaceHealthProvider>
  );
}

function WorkspaceSettingsSkeleton() {
  return (
    <div className="w-screen h-screen overflow-hidden bg-zinc-950 light:bg-slate-50 flex">
      {!isMobile && <Sidebar />}
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-hidden"
      >
        <div className="flex gap-x-8 pt-6 pb-4 ml-16 mr-8 border-b-2 border-white light:border-theme-chat-input-border border-opacity-10">
          {[0, 1, 2, 3].map((index) => (
            <div
              key={index}
              className="motion-skeleton h-6 w-28 rounded-md"
              style={{ "--motion-list-index": index }}
            />
          ))}
        </div>
        <div className="px-16 py-6 space-y-4">
          <div className="motion-skeleton h-8 w-64 rounded-md" />
          <div className="motion-skeleton h-24 w-full max-w-3xl rounded-md" />
          <div className="motion-skeleton h-10 w-52 rounded-md" />
        </div>
      </div>
    </div>
  );
}

function TabItem({ title, icon, to, visible = true }) {
  if (!visible) return null;
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `${
          isActive
            ? "text-sky-400 pb-4 border-b-[4px] -mb-[19px] border-sky-400"
            : "text-white/60 hover:text-sky-400"
        } ` + " flex gap-x-2 items-center font-medium"
      }
    >
      {icon}
      <div>{title}</div>
    </NavLink>
  );
}
