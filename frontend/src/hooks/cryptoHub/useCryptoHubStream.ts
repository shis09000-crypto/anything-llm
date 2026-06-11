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
  try {
    const payload = JSON.parse(raw) as CryptoHubSseEnvelope<T> | T;
    if (
      payload &&
      typeof payload === "object" &&
      "type" in payload &&
      "topic" in payload &&
      "data" in payload
    ) {
      return payload as CryptoHubSseEnvelope<T>;
    }
    return {
      type: "update",
      topic: "legacy",
      asOf: Date.now(),
      data: payload as T,
      freshness: null,
      safeErrorMessage: null,
    };
  } catch {
    return null;
  }
}

export function cryptoHubSseData<T>(raw: string): T | null {
  const envelope = parseCryptoHubSse<T>(raw);
  if (
    !envelope ||
    envelope.type === "heartbeat" ||
    envelope.type === "status"
  ) {
    return null;
  }
  return envelope.data;
}
