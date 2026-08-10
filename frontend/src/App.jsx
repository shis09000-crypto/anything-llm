import React, { Suspense, useEffect } from "react";
import { useState } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { I18nextProvider, useTranslation } from "react-i18next";
import { AuthContext, AuthProvider } from "@/AuthContext";
import i18n, { i18nReady } from "./i18n";

import { PfpProvider } from "./PfpContext";
import { LogoProvider } from "./LogoContext";
import { FullScreenLoader } from "./components/Preloader";
import { ThemeProvider, useThemeContext } from "./ThemeContext";
import { PWAModeProvider } from "./PWAContext";
import KeyboardShortcutsHelp from "@/components/KeyboardShortcutsHelp";
import ImageLightbox from "@/components/ImageLightbox";
import { ErrorBoundary } from "react-error-boundary";
import ErrorBoundaryFallback from "./components/ErrorBoundaryFallback";
import { MotionProvider } from "@/contexts/MotionProvider";
import MotionRouteOutlet from "@/components/MotionRouteOutlet";
import { AppToastHost } from "@/components/lib/AppToast";
import { AppConfirmDialogHost } from "@/components/lib/AppConfirmDialog/confirm";
import { loadAppEnvironment } from "@/utils/appEnvironment";
import CommunicationDebugPanel from "@/components/CommunicationDebugPanel";
import CacheSchedulerDebugPanel from "@/components/CacheSchedulerDebugPanel";
import { SyncCenterProvider } from "@/hooks/useSyncCenterEvents";
import { markLoginBoot } from "@/utils/loginBootPerf";
import { hydrateAppearancePreferences } from "@/utils/userStateSync";
import { isPersistentSettingsRoute } from "@/utils/settingsRoutes";
import {
  activateRouteScope,
  routeScopeFromPathname,
} from "@/utils/tasks/routeScopeManager";
import {
  installNavigationPageLifecycle,
  navigationLifecycle,
} from "@/utils/navigationLifecycle";
import { taskScheduler } from "@/utils/tasks/taskScheduler";
import { serverStateCache } from "@/utils/serverState/serverStateCache";
import { optimisticActionCenter } from "@/utils/optimistic/optimisticActionCenter";
import { recoveryCenter } from "@/utils/recovery/recoveryCenter";
import {
  broadcastClient,
  broadcastSubscriptionManager,
  visibleBroadcastScopesForPath,
} from "@/lib/communication/broadcast";
import SyncConflictCenter from "@/components/SyncConflictCenter";

