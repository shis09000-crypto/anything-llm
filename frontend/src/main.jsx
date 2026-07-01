import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import App from "@/App.jsx";
import PrivateRoute, {
  AdminRoute,
  DeveloperRoute,
  ManagerRoute,
  SingleUserRoute,
} from "@/components/PrivateRoute";
import "@/index.css";
import { installEnvironmentStorageScope } from "@/utils/appEnvironment";
import { isCryptoCenterDevAuthBypassEnabled } from "@/utils/cryptoCenterDevAuthBypass";
import {
  installFontDiagnostics,
  installFontPlatformScope,
} from "@/utils/fontPlatform";
import { SoftSettingsOutletLayout } from "@/components/SoftSettings";

const isDev = import.meta.env.DEV;
const REACTWRAP = isDev ? React.Fragment : React.StrictMode;

installEnvironmentStorageScope();
installFontPlatformScope();
installFontDiagnostics();

const GeneralLLMPreference = React.lazy(
  () => import("@/pages/GeneralSettings/LLMPreference")
);
const GeneralVectorDatabase = React.lazy(
  () => import("@/pages/GeneralSettings/VectorDatabase")
);
const GeneralEmbeddingPreference = React.lazy(
  () => import("@/pages/GeneralSettings/EmbeddingPreference")
);
const GeneralRerankPreference = React.lazy(
  () => import("@/pages/GeneralSettings/RerankPreference")
);
const GeneralSearchModelPreference = React.lazy(
  () => import("@/pages/GeneralSettings/SearchModelPreference")
);
const GeneralOcrPreference = React.lazy(
  () => import("@/pages/GeneralSettings/OcrPreference")
);
const GeneralVisionPreference = React.lazy(
  () => import("@/pages/GeneralSettings/VisionPreference")
);
const EmbeddingTextSplitterPreference = React.lazy(
  () => import("@/pages/GeneralSettings/EmbeddingTextSplitterPreference")
);
const BatchJobs = React.lazy(() => import("@/pages/GeneralSettings/BatchJobs"));
const GeneralAudioPreference = React.lazy(
  () => import("@/pages/GeneralSettings/AudioPreference")
);
const GeneralTranscriptionPreference = React.lazy(
  () => import("@/pages/GeneralSettings/TranscriptionPreference")
);
const GeneralSecurity = React.lazy(
  () => import("@/pages/GeneralSettings/Security")
);
const InterfaceSettings = React.lazy(
  () => import("@/pages/GeneralSettings/Settings/Interface")
);
const GeneralApiKeys = React.lazy(
  () => import("@/pages/GeneralSettings/ApiKeys")
);
const ScheduledJobs = React.lazy(
  () => import("@/pages/GeneralSettings/ScheduledJobs")
);
const ScheduledJobRuns = React.lazy(
  () => import("@/pages/GeneralSettings/ScheduledJobs/RunHistoryPage")
);
const ScheduledJobRunDetail = React.lazy(
  () => import("@/pages/GeneralSettings/ScheduledJobs/RunDetailPage")
);
const AdminAgents = React.lazy(() => import("@/pages/Admin/Agents"));
const AdminLogs = React.lazy(() => import("@/pages/Admin/Logging"));
const SystemPatrol = React.lazy(
  () => import("@/pages/GeneralSettings/SystemPatrol")
);
const CryptoCenter = React.lazy(() => import("@/pages/Admin/CryptoCenter"));
const ChatEmbedWidgets = React.lazy(
  () => import("@/pages/GeneralSettings/ChatEmbedWidgets")
);
const PrivacyAndData = React.lazy(
  () => import("@/pages/GeneralSettings/PrivacyAndData")
);
const BrandingSettings = React.lazy(
  () => import("@/pages/GeneralSettings/Settings/Branding")
);
const ButtonLab = React.lazy(
  () => import("@/pages/GeneralSettings/Settings/ButtonLab")
);
const MobilePageExperiment = React.lazy(
  () => import("@/pages/GeneralSettings/Settings/MobilePageExperiment")
);
const CryptoComponentExperiment = React.lazy(
  () => import("@/pages/GeneralSettings/Settings/CryptoComponentExperiment")
);
const ChatSettings = React.lazy(
  () => import("@/pages/GeneralSettings/Settings/Chat")
);
const ExperimentalFeatures = React.lazy(
  () => import("@/pages/Admin/ExperimentalFeatures")
);
const LiveDocumentSyncManage = React.lazy(
  () => import("@/pages/Admin/ExperimentalFeatures/Features/LiveSync/manage")
);
const SystemPromptVariables = React.lazy(
  () => import("@/pages/Admin/SystemPromptVariables")
);
const GeneralBrowserExtension = React.lazy(
  () => import("@/pages/GeneralSettings/BrowserExtensionApiKey")
);
const MobileConnections = React.lazy(
  () => import("@/pages/GeneralSettings/MobileConnections")
);
const TelegramBotSettings = React.lazy(
  () => import("@/pages/GeneralSettings/Connections/TelegramBot")
);
const WeChatConnectorSettings = React.lazy(
  () => import("@/pages/GeneralSettings/Connections/WeChatConnector")
);
const AdvancedGatewayConnectorSettings = React.lazy(
  () => import("@/pages/GeneralSettings/Connections/AdvancedGatewayConnector")
);

