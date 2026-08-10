import { memo } from "react";
import {
  CheckCircle,
  CircleNotch,
  Clock,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { humanFileSize } from "@/utils/numbers";

const STATUS_CONFIG = Object.freeze({
  uploading: {
    key: "uploading",
    className:
      "bg-sky-500/15 text-sky-200 ring-sky-400/25 light:bg-sky-100 light:text-sky-700 light:ring-sky-300",
    icon: CircleNotch,
    spin: true,
  },
  pending: {
    key: "waiting",
    className:
      "bg-slate-500/15 text-slate-200 ring-slate-400/25 light:bg-slate-100 light:text-slate-700 light:ring-slate-300",
    icon: Clock,
  },
  processing: {
    key: "processing",
    className:
      "bg-violet-500/15 text-violet-200 ring-violet-400/25 light:bg-violet-100 light:text-violet-700 light:ring-violet-300",
    icon: CircleNotch,
    spin: true,
  },
  indexing: {
    key: "indexing",
    className:
      "bg-violet-500/15 text-violet-200 ring-violet-400/25 light:bg-violet-100 light:text-violet-700 light:ring-violet-300",
    icon: CircleNotch,
    spin: true,
  },
  embedding: {
    key: "embedding",
    className:
      "bg-violet-500/15 text-violet-200 ring-violet-400/25 light:bg-violet-100 light:text-violet-700 light:ring-violet-300",
    icon: CircleNotch,
    spin: true,
  },
  uploaded: {
    key: "uploaded",
    className:
      "bg-emerald-500/15 text-emerald-200 ring-emerald-400/25 light:bg-emerald-100 light:text-emerald-700 light:ring-emerald-300",
    icon: CheckCircle,
  },
  indexed: {
    key: "indexed",
    className:
      "bg-emerald-500/15 text-emerald-200 ring-emerald-400/25 light:bg-emerald-100 light:text-emerald-700 light:ring-emerald-300",
    icon: CheckCircle,
  },
  outdated: {
    key: "outdated",
    className:
      "bg-orange-500/15 text-orange-200 ring-orange-400/25 light:bg-orange-100 light:text-orange-700 light:ring-orange-300",
    icon: WarningCircle,
  },
  failed: {
    key: "failed",
    className:
      "bg-red-500/15 text-red-200 ring-red-400/25 light:bg-red-100 light:text-red-700 light:ring-red-300",
    icon: XCircle,
  },
  cancelled: {
    key: "cancelled",
    className:
      "bg-slate-500/15 text-slate-300 ring-slate-400/20 light:bg-slate-100 light:text-slate-600 light:ring-slate-300",
    icon: XCircle,
  },
  cached: {
    key: "cached",
    className:
      "bg-slate-500/15 text-slate-200 ring-slate-400/25 light:bg-slate-100 light:text-slate-700 light:ring-slate-300",
    icon: CheckCircle,
  },
});

function normalizedStatus(status) {
  const value = String(status || "").toLowerCase();
  if (["queued", "queue"].includes(value)) return "pending";
  if (["complete", "completed"].includes(value)) return "indexed";
  if (value === "success") return "uploaded";
  if (value === "canceled") return "cancelled";
  return value;
}

function DocumentStatusBadge({ status, details = {}, progress = null }) {
  const { t } = useTranslation();
  const normalized = normalizedStatus(status);
  const config = STATUS_CONFIG[normalized];
  if (!config) return null;
  const Icon = config.icon;
  const percent = Number.isFinite(Number(progress))
    ? Math.max(0, Math.min(100, Math.round(Number(progress))))
    : null;
  const chunksProcessed = Number(details?.chunksProcessed || 0);
  const totalChunks = Number(details?.totalChunks || 0);
  const speed = Number(details?.speedBps || 0);
  const baseLabel = t(`connectors.document-status.${config.key}`);
  const visibleLabel = [
    baseLabel,
    percent !== null ? `${percent}%` : null,
    totalChunks > 0 ? `${chunksProcessed}/${totalChunks}` : null,
    speed > 0 ? `${humanFileSize(speed)}/s` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const title = [
    visibleLabel,
    details?.indexedAt
      ? t("connectors.document-status.last-indexed", {
          value: details.indexedAt,
        })
      : null,
    details?.embeddingCount !== undefined && details?.embeddingCount !== null
      ? t("connectors.document-status.embedding-count", {
          count: details.embeddingCount,
        })
      : null,
    details?.batchJobId
      ? t("connectors.document-status.batch-id", {
          value: details.batchJobId,
        })
      : null,
    details?.error
      ? t("connectors.document-status.failure-reason", {
          value: details.error,
        })
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <span
      title={title}
      aria-label={visibleLabel}
      className={`inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-tight ring-1 ring-inset ${config.className}`}
    >
      <Icon
        size={12}
        weight={config.spin ? "bold" : "fill"}
        className={`${config.spin ? "animate-spin" : ""} shrink-0`}
        aria-hidden="true"
      />
      <span className="truncate">{visibleLabel}</span>
    </span>
  );
}

export { normalizedStatus };
export default memo(DocumentStatusBadge);
