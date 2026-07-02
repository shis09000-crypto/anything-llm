type CryptoCenterPerfWindow = Window & {
  __cryptoCenterPerf?: Array<{
    name: string;
    at: number;
    detail?: Record<string, unknown>;
  }>;
};

export function markCryptoCenterPerf(
  name: string,
  detail?: Record<string, unknown>
) {
  if (typeof window === "undefined") return;

  const at = performance.now();
  const perfWindow = window as CryptoCenterPerfWindow;
  perfWindow.__cryptoCenterPerf = [
    ...(perfWindow.__cryptoCenterPerf || []),
    { name, at, detail },
  ].slice(-80);

  try {
    performance.mark(`crypto-center:${name}`);
  } catch {
    // Perf marks are diagnostic only.
  }
}
