import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { FullScreenLoader } from "../Preloader";
import { validateSessionTokenForUserDetailed } from "@/utils/session";
import paths from "@/utils/paths";
import { userFromStorage } from "@/utils/request";
import { getAuthToken } from "@/utils/authTokenStorage";
import System from "@/models/system";
import UserMenu from "../UserMenu";
import { KeyboardShortcutWrapper } from "@/utils/keyboardShortcuts";
import { isCodexDevAuthBypassEnabled } from "@/utils/codexDevAuthBypass";
import UserActionActivityTracker from "@/components/UserActionActivityTracker";
import { localIdleExpired } from "@/utils/userAction";
import {
  canSeeAdmin,
  canSeeExperiment,
  canSeeOwnerSecurity,
} from "@/utils/authz";
import { markLoginBoot } from "@/utils/loginBootPerf";
import { AuthBootstrapError } from "@/components/Modals/Password";
import { clearSensitiveClientSession } from "@/utils/security/clearSensitiveClientState";
import { hasStoredAuthUser } from "@/utils/authUserStorage";
import {
  clearRouteAuthCache,
  readRouteAuthCache,
  resolveRouteAuthCache,
  routeAuthCacheKey,
} from "@/utils/routeAuthCache";

const EMPTY_AUTH_STATE = {
  isAuthd: null,
  shouldRedirectToOnboarding: false,
  multiUserMode: false,
  authUnavailable: false,
};

function currentRouteAuthCacheKey() {
  return routeAuthCacheKey({
    authToken: getAuthToken(),
    hasUser: hasStoredAuthUser(),
    codexDevAuthBypass: isCodexDevAuthBypassEnabled(),
  });
}

function authResult({
  isAuthd,
  shouldRedirectToOnboarding = false,
  multiUserMode = false,
  authUnavailable = false,
  mode = "unknown",
  success = null,
  cacheable = true,
} = {}) {
  return {
    isAuthd,
    shouldRedirectToOnboarding,
    multiUserMode,
    authUnavailable,
    mode,
    success,
    cacheable,
  };
}

async function validateRouteAuthState() {
  if (isCodexDevAuthBypassEnabled()) {
    return authResult({
      isAuthd: true,
      mode: "codex-dev",
    });
  }

  const onboardingComplete = await System.isOnboardingComplete();
  const settings = await System.keys();
  if (!settings) {
    clearRouteAuthCache();
    return authResult({
      isAuthd: false,
      authUnavailable: true,
      mode: "settings-unavailable",
      cacheable: false,
    });
  }

  const { MultiUserMode, RequiresAuth } = settings;

  if (onboardingComplete === false) {
    return authResult({
      isAuthd: true,
      shouldRedirectToOnboarding: true,
      multiUserMode: MultiUserMode,
      mode: "onboarding",
    });
  }

  if (!MultiUserMode && !RequiresAuth) {
    return authResult({
      isAuthd: true,
      multiUserMode: false,
      mode: "single-public",
    });
  }

  if (!MultiUserMode && RequiresAuth) {
    const localAuthToken = getAuthToken();
    if (!localAuthToken) {
      markRouteAuthLoginRedirect("single-password", "missing-token");
      return authResult({
        isAuthd: false,
        multiUserMode: false,
        mode: "single-password",
        success: false,
      });
    }

    const validation = await validateSessionTokenForUserDetailed();
    if (validation.transient) {
      markRouteAuthTransientPreserved("single-password");
      return authResult({
        isAuthd: true,
        multiUserMode: false,
        mode: "single-password-transient",
        success: true,
        cacheable: false,
      });
    }

    const isValid = validation.valid;
    if (!isValid) {
      clearRouteAuthCache();
      markRouteAuthExplicitInvalid("single-password", validation.reason);
    }
    return authResult({
      isAuthd: isValid,
      multiUserMode: false,
      mode: "single-password",
      success: isValid,
      cacheable: isValid,
    });
  }

  const localUser = hasStoredAuthUser();
  const localAuthToken = getAuthToken();
  if (!localUser || !localAuthToken) {
    markRouteAuthLoginRedirect("multi", "missing-local-auth");
    return authResult({
      isAuthd: false,
      multiUserMode: true,
      mode: "multi",
      success: false,
    });
  }

  if (localIdleExpired()) {
    clearRouteAuthCache();
    clearSensitiveClientSession();
    markRouteAuthLoginRedirect("multi-idle-expired", "idle-expired");
    return authResult({
      isAuthd: false,
      multiUserMode: true,
      mode: "multi-idle-expired",
      success: false,
      cacheable: false,
    });
  }

  const validation = await validateSessionTokenForUserDetailed();
  if (validation.transient) {
    markRouteAuthTransientPreserved("multi");
    return authResult({
      isAuthd: true,
      multiUserMode: true,
      mode: "multi-transient",
      success: true,
      cacheable: false,
    });
  }

  const isValid = validation.valid;
  if (!isValid) {
    clearRouteAuthCache();
    clearSensitiveClientSession();
    markRouteAuthExplicitInvalid("multi", validation.reason);
  }

  return authResult({
    isAuthd: isValid,
    multiUserMode: true,
    mode: "multi",
    success: isValid,
    cacheable: isValid,
  });
}

