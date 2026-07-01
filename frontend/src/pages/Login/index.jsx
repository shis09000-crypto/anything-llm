import { lazy, Suspense, useContext } from "react";
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
  const { loading: ssoLoading, ssoConfig } = useSimpleSSO();
  const { loading, requiresAuth, mode, error } = usePasswordModal(
    !!query.get("nt")
  );

  if (loading || ssoLoading) return <FullScreenLoader />;
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
            navigate(paths.home(), { replace: true });
          }}
        />
      </Suspense>
    );
  }

  return <PasswordModal mode={mode} />;
}
