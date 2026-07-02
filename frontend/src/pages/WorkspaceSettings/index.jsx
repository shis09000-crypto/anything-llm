import React, { useEffect, useState } from "react";
import Workspace from "@/models/workspace";
import PasswordModal, {
  AuthBootstrapError,
  usePasswordModal,
} from "@/components/Modals/Password";
import { isMobile } from "react-device-detect";
import {
  ArrowUUpLeft,
  ChatText,
  Database,
  Heartbeat,
  Robot,
  Wrench,
} from "@phosphor-icons/react";
import paths from "@/utils/paths";
import { Link, Navigate, NavLink, useParams } from "react-router-dom";
import GeneralAppearance from "./GeneralAppearance";
import ChatSettings from "./ChatSettings";
import VectorDatabase from "./VectorDatabase";
import WorkspaceAgentConfiguration from "./AgentConfig";
import HealthCenter from "./HealthCenter";
import { useTranslation } from "react-i18next";
import { WorkspaceHealthProvider } from "@/contexts/WorkspaceHealthProvider";
import { requestPriorityQueue } from "@/utils/chat/requestPriorityQueue";
import { workspaceNavigationCache } from "@/utils/chat/workspaceNavigationCache";
import { pathForLastVisitedThread } from "@/utils/lastVisitedWorkspace";

const TABS = {
  "general-appearance": GeneralAppearance,
  "chat-settings": ChatSettings,
  "vector-database": VectorDatabase,
  "health-center": HealthCenter,
  "reading-tools": ReadingToolsRedirect,
  "agent-config": WorkspaceAgentConfiguration,
};

export default function WorkspaceSettings() {
  const { loading, requiresAuth, mode, error } = usePasswordModal();
  const { slug } = useParams();

  if (loading) {
    return (
      <WorkspaceSettingsShell slug={slug}>
        <WorkspaceSettingsSkeletonContent />
      </WorkspaceSettingsShell>
    );
  }
  if (error) return <AuthBootstrapError message={error} />;
  if (requiresAuth !== false) {
    return <>{requiresAuth !== null && <PasswordModal mode={mode} />}</>;
  }

  return <WorkspaceSettingsOutletLayout />;
}

function WorkspaceSettingsOutletLayout() {
  const { slug, tab } = useParams();
  const TabContent = TABS[tab];
  const [workspace, setWorkspace] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    async function getWorkspace() {
      if (!slug) return;
      const cached = workspaceNavigationCache.getWorkspaceDetail(slug);
      if (cached) {
        setWorkspace(cached);
        setLoading(false);
      } else {
        setLoading(true);
      }

      let _workspace = null;
      try {
        _workspace = await workspaceNavigationCache.runInFlight(
          `workspace:${slug}`,
          () =>
            requestPriorityQueue.schedule(
              () =>
                Workspace.bySlug(slug, {
                  signal: controller.signal,
                  communicationScene: "workspace-settings",
                  task: false,
                }),
              {
                priority: cached ? "P1" : "P0",
                label: "workspace-settings:workspace-detail",
                kind: "settings",
                scope: {
                  route: "workspace-settings",
                  workspaceSlug: slug,
                },
                policy: cached ? "visible" : "foreground",
                emergency: !cached,
                intentRank: 0,
                signal: controller.signal,
                dedupeKey: `workspace-settings:workspace:${slug}`,
              }
            )
        );
      } catch (error) {
        if (error?.name === "AbortError" || controller.signal.aborted) return;
        console.error(error);
      }
      if (controller.signal.aborted) return;
      if (!_workspace) {
        setLoading(false);
        return;
      }

      setWorkspace(_workspace);
      setLoading(false);
    }
    getWorkspace();
    return () => controller.abort();
  }, [slug]);

  if (!TabContent) {
    return (
      <Navigate to={paths.workspace.settings.generalAppearance(slug)} replace />
    );
  }

  if (loading) {
    return (
      <WorkspaceSettingsShell slug={slug}>
        <WorkspaceSettingsSkeletonContent />
      </WorkspaceSettingsShell>
    );
  }

  return (
    <WorkspaceHealthProvider
      workspaceSlug={slug}
      autoLoad={tab === "health-center"}
      communicationScene="settings-tab"
    >
      <WorkspaceSettingsShell slug={slug}>
        <TabContent slug={slug} workspace={workspace} />
      </WorkspaceSettingsShell>
    </WorkspaceHealthProvider>
  );
}

export function WorkspaceSettingsDefaultRedirect() {
  const { slug } = useParams();
  return (
    <Navigate to={paths.workspace.settings.generalAppearance(slug)} replace />
  );
}

function WorkspaceSettingsShell({ slug, children }) {
  const { t } = useTranslation();

  return (
    <div
      style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
      className="motion-hover relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll"
    >
      <div className="flex flex-wrap gap-x-8 gap-y-3 pt-6 pb-4 ml-16 mr-8 border-b-2 border-white light:border-theme-chat-input-border border-opacity-10">
        <Link
          to={pathForLastVisitedThread(slug)}
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
          title={t("workspaces—settings.agent")}
          icon={<Robot className="h-6 w-6" />}
          to={paths.workspace.settings.agentConfig(slug)}
        />
      </div>
      <div className="px-16 py-6">{children}</div>
    </div>
  );
}

function ReadingToolsRedirect() {
  return (
    <Navigate
      to={paths.settings.interface({ hash: "reading-tools" })}
      replace
    />
  );
}

function WorkspaceSettingsSkeletonContent() {
  return (
    <div className="space-y-4">
      <div className="motion-skeleton h-8 w-64 rounded-md" />
      <div className="motion-skeleton h-24 w-full max-w-3xl rounded-md" />
      <div className="motion-skeleton h-10 w-52 rounded-md" />
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
