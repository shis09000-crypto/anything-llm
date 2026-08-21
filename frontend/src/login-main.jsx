import React, { Suspense, useEffect } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { ErrorBoundary } from "react-error-boundary";
import { I18nextProvider } from "react-i18next";
import { LogoContext } from "@/LogoContext";
import { FullScreenLoader } from "@/components/Preloader";
import ErrorBoundaryFallback from "@/components/ErrorBoundaryFallback";
import { MotionProvider } from "@/contexts/MotionProvider";
import Login from "@/pages/Login";
import AthenaMark from "@/media/logo/athena-mark.svg";
import AthenaLogo from "@/media/logo/athena-logo.svg";
import i18n, { i18nReady } from "@/i18n";
import { installEnvironmentStorageScope } from "@/utils/appEnvironment";
import { installFontPlatformScope } from "@/utils/fontPlatform";
import "@/index.css";

installEnvironmentStorageScope();
installFontPlatformScope();

function installPublicRouteTheme() {
  const storedTheme = window.localStorage.getItem("theme");
  const theme = storedTheme === "default" ? "dark" : storedTheme || "system";
  const resolvedTheme =
    theme === "system"
      ? window.matchMedia?.("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : theme;
  document.documentElement.setAttribute("data-theme", resolvedTheme);
  document.body.classList.toggle("light", resolvedTheme === "light");
}

installPublicRouteTheme();

const publicLogoValue = {
  logo: AthenaMark,
  setLogo: () => {},
  loginLogo: AthenaLogo,
  isCustomLogo: false,
};

const SimpleSSOPassthrough = React.lazy(
  () => import("@/pages/Login/SSO/simple")
);

function LoadMainApplication() {
  const location = useLocation();

  useEffect(() => {
    window.location.replace(
      `${location.pathname}${location.search}${location.hash}`
    );
  }, [location]);

  return <FullScreenLoader />;
}

function LoginApplication() {
  return (
    <ErrorBoundary FallbackComponent={ErrorBoundaryFallback}>
      <LogoContext.Provider value={publicLogoValue}>
        <I18nextProvider i18n={i18n}>
          <MotionProvider>
            <Suspense fallback={<FullScreenLoader />}>
              <Routes>
                <Route path="/login" element={<Login />} />
                <Route path="/sso/simple" element={<SimpleSSOPassthrough />} />
                <Route path="*" element={<LoadMainApplication />} />
              </Routes>
            </Suspense>
          </MotionProvider>
        </I18nextProvider>
      </LogoContext.Provider>
    </ErrorBoundary>
  );
}

void i18nReady.finally(() => {
  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <BrowserRouter>
        <LoginApplication />
      </BrowserRouter>
    </React.StrictMode>
  );
});
