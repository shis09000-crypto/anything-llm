import {
  CRYPTO_HUB_BASE,
  cryptoHubFetch as requestCryptoHub,
} from "@/lib/communication/crypto/cryptoHubClient";

export { CRYPTO_HUB_BASE };

export async function cryptoHubFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  return requestCryptoHub(path, options) as Promise<T>;
}
