export const CRYPTO_HUB_INIT_RETRY_DELAYS_MS = [0, 1_000, 2_500, 5_000];

export function cryptoHubInitErrorStatus(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  return Number.isFinite(status) ? status : 0;
}

export function shouldRetryCryptoHubInit(error) {
  if (error?.name === "AbortError") return false;
  return [0, 502, 503, 504].includes(cryptoHubInitErrorStatus(error));
}
