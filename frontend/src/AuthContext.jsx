import React, { useState, createContext, useEffect } from "react";
import {
  AUTH_TIMESTAMP,
  AUTH_USER,
  LAST_USER_ACTION_AT,
  USER_PROMPT_INPUT_MAP,
} from "@/utils/constants";
import System from "./models/system";
import { useNavigate } from "react-router-dom";
import { safeJsonParse } from "@/utils/request";
import {
  CODEX_DEV_AUTH_BYPASS_KEY,
  CODEX_DEV_AUTH_BYPASS_USER_ID,
  isCodexDevAuthBypassEnabled,
} from "@/utils/codexDevAuthBypass";
import { setLoginUserActionNow } from "@/utils/userAction";
import {
  getAuthToken,
  removeAuthToken,
  setAuthToken,
} from "@/utils/authTokenStorage";

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
  const localUser = localStorage.getItem(AUTH_USER);
  const localAuthToken = getAuthToken();
  const codexDevAuthBypass = isCodexDevAuthBypassEnabled();
  const [store, setStore] = useState({
    user: codexDevAuthBypass
      ? codexDevAuthUser()
      : localUser
        ? safeJsonParse(localUser, null)
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
      localStorage.setItem(AUTH_USER, JSON.stringify(user));
      setAuthToken(authToken);
      setLoginUserActionNow();
      setStore({ user, authToken });
    },
    unsetUser: () => {
      localStorage.removeItem(AUTH_USER);
      removeAuthToken();
      localStorage.removeItem(AUTH_TIMESTAMP);
      localStorage.removeItem(LAST_USER_ACTION_AT);
      localStorage.removeItem(USER_PROMPT_INPUT_MAP);
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
    async function refreshUser() {
      if (isCodexDevAuthBypassEnabled()) {
        setStore({
          user: codexDevAuthUser(),
          authToken: CODEX_DEV_AUTH_BYPASS_KEY,
        });
        return;
      }

      const { success, user: refreshedUser } = await System.refreshUser();
      if (success && refreshedUser === null) return;

      if (!success) {
        localStorage.removeItem(AUTH_USER);
        removeAuthToken();
        localStorage.removeItem(AUTH_TIMESTAMP);
        localStorage.removeItem(LAST_USER_ACTION_AT);
        localStorage.removeItem(USER_PROMPT_INPUT_MAP);
        setStore({ user: null, authToken: null });
        navigate("/login");
        return;
      }

      localStorage.setItem(AUTH_USER, JSON.stringify(refreshedUser));
      setStore((prev) => ({
        ...prev,
        user: refreshedUser,
      }));
    }
    if (store.authToken) refreshUser();
  }, [store.authToken]);

  return (
    <AuthContext.Provider value={{ store, actions }}>
      {props.children}
    </AuthContext.Provider>
  );
}
