import React, { useState, createContext, useEffect } from "react";
import { AUTH_TIMESTAMP } from "@/utils/constants";
import System from "./models/system";
import { useNavigate } from "react-router-dom";
import {
  CODEX_DEV_AUTH_BYPASS_KEY,
  CODEX_DEV_AUTH_BYPASS_USER_ID,
  isCodexDevAuthBypassEnabled,
} from "@/utils/codexDevAuthBypass";
import { localIdleExpired, setLoginUserActionNow } from "@/utils/userAction";
import { getAuthToken, setAuthToken } from "@/utils/authTokenStorage";
import { markLoginBoot } from "@/utils/loginBootPerf";
import showToast, { dismissToast } from "@/utils/toast";
import {
  authMaintenanceRetryDelayMs,
  classifyAuthRefreshResult,
  DEV_AUTH_REFRESH_TOAST_ID,
} from "@/utils/authSessionMaintenance";
import { clearSensitiveClientSession } from "@/utils/security/clearSensitiveClientState";
import { getStoredAuthUser, setStoredAuthUser } from "@/utils/authUserStorage";

export const AuthContext = createContext(null);

function codexDevAuthUser() {
  return {
    id:
      Number.isFinite(CODEX_DEV_AUTH_BYPASS_USER_ID) &&
      CODEX_DEV_AUTH_BYPASS_USER_ID > 0
        ? CODEX_DEV_AUTH_BYPASS_USER_ID
        : 1,
    username: "codex-dev",
    role: "admin",
    suspended: false,
    __codexDevAuthBypass: true,
  };
}

export function AuthProvider(props) {
  const localUser = getStoredAuthUser();
  const localAuthToken = getAuthToken();
  const codexDevAuthBypass = isCodexDevAuthBypassEnabled();
  const [store, setStore] = useState({
    user: codexDevAuthBypass
      ? codexDevAuthUser()
      : localUser
        ? localUser
        : null,
    authToken: codexDevAuthBypass
      ? CODEX_DEV_AUTH_BYPASS_KEY
      : localAuthToken
        ? localAuthToken
        : null,
  });

  const navigate = useNavigate();

  /* NOTE:
   * 1. There's no reason for these helper functions to be stateful. They could
   * just be regular funcs or methods on a basic object.
   * 2. These actions are not being invoked anywhere in the
   * codebase, dead code.
   */
  const [actions] = useState({
    updateUser: (user, authToken = "") => {
      setStoredAuthUser(user);
      localStorage.setItem(AUTH_TIMESTAMP, Number(new Date()));
      setAuthToken(authToken);
      setLoginUserActionNow();
      markLoginBoot("token_received", { userId: user?.id || null });
      setStore({ user, authToken });
    },
    unsetUser: () => {
      clearSensitiveClientSession();
      setStore({ user: null, authToken: null });
    },
  });

  /*
   * On initial mount and whenever the token changes, fetch a new user object
   * If the user is suspended, (success === false and data === null) logout the user and redirect to the login page
   * If success is true and data is not null, update the user object in the store (multi-user mode only)
   * If success is true and data is null, do nothing (single-user mode only) with or without password protection
   */
  useEffect(() => {
    let cancelled = false;
    let retryTimer = null;

    async function refreshUser(attempt = 0) {
      if (isCodexDevAuthBypassEnabled()) {
        setStore({
          user: codexDevAuthUser(),
          authToken: CODEX_DEV_AUTH_BYPASS_KEY,
        });
        return;
      }

      const refreshResult = await System.refreshUser();
      if (cancelled) return;

      const { success, user: refreshedUser } = refreshResult;
      markLoginBoot("refresh_user_done", { success });
      if (success && refreshedUser === null) {
        dismissToast(DEV_AUTH_REFRESH_TOAST_ID);
        return;
      }

      const refreshState = classifyAuthRefreshResult(refreshResult);

      if (refreshState === "transient") {
        showToast("本地服务正在恢复，已暂时保留登录状态。", "warning", {
          toastId: DEV_AUTH_REFRESH_TOAST_ID,
          duration: 4_000,
          dismissOnClick: true,
        });
        retryTimer = window.setTimeout(
          () => refreshUser(attempt + 1),
          authMaintenanceRetryDelayMs(attempt)
        );
        return;
      }

      if (!success) {
        clearSensitiveClientSession();
        setStore({ user: null, authToken: null });
        navigate("/login");
        return;
      }

      setStoredAuthUser(refreshedUser);
      dismissToast(DEV_AUTH_REFRESH_TOAST_ID);
      setStore((prev) => ({
        ...prev,
        user: refreshedUser,
      }));
    }
    if (store.authToken) refreshUser();
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [store.authToken]);

  useEffect(() => {
    if (!store.authToken || isCodexDevAuthBypassEnabled()) return;
    let active = true;

    async function handleUserProfileRefresh(event) {
      const userId = event?.detail?.userId;
      if (
        userId &&
        store.user?.id &&
        String(userId) !== String(store.user.id)
      ) {
        return;
      }

      const refreshResult = await System.refreshUser();
      if (!active) return;
      if (!refreshResult?.success || !refreshResult.user) return;

      setStoredAuthUser(refreshResult.user);
      setStore((prev) => ({
        ...prev,
        user: refreshResult.user,
      }));
    }

    window.addEventListener(
      "athena-user-profile-refresh",
      handleUserProfileRefresh
    );
    return () => {
      active = false;
      window.removeEventListener(
        "athena-user-profile-refresh",
        handleUserProfileRefresh
      );
    };
  }, [store.authToken, store.user?.id]);

  useEffect(() => {
    if (!store.authToken || isCodexDevAuthBypassEnabled()) return;

    function clearWhenIdleVisible() {
      if (document.visibilityState === "hidden") return;
      if (!localIdleExpired()) return;
      clearSensitiveClientSession();
      setStore({ user: null, authToken: null });
      navigate("/login?reason=session-expired", { replace: true });
    }

    document.addEventListener("visibilitychange", clearWhenIdleVisible);
    window.addEventListener("focus", clearWhenIdleVisible);
    clearWhenIdleVisible();
    return () => {
      document.removeEventListener("visibilitychange", clearWhenIdleVisible);
      window.removeEventListener("focus", clearWhenIdleVisible);
    };
  }, [store.authToken]);

  return (
    <AuthContext.Provider value={{ store, actions }}>
      {props.children}
    </AuthContext.Provider>
  );
}
