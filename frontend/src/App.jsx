import React, { Suspense, useEffect } from "react";
import { useState } from "react";
import { useLocation } from "react-router-dom";
import { I18nextProvider, useTranslation } from "react-i18next";
import { AuthProvider } from "@/AuthContext";
import i18n from "./i18n";

import { PfpProvider } from "./PfpContext";
import { LogoProvider } from "./LogoContext";
import { FullScreenLoader } from "./components/Preloader";
import { ThemeProvider } from "./ThemeContext";
import { PWAModeProvider } from "./PWAContext";
import KeyboardShortcutsHelp from "@/components/KeyboardShortcutsHelp";
import ImageLightbox from "@/components/ImageLightbox";
import { ErrorBoundary } from "react-error-boundary";
import ErrorBoundaryFallback from "./components/ErrorBoundaryFallback";
import { ChatThreadDraftProvider } from "@/contexts/ChatThreadDraftProvider";
import { MotionProvider } from "@/contexts/MotionProvider";
import MotionRouteOutlet from "@/components/MotionRouteOutlet";
import { installAnythingMemoryDiagnostics } from "@/utils/chat/memoryDiagnostics";
import { AppToastHost } from "@/components/lib/AppToast";
import { AppConfirmDialogHost } from "@/components/lib/AppConfirmDialog/confirm";
import { loadAppEnvironment } from "@/utils/appEnvironment";

export default function App() {
  const location = useLocation();
  const [environmentReady, setEnvironmentReady] = useState(false);

  useEffect(() => {
    installAnythingMemoryDiagnostics();
  }, []);

  useEffect(() => {
    let mounted = true;
    loadAppEnvironment().finally(() => {
      if (mounted) setEnvironmentReady(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  if (!environmentReady) return <FullScreenLoader />;

  return (
    <ErrorBoundary
      FallbackComponent={ErrorBoundaryFallback}
      onError={console.error}
      resetKeys={[location.pathname]}
    >
      <ThemeProvider>
        <PWAModeProvider>
          <Suspense fallback={<FullScreenLoader />}>
            <AuthProvider>
              <LogoProvider>
                <PfpProvider>
                  <I18nextProvider i18n={i18n}>
                    <MotionProvider>
                      <ChatThreadDraftProvider>
                        <DefaultDocumentTitle />
                        <MotionRouteOutlet />
                        <AppConfirmDialogHost />
                        <AppToastHost />
                        <KeyboardShortcutsHelp />
                        <ImageLightbox />
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

function DefaultDocumentTitle() {
  const { t, i18n } = useTranslation();

  useEffect(() => {
    const defaultTitles = new Set([
      "AnythingLLM",
      "AnythingLLM | Your personal LLM trained on anything",
      "向量知识库",
    ]);
    if (defaultTitles.has(document.title)) {
      document.title = t("common.defaultSiteTitle");
    }
  }, [i18n.language, t]);

  return null;
}