function routeElement(RouteComponent, Component, props = {}) {
  return <RouteComponent Component={Component} {...props} />;
}

function cryptoBypassElement(RouteComponent, Component) {
  return isCryptoCenterDevAuthBypassEnabled() ? (
    <Component />
  ) : (
    <RouteComponent Component={Component} />
  );
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      {
        path: "/",
        lazy: async () => {
          const { default: Main } = await import("@/pages/Main");
          return { element: <PrivateRoute Component={Main} /> };
        },
      },
      {
        path: "/login",
        lazy: async () => {
          const { default: Login } = await import("@/pages/Login");
          return { element: <Login /> };
        },
      },
      {
        path: "/sso/simple",
        lazy: async () => {
          const { default: SimpleSSOPassthrough } = await import(
            "@/pages/Login/SSO/simple"
          );
          return { element: <SimpleSSOPassthrough /> };
        },
      },
      {
        path: "/workspace/:slug/settings/:tab",
        lazy: async () => {
          const { default: WorkspaceSettings } = await import(
            "@/pages/WorkspaceSettings"
          );
          return { element: <PrivateRoute Component={WorkspaceSettings} /> };
        },
      },
      {
        path: "/workspace/:slug",
        lazy: async () => {
          const { default: WorkspaceChat } = await import(
            "@/pages/WorkspaceChat"
          );
          return { element: <PrivateRoute Component={WorkspaceChat} /> };
        },
        children: [{ path: "t/:threadSlug" }],
      },
      {
        path: "/accept-invite/:code",
        lazy: async () => {
          const { default: InvitePage } = await import("@/pages/Invite");
          return { element: <InvitePage /> };
        },
      },
      {
        path: "/auth/admin-invite",
        lazy: async () => {
          const { default: InvitePage } = await import("@/pages/Invite");
          return { element: <InvitePage /> };
        },
      },
      {
        path: "/settings/account",
        lazy: async () => {
          const { default: AccountSettings } = await import(
            "@/pages/UserSettings/AccountSettings"
          );
          return { element: <PrivateRoute Component={AccountSettings} /> };
        },
      },
      // Admin routes
      {
        path: "/settings",
        element: <SoftSettingsOutletLayout />,
        children: [
          {
            path: "llm-preference",
            element: routeElement(AdminRoute, GeneralLLMPreference),
          },
          {
            path: "vector-database",
            element: routeElement(AdminRoute, GeneralVectorDatabase),
          },
          {
            path: "embedding-preference",
            element: routeElement(AdminRoute, GeneralEmbeddingPreference),
          },
          {
            path: "rerank-preference",
            element: routeElement(AdminRoute, GeneralRerankPreference),
          },
          {
            path: "search-model-preference",
            element: routeElement(AdminRoute, GeneralSearchModelPreference),
          },
          {
            path: "ocr-preference",
            element: routeElement(AdminRoute, GeneralOcrPreference),
          },
          {
            path: "vision-preference",
            element: routeElement(AdminRoute, GeneralVisionPreference),
          },
          {
            path: "text-splitter-preference",
            element: routeElement(AdminRoute, EmbeddingTextSplitterPreference),
          },
          {
            path: "batch-jobs",
            element: routeElement(AdminRoute, BatchJobs),
          },
          {
            path: "audio-preference",
            element: routeElement(AdminRoute, GeneralAudioPreference),
          },
          {
            path: "transcription-preference",
            element: routeElement(AdminRoute, GeneralTranscriptionPreference),
          },
          {
            path: "security",
            element: routeElement(ManagerRoute, GeneralSecurity),
          },
          {
            path: "interface",
            element: routeElement(PrivateRoute, InterfaceSettings),
          },
          {
            path: "api-keys",
            element: routeElement(AdminRoute, GeneralApiKeys),
          },
          {
            path: "scheduled-jobs",
            element: routeElement(SingleUserRoute, ScheduledJobs),
          },
          {
            path: "scheduled-jobs/:id/runs",
            element: routeElement(SingleUserRoute, ScheduledJobRuns),
          },
          {
            path: "scheduled-jobs/:id/runs/:runId",
            element: routeElement(SingleUserRoute, ScheduledJobRunDetail),
          },
          {
            path: "agents",
            element: routeElement(AdminRoute, AdminAgents),
          },
          {
            path: "event-logs",
            element: routeElement(AdminRoute, AdminLogs),
          },
          {
            path: "system-patrol",
            element: routeElement(AdminRoute, SystemPatrol),
          },
          {
            path: "embed-chat-widgets",
            element: routeElement(AdminRoute, ChatEmbedWidgets),
          },
          {
            path: "privacy",
            element: routeElement(AdminRoute, PrivacyAndData),
          },
          {
            path: "branding",
            element: routeElement(ManagerRoute, BrandingSettings),
          },
          {
            path: "button-lab",
            element: routeElement(ManagerRoute, ButtonLab),
          },
          {
            path: "mobile-page-experiment",
            element: routeElement(DeveloperRoute, MobilePageExperiment),
          },
          {
            path: "crypto-component-experiment",
            element: cryptoBypassElement(
              DeveloperRoute,
              CryptoComponentExperiment
            ),
          },
          {
            path: "chat",
            element: routeElement(ManagerRoute, ChatSettings),
          },
          {
            path: "beta-features",
            element: routeElement(AdminRoute, ExperimentalFeatures),
          },
          {
            path: "beta-features/live-document-sync/manage",
            element: routeElement(AdminRoute, LiveDocumentSyncManage),
          },
          {
            path: "system-prompt-variables",
            element: routeElement(AdminRoute, SystemPromptVariables),
          },
          {
            path: "browser-extension",
            element: routeElement(ManagerRoute, GeneralBrowserExtension),
          },
          {
            path: "mobile-connections",
            element: routeElement(ManagerRoute, MobileConnections),
          },
          {
            path: "external-connections/telegram",
            element: routeElement(AdminRoute, TelegramBotSettings),
          },
          {
            path: "external-connections/wechat",
            element: routeElement(AdminRoute, WeChatConnectorSettings),
          },
          {
            path: "external-connections/advanced-gateway",
            element: routeElement(AdminRoute, AdvancedGatewayConnectorSettings),
          },
        ],
      },
      {
        path: "/settings/crypto-center",
        element: cryptoBypassElement(AdminRoute, CryptoCenter),
      },
      {
        path: "/settings/agents/builder",
        lazy: async () => {
          const { default: AgentBuilder } = await import(
            "@/pages/Admin/AgentBuilder"
          );
          return {
            element: (
              <AdminRoute Component={AgentBuilder} hideUserMenu={true} />
            ),
          };
        },
      },
      {
        path: "/settings/agents/builder/:flowId",
        lazy: async () => {
          const { default: AgentBuilder } = await import(
            "@/pages/Admin/AgentBuilder"
          );
          return {
            element: (
              <AdminRoute Component={AgentBuilder} hideUserMenu={true} />
            ),
          };
        },
      },
      {
        path: "/settings/default-system-prompt",
        lazy: async () => {
          const { default: AdminLegacyRedirect } = await import(
            "@/pages/UserSettings/AccountSettings/AdminLegacyRedirect"
          );
          return { element: <AdminRoute Component={AdminLegacyRedirect} /> };
        },
      },
      {
        path: "/settings/workspace-chats",
        lazy: async () => {
          const { default: AdminLegacyRedirect } = await import(
            "@/pages/UserSettings/AccountSettings/AdminLegacyRedirect"
          );
          return { element: <AdminRoute Component={AdminLegacyRedirect} /> };
        },
      },
      {
        path: "/settings/invites",
        lazy: async () => {
          const { default: AdminLegacyRedirect } = await import(
            "@/pages/UserSettings/AccountSettings/AdminLegacyRedirect"
          );
          return { element: <AdminRoute Component={AdminLegacyRedirect} /> };
        },
      },
      {
        path: "/settings/users",
        lazy: async () => {
          const { default: AdminLegacyRedirect } = await import(
            "@/pages/UserSettings/AccountSettings/AdminLegacyRedirect"
          );
          return { element: <AdminRoute Component={AdminLegacyRedirect} /> };
        },
      },
      {
        path: "/settings/workspaces",
        lazy: async () => {
          const { default: AdminLegacyRedirect } = await import(
            "@/pages/UserSettings/AccountSettings/AdminLegacyRedirect"
          );
          return { element: <AdminRoute Component={AdminLegacyRedirect} /> };
        },
      },
      // Onboarding Flow
      {
        path: "/onboarding",
        lazy: async () => {
          const { default: OnboardingFlow } = await import(
            "@/pages/OnboardingFlow"
          );
          return { element: <OnboardingFlow /> };
        },
      },
      {
        path: "/onboarding/:step",
        lazy: async () => {
          const { default: OnboardingFlow } = await import(
            "@/pages/OnboardingFlow"
          );
          return { element: <OnboardingFlow /> };
        },
      },
      // Catch-all route for 404s
      {
        path: "*",
        lazy: async () => {
          const { default: NotFound } = await import("@/pages/404");
          return { element: <NotFound /> };
        },
      },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root")).render(
  <REACTWRAP>
    <RouterProvider router={router} />
  </REACTWRAP>
);