function toHookState(result = EMPTY_AUTH_STATE) {
  return {
    isAuthd: result.isAuthd,
    shouldRedirectToOnboarding: Boolean(result.shouldRedirectToOnboarding),
    multiUserMode: Boolean(result.multiUserMode),
    authUnavailable: Boolean(result.authUnavailable),
  };
}

function markRouteAuthValidated(result = {}) {
  if (!result?.mode) return;
  const payload = { mode: result.mode };
  if (typeof result.success === "boolean") payload.success = result.success;
  if (result.cached) payload.cached = true;
  markLoginBoot("private_route_validated", payload);
}

function markRouteAuthTransientPreserved(mode) {
  markLoginBoot("route_auth_transient_preserved", { mode });
}

function markRouteAuthExplicitInvalid(mode, reason = "invalid-session") {
  markLoginBoot("route_auth_explicit_invalid", { mode, reason });
}

function markRouteAuthLoginRedirect(mode, reason = "not-authenticated") {
  markLoginBoot("route_auth_login_redirect", { mode, reason });
}

// Used only for Multi-user mode only as we permission specific pages based on auth role.
// When in single user mode we just bypass any authchecks.
function useIsAuthenticated() {
  const cacheKey = currentRouteAuthCacheKey();
  const [authState, setAuthState] = useState(() => {
    const cached = readRouteAuthCache(cacheKey);
    return cached ? toHookState(cached) : EMPTY_AUTH_STATE;
  });

  useEffect(() => {
    let cancelled = false;

    const cached = readRouteAuthCache(cacheKey);
    if (cached) {
      setAuthState(toHookState(cached));
      markRouteAuthValidated({ ...cached, cached: true });
      return;
    }

    setAuthState(EMPTY_AUTH_STATE);
    resolveRouteAuthCache(cacheKey, validateRouteAuthState)
      .then((result) => {
        if (cancelled) return;
        setAuthState(toHookState(result));
        markRouteAuthValidated(result);
      })
      .catch(() => {
        if (cancelled) return;
        clearRouteAuthCache();
        setAuthState(
          toHookState(
            authResult({
              isAuthd: false,
              authUnavailable: true,
              mode: "auth-bootstrap-error",
              success: false,
              cacheable: false,
            })
          )
        );
        markRouteAuthValidated({
          mode: "auth-bootstrap-error",
          success: false,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [cacheKey]);

  return authState;
}

// Allows only admin to access the route and if in single user mode,
// allows all users to access the route
export function AdminRoute({ Component, hideUserMenu = false }) {
  const {
    isAuthd,
    shouldRedirectToOnboarding,
    multiUserMode,
    authUnavailable,
  } = useIsAuthenticated();
  if (isAuthd === null) return <FullScreenLoader />;
  if (authUnavailable) return <AuthBootstrapError />;

  if (shouldRedirectToOnboarding) {
    return <Navigate to={paths.onboarding.home()} />;
  }

  const user = userFromStorage();
  return isAuthd && (canSeeAdmin(user) || !multiUserMode) ? (
    <RouteShell Component={Component} hideUserMenu={hideUserMenu} />
  ) : (
    <Navigate to={paths.home()} />
  );
}

// Legacy wrapper kept for older route declarations. Manager is no longer a real
// account role, so this now maps to the admin/owner backend policy.
export function ManagerRoute({ Component }) {
  const {
    isAuthd,
    shouldRedirectToOnboarding,
    multiUserMode,
    authUnavailable,
  } = useIsAuthenticated();
  if (isAuthd === null) return <FullScreenLoader />;
  if (authUnavailable) return <AuthBootstrapError />;

  if (shouldRedirectToOnboarding) {
    return <Navigate to={paths.onboarding.home()} />;
  }

  const user = userFromStorage();
  return isAuthd && (canSeeAdmin(user) || !multiUserMode) ? (
    <RouteShell Component={Component} />
  ) : (
    <Navigate to={paths.home()} />
  );
}

export function DeveloperRoute({ Component }) {
  const {
    isAuthd,
    shouldRedirectToOnboarding,
    multiUserMode,
    authUnavailable,
  } = useIsAuthenticated();
  if (isAuthd === null) return <FullScreenLoader />;
  if (authUnavailable) return <AuthBootstrapError />;

  if (shouldRedirectToOnboarding) {
    return <Navigate to={paths.onboarding.home()} />;
  }

  const user = userFromStorage();
  return isAuthd && (canSeeExperiment(user) || !multiUserMode) ? (
    <RouteShell Component={Component} />
  ) : (
    <Navigate to={paths.home()} />
  );
}

export function OwnerRoute({ Component }) {
  const {
    isAuthd,
    shouldRedirectToOnboarding,
    multiUserMode,
    authUnavailable,
  } = useIsAuthenticated();
  if (isAuthd === null) return <FullScreenLoader />;
  if (authUnavailable) return <AuthBootstrapError />;

  if (shouldRedirectToOnboarding) {
    return <Navigate to={paths.onboarding.home()} />;
  }

  const user = userFromStorage();
  return isAuthd && (canSeeOwnerSecurity(user) || !multiUserMode) ? (
    <RouteShell Component={Component} />
  ) : (
    <Navigate to={paths.home()} />
  );
}

// Allows access only in single user mode — redirects to home in multi-user mode
export function SingleUserRoute({ Component }) {
  const {
    isAuthd,
    shouldRedirectToOnboarding,
    multiUserMode,
    authUnavailable,
  } = useIsAuthenticated();
  if (isAuthd === null) return <FullScreenLoader />;
  if (authUnavailable) return <AuthBootstrapError />;

  if (shouldRedirectToOnboarding) {
    return <Navigate to={paths.onboarding.home()} />;
  }

  return isAuthd && !multiUserMode ? (
    <KeyboardShortcutWrapper>
      <Component />
    </KeyboardShortcutWrapper>
  ) : (
    <Navigate to={paths.home()} />
  );
}

export default function PrivateRoute({ Component }) {
  const { isAuthd, shouldRedirectToOnboarding, authUnavailable } =
    useIsAuthenticated();
  if (isAuthd === null) return <FullScreenLoader />;
  if (authUnavailable) return <AuthBootstrapError />;

  if (shouldRedirectToOnboarding) {
    return <Navigate to="/onboarding" />;
  }

  return isAuthd ? (
    <RouteShell Component={Component} />
  ) : (
    <Navigate to={paths.login(true)} />
  );
}

function RouteShell({ Component, hideUserMenu = false }) {
  if (hideUserMenu) {
    return (
      <KeyboardShortcutWrapper>
        <UserActionActivityTracker />
        <Component />
      </KeyboardShortcutWrapper>
    );
  }

  return (
    <KeyboardShortcutWrapper>
      <UserMenu>
        <UserActionActivityTracker />
        <Component />
      </UserMenu>
    </KeyboardShortcutWrapper>
  );
}
