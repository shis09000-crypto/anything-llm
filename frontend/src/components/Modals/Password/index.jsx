import React, { useState, useEffect } from "react";
import System from "../../../models/system";
import SingleUserAuth from "./SingleUserAuth";
import MultiUserAuth, { SoftLoginShell } from "./MultiUserAuth";
import useLogo from "../../../hooks/useLogo";
import { isCodexDevAuthBypassEnabled } from "@/utils/codexDevAuthBypass";
import { getAuthToken } from "@/utils/authTokenStorage";
import { clearSensitiveClientSession } from "@/utils/security/clearSensitiveClientState";
import {
  SESSION_VALIDATION_STATE,
  validateSessionTokenForUserDetailed,
} from "@/utils/session";
import {
  hardReloadForRelease,
  redirectToLogin,
} from "@/utils/authLifecycleCoordinator";
export { default as AuthBootstrapError } from "./AuthBootstrapError";

export default function PasswordModal({ mode = "single", bootstrap = null }) {
  const { loginLogo, isCustomLogo } = useLogo();
  if (mode === "multi") {
    return (
      <MultiUserAuth
        loginLogo={loginLogo}
        isCustomLogo={isCustomLogo}
        authBootstrap={bootstrap}
      />
    );
  }

  return (
    <SoftLoginShell loginLogo={loginLogo} isCustomLogo={isCustomLogo}>
      <SingleUserAuth />
    </SoftLoginShell>
  );
}

export function usePasswordModal(notry = false) {
  const [auth, setAuth] = useState({
    loading: true,
    requiresAuth: false,
    mode: "single",
    error: null,
    bootstrap: null,
    reconnecting: false,
  });

  useEffect(() => {
    let cancelled = false;
    let retryTimer = null;
    async function checkAuthReq() {
      try {
        if (!window) return;

        if (isCodexDevAuthBypassEnabled()) {
          setAuth({
            loading: false,
            requiresAuth: false,
            mode: "multi",
            error: null,
            bootstrap: null,
            reconnecting: false,
          });
          return;
        }

        const bootstrap = await System.authBootstrap();
        if (cancelled) return;
        if (bootstrap.nextAction === "hard_reload") {
          hardReloadForRelease(bootstrap.deployment?.releaseId);
          return;
        }
        const mode = bootstrap.authMode === "multi" ? "multi" : "single";
        const currentToken = getAuthToken();
        if (bootstrap.nextAction === "login" && currentToken) {
          clearSensitiveClientSession({
            includeDurableCaches: false,
            preserveRecovery: true,
          });
        }
        const explicitlyRequiresLogin =
          notry ||
          bootstrap.nextAction === "login" ||
          (bootstrap.authMode !== "public" && !currentToken);
        if (bootstrap.authMode === "public") {
          setAuth({
            loading: false,
            requiresAuth: false,
            mode,
            error: null,
            bootstrap,
            reconnecting: bootstrap.serviceStatus !== "ready",
          });
          return;
        }
        if (explicitlyRequiresLogin) {
          setAuth({
            loading: false,
            requiresAuth: true,
            mode,
            error: null,
            bootstrap,
            reconnecting: bootstrap.serviceStatus !== "ready",
          });
          return;
        }

        const validation = await validateSessionTokenForUserDetailed();
        if (cancelled) return;
        if (validation.state === SESSION_VALIDATION_STATE.INVALID) {
          clearSensitiveClientSession({
            includeDurableCaches: false,
            preserveRecovery: true,
          });
        }
        setAuth({
          loading: false,
          requiresAuth: validation.state === SESSION_VALIDATION_STATE.INVALID,
          mode,
          error: null,
          bootstrap,
          reconnecting:
            validation.state === SESSION_VALIDATION_STATE.TRANSIENT ||
            bootstrap.serviceStatus !== "ready",
        });
        if (validation.state === SESSION_VALIDATION_STATE.TRANSIENT) {
          retryTimer = window.setTimeout(() => {
            System.clearAuthBootstrapCache();
            void checkAuthReq();
          }, bootstrap.retryAfterMs || 3_000);
        }
      } catch (error) {
        if (cancelled) return;
        console.error("[Auth] bootstrap failed", error);
        redirectToLogin({ reason: "force_reauth" });
        setAuth({
          loading: false,
          requiresAuth: true,
          mode: "multi",
          error: null,
          bootstrap: null,
          reconnecting: false,
        });
        if (validation.state === SESSION_VALIDATION_STATE.TRANSIENT) {
          retryTimer = window.setTimeout(() => {
            System.clearAuthBootstrapCache();
            void checkAuthReq();
          }, bootstrap.retryAfterMs || 3_000);
        }
      } catch (error) {
        if (cancelled) return;
        console.error("[Auth] bootstrap failed", error);
        const hasLocalSession = Boolean(getAuthToken());
        setAuth({
          loading: false,
          requiresAuth: hasLocalSession ? false : null,
          mode: "multi",
          error: hasLocalSession ? null : "登录服务正在恢复，系统会自动重试。",
          bootstrap: null,
          reconnecting: true,
        });
        retryTimer = window.setTimeout(() => {
          System.clearAuthBootstrapCache();
          void checkAuthReq();
        }, 3_000);
      }
    }
    void checkAuthReq();
    const retryNow = () => {
      if (retryTimer) window.clearTimeout(retryTimer);
      retryTimer = null;
      void checkAuthReq();
    };
    window.addEventListener("athena-auth-bootstrap-retry", retryNow);
    window.addEventListener("online", retryNow);
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      window.removeEventListener("athena-auth-bootstrap-retry", retryNow);
      window.removeEventListener("online", retryNow);
    };
  }, []);

  return auth;
}
