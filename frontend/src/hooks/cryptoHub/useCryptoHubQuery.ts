import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

export const CRYPTO_HUB_BASE = `${API_BASE}/crypto-hub`;

export async function cryptoHubFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${CRYPTO_HUB_BASE}${path}`, {
    ...options,
    headers: {
      ...baseHeaders(),
      ...(options.headers || {}),
    },
  });
  const payload = (await response.json()) as T & {
    success?: boolean;
    safeErrorMessage?: string;
    error?: string;
  };
  if (!response.ok || payload?.success === false) {
    throw new Error(
      payload?.safeErrorMessage || payload?.error || "Crypto Hub request failed"
    );
  }
  return payload;
}
