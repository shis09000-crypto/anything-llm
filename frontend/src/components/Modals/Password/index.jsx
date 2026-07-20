import React, { useState, useEffect } from "react";
import System from "../../../models/system";
import SingleUserAuth from "./SingleUserAuth";
import MultiUserAuth, { SoftLoginShell } from "./MultiUserAuth";
import useLogo from "../../../hooks/useLogo";
import { isCodexDevAuthBypassEnabled } from "@/utils/codexDevAuthBypass";
import { getAuthToken } from "@/utils/authTokenStorage";
import { clearSensitiveClientSession } from "@/utils/security/clearSensitiveClientState";
export { default as AuthBootstrapError } from "./AuthBootstrapError";

export default function PasswordModal({ mode = "single" }) {
  const { loginLogo, isCustomLogo } = useLogo();
  if (mode === "multi") {
    return <MultiUserAuth loginLogo={loginLogo} isCustomLogo={isCustomLogo} />;
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
  });

  useEffect(() => {
    async function checkAuthReq() {
      try {
        if (!window) return;

        if (isCodexDevAuthBypassEnabled()) {
          setAuth({
            loading: false,
            requiresAuth: false,
            mode: "multi",
            error: null,
          });
          return;
        }

        // If the last validity check is still valid
        // we can skip the loading.
        if (!System.needsAuthCheck() && notry === false) {
          setAuth({
            loading: false,
            requiresAuth: false,
            mode: "multi",
            error: null,
          });
          return;
        }

        const settings = await System.keys();
        if (!settings) {
          setAuth({
            loading: false,
            requiresAuth: null,
            mode: "multi",
            error:
              "无法读取系统登录配置。请确认服务器在线、反向代理与 HTTPS 配置正常后重试。",
          });
          return;
        }

        if (settings?.MultiUserMode) {
          const currentToken = getAuthToken();
          if (!!currentToken) {
            const valid = notry ? false : await System.checkAuth(currentToken);
            if (!valid) {
              setAuth({
                loading: false,
                requiresAuth: true,
                mode: "multi",
                error: null,
              });
              clearSensitiveClientSession();
              return;
            } else {
              setAuth({
                loading: false,
                requiresAuth: false,
                mode: "multi",
                error: null,
              });
              return;
            }
          } else {
            setAuth({
              loading: false,
              requiresAuth: true,
              mode: "multi",
              error: null,
            });
            return;
          }
        } else {
          // Running token check in single user Auth mode.
          // If Single user Auth is disabled - skip check
          const requiresAuth = settings?.RequiresAuth || false;
          if (!requiresAuth) {
            setAuth({
              loading: false,
              requiresAuth: false,
              mode: "single",
              error: null,
            });
            return;
          }

          const currentToken = getAuthToken();
          if (!!currentToken) {
            const valid = notry ? false : await System.checkAuth(currentToken);
            if (!valid) {
              setAuth({
                loading: false,
                requiresAuth: true,
                mode: "single",
                error: null,
              });
              clearSensitiveClientSession();
              return;
            } else {
              setAuth({
                loading: false,
                requiresAuth: false,
                mode: "single",
                error: null,
              });
              return;
            }
          } else {
            setAuth({
              loading: false,
              requiresAuth: true,
              mode: "single",
              error: null,
            });
            return;
          }
        }
      } catch (error) {
        console.error("[Auth] bootstrap failed", error);
        setAuth({
          loading: false,
          requiresAuth: null,
          mode: "multi",
          error: "登录初始化失败。请确认服务器在线、网络未被拦截后重新加载。",
        });
      }
    }
    checkAuthReq();
  }, []);

  return auth;
}
