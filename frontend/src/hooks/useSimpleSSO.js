import { useEffect, useState } from "react";
import System from "@/models/system";

/**
 * Checks if Simple SSO is enabled and if the user should be redirected to the SSO login page.
 * @returns {{loading: boolean, ssoConfig: {enabled: boolean, noLogin: boolean, noLoginRedirect: string | null}}}
 */
export default function useSimpleSSO(bootstrap = null) {
  const [loading, setLoading] = useState(true);
  const [ssoConfig, setSsoConfig] = useState({
    enabled: false,
    noLogin: false,
    noLoginRedirect: null,
  });

  useEffect(() => {
    async function checkSsoConfig() {
      try {
        const settings = bootstrap || (await System.authBootstrap());
        const sso = settings?.methods?.sso || {};
        setSsoConfig({
          enabled: Boolean(sso.enabled),
          noLogin: Boolean(sso.noLogin),
          noLoginRedirect: sso.redirectUrl || null,
        });
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    checkSsoConfig();
  }, [bootstrap]);

  return { loading, ssoConfig };
}
