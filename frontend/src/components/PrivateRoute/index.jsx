import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { FullScreenLoader } from "../Preloader";
import validateSessionTokenForUser from "@/utils/session";
import paths from "@/utils/paths";
import {
  AUTH_TIMESTAMP,
  AUTH_TOKEN,
  AUTH_USER,
  LAST_USER_ACTION_AT,
} from "@/utils/constants";
import { userFromStorage } from "@/utils/request";
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

// Used only for Multi-user mode only as we permission specific pages based on auth role.
// When in single user mode we just bypass any authchecks.
function useIsAuthenticated() {
  const [isAuthd, setIsAuthed] = useState(null);
  const [shouldRedirectToOnboarding, setShouldRedirectToOnboarding] =
    useState(false);
  const [multiUserMode, setMultiUserMode] = useState(false);

  useEffect(() => {
    const validateSession = async () => {
      if (isCodexDevAuthBypassEnabled()) {
        setMultiUserMode(false);
        setIsAuthed(true);
        return;
      }

      const onboardingComplete = await System.isOnboardingComplete();
      const { MultiUserMode, RequiresAuth } = await System.keys();
      setMultiUserMode(MultiUserMode);

      // Check for the onboarding redirect condition
      if (onboardingComplete === false) {
        setShouldRedirectToOnboarding(true);
        setIsAuthed(true);
        return;
      }

      // Single User mode without password - no auth required
      if (!MultiUserMode && !RequiresAuth) {
        setIsAuthed(true);
        return;
      }

      // Single User password mode check
      if (!MultiUserMode && RequiresAuth) {
        const localAuthToken = localStorage.getItem(AUTH_TOKEN);
        if (!localAuthToken) {
          setIsAuthed(false);
          return;
        }

        const isValid = await validateSessionTokenForUser();
        setIsAuthed(isValid);
        return;
      }

      // Multi-user mode checks
      const localUser = localStorage.getItem(AUTH_USER);
      const localAuthToken = localStorage.getItem(AUTH_TOKEN);
      if (!localUser || !localAuthToken) {
        setIsAuthed(false);
        return;
      }

      if (localIdleExpired()) {
        localStorage.removeItem(AUTH_USER);
        localStorage.removeItem(AUTH_TOKEN);
        localStorage.removeItem(AUTH_TIMESTAMP);
        localStorage.removeItem(LAST_USER_ACTION_AT);
        setIsAuthed(false);
        return;
      }

      const isValid = await validateSessionTokenForUser();
      if (!isValid) {
        localStorage.removeItem(AUTH_USER);
        localStorage.removeItem(AUTH_TOKEN);
        localStorage.removeItem(AUTH_TIMESTAMP);
        localStorage.removeItem(LAST_USER_ACTION_AT);
        setIsAuthed(false);
        return;
      }

      setIsAuthed(true);
    };
    validateSession();
  }, []);

  return { isAuthd, shouldRedirectToOnboarding, multiUserMode };
}

// Allows only admin to access the route and if in single user mode,
// allows all users to access the route
export function AdminRoute({ Component, hideUserMenu = false }) {
  const { isAuthd, shouldRedirectToOnboarding, multiUserMode } =
    useIsAuthenticated();
  if (isAuthd === null) return <FullScreenLoader />;

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
  const { isAuthd, shouldRedirectToOnboarding, multiUserMode } =
    useIsAuthenticated();
  if (isAuthd === null) return <FullScreenLoader />;

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
  const { isAuthd, shouldRedirectToOnboarding, multiUserMode } =
    useIsAuthenticated();
  if (isAuthd === null) return <FullScreenLoader />;

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
  const { isAuthd, shouldRedirectToOnboarding, multiUserMode } =
    useIsAuthenticated();
  if (isAuthd === null) return <FullScreenLoader />;

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
  const { isAuthd, shouldRedirectToOnboarding, multiUserMode } =
    useIsAuthenticated();
  if (isAuthd === null) return <FullScreenLoader />;

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
  const { isAuthd, shouldRedirectToOnboarding } = useIsAuthenticated();
  if (isAuthd === null) return <FullScreenLoader />;

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
