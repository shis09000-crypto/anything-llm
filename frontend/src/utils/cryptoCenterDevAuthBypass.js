export const CRYPTO_CENTER_DEV_AUTH_BYPASS_HEADER =
  "X-Crypto-Center-Dev-Auth-Bypass";
export const CRYPTO_CENTER_DEV_AUTH_BYPASS_QUERY = "cryptoCenterAuthBypass";
export const CRYPTO_CENTER_DEV_AUTH_BYPASS_STORAGE_KEY =
  "anythingllm_crypto_center_dev_auth_bypass";

export function isCryptoCenterDevAuthBypassEnabled() {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;

  const params = new URLSearchParams(window.location.search);
  const queryValue = params.get(CRYPTO_CENTER_DEV_AUTH_BYPASS_QUERY);
  if (queryValue === "1" || queryValue === "true") {
    window.localStorage.setItem(CRYPTO_CENTER_DEV_AUTH_BYPASS_STORAGE_KEY, "1");
    return true;
  }
  if (queryValue === "0" || queryValue === "false") {
    window.localStorage.removeItem(CRYPTO_CENTER_DEV_AUTH_BYPASS_STORAGE_KEY);
    return false;
  }

  return (
    import.meta.env.VITE_CRYPTO_CENTER_AUTH_BYPASS === "true" ||
    window.localStorage.getItem(CRYPTO_CENTER_DEV_AUTH_BYPASS_STORAGE_KEY) ===
      "1"
  );
}
