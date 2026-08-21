import {
  CRYPTO_HUB_BASE,
  cryptoHubFetch as requestCryptoHub,
} from "@/lib/communication/crypto/cryptoHubClient";

export { CRYPTO_HUB_BASE };

export type CryptoHubRequestOptions = RequestInit & {
  communicationScene?: string | null;
  task?: false | Record<string, unknown>;
};

export async function cryptoHubFetch<T>(
  path: string,
  options: CryptoHubRequestOptions = {}
): Promise<T> {
  return requestCryptoHub(path, options) as Promise<T>;
}