export default function App() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const [environmentReady, setEnvironmentReady] = useState(false);
  const loaderSurface = isPersistentSettingsRoute(location.pathname)
    ? "settings"
    : null;

  useEffect(() => {
    if (import.meta.env.DEV) {
      void import("@/utils/chat/memoryDiagnostics").then(
        ({ installAnythingMemoryDiagnostics }) =>
          installAnythingMemoryDiagnostics()
      );
    }
    const cleanupNavigationLifecycle = installNavigationPageLifecycle();
    return () => cleanupNavigationLifecycle?.();
  }, []);

  useEffect(() => {
    let mounted = true;
    markLoginBoot("app_boot_start", { path: window.location.pathname });
    Promise.all([loadAppEnvironment(), i18nReady]).finally(() => {
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
      resetKeys={[location.key, location.pathname, location.search]}
    >
      <ThemeProvider>
        <PWAModeProvider>
          <Suspense fallback={<FullScreenLoader surface={loaderSurface} />}>
            <AuthProvider>
              <LogoProvider>
                <PfpProvider>
                  <I18nextProvider i18n={i18n}>
                    <MotionProvider>
                      <AuthenticatedSyncCenter>
                        <AuthenticatedAppearanceSyncBridge />
                        <RouteTaskScopeBridge
                          pathname={location.pathname}
                          navigationType={navigationType}
                        />
                        <DeveloperNavigationControlBridge />
                        <DefaultDocumentTitle />
                        <MotionRouteOutlet />
                        <AppConfirmDialogHost />
                        <AppToastHost />
                        <SyncConflictCenter />
                        <KeyboardShortcutsHelp />
                        <ImageLightbox />
                        <CommunicationDebugPanel />
                        <CacheSchedulerDebugPanel />
                      </AuthenticatedSyncCenter>
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

const NAVIGATION_DEV_CONTROL_EVENT = "athena-dev-control-navigation-command";
const NAVIGATION_DEV_CONTROL_RESULT_EVENT =
  "athena-dev-control-navigation-result";
const NAVIGATION_DEV_CONTROL_ALLOWED_COMMANDS = new Set([
  "navigation.snapshot",
  "navigation.ui.snapshot",
  "navigation.ui.goto",
  "navigation.ui.back",
  "navigation.ui.forward",
  "navigation.ui.reload",
  "navigation.ui.openChat",
  "navigation.ui.openSettings",
  "navigation.ui.openCrypto",
  "navigation.ui.enableObserver",
  "navigation.test.roundTrip",
]);

function isSafeNavigationPath(path) {
  return (
    typeof path === "string" &&
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !/^[a-z][a-z0-9+.-]*:/i.test(path)
  );
}

function navigationSleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function redactDebugString(value) {
  return String(value)
    .replace(
      /([?&](?:token|auth|authorization|secret|key)=)[^&#\s]+/gi,
      "$1[REDACTED]"
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/(X-Athena-Sensitive-Session[:=]\s*)[^\s,}]+/gi, "$1[REDACTED]");
}

function redactDebugValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const redacted = redactDebugString(value);
    return redacted.length > 800 ? `${redacted.slice(0, 800)}...` : redacted;
  }
  if (typeof value !== "object") return value;
  if (depth > 6) return "[MaxDepth]";
  if (Array.isArray(value)) {
    return value.slice(0, 80).map((item) => redactDebugValue(item, depth + 1));
  }
  const result = {};
  Object.entries(value)
    .slice(0, 120)
    .forEach(([key, item]) => {
      if (
        /(token|secret|authorization|cookie|apikey|apiKey|signingSecret|sessionSecret|originalUrl|absolutePath|localPath|content|body)/i.test(
          key
        )
      ) {
        result[key] = "[REDACTED]";
        return;
      }
      result[key] = redactDebugValue(item, depth + 1);
    });
  return result;
}

function performanceSummary() {
  if (typeof performance === "undefined") return [];
  return performance
    .getEntriesByType("mark")
    .slice(-80)
    .map((entry) => ({
      name: entry.name,
      startTime: Math.round(entry.startTime),
    }));
}

function DeveloperNavigationControlBridge() {
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = React.useRef(location);

  useEffect(() => {
    locationRef.current = location;
  }, [location]);

  const currentPath = React.useCallback(() => {
    const current = locationRef.current || window.location;
    return `${current.pathname || window.location.pathname}${
      current.search || window.location.search || ""
    }${current.hash || window.location.hash || ""}`;
  }, []);

  const navigationDevSnapshot = React.useCallback(
    () =>
      redactDebugValue({
        location: {
          path: currentPath(),
          pathname: locationRef.current?.pathname || window.location.pathname,
          search: locationRef.current?.search || window.location.search,
          hash: locationRef.current?.hash || window.location.hash,
          title: document.title,
        },
        navigation: navigationLifecycle.snapshot(),
        scheduler: taskScheduler.snapshot(),
        cache: serverStateCache.snapshot(),
        broadcast: broadcastClient.snapshot(),
        optimistic: optimisticActionCenter.snapshot(),
        recovery: recoveryCenter.snapshot(),
        reader:
          typeof window !== "undefined"
            ? window.__athenaReaderDevControlLastResult || null
            : null,
        runtimeObserver:
          typeof window !== "undefined" &&
          window.__athenaRuntimeObserver?.enabled !== false
            ? window.__athenaRuntimeObserver?.snapshot?.() || null
            : null,
        marks: performanceSummary(),
      }),
    [currentPath]
  );

  const publishNavigationDevResult = React.useCallback(
    (result = {}) => {
      if (typeof window === "undefined") return result;
      const payload = redactDebugValue({
        at: Date.now(),
        path: currentPath(),
        ...result,
      });
      window.__athenaNavigationDevControlLastResult = payload;
      window.dispatchEvent(
        new CustomEvent(NAVIGATION_DEV_CONTROL_RESULT_EVENT, {
          detail: payload,
        })
      );
      return payload;
    },
    [currentPath]
  );

  useEffect(() => {
    let cancelled = false;
    const validCommand = (detail = {}) => {
      if (detail?.center !== "developer-control") return false;
      if (!NAVIGATION_DEV_CONTROL_ALLOWED_COMMANDS.has(detail?.command))
        return false;
      const expiresAt = Date.parse(detail.expiresAt || "");
      if (Number.isFinite(expiresAt) && Date.now() > expiresAt) return false;
      return true;
    };
    const safePath = (path, fallback = null) =>
      isSafeNavigationPath(path) ? path : fallback;
    const settle = (params = {}, fallback = 220) =>
      Math.max(50, Math.min(10_000, Number(params.settleMs) || fallback));

    const respond = (detail, patch = {}) =>
      publishNavigationDevResult({
        command: detail.command,
        commandId: detail.commandId || null,
        requestId: detail.requestId || detail.sourceRequestId || null,
        success: patch.success !== false,
        ...patch,
      });

    const enableObserver = (params = {}) => {
      if (!import.meta.env?.DEV) return;
      window.localStorage?.setItem?.("athenaRuntimeObserver", "true");
      window.localStorage?.setItem?.("athenaRuntimeObserverPanel", "true");
      window.localStorage?.setItem?.("athenaNavigationLifecycleDebug", "true");
      window.localStorage?.setItem?.("athenaBroadcastDebug", "true");
      window.localStorage?.setItem?.("athenaRecoveryDebug", "true");
      window.localStorage?.setItem?.("athenaOptimisticActionDebug", "true");
      if (params.cacheDebug !== false) {
        window.localStorage?.setItem?.("athenaServerStateDebug", "true");
      }
    };

    const runCommand = async (event) => {
      const detail = event.detail || {};
      if (!validCommand(detail) || cancelled) return;
      const params = detail.params || {};
      const command = detail.command;
      try {
        if (
          command === "navigation.snapshot" ||
          command === "navigation.ui.snapshot"
        ) {
          return respond(detail, {
            status: "snapshot",
            snapshot: navigationDevSnapshot(),
          });
        }

        if (command === "navigation.ui.enableObserver") {
          enableObserver(params);
          const result = respond(detail, {
            status: "observer_enabled",
            snapshot: navigationDevSnapshot(),
          });
          if (params.reload) {
            window.setTimeout(() => window.location.reload(), 80);
          }
          return result;
        }

        if (command === "navigation.ui.reload") {
          const result = respond(detail, {
            status: "reload_scheduled",
            snapshot: navigationDevSnapshot(),
          });
          window.setTimeout(() => window.location.reload(), 80);
          return result;
        }

        if (
          command === "navigation.ui.goto" ||
          command === "navigation.ui.openChat" ||
          command === "navigation.ui.openSettings" ||
          command === "navigation.ui.openCrypto"
        ) {
          const path = safePath(params.path);
          if (!path) {
            return respond(detail, {
              success: false,
              status: "invalid_navigation_path",
            });
          }
          const startedAt = performance.now();
          navigate(path, { replace: params.replace === true });
          await navigationSleep(settle(params));
          return respond(detail, {
            status: "navigated",
            path,
            durationMs: Math.round(performance.now() - startedAt),
            snapshot: navigationDevSnapshot(),
          });
        }

        if (
          command === "navigation.ui.back" ||
          command === "navigation.ui.forward"
        ) {
          const startedAt = performance.now();
          const beforePath = currentPath();
          command === "navigation.ui.back"
            ? window.history.back()
            : window.history.forward();
          await navigationSleep(settle(params, 450));
          return respond(detail, {
            status:
              command === "navigation.ui.back"
                ? "history_back"
                : "history_forward",
            beforePath,
            afterPath: currentPath(),
            durationMs: Math.round(performance.now() - startedAt),
            snapshot: navigationDevSnapshot(),
          });
        }

        if (command === "navigation.test.roundTrip") {
          const startPath = safePath(params.fromPath, currentPath());
          const toPath = safePath(params.toPath || params.path);
          if (!toPath) {
            return respond(detail, {
              success: false,
              status: "invalid_round_trip_target",
            });
          }
          const t0 = performance.now();
          navigate(toPath, { replace: false });
          await navigationSleep(
            Math.max(50, Math.min(10_000, Number(params.backDelayMs) || 650))
          );
          const enteredAt = performance.now();
          const returnMode = params.returnMode || "history";
          if (returnMode === "navigate") {
            navigate(startPath, { replace: params.replaceReturn === true });
          } else {
            window.history.back();
          }
          await navigationSleep(settle(params, 900));
          const returnedAt = performance.now();
          if (returnMode !== "navigate" && currentPath() !== startPath) {
            navigate(startPath, { replace: true });
            await navigationSleep(220);
          }
          return respond(detail, {
            status: "round_trip_completed",
            startPath,
            toPath,
            returnMode,
            timing: {
              enterMs: Math.round(enteredAt - t0),
              returnMs: Math.round(returnedAt - enteredAt),
              totalMs: Math.round(returnedAt - t0),
            },
            finalPath: currentPath(),
            snapshot: navigationDevSnapshot(),
          });
        }
      } catch (error) {
        return respond(detail, {
          success: false,
          status: "command_failed",
          message: error?.message || "Navigation dev command failed",
          snapshot: navigationDevSnapshot(),
        });
      }
    };

    window.addEventListener(NAVIGATION_DEV_CONTROL_EVENT, runCommand);
    return () => {
      cancelled = true;
      window.removeEventListener(NAVIGATION_DEV_CONTROL_EVENT, runCommand);
    };
  }, [
    currentPath,
    navigate,
    navigationDevSnapshot,
    publishNavigationDevResult,
  ]);

  return null;
}

function RouteTaskScopeBridge({ pathname, navigationType }) {
  useEffect(() => {
    activateRouteScope(routeScopeFromPathname(pathname), "route-change", {
      navigationType,
      pathname,
    });
    broadcastSubscriptionManager.setVisibleScopes(
      visibleBroadcastScopesForPath(pathname)
    );
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
