import { useTranslation } from "react-i18next";

export type CryptoRealtimeStatus = "connected" | "degraded" | "disconnected";

export type CryptoRealtimeStatusLabel =
  | CryptoRealtimeStatus
  | "reconnecting"
  | "syncing";

type CryptoLanguage = "en" | "zh" | "ja";

const statusLabels: Record<
  CryptoLanguage,
  Record<CryptoRealtimeStatusLabel, string>
> = {
  en: {
    connected: "Live",
    degraded: "Degraded",
    disconnected: "Offline",
    reconnecting: "Reconnecting",
    syncing: "Syncing",
  },
  zh: {
    connected: "实时",
    degraded: "降级",
    disconnected: "离线",
    reconnecting: "重连中",
    syncing: "同步中",
  },
  ja: {
    connected: "リアルタイム",
    degraded: "縮退",
    disconnected: "オフライン",
    reconnecting: "再接続中",
    syncing: "同期中",
  },
};

export function cryptoLanguageFrom(language?: string): CryptoLanguage {
  const normalized = String(language || "en").toLowerCase();
  if (normalized.startsWith("zh")) return "zh";
  if (normalized.startsWith("ja")) return "ja";
  return "en";
}

export function getCryptoStatusLabel(
  status: CryptoRealtimeStatusLabel,
  language?: string
) {
  return statusLabels[cryptoLanguageFrom(language)][status];
}

export function useCryptoStatusLabel(status: CryptoRealtimeStatusLabel) {
  const { i18n } = useTranslation();
  return getCryptoStatusLabel(status, i18n.language);
}
