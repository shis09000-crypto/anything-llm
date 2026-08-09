import { lazy, Suspense, useContext, useEffect } from "react";
import PasswordModal, {
  AuthBootstrapError,
  usePasswordModal,
} from "@/components/Modals/Password";
import { FullScreenLoader } from "@/components/Preloader";
import { Navigate, useNavigate } from "react-router-dom";
import paths from "@/utils/paths";
import useQuery from "@/hooks/useQuery";
import useSimpleSSO from "@/hooks/useSimpleSSO";
import { isCodexDevAuthBypassEnabled } from "@/utils/codexDevAuthBypass";
import { AuthContext } from "@/AuthContext";
import { mobileRuntimeActive } from "@/utils/mobileRuntime";
import {
  consumeAuthReturnRef,
  normalizeLegacyLoginSearch,
} from "@/utils/authLifecycleCoordinator";

const MobileLoginRoute = lazy(() => import("./MobileLoginRoute"));

/**
 * Login page that handles both single and multi-user login.
 *
 * If Simple SSO is enabled and no login is allowed, the user will be redirected to the SSO login page
 * which may not have a token so the login will fail.
 *
 * @returns {JSX.Element}
 */
export default function Login() {
  const query = useQuery();
  const auth = useContext(AuthContext);
  const navigate = useNavigate();
  const normalizedLoginSearch = normalizeLegacyLoginSearch(
    window.location.search
  );
  const hasLegacyNonTerminalReason =
    normalizedLoginSearch !== window.location.search;
  const { loading, requiresAuth, mode, error, bootstrap } = usePasswordModal(
    !!query.get("nt")
  );
  const { loading: ssoLoading, ssoConfig } = useSimpleSSO(bootstrap);

  useEffect(() => {
    if (!hasLegacyNonTerminalReason) return;
    navigate(`${paths.login()}${normalizedLoginSearch}`, { replace: true });
  }, [hasLegacyNonTerminalReason, navigate, normalizedLoginSearch]);

  if (hasLegacyNonTerminalReason || loading || ssoLoading)
    return <FullScreenLoader />;
  if (error) return <AuthBootstrapError message={error} />;

  if (isCodexDevAuthBypassEnabled()) return <Navigate to={paths.home()} />;

  // If simple SSO is enabled and no login is allowed, redirect to the SSO login page.
  if (ssoConfig.enabled && ssoConfig.noLogin) {
    // If a noLoginRedirect is provided and no token is provided, redirect to that webpage.
    if (!!ssoConfig.noLoginRedirect && !query.has("token"))
      return window.location.replace(ssoConfig.noLoginRedirect);
    // Otherwise, redirect to the SSO login page.
    else return <Navigate to={paths.sso.login()} />;
  }

  if (requiresAuth === false) return <Navigate to={paths.home()} />;

  if (mobileRuntimeActive()) {
    return (
      <Suspense fallback={<FullScreenLoader />}>
        <MobileLoginRoute
          user={auth?.store?.user}
          onAuthenticated={(user, token) => {
            auth?.actions?.updateUser?.(user, token);
            navigate(consumeAuthReturnRef() || paths.home(), { replace: true });
          }}
          authBootstrap={bootstrap}
        />
      </Suspense>
    );
  }

  return <PasswordModal mode={mode} bootstrap={bootstrap} />;
}
