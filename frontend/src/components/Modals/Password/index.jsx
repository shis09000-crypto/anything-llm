import React, { useState, useEffect } from "react";
import System from "../../../models/system";
import SingleUserAuth from "./SingleUserAuth";
import MultiUserAuth from "./MultiUserAuth";
import useLogo from "../../../hooks/useLogo";
import { isCodexDevAuthBypassEnabled } from "@/utils/codexDevAuthBypass";
import { getAuthToken } from "@/utils/authTokenStorage";
import { clearSensitiveClientSession } from "@/utils/security/clearSensitiveClientState";

export default function PasswordModal({ mode = "single" }) {
  const { loginLogo, isCustomLogo } = useLogo();
  if (mode === "multi") {
    return <MultiUserAuth loginLogo={loginLogo} isCustomLogo={isCustomLogo} />;
  }

  return (
    <div className="fixed inset-0 bg-zinc-950 light:bg-slate-50 flex flex-col items-center justify-center overflow-hidden">
      <img
        src={loginLogo}
        alt="Logo"
        className={`max-h-[80px] ${isCustomLogo ? "rounded-lg" : ""}`}
        style={{ objectFit: "contain" }}
      />
      <SingleUserAuth />
    </div>
  );
}

export function AuthBootstrapError({
  message = "认证配置暂时不可用，请检查网络连接后重试。",
} = {}) {
  const { loginLogo, isCustomLogo } = useLogo();
  return (
    <div className="fixed inset-0 bg-zinc-950 light:bg-slate-50 flex flex-col items-center justify-center overflow-hidden px-6 text-center">
      <img
        src={loginLogo}
        alt="Logo"
        className={`mb-6 max-h-[72px] ${isCustomLogo ? "rounded-lg" : ""}`}
        style={{ objectFit: "contain" }}
      />
      <div className="max-w-md rounded-xl border border-white/10 bg-white/5 p-6 shadow-2xl light:border-slate-200 light:bg-white">
        <h1 className="text-lg font-semibold text-white light:text-slate-900">
          登录服务暂时不可用
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-300 light:text-slate-600">
          {message}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-5 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-slate-200 light:bg-slate-900 light:text-white light:hover:bg-slate-700"
        >
          重新加载
        </button>
      </div>
    </div>
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
