import {
  cryptoHubSseData as getCryptoHubSseData,
  parseCryptoHubSse as parseCryptoHubSseEnvelope,
} from "@/lib/communication/crypto/cryptoHubStreamClient";

export type CryptoHubSseEnvelope<T> = {
  type: "snapshot" | "update" | "status" | "error" | "heartbeat";
  topic: string;
  asOf: number;
  data: T;
  freshness?: unknown;
  safeErrorMessage?: string | null;
};

export function parseCryptoHubSse<T>(
  raw: string
): CryptoHubSseEnvelope<T> | null {
  return parseCryptoHubSseEnvelope(raw) as CryptoHubSseEnvelope<T> | null;
}

export function cryptoHubSseData<T>(raw: string): T | null {
  return getCryptoHubSseData(raw) as T | null;
}
