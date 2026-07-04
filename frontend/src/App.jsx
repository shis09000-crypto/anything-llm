import React, { Suspense, useEffect } from "react";
import { useState } from "react";
import { useLocation, useNavigationType } from "react-router-dom";
import { I18nextProvider, useTranslation } from "react-i18next";
import { AuthContext, AuthProvider } from "@/AuthContext";
import i18n from "./i18n";

import { PfpProvider } from "./PfpContext";
import { LogoProvider } from "./LogoContext";
import { FullScreenLoader } from "./components/Preloader";
import { ThemeProvider, useThemeContext } from "./ThemeContext";
import { PWAModeProvider } from "./PWAContext";
import KeyboardShortcutsHelp from "@/components/KeyboardShortcutsHelp";
import ImageLightbox from "@/components/ImageLightbox";
import { ErrorBoundary } from "react-error-boundary";
import ErrorBoundaryFallback from "./components/ErrorBoundaryFallback";
import { ChatThreadDraftProvider } from "@/contexts/ChatThreadDraftProvider";
import { WorkspaceLayoutProvider } from "@/contexts/WorkspaceLayoutProvider";
import { MotionProvider } from "@/contexts/MotionProvider";
import MotionRouteOutlet from "@/components/MotionRouteOutlet";
import { installAnythingMemoryDiagnostics } from "@/utils/chat/memoryDiagnostics";
import { AppToastHost } from "@/components/lib/AppToast";
import { AppConfirmDialogHost } from "@/components/lib/AppConfirmDialog/confirm";
import { loadAppEnvironment } from "@/utils/appEnvironment";
import CommunicationDebugPanel from "@/components/CommunicationDebugPanel";
import CacheSchedulerDebugPanel from "@/components/CacheSchedulerDebugPanel";
import { SettingsDataProvider } from "@/pages/GeneralSettings/SettingsDataProvider";
import { SyncCenterProvider } from "@/hooks/useSyncCenterEvents";
import { useWorkspaceNavigationSyncInvalidation } from "@/hooks/useWorkspaceSyncEvents";
import { markLoginBoot } from "@/utils/loginBootPerf";
import { hydrateAppearancePreferences } from "@/utils/userStateSync";
import { isPersistentSettingsRoute } from "@/utils/settingsRoutes";
import {
  activateRouteScope,
  routeScopeFromPathname,
} from "@/utils/tasks/routeScopeManager";
import { installNavigationPageLifecycle } from "@/utils/navigationLifecycle";

export default function App() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const [environmentReady, setEnvironmentReady] = useState(false);
  const loaderSurface = isPersistentSettingsRoute(location.pathname)
    ? "settings"
    : null;

  useEffect(() => {
    installAnythingMemoryDiagnostics();
    const cleanupNavigationLifecycle = installNavigationPageLifecycle();
    return () => cleanupNavigationLifecycle?.();
  }, []);

  useEffect(() => {
    let mounted = true;
    markLoginBoot("app_boot_start", { path: window.location.pathname });
    loadAppEnvironment().finally(() => {
      markLoginBoot("environment_loaded");
      if (mounted) setEnvironmentReady(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  if (!environmentReady) return <FullScreenLoader surface={loaderSurface} />;

  return (
    <ErrorBoundary
      FallbackComponent={ErrorBoundaryFallback}
      onError={console.error}
      resetKeys={[location.pathname]}
    >
      <ThemeProvider>
        <PWAModeProvider>
          <Suspense fallback={<FullScreenLoader surface={loaderSurface} />}>
            <AuthProvider>
              <LogoProvider>
                <PfpProvider>
                  <I18nextProvider i18n={i18n}>
                    <MotionProvider>
                      <ChatThreadDraftProvider>
                        <WorkspaceLayoutProvider>
                          <AuthenticatedSyncCenter>
                            <AuthenticatedAppearanceSyncBridge />
                            <SettingsDataProvider>
                              <WorkspaceNavigationSyncBridge />
                              <RouteTaskScopeBridge
                                pathname={location.pathname}
                                navigationType={navigationType}
                              />
                              <DefaultDocumentTitle />
                              <MotionRouteOutlet />
                              <AppConfirmDialogHost />
                              <AppToastHost />
                              <KeyboardShortcutsHelp />
                              <ImageLightbox />
                              <CommunicationDebugPanel />
                              <CacheSchedulerDebugPanel />
                            </SettingsDataProvider>
                          </AuthenticatedSyncCenter>
                        </WorkspaceLayoutProvider>
                      </ChatThreadDraftProvider>
                    </MotionProvider>
                  </I18nextProvider>
                </PfpProvider>
              </LogoProvider>
            </AuthProvider>
          </Suspense>
        </PWAModeProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

function RouteTaskScopeBridge({ pathname, navigationType }) {
  useEffect(() => {
    activateRouteScope(routeScopeFromPathname(pathname), "route-change", {
      navigationType,
      pathname,
    });
  }, [pathname, navigationType]);

  return null;
}

function AuthenticatedSyncCenter({ children }) {
  const auth = React.useContext(AuthContext);
  return (
    <SyncCenterProvider enabled={!!auth?.store?.authToken}>
      {children}
    </SyncCenterProvider>
  );
}

function AuthenticatedAppearanceSyncBridge() {
  const auth = React.useContext(AuthContext);
  const theme = useThemeContext();
  const hydratedKeyRef = React.useRef(null);
  const authToken = auth?.store?.authToken || null;
  const userId =
    auth?.store?.user?.authUserId || auth?.store?.user?.id || "single-user";

  React.useEffect(() => {
    if (!authToken) return;
    const hydrationKey = `${userId}:${authToken}`;
    if (hydratedKeyRef.current === hydrationKey) return;
    hydratedKeyRef.current = hydrationKey;
    void hydrateAppearancePreferences((value) => {
      if (value?.theme) theme?.setTheme?.(value.theme);
    });
  }, [authToken, theme, userId]);

  return null;
}

function WorkspaceNavigationSyncBridge() {
  useWorkspaceNavigationSyncInvalidation();
  return null;
}

function DefaultDocumentTitle() {
  const { t, i18n } = useTranslation();

  useEffect(() => {
    const defaultTitles = new Set([
      "Athena",
      "向量知识库",
      "Athena | Knowledge Operating System",
      "Athena | 知识操作系统",
    ]);
    if (defaultTitles.has(document.title)) {
      document.title = t("common.defaultSiteTitle");
    }
  }, [i18n.language, t]);

  return null;
}
