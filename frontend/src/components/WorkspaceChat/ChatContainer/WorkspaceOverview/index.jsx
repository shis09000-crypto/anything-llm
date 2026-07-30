import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowRight,
  ArrowsClockwise,
  Brain,
  Clock,
  Compass,
  FileText,
  Graph,
  Heartbeat,
  Lightning,
  Path,
  Sparkle,
  Trash,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import AppButton from "@/components/lib/AppButton";
import WorkspaceOverviewModel from "@/models/workspaceOverview";
import showToast from "@/utils/toast";
import { API_BASE } from "@/utils/constants";
import { BLOB_KINDS, requestBlob } from "@/lib/communication/blobClient";
import { isApiAbortError } from "@/lib/communication/apiError";
import { recordClientUiObservation } from "@/lib/communication/clientUiObservability";
import defaultWorkspaceHeroBg from "@/media/overview/default-workspace-hero-bg.webp";
import defaultNodeFocusBg from "@/media/overview/default-node-focus-bg.webp";
import { useTranslation } from "react-i18next";
import CognitiveCenter from "./CognitiveCenter";

const OVERVIEW_CACHE_TTL_MS = 60_000;
const HERO_BACKGROUND_MAX_BYTES = 5 * 1024 * 1024;
const HERO_BACKGROUND_MIN_WIDTH = 1200;
const HERO_BACKGROUND_MIN_HEIGHT = 600;
const HERO_BACKGROUND_MIN_RATIO = 1.45;
const HERO_BACKGROUND_MAX_RATIO = 2.5;
const HERO_BACKGROUND_ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const HERO_BACKGROUND_RECOMMENDATION =
  "建议上传 1600×900 或 1800×900 的横向 PNG/JPG/WebP，比例约 16:9 到 2:1，文件小于 5MB。";
const overviewCache = new Map();

function overviewRetryDelay(retryCount) {
  return Math.min(100 * 2 ** Math.max(0, retryCount - 1), 1_000);
}

function formatTime(value) {
  if (!value) return "暂无";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return "暂无";
  }
}

function hexToRgb(hex, fallback = [219, 234, 254]) {
  if (typeof hex !== "string") return fallback;
  const clean = hex.replace("#", "").trim();
  if (!/^[0-9a-f]{6}$/i.test(clean)) return fallback;
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function rgba([red, green, blue], alpha) {
  return `rgb(${red} ${green} ${blue} / ${alpha})`;
}

function mixRgb(first, second, amount = 0.5) {
  return first.map((channel, index) =>
    Math.round(channel * (1 - amount) + second[index] * amount)
  );
}

function getHeroTaglineDisplayStyle(tagline) {
  const length = Array.from(tagline.trim()).length;
  let fontSize = "15.5px";
  let lineHeight = "1.45";
  let maxLines = 5;

  if (length <= 60) {
    fontSize = "20px";
    lineHeight = "1.6";
    maxLines = 3;
  } else if (length <= 100) {
    fontSize = "18px";
    lineHeight = "1.55";
    maxLines = 5;
  } else if (length <= 150) {
    fontSize = "16.5px";
    lineHeight = "1.5";
    maxLines = 5;
  }

  return {
    "--overview-tagline-font-size": fontSize,
    "--overview-tagline-line-height": lineHeight,
    "--overview-tagline-max-lines": maxLines,
  };
}

function overviewThemeStyle(metadata = {}) {
  const average = hexToRgb(metadata?.averageColor || metadata?.dominantColor);
  const dominant = hexToRgb(metadata?.dominantColor, average);
  const brightness = clampNumber(metadata?.brightness, 0, 1, 0.86);
  const contrastHint =
    metadata?.contrastHint ||
    (brightness < 0.45 ? "dark" : brightness > 0.7 ? "light" : "mixed");
  const temperatureHint = metadata?.temperatureHint || "cool";
  const isDark = contrastHint === "dark" || brightness < 0.45;
  const isMixed = contrastHint === "mixed";
  const isWarm = temperatureHint === "warm";
  const coolAccent = mixRgb(dominant, [37, 99, 235], isWarm ? 0.12 : 0.42);
  const warmAccent = mixRgb(dominant, [214, 159, 92], 0.36);
  const accent = isWarm ? warmAccent : coolAccent;
  const overlayStrength = isDark ? 0.58 : isMixed ? 0.42 : 0.28;
  const mistStrength = isDark ? 0.26 : isMixed ? 0.16 : 0.08;
  const glassAlpha = isDark ? 0.36 : isMixed ? 0.52 : 0.44;
  const textPrimary = isDark ? [248, 250, 252] : [15, 23, 42];
  const textSecondary = isDark ? [226, 232, 240] : [71, 85, 105];
  const neutralGlow = isWarm ? [255, 248, 237] : [219, 234, 254];

  return {
    "--overview-text-primary": rgba(textPrimary, isDark ? 0.98 : 0.96),
    "--overview-text-secondary": rgba(textSecondary, isDark ? 0.84 : 0.82),
    "--overview-glass-bg": isDark
      ? rgba([15, 23, 42], glassAlpha)
      : rgba([255, 255, 255], glassAlpha),
    "--overview-glass-bg-strong": isDark
      ? rgba([15, 23, 42], 0.48)
      : rgba([255, 255, 255], 0.62),
    "--overview-glass-border": isDark
      ? rgba([255, 255, 255], 0.34)
      : rgba([255, 255, 255], 0.72),
    "--overview-accent": rgba(accent, isDark ? 0.88 : 0.82),
    "--overview-accent-soft": rgba(accent, isDark ? 0.22 : 0.16),
    "--overview-overlay-from": rgba([255, 255, 255], overlayStrength),
    "--overview-overlay-mid": rgba(
      isDark ? [255, 255, 255] : neutralGlow,
      isDark ? 0.4 : 0.22
    ),
    "--overview-overlay-to": rgba([255, 255, 255], isDark ? 0.18 : 0.06),
    "--overview-radial-glow": rgba(neutralGlow, isWarm ? 0.18 : 0.22),
    "--overview-mist": rgba([255, 255, 255], mistStrength),
    "--overview-bg-fallback": `linear-gradient(120deg, ${rgba(
      mixRgb(average, [255, 255, 255], 0.84),
      1
    )}, ${rgba(mixRgb(dominant, [219, 234, 254], 0.72), 1)})`,
  };
}

function healthToneStyle(status) {
  const tones = {
    healthy: [16, 185, 129],
    warning: [217, 119, 6],
    degraded: [234, 88, 12],
    critical: [225, 29, 72],
  };
  const accent = tones[status] || [37, 99, 235];
  return {
    "--overview-health-accent": rgba(accent, 0.95),
    "--overview-health-accent-soft": rgba(accent, 0.16),
  };
}

function formatBytes(bytes = 0) {
  if (!Number.isFinite(Number(bytes))) return "0MB";
  return `${(Number(bytes) / (1024 * 1024)).toFixed(1)}MB`;
}

function loadImageDimensions(file) {
  if (!file) return Promise.resolve(null);
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(file).then((bitmap) => {
      const dimensions = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      return dimensions;
    });
  }

  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve({
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
      });
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("image_dimensions_unreadable"));
    };
    image.src = objectUrl;
  });
}

async function validateHeroBackgroundFile(file) {
  if (!file) return { ok: false, reason: "未选择图片。" };
  if (!HERO_BACKGROUND_ALLOWED_TYPES.has(file.type)) {
    return {
      ok: false,
      reason: "图片格式不支持。请上传 PNG、JPG 或 WebP。",
    };
  }
  if (file.size > HERO_BACKGROUND_MAX_BYTES) {
    return {
      ok: false,
      reason: `图片文件过大（${formatBytes(file.size)}）。请控制在 5MB 以内。`,
    };
  }

  let dimensions;
  try {
    dimensions = await loadImageDimensions(file);
  } catch {
    return {
      ok: false,
      reason: "无法读取图片尺寸，请换一张标准 PNG、JPG 或 WebP。",
    };
  }

  const width = Number(dimensions?.width || 0);
  const height = Number(dimensions?.height || 0);
  const ratio = height > 0 ? width / height : 0;
  const dimensionLabel = width && height ? `${width}×${height}` : "未知尺寸";
  const sizeTooSmall =
    width < HERO_BACKGROUND_MIN_WIDTH || height < HERO_BACKGROUND_MIN_HEIGHT;
  const ratioOutOfRange =
    ratio < HERO_BACKGROUND_MIN_RATIO || ratio > HERO_BACKGROUND_MAX_RATIO;

  if (sizeTooSmall || ratioOutOfRange) {
    return {
      ok: false,
      reason: `这张图尺寸为 ${dimensionLabel}，不适合当前首页背景。${HERO_BACKGROUND_RECOMMENDATION}`,
    };
  }

  return { ok: true, width, height, ratio };
}

function resolveOverviewAssetUrl(url = null) {
  if (!url) return null;
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  if (API_BASE.startsWith("http") && url.startsWith("/api/")) {
    return `${API_BASE.replace(/\/api\/?$/, "")}${url}`;
  }
  return url;
}

function isPrivateOverviewAssetUrl(url = null) {
  const value = String(url || "");
  return value.includes("/api/workspace/") && value.includes("/visual-assets/");
}

function useOverviewImageUrl(url = null) {
  const [state, setState] = useState({
    src: null,
    failed: false,
  });

  useEffect(() => {
    if (!url) {
      setState({ src: null, failed: false });
      return;
    }

    if (!isPrivateOverviewAssetUrl(url)) {
      setState({ src: url, failed: false });
      return;
    }

    const controller = new AbortController();
    let objectUrl = null;
    let cancelled = false;
    setState({ src: null, failed: false });

    requestBlob(url, {
      blobKind: BLOB_KINDS.visualAsset,
      signal: controller.signal,
    })
      .then(({ blob }) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ src: objectUrl, failed: false });
      })
      .catch((error) => {
        if (error?.name === "AbortError" || cancelled) return;
        setState({ src: null, failed: true });
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  return state;
}

function VisualBackground({
  userUrl = null,
  defaultUrl = null,
  className = "",
}) {
  const resolvedUserUrl = resolveOverviewAssetUrl(userUrl);
  const userImage = useOverviewImageUrl(resolvedUserUrl);
  const [source, setSource] = useState(resolvedUserUrl ? "user" : "default");
  useEffect(() => {
    setSource(resolvedUserUrl ? "user" : "default");
  }, [defaultUrl, resolvedUserUrl]);

  useEffect(() => {
    if (userImage.failed) setSource(defaultUrl ? "default" : "css");
  }, [defaultUrl, userImage.failed]);

  const src =
    source === "user" && resolvedUserUrl
      ? userImage.src || defaultUrl
      : source === "default" && defaultUrl
        ? defaultUrl
        : null;

  return (
    <div className={`overview-visual-background ${className}`}>
      {src && (
        <img
          key={src}
          src={src}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover object-center"
          onError={() => {
            setSource((current) =>
              current === "user" && defaultUrl ? "default" : "css"
            );
          }}
        />
      )}
      <div className="overview-hero-overlay" />
    </div>
  );
}

export default function WorkspaceOverview({
  workspace,
  threadSlug = null,
  shouldLoad = true,
  isVisible = true,
  onOpenGraph,
  onOpenPath,
  onOpenEvidence,
  onOpenDocument,
  onUploadDocument,
}) {
  const { t } = useTranslation();
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(new Set());
  const [profileDraft, setProfileDraft] = useState({
    open: false,
    userDescription: "",
    profileType: "",
    bookStructureType: "",
    primaryAxis: "",
    secondaryAxes: "",
    saving: false,
  });
  const [pageSessionId, setPageSessionId] = useState(null);
  const cacheKey = useMemo(
    () => `${workspace?.slug || "workspace"}:${threadSlug || "default"}`,
    [threadSlug, workspace?.slug]
  );
  const requestRef = useRef({ id: 0, controller: null });

  useEffect(() => {
    if (typeof crypto !== "undefined" && crypto.randomUUID)
      setPageSessionId(crypto.randomUUID());
    else
      setPageSessionId(
        `overview-${workspace?.slug || "workspace"}-${Date.now()}`
      );
  }, [workspace?.slug]);
  const reportedImpressionsRef = useRef(new Set());

  const loadOverview = useCallback(
    async ({ force = false } = {}) => {
      if (!workspace?.slug || (!shouldLoad && !force)) return;
      const cached = overviewCache.get(cacheKey);
      const cachedOverview = cached?.overview || null;
      if (cached?.overview && !force) {
        setOverview(cached.overview);
        setLoading(false);
        if (Date.now() - cached.updatedAt < OVERVIEW_CACHE_TTL_MS) return;
      } else {
        setLoading(true);
      }

      requestRef.current.controller?.abort();
      const generation = requestRef.current.id + 1;
      requestRef.current = { id: generation, controller: null };
      let retryCount = 0;
      let firstPreemptedAt = 0;

      while (requestRef.current.id === generation) {
        const controller = new AbortController();
        requestRef.current.controller = controller;
        const startedAt = performance.now();
        let correlatedRequestId = "";
        let result = null;

        try {
          result = await WorkspaceOverviewModel.get(
            workspace.slug,
            {
              threadSlug,
            },
            {
              signal: controller.signal,
              onRequestMetadata: ({ requestId }) => {
                correlatedRequestId = requestId || correlatedRequestId;
              },
            }
          );
        } catch (error) {
          if (
            controller.signal.aborted ||
            requestRef.current.id !== generation
          ) {
            return;
          }
          if (!isApiAbortError(error)) {
            result = {
              error: error?.message || "加载工作区首页失败。",
              failureKind: error?.status ? "http_error" : "network_error",
              requestId: error?.details?.requestId || correlatedRequestId,
            };
          } else {
            retryCount += 1;
            if (!firstPreemptedAt) firstPreemptedAt = Date.now();
            recordClientUiObservation({
              event: "overview_preempted",
              outcome: "observed",
              reason: "scheduler_abort",
              requestId: correlatedRequestId,
              retryCount,
              durationMs: performance.now() - startedAt,
            });
            await new Promise((resolve) =>
              window.setTimeout(resolve, overviewRetryDelay(retryCount))
            );
            if (
              controller.signal.aborted ||
              requestRef.current.id !== generation ||
              !isVisible
            ) {
              return;
            }
            continue;
          }
        }

        if (controller.signal.aborted || requestRef.current.id !== generation) {
          return;
        }
        if (!result?.error) {
          overviewCache.set(cacheKey, {
            overview: result,
            updatedAt: Date.now(),
          });
          setOverview(result);
          if (retryCount > 0) {
            recordClientUiObservation({
              event: "overview_recovered",
              outcome: "recovered",
              reason: "scheduler_abort",
              requestId: correlatedRequestId,
              retryCount,
              durationMs: Date.now() - firstPreemptedAt,
            });
          }
        } else {
          setOverview(cachedOverview || result);
          recordClientUiObservation({
            event: "overview_failed",
            outcome: "failed",
            reason: result.failureKind || "unknown",
            requestId: result.requestId || correlatedRequestId,
            retryCount,
            durationMs: performance.now() - startedAt,
          });
        }
        setLoading(false);
        return;
      }
    },
    [cacheKey, isVisible, shouldLoad, threadSlug, workspace?.slug]
  );

  const refreshKnowledgeProfile = useCallback(
    async (body = {}) => {
      if (!workspace?.slug) return;
      setProfileDraft((prev) => ({ ...prev, saving: true }));
      const result = await WorkspaceOverviewModel.updateKnowledgeProfile(
        workspace.slug,
        { refresh: true, ...body }
      );
      setProfileDraft((prev) => ({ ...prev, saving: false, open: false }));
      if (result?.success) {
        overviewCache.delete(cacheKey);
        await loadOverview({ force: true });
      }
    },
    [cacheKey, loadOverview, workspace?.slug]
  );

  const applyHeroBackgroundAsset = useCallback((asset = null) => {
    if (!asset?.url) return;
    setOverview((previous) => {
      if (!previous) return previous;
      return {
        ...previous,
        workspaceHero: {
          ...(previous.workspaceHero || {}),
          backgroundImageUrl: asset.url,
          backgroundAsset: asset,
        },
        visualAssets: {
          ...(previous.visualAssets || {}),
          workspaceBackground: asset,
        },
      };
    });
  }, []);

  useEffect(() => {
    if (!shouldLoad) return;
    loadOverview();
    return () => requestRef.current.controller?.abort();
  }, [shouldLoad, loadOverview]);

  const recordUsage = useCallback(
    (recommendation, action) => {
      if (!workspace?.slug || !recommendation?.recommendationId) return;
      if (action === "impression" && !pageSessionId) return;
      if (
        action === "impression" &&
        reportedImpressionsRef.current.has(recommendation.recommendationId)
      )
        return;
      if (action === "impression")
        reportedImpressionsRef.current.add(recommendation.recommendationId);
      WorkspaceOverviewModel.recordUsage(workspace.slug, {
        recommendationId: recommendation.recommendationId,
        formulaVersion: recommendation.formulaVersion,
        type: recommendation.type,
        targetType: recommendation.target?.targetType,
        targetId: recommendation.target?.targetId,
        action,
        pageSessionId,
      });
    },
    [pageSessionId, workspace?.slug]
  );

  const activateRecommendation = useCallback(
    (recommendation, action = "click") => {
      recordUsage(recommendation, action);
      const target = recommendation.target || {};
      if (target.targetType === "path") {
        onOpenPath?.({
          source: target.sourceConcept,
          target: target.targetConcept,
          title: recommendation.title,
        });
        return;
      }
      if (target.targetType === "edge") {
        onOpenEvidence?.({
          targetType: "edge",
          targetId: target.edgeId || target.targetId,
          concept: target.sourceConcept || target.concept,
        });
        return;
      }
      if (target.targetType === "document") {
        onOpenDocument?.(target);
        return;
      }
      onOpenGraph?.({
        concept: target.concept || target.displayName || recommendation.title,
        displayName: target.displayName || recommendation.title,
        nodeKey: target.nodeKey,
        nodeId: target.nodeId || target.targetId,
      });
    },
    [onOpenDocument, onOpenEvidence, onOpenGraph, onOpenPath, recordUsage]
  );

  const recommendations = useMemo(
    () =>
      (overview?.personalizedRecommendations || []).filter(
        (item) => !dismissed.has(item.recommendationId)
      ),
    [dismissed, overview?.personalizedRecommendations]
  );

  if (loading) {
    return (
      <div className="w-full max-w-6xl mx-auto px-4 md:px-8 py-10 text-slate-500">
        正在整理你的研究导航...
      </div>
    );
  }

  if (overview?.error) {
    return (
      <div className="w-full max-w-4xl mx-auto px-4 md:px-8 py-12">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-8 shadow-sm">
          <div className="flex items-center gap-3 text-amber-900 font-semibold text-lg">
            <WarningCircle size={22} className="text-amber-600" />
            动态首页暂时加载失败
          </div>
          <p className="mt-3 text-sm leading-6 text-amber-800">
            这不是因为知识库没有数据，而是首页聚合接口返回了异常。请刷新重试，或查看后端日志。
          </p>
          <p className="mt-2 rounded-lg bg-white/70 px-3 py-2 text-xs text-amber-900">
            {overview.error}
          </p>
          <button
            type="button"
            onClick={() => loadOverview({ force: true })}
            className="mt-5 rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-amber-800 hover:bg-amber-100"
          >
            重新加载
          </button>
        </div>
      </div>
    );
  }

  if (overview?.emptyState?.show) {
    return (
      <div className="overview-themed-surface h-full w-full overflow-y-auto bg-slate-50 light:bg-slate-50">
        <div className="mx-auto w-full max-w-5xl px-4 py-10 md:px-8">
          <section className="overview-themed-surface relative min-h-[220px] overflow-hidden rounded-[28px] border border-[color:var(--overview-glass-border)] bg-white shadow-[0_24px_70px_rgb(15_23_42_/_0.10)]">
            <VisualBackground defaultUrl={defaultWorkspaceHeroBg} />
            <div className="relative p-6 sm:p-8">
              <div className="overview-glass-pill inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold">
                <Compass size={17} />
                动态知识库首页
              </div>
              <h2 className="mt-5 max-w-2xl text-2xl font-bold leading-tight text-[color:var(--overview-text-primary)] sm:text-3xl">
                动态知识库首页还在等待数据
              </h2>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-[color:var(--overview-text-secondary)]">
                当前 workspace
                还没有足够的知识图谱、证据或使用记录。你可以先上传文档、运行
                Knowledge Graph backfill，或继续聊天来积累研究信号。
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <AppButton
                  type="button"
                  onClick={onUploadDocument}
                  size="md"
                  title={t("chat_window.controls.upload.workspaceDescription")}
                  aria-label={t(
                    "chat_window.controls.upload.workspaceDescription"
                  )}
                  leftIcon={<UploadSimple size={16} weight="bold" />}
                >
                  {t("chat_window.controls.upload.workspaceLabel")}
                </AppButton>
                <AppButton
                  type="button"
                  variant="secondary"
                  onClick={() => loadOverview({ force: true })}
                  size="md"
                  leftIcon={<ArrowsClockwise size={16} weight="bold" />}
                >
                  重新检查
                </AppButton>
              </div>
            </div>
          </section>
        </div>
      </div>
    );
  }

  const focusTarget =
    overview?.userCognitiveState?.currentFocusConcepts?.[0] ||
    overview?.userCognitiveState?.activeTopics?.[0] ||
    null;
  const hero = overview?.workspaceHero || {};
  const health = overview?.healthLite || {};
  const recentActivity = overview?.recentActivity?.[0] || null;
  const taglinePending = hero?.taglineStatus === "pending";
  const heroBackgroundAsset =
    hero?.backgroundAsset ||
    overview?.visualAssets?.workspaceBackground ||
    null;
  const heroBackgroundUrl =
    hero?.backgroundImageUrl || heroBackgroundAsset?.url || null;
  const heroThemeStyle = heroBackgroundUrl
    ? overviewThemeStyle(heroBackgroundAsset?.metadata)
    : undefined;
  const overviewRenderLoad =
    (overview?.personalizedRecommendations?.length || 0) +
    (overview?.unfinishedExplorations?.length || 0) +
    (overview?.curiosityRecommendations?.length || 0) +
    (overview?.recentActivity?.length || 0) +
    (overview?.bookStructure?.secondaryAxes?.length || 0);
  const axesTextLength = (overview?.bookStructure?.secondaryAxes || []).join(
    ""
  ).length;
  const isRenderHeavy = overviewRenderLoad >= 18 || axesTextLength > 420;

  return (
    <div
      className={`overview-themed-surface h-full w-full overflow-y-auto bg-slate-50 light:bg-slate-50 ${
        isRenderHeavy ? "overview-high-load" : ""
      }`}
    >
      <div className="w-full max-w-7xl mx-auto px-4 md:px-8 pt-7 md:pt-9 pb-72">
        <section className="overview-themed-surface grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(220px,2fr)]">
          <div
            className="overview-themed-surface relative min-h-[350px] overflow-hidden rounded-[28px] border border-[color:var(--overview-glass-border)] bg-white shadow-[0_24px_70px_rgb(15_23_42_/_0.10)]"
            style={heroThemeStyle}
          >
            <VisualBackground
              userUrl={heroBackgroundUrl}
              defaultUrl={defaultWorkspaceHeroBg}
            />
            <div className="relative grid min-h-[350px] gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:p-8 xl:p-9">
              <div className="flex min-w-0 flex-col justify-between gap-6">
                <div>
                  <div className="overview-glass-pill inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold">
                    <Compass size={17} />
                    个性化知识推荐首页
                  </div>
                  <h1 className="overview-hero-title mt-5 max-w-2xl">
                    {hero?.title || workspace?.name || "Workspace"}
                  </h1>
                  <div className="mt-5 flex items-center gap-3">
                    <span className="h-px w-20 rounded-full bg-[color:var(--overview-accent)]" />
                    <Sparkle
                      size={18}
                      weight="fill"
                      className="text-[color:var(--overview-accent)]"
                    />
                  </div>
                </div>
                <div className="overview-glass-pill inline-flex w-fit items-center gap-2 px-4 py-2.5 text-sm">
                  <Clock size={17} />
                  <span>最近活动</span>
                  <span className="h-4 w-px bg-[color:var(--overview-glass-border)]" />
                  <span className="font-semibold">
                    {formatTime(recentActivity?.createdAt)}
                  </span>
                  <span className="ml-1 h-2 w-2 rounded-full bg-[color:var(--overview-accent)]" />
                </div>
              </div>
              <div className="flex min-w-0 items-center">
                {hero?.tagline ? (
                  <div className="overview-glass-card w-full rounded-[24px] p-5 lg:-ml-6 lg:w-[calc(100%+3rem)]">
                    <div className="mb-2.5 flex items-center gap-2.5 text-[color:var(--overview-accent)]">
                      <FileText size={18} />
                      <div className="text-base font-semibold sm:text-lg">
                        {t("workspace-overview.workspaceOverview")}
                      </div>
                    </div>
                    <div className="mb-3 h-px w-14 bg-[color:var(--overview-accent)]" />
                    <p
                      className="overview-hero-tagline"
                      style={getHeroTaglineDisplayStyle(hero.tagline)}
                    >
                      {hero.tagline}
                    </p>
                  </div>
                ) : taglinePending ? (
                  <p className="overview-glass-pill px-4 py-2 text-sm">
                    {t("workspace-overview.overviewGenerating")}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
          <div
            className="overview-glass-card min-h-[250px] rounded-[24px] p-6"
            style={healthToneStyle(health.status)}
          >
            <div className="flex h-full flex-col justify-between gap-5">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-[color:var(--overview-health-accent)]">
                  <Heartbeat size={18} />
                  {t("workspace-overview.workspaceHealth")}
                </div>
                <div className="mt-5 text-5xl font-semibold leading-none text-[color:var(--overview-health-accent)]">
                  {health.score ?? t("workspace-overview.unknown")}
                </div>
                <p className="mt-4 text-sm leading-6 text-[color:var(--overview-text-secondary)]">
                  {health.summary || t("workspace-overview.healthUnavailable")}
                </p>
              </div>
              <p className="text-xs leading-5 text-[color:var(--overview-text-secondary)]">
                {t("workspace-overview.healthNote")}
              </p>
            </div>
          </div>
        </section>

        <CurrentFocusCard
          detail={overview?.currentFocusDetail}
          recentActivity={recentActivity}
          focusTarget={focusTarget}
          onOpenGraph={onOpenGraph}
        />

        <KnowledgeProfilePanel
          profile={overview?.workspaceProfile}
          bookStructure={overview?.bookStructure}
          engine={overview?.recommendationEngine}
          draft={profileDraft}
          setDraft={setProfileDraft}
          onRefresh={() => refreshKnowledgeProfile()}
          onSave={(body) => refreshKnowledgeProfile(body)}
        />

        <WorkspaceSupplementPanel
          workspace={workspace}
          profile={overview?.workspaceProfile}
          summary={overview?.workspaceSupplements}
          workspaceBackground={overview?.visualAssets?.workspaceBackground}
          onChanged={async (asset = null) => {
            applyHeroBackgroundAsset(asset);
            overviewCache.delete(cacheKey);
            await loadOverview({ force: true });
            applyHeroBackgroundAsset(asset);
          }}
        />

        <CognitiveCenter workspace={workspace} threadSlug={threadSlug} />

        <div className="mt-5 grid min-w-0 grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)]">
          <main className="min-w-0 space-y-5">
            <OverviewSection
              icon={<Path size={18} />}
              title={t("workspace-overview.continueLast")}
              empty={t("workspace-overview.noContinue")}
            >
              <div className="grid grid-cols-1 items-stretch gap-3 md:grid-cols-2">
                {(overview?.unfinishedExplorations || [])
                  .slice(0, 4)
                  .map((item) => (
                    <RecommendationCard
                      key={item.recommendationId}
                      recommendation={item}
                      isVisible={isVisible}
                      onImpression={recordUsage}
                      onActivate={(rec) =>
                        activateRecommendation(rec, "continue")
                      }
                      actionLabel="继续"
                    />
                  ))}
              </div>
            </OverviewSection>

            <OverviewSection
              icon={<Sparkle size={18} />}
              title={t("workspace-overview.recommended")}
              empty={t("workspace-overview.noRecommendations")}
            >
              <div className="grid grid-cols-1 items-stretch gap-3 md:grid-cols-2">
                {recommendations.slice(0, 8).map((item) => (
                  <RecommendationCard
                    key={item.recommendationId}
                    recommendation={item}
                    isVisible={isVisible}
                    onImpression={recordUsage}
                    onActivate={activateRecommendation}
                    onDismiss={(rec) => {
                      recordUsage(rec, "dismiss");
                      setDismissed(
                        (prev) => new Set([...prev, rec.recommendationId])
                      );
                    }}
                  />
                ))}
              </div>
            </OverviewSection>

            <OverviewSection
              icon={<WarningCircle size={18} />}
              title={t("workspace-overview.knowledgeGaps")}
            >
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {(overview?.curiosityRecommendations || [])
                  .slice(0, 6)
                  .map((item) => (
                    <SmallInsight
                      key={item.recommendationId}
                      item={item}
                      onClick={() => activateRecommendation(item)}
                    />
                  ))}
              </div>
            </OverviewSection>
          </main>

          <aside className="min-w-0 space-y-5">
            <StatsPanel overview={overview} />
            <ActivityPanel activities={overview?.recentActivity || []} />
            <DebugPanel debug={overview?.recommendationDebug} />
          </aside>
        </div>
      </div>
    </div>
  );
}

function CurrentFocusCard({
  detail = null,
  recentActivity = null,
  focusTarget = null,
  onOpenGraph,
}) {
  if (!detail) return null;
  const stats = [
    ["证据", detail.evidenceCount],
    ["关系", detail.relationCount],
    ["补充", detail.supplementCount],
  ];
  const bits = [
    detail.whyRecommended,
    detail.nextAction,
    ...(detail.knowledgeBits || []),
  ].filter(
    (bit) =>
      Boolean(bit) && bit !== detail.summary && bit !== detail.mainlinePath
  );

  return (
    <section
      className="overview-themed-surface relative mt-5 min-h-[250px] overflow-hidden rounded-[26px] border border-[color:var(--overview-glass-border)] shadow-[0_18px_54px_rgb(15_23_42_/_0.08)]"
      style={
        detail.backgroundAsset?.metadata
          ? overviewThemeStyle(detail.backgroundAsset.metadata)
          : undefined
      }
    >
      <VisualBackground
        userUrl={detail.backgroundImageUrl}
        defaultUrl={defaultNodeFocusBg}
      />
      <div className="relative p-6 md:p-8">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <p className="overview-glass-pill inline-flex px-3 py-1.5 text-xs font-semibold">
              当前研究焦点
            </p>
            <h2 className="mt-4 text-2xl font-semibold leading-tight text-[color:var(--overview-text-primary)] md:text-3xl">
              {detail.displayName || detail.title || "当前研究焦点"}
            </h2>
            {detail.nodeTypeLabel && (
              <p className="mt-2 text-xs text-[color:var(--overview-text-secondary)]">
                {detail.nodeTypeLabel}
                {detail.nodeKey ? ` · ${detail.nodeKey}` : ""}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {stats.map(([label, value]) => (
              <span
                key={label}
                className="overview-glass-pill px-3 py-1 text-xs font-semibold"
              >
                {label} {Number(value || 0)}
              </span>
            ))}
          </div>
        </div>
        {detail.summary && (
          <p className="mt-5 max-w-4xl text-sm leading-6 text-[color:var(--overview-text-secondary)]">
            {detail.summary}
          </p>
        )}
        {detail.mainlinePath && (
          <div className="overview-glass-card mt-4 rounded-2xl px-4 py-3 text-xs leading-5 text-[color:var(--overview-text-secondary)]">
            路径：{detail.mainlinePath}
          </div>
        )}
        {bits.length > 0 && (
          <div className="mt-4 grid gap-2 md:grid-cols-2">
            {[...new Set(bits)].slice(0, 4).map((bit) => (
              <div
                key={bit}
                className="overview-glass-card rounded-2xl px-4 py-3 text-xs leading-5 text-[color:var(--overview-text-secondary)]"
              >
                {bit}
              </div>
            ))}
          </div>
        )}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-xs text-[color:var(--overview-text-secondary)]">
          <span>最近活动：{formatTime(recentActivity?.createdAt)}</span>
          {detail.nodeKey && (
            <button
              type="button"
              onClick={() =>
                onOpenGraph?.({
                  concept:
                    focusTarget?.concept || detail.displayName || detail.title,
                  displayName: detail.displayName || detail.title,
                  nodeKey: detail.nodeKey,
                  nodeId: detail.nodeId,
                })
              }
              className="overview-action-button rounded-xl px-3 py-1.5 text-xs font-semibold"
            >
              打开节点详情
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function OverviewSection({ icon, title, empty, children }) {
  const hasContent = Boolean(children?.props?.children?.length ?? children);
  return (
    <section className="overview-glass-card rounded-[24px] p-5">
      <div className="mb-4 flex items-center gap-2 font-semibold text-[color:var(--overview-text-primary)]">
        <span className="text-[color:var(--overview-accent)]">{icon}</span>
        {title}
      </div>
      {hasContent ? (
        children
      ) : (
        <p className="text-sm text-[color:var(--overview-text-secondary)]">
          {empty}
        </p>
      )}
    </section>
  );
}

const workspaceSupplementKinds = [
  ["structure_json", "结构说明"],
  ["reading_guide", "阅读导引"],
  ["chapter_overview", "章节总览"],
  ["timeline", "时间线"],
  ["person_map", "人物关系"],
  ["concept_index", "概念索引"],
  ["summary_standard", "总结标准"],
  ["other", "其他补充"],
];

function WorkspaceSupplementPanel({
  workspace,
  profile,
  summary,
  workspaceBackground = null,
  onChanged,
}) {
  const { t } = useTranslation();
  const fileInputRef = useRef(null);
  const visualInputRef = useRef(null);
  const triggerRef = useRef(null);
  const promptCacheRef = useRef({});
  const defaultScope = profile?.profileType === "book" ? "book" : "workspace";
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState("list");
  const [saving, setSaving] = useState(false);
  const [visualSaving, setVisualSaving] = useState(false);
  const [supplements, setSupplements] = useState(summary?.supplements || []);
  const [toolManifest, setToolManifest] = useState(null);
  const [structureError, setStructureError] = useState("");
  const [draft, setDraft] = useState({
    title: "",
    text: "",
    structureJsonText: "",
    documentId: "",
    scopeType: defaultScope,
    supplementKind: "reading_guide",
    allowDowngrade: false,
  });

  useEffect(() => {
    setSupplements(summary?.supplements || []);
  }, [summary]);

  useEffect(() => {
    promptCacheRef.current = {};
  }, [workspace?.slug]);

  useEffect(() => {
    setDraft((prev) => ({
      ...prev,
      scopeType: prev.scopeType || defaultScope,
    }));
  }, [defaultScope]);

  const closeModal = useCallback(() => {
    setOpen(false);
    setStructureError("");
    window.setTimeout(() => triggerRef.current?.focus?.(), 0);
  }, []);

  useEffect(() => {
    if (!open) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event) => {
      if (event.key === "Escape") closeModal();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [closeModal, open]);

  const refreshList = useCallback(async () => {
    if (!workspace?.slug) return;
    const [result, manifestResult] = await Promise.all([
      WorkspaceOverviewModel.listWorkspaceSupplements(workspace.slug),
      WorkspaceOverviewModel.workspaceSupplementToolManifestPreview(
        workspace.slug
      ),
    ]);
    if (result?.success) setSupplements(result.supplements || []);
    if (manifestResult?.success)
      setToolManifest(manifestResult.manifest || null);
  }, [workspace?.slug]);

  useEffect(() => {
    if (!workspace?.slug) return;
    WorkspaceOverviewModel.workspaceSupplementToolManifestPreview(
      workspace.slug
    ).then((result) => {
      if (result?.success) setToolManifest(result.manifest || null);
    });
  }, [summary?.count, workspace?.slug]);

  const openModal = async (nextMode, event) => {
    triggerRef.current = event?.currentTarget || document.activeElement;
    setStructureError("");
    setMode(nextMode);
    setOpen(true);
    if (nextMode === "list") await refreshList();
  };

  const copyPrompt = async () => {
    const kind = draft.supplementKind || "reading_guide";
    const cacheKey = `${workspace?.slug || "workspace"}:${kind}`;
    let cached = promptCacheRef.current[cacheKey];
    if (!cached) {
      const result = await WorkspaceOverviewModel.workspaceSupplementPrompt(
        workspace.slug,
        { supplementKind: kind }
      );
      if (!result?.success || !result.prompt) {
        showToast("复制 Prompt 失败，请稍后重试。", "error");
        return;
      }
      cached = {
        prompt: result.prompt,
        label: result.supplementKindLabel || supplementKindLabel(kind),
      };
      promptCacheRef.current[cacheKey] = cached;
    }
    await navigator.clipboard?.writeText(cached.prompt);
    showToast(`已复制${cached.label} Prompt`, "success");
  };

  const uploadFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !workspace?.slug) return;
    setSaving(true);
    const formData = new FormData();
    formData.append("file", file, file.name);
    formData.append("scopeType", draft.scopeType || defaultScope);
    formData.append("supplementKind", draft.supplementKind || "other");
    const result = await WorkspaceOverviewModel.uploadWorkspaceSupplement(
      workspace.slug,
      formData
    );
    setSaving(false);
    if (!result?.success) {
      showToast(
        result?.message || result?.error || "全书补充上传失败。",
        "error"
      );
      return;
    }
    showToast("已添加全书补充。", "success");
    await refreshList();
    await onChanged?.();
  };

  const uploadWorkspaceBackground = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !workspace?.slug) return;

    const validation = await validateHeroBackgroundFile(file);
    if (!validation.ok) {
      showToast("这张背景图不建议上传", "warning", {
        description: validation.reason,
        duration: 5_800,
      });
      return;
    }

    setVisualSaving(true);
    const formData = new FormData();
    formData.append("file", file, file.name);
    formData.append("scopeType", "workspace");
    formData.append("role", "hero_background");
    const result = await WorkspaceOverviewModel.uploadVisualAsset(
      workspace.slug,
      formData
    );
    setVisualSaving(false);
    if (!result?.success) {
      showToast(result?.error || "工作区背景图上传失败。", "error");
      return;
    }
    showToast("已更新工作区背景图。", "success");
    await onChanged?.(result.asset);
  };

  const openWorkspaceBackgroundPicker = () => {
    showToast("上传工作区背景图", "info", {
      description: HERO_BACKGROUND_RECOMMENDATION,
      duration: 5_000,
      toastId: "workspace-hero-background-upload-guidance",
    });
    visualInputRef.current?.click();
  };

  const removeWorkspaceBackground = async () => {
    if (!workspaceBackground?.id || !workspace?.slug) return;
    setVisualSaving(true);
    const result = await WorkspaceOverviewModel.deleteVisualAsset(
      workspace.slug,
      workspaceBackground.id
    );
    setVisualSaving(false);
    if (!result?.success) {
      showToast(result?.error || "移除背景图失败。", "error");
      return;
    }
    showToast("已移除工作区背景图。", "success");
    await onChanged?.();
  };

  const saveText = async () => {
    const isStructure = draft.supplementKind === "structure_json";
    const structureText =
      isStructure && draft.structureJsonText.trim()
        ? `${draft.text.trim() || "## 结构说明"}\n\n\`\`\`json\n${draft.structureJsonText.trim()}\n\`\`\``
        : draft.text;
    if (!String(structureText || "").trim()) {
      showToast("请先输入全书补充文本。", "error");
      return;
    }
    setSaving(true);
    setStructureError("");
    const result = await WorkspaceOverviewModel.createWorkspaceSupplementText(
      workspace.slug,
      {
        title: draft.title || "全书补充资料",
        text: structureText,
        scopeType: draft.scopeType || defaultScope,
        supplementKind: draft.supplementKind,
        allowDowngrade: isStructure && draft.allowDowngrade,
      }
    );
    setSaving(false);
    if (!result?.success) {
      if (
        draft.supplementKind === "structure_json" &&
        result?.error === "invalid_structure_json"
      ) {
        setStructureError(
          result?.message || "JSON 校验失败，可修改内容后重试。"
        );
      }
      showToast(
        result?.message || "全书补充保存失败，请检查内容后重试。",
        "error"
      );
      return;
    }
    showToast("已保存全书补充。", "success");
    setDraft((prev) => ({
      ...prev,
      title: "",
      text: "",
      structureJsonText: "",
      allowDowngrade: false,
    }));
    await refreshList();
    await onChanged?.();
  };

  const bindDocument = async () => {
    if (!draft.documentId.trim()) {
      showToast("请输入已有文档的 docId。", "error");
      return;
    }
    setSaving(true);
    const result = await WorkspaceOverviewModel.bindWorkspaceSupplement(
      workspace.slug,
      {
        documentId: draft.documentId.trim(),
        scopeType: draft.scopeType || defaultScope,
        supplementKind: draft.supplementKind,
        allowDowngrade: draft.allowDowngrade,
      }
    );
    setSaving(false);
    if (!result?.success) {
      showToast(
        result?.message || result?.error || "绑定已有文档失败。",
        "error"
      );
      return;
    }
    showToast("已绑定为全书补充。", "success");
    setDraft((prev) => ({ ...prev, documentId: "" }));
    await refreshList();
    await onChanged?.();
  };

  const removeSupplement = async (supplement) => {
    const result = await WorkspaceOverviewModel.deleteWorkspaceSupplement(
      workspace.slug,
      supplement.id
    );
    if (!result?.success) {
      showToast(result?.error || "解除绑定失败。", "error");
      return;
    }
    setSupplements((prev) => prev.filter((item) => item.id !== supplement.id));
    showToast("已解除全书补充绑定，原文档仍保留在知识库。", "success");
    await onChanged?.();
  };

  return (
    <section className="overview-glass-card mt-5 rounded-[24px] p-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-[color:var(--overview-text-primary)]">
            <FileText
              size={18}
              className="text-[color:var(--overview-accent)]"
            />
            全书补充
          </div>
          <p className="mt-1 text-xs text-[color:var(--overview-text-secondary)]">
            已添加 {summary?.count || 0} 份，用于画像、书籍结构、路径和推荐。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={uploadFile}
          />
          <input
            ref={visualInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={uploadWorkspaceBackground}
          />
          <button
            type="button"
            disabled={saving}
            onClick={() => fileInputRef.current?.click()}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            上传
          </button>
          <button
            type="button"
            disabled={visualSaving}
            onClick={openWorkspaceBackgroundPicker}
            className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-2 text-xs font-semibold text-cyan-800 hover:bg-cyan-100 disabled:opacity-60"
          >
            <UploadSimple size={13} />
            上传工作区背景图
          </button>
          {workspaceBackground?.id && (
            <button
              type="button"
              disabled={visualSaving}
              onClick={removeWorkspaceBackground}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-60"
            >
              <Trash size={13} />
              移除背景图
            </button>
          )}
          <button
            type="button"
            onClick={(event) => openModal("text", event)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            输入文本
          </button>
          <button
            type="button"
            onClick={(event) => openModal("bind", event)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            绑定已有文档
          </button>
          <button
            type="button"
            onClick={(event) => openModal("list", event)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            查看全部
          </button>
        </div>
      </div>
      <SupplementToolPreview manifest={toolManifest} t={t} />
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/40 p-3 md:p-6"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeModal();
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label={
                mode === "text"
                  ? "输入全书补充文本"
                  : mode === "bind"
                    ? "绑定已有文档"
                    : "全部全书补充"
              }
              className="flex max-h-[calc(100dvh-24px)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
                <div className="font-semibold text-slate-900">
                  {mode === "text"
                    ? "输入全书补充文本"
                    : mode === "bind"
                      ? "绑定已有文档"
                      : "全部全书补充"}
                </div>
                <button
                  type="button"
                  onClick={closeModal}
                  className="rounded-lg p-1 text-slate-500 hover:bg-slate-100"
                  aria-label="关闭弹窗"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {mode !== "list" && (
                  <SupplementControls
                    draft={draft}
                    setDraft={setDraft}
                    onCopyPrompt={copyPrompt}
                    structureError={structureError}
                  />
                )}
                {mode === "text" && (
                  <div className="flex min-h-[48vh] flex-col gap-3">
                    <input
                      value={draft.title}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          title: event.target.value,
                        }))
                      }
                      placeholder="标题，例如：西方哲学史阅读导引"
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    />
                    {draft.supplementKind === "structure_json" ? (
                      <div className="grid min-h-[300px] flex-1 gap-3 lg:grid-cols-2">
                        <label className="flex min-h-0 flex-col gap-2">
                          <span className="text-xs font-semibold text-slate-600">
                            Markdown 说明
                          </span>
                          <textarea
                            value={draft.text}
                            onChange={(event) =>
                              setDraft((prev) => ({
                                ...prev,
                                text: event.target.value,
                              }))
                            }
                            placeholder="写这份结构说明的用途、阅读方式、主线判断依据。这里不需要粘贴 JSON。"
                            className="min-h-[260px] flex-1 resize-none overflow-y-auto rounded-xl border border-slate-200 p-3 text-sm leading-6 focus:border-blue-500 focus:outline-none"
                          />
                        </label>
                        <label className="flex min-h-0 flex-col gap-2">
                          <span className="text-xs font-semibold text-slate-600">
                            结构 JSON
                          </span>
                          <textarea
                            value={draft.structureJsonText}
                            onChange={(event) =>
                              setDraft((prev) => ({
                                ...prev,
                                structureJsonText: event.target.value,
                              }))
                            }
                            placeholder={`只粘贴 JSON 对象，例如：\n{\n  "资料类型": "书籍",\n  "主轴": "哲学家",\n  "次轴": ["概念", "学派"]\n}`}
                            className="min-h-[260px] flex-1 resize-none overflow-y-auto rounded-xl border border-slate-200 bg-slate-950 p-3 font-mono text-xs leading-5 text-slate-50 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none"
                          />
                        </label>
                      </div>
                    ) : (
                      <textarea
                        value={draft.text}
                        onChange={(event) =>
                          setDraft((prev) => ({
                            ...prev,
                            text: event.target.value,
                          }))
                        }
                        placeholder="粘贴中文 Markdown。"
                        className="min-h-[240px] flex-1 resize-none overflow-y-auto rounded-xl border border-slate-200 p-3 text-sm leading-6 focus:border-blue-500 focus:outline-none"
                      />
                    )}
                  </div>
                )}
                {mode === "bind" && (
                  <div className="space-y-3">
                    <input
                      value={draft.documentId}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          documentId: event.target.value,
                        }))
                      }
                      placeholder="已有文档 ID"
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    />
                  </div>
                )}
                {mode === "list" && (
                  <div className="space-y-2">
                    {supplements.length === 0 ? (
                      <p className="text-sm text-slate-500">暂无全书补充。</p>
                    ) : (
                      supplements.map((supplement) => (
                        <div
                          key={supplement.id}
                          className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-slate-800">
                              {supplement.documentName || supplement.documentId}
                            </div>
                            <div className="text-xs text-slate-500">
                              {`${supplementKindLabel(
                                supplement.supplementKind
                              )} · ${scopeTypeLabel(supplement.scopeType)}`}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeSupplement(supplement)}
                            className="shrink-0 rounded-lg px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                          >
                            解除绑定
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
              <div className="sticky bottom-0 flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-slate-100 bg-white px-5 py-4">
                <button
                  type="button"
                  onClick={closeModal}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
                >
                  取消
                </button>
                {mode === "text" && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={saveText}
                    className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-blue-600/20 transition hover:from-blue-700 hover:to-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Sparkle size={14} weight="fill" />
                    保存为{scopeTypeLabel(draft.scopeType)}
                  </button>
                )}
                {mode === "bind" && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={bindDocument}
                    className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-blue-600/20 transition hover:from-blue-700 hover:to-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Sparkle size={14} weight="fill" />
                    保存为{scopeTypeLabel(draft.scopeType)}
                  </button>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}
    </section>
  );
}

function SupplementControls({
  draft,
  setDraft,
  onCopyPrompt,
  structureError = "",
}) {
  const isStructure = draft.supplementKind === "structure_json";
  return (
    <div className="mb-3 space-y-3">
      <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
        <label className="space-y-1 text-xs font-medium text-slate-600">
          <span>补充范围</span>
          <select
            value={draft.scopeType}
            onChange={(event) =>
              setDraft((prev) => ({ ...prev, scopeType: event.target.value }))
            }
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs"
          >
            <option value="book">全书补充</option>
            <option value="workspace">工作区补充</option>
          </select>
        </label>
        <label className="space-y-1 text-xs font-medium text-slate-600">
          <span>当前补充类型</span>
          <select
            value={draft.supplementKind}
            onChange={(event) =>
              setDraft((prev) => ({
                ...prev,
                supplementKind: event.target.value,
                allowDowngrade: false,
              }))
            }
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs"
          >
            {workspaceSupplementKinds.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={onCopyPrompt}
          className="self-end rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-100"
        >
          复制当前类型 Prompt
        </button>
      </div>
      {!isStructure && (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
          该类型不会参与强结构判断。
        </p>
      )}
      {isStructure && structureError && (
        <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <p>JSON 校验失败，可修改内容后重试。</p>
          <p>{structureError}</p>
          <label className="flex items-center gap-2 font-medium">
            <input
              type="checkbox"
              checked={draft.allowDowngrade}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  allowDowngrade: event.target.checked,
                }))
              }
            />
            降级保存为阅读导引
          </label>
        </div>
      )}
      {isStructure && !structureError && (
        <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700">
          结构说明会参与画像、书籍结构、主轴次轴和节点解析标准判断，请粘贴包含中文
          JSON 代码块的 Markdown。
        </p>
      )}
    </div>
  );
}

function scopeTypeLabel(scopeType) {
  if (scopeType === "book") return "全书补充";
  return "工作区补充";
}

function supplementKindLabel(kind) {
  return (
    Object.fromEntries(workspaceSupplementKinds)[kind] || kind || "未知类型"
  );
}

function SupplementToolPreview({ manifest, t }) {
  const standardKinds = manifest?.standardKinds || [];
  const customDocuments = manifest?.customDocuments || [];
  const hasSupplements = standardKinds.length > 0 || customDocuments.length > 0;

  return (
    <div className="mt-4 rounded-2xl border border-slate-200/80 bg-white/70 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold text-slate-700">
            {t("workspaceSupplement.tool.title")}
          </div>
          <p className="mt-1 text-[11px] leading-5 text-slate-500">
            {t("workspaceSupplement.tool.description")}
          </p>
        </div>
        {!hasSupplements && (
          <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] text-slate-500">
            {t("workspaceSupplement.tool.noAvailableSupplements")}
          </span>
        )}
      </div>
      {hasSupplements && (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {t("workspaceSupplement.tool.availableKinds")}
            </div>
            {standardKinds.length ? (
              <div className="flex flex-wrap gap-2">
                {standardKinds.map((item) => (
                  <span
                    key={item.kind}
                    className="rounded-full border border-blue-100 bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-700"
                    title={t(item.descriptionKey)}
                  >
                    {t(item.labelKey)} · {item.count}
                    {item.kind === "structure_json" &&
                      ` · ${
                        item.structureJsonValid
                          ? t("workspaceSupplement.structureJsonValid")
                          : t("workspaceSupplement.structureJsonInvalid")
                      }`}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-slate-400">
                {t("workspaceSupplement.tool.noAvailableSupplements")}
              </p>
            )}
          </div>
          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {t("workspaceSupplement.tool.customDocuments")}
            </div>
            {customDocuments.length ? (
              <div className="flex flex-wrap gap-2">
                {customDocuments.map((item) => (
                  <span
                    key={item.supplementId}
                    className="max-w-full truncate rounded-full border border-emerald-100 bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700"
                    title={`${item.title} · ${t(
                      "workspaceSupplement.usagePreview"
                    )}: ${item.contentPreview || ""}`}
                  >
                    {item.title}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-slate-400">
                {t("workspaceSupplement.tool.noAvailableSupplements")}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function KnowledgeProfilePanel({
  profile,
  bookStructure,
  engine,
  draft,
  setDraft,
  onRefresh,
  onSave,
}) {
  const profileLabel = profileTypeLabel(profile?.profileType);
  const structureLabel = bookStructureTypeLabel(bookStructure?.structureType);
  const axes = [
    bookStructure?.primaryAxis,
    ...(bookStructure?.secondaryAxes || []),
  ].filter(Boolean);

  return (
    <section className="overview-glass-card mt-5 rounded-[24px] p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-[color:var(--overview-text-primary)]">
            <Compass
              size={18}
              className="text-[color:var(--overview-accent)]"
            />
            工作区知识画像
            {profile?.manualOverride && (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
                手动覆盖
              </span>
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-[color:var(--overview-text-secondary)]">
            <span className="overview-glass-pill px-2 py-1">
              画像：{profileLabel}
            </span>
            {bookStructure && (
              <span className="overview-glass-pill px-2 py-1">
                书籍结构：{structureLabel}
              </span>
            )}
            {!!axes.length && (
              <span className="overview-glass-chip px-2 py-1">
                主轴/次轴：{axes.join(" / ")}
              </span>
            )}
            <span className="overview-glass-pill px-2 py-1">
              推荐来源：
              {engine?.primary === "knowledge_engine"
                ? "知识引擎"
                : "旧逻辑兜底"}
            </span>
            <span className="overview-glass-pill px-2 py-1">
              上次分析：{formatTime(profile?.lastAnalyzedAt)}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            onClick={onRefresh}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            手动刷新
          </button>
          <button
            type="button"
            onClick={() =>
              setDraft((prev) => ({
                ...prev,
                open: !prev.open,
                userDescription:
                  prev.userDescription || profile?.userDescription || "",
                profileType: prev.profileType || profile?.profileType || "",
                bookStructureType:
                  prev.bookStructureType || bookStructure?.structureType || "",
                primaryAxis:
                  prev.primaryAxis || bookStructure?.primaryAxis || "",
                secondaryAxes:
                  prev.secondaryAxes ||
                  (bookStructure?.secondaryAxes || []).join(", "),
              }))
            }
            className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-100"
          >
            高级修正
          </button>
        </div>
      </div>
      {draft.open && (
        <div className="mt-4 grid gap-3 border-t border-slate-100 pt-4 lg:grid-cols-2">
          <textarea
            value={draft.userDescription}
            onChange={(event) =>
              setDraft((prev) => ({
                ...prev,
                userDescription: event.target.value,
              }))
            }
            rows={8}
            placeholder={[
              "资料类型：书籍 / 课程 / 研究资料 / 项目资料 / 零散笔记 / 混合资料",
              "主文档：哪一个文档是核心文本，或说明没有主文档",
              "主题范围：这批资料主要讨论什么，也请说明不讨论什么",
              "组织方式：按人物、概念、时间、问题、方法、章节、论证，还是混合",
              "学习目标、重要对象、推荐偏好、禁止误判、语言偏好",
            ].join("\n")}
            className="min-h-[180px] rounded-xl border border-slate-200 bg-white p-3 text-xs leading-5 text-slate-700 outline-none focus:border-blue-300"
          />
          <div className="space-y-3">
            <select
              value={draft.profileType}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  profileType: event.target.value,
                }))
              }
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700"
            >
              <option value="">自动判断画像类型</option>
              {[
                "book",
                "course",
                "research",
                "project",
                "loose_notes",
                "mixed",
              ].map((type) => (
                <option key={type} value={type}>
                  {profileTypeLabel(type)}
                </option>
              ))}
            </select>
            <select
              value={draft.bookStructureType}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  bookStructureType: event.target.value,
                }))
              }
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700"
            >
              <option value="">自动判断书籍结构</option>
              {[
                "person_driven",
                "concept_driven",
                "chronology_driven",
                "problem_driven",
                "method_driven",
                "chapter_driven",
                "argument_driven",
                "mixed_structure",
              ].map((type) => (
                <option key={type} value={type}>
                  {bookStructureTypeLabel(type)}
                </option>
              ))}
            </select>
            <input
              value={draft.primaryAxis}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  primaryAxis: event.target.value,
                }))
              }
              placeholder="主轴，例如：概念 / 时间线 / 方法 / 论证"
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700"
            />
            <input
              value={draft.secondaryAxes}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  secondaryAxes: event.target.value,
                }))
              }
              placeholder="次轴，用逗号分隔，例如：问题, 章节, 对比"
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={draft.saving}
                onClick={() =>
                  onSave({
                    userDescription: draft.userDescription,
                    profileType: draft.profileType || undefined,
                    bookStructureType: draft.bookStructureType || undefined,
                    primaryAxis: draft.primaryAxis || undefined,
                    secondaryAxes: draft.secondaryAxes
                      ? draft.secondaryAxes
                          .split(/[,，]/)
                          .map((item) => item.trim())
                          .filter(Boolean)
                      : undefined,
                    overrideReason: "用户在工作区首页高级入口修正",
                  })
                }
                className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
              >
                保存并刷新
              </button>
              <button
                type="button"
                disabled={draft.saving}
                onClick={() =>
                  onSave({
                    refresh: true,
                    userDescription: draft.userDescription,
                  })
                }
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                恢复自动判断
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function profileTypeLabel(type) {
  return (
    {
      book: "书籍",
      course: "课程",
      research: "研究",
      project: "项目",
      loose_notes: "零散笔记",
      mixed: "混合资料",
    }[type] || "未分析"
  );
}

function bookStructureTypeLabel(type) {
  return (
    {
      person_driven: "人物驱动",
      concept_driven: "概念驱动",
      chronology_driven: "时间驱动",
      problem_driven: "问题驱动",
      method_driven: "方法驱动",
      chapter_driven: "章节驱动",
      argument_driven: "论证驱动",
      mixed_structure: "混合结构",
    }[type] || "未分析"
  );
}

function RecommendationCard({
  recommendation,
  isVisible = true,
  onImpression,
  onActivate,
  onDismiss,
  actionLabel = "打开",
}) {
  const ref = useRef(null);
  const cardType =
    recommendation.cardType ||
    (recommendation.target?.targetType === "document"
      ? "document"
      : recommendation.type === "organize_cluster"
        ? "cluster"
        : "node");
  const lowValueReasons = new Set([
    "你最近查看过这个概念，但还可以继续展开相关关系或证据。",
    "它还有可继续探索的关联节点。",
    "你最近查看过这个概念或相关证据。",
    "该路径由知识图谱结构解析产生，不依赖旧首页的零散活动信号。",
    "适合按当前工作区主导脉络继续推进。",
  ]);
  const fallbackReasons = (recommendation.reasonZh || []).filter(
    (reason) => reason && !lowValueReasons.has(reason)
  );
  const sourceTargetLine =
    recommendation.sourceNodeLabel && recommendation.targetNodeLabel
      ? `关键关联：${[
          recommendation.sourceNodeLabel,
          recommendation.targetNodeLabel,
        ].join(" / ")}`
      : "";
  const cardLabel =
    cardType === "relation"
      ? recommendation.relationTypeLabel || "关键关联"
      : cardType === "path"
        ? "路径"
        : cardType === "document"
          ? "文档"
          : cardType === "cluster"
            ? "主题簇"
            : recommendation.nodeTypeLabel;
  const title =
    recommendation.relationTitle ||
    (cardType === "path" && recommendation.pathSummary
      ? `继续路径：${recommendation.pathSummary}`
      : recommendation.title);
  const primaryText =
    cardType === "relation" || cardType === "path"
      ? recommendation.relationSummary || fallbackReasons[0] || ""
      : recommendation.nodeSummary || fallbackReasons[0] || "";
  const supportLines =
    cardType === "relation"
      ? [sourceTargetLine, recommendation.nextAction].filter(Boolean)
      : cardType === "path"
        ? [
            recommendation.pathSummary
              ? `路径：${recommendation.pathSummary}`
              : "",
            recommendation.nextAction,
          ].filter(Boolean)
        : [
            recommendation.mainlinePath,
            recommendation.whyRecommended || fallbackReasons[1],
            recommendation.nextAction,
          ].filter(Boolean);
  const stats = [
    recommendation.evidenceCount > 0
      ? `证据 ${recommendation.evidenceCount} 条`
      : null,
    (cardType === "relation" || cardType === "path") &&
    recommendation.relatedNodeCount > 0
      ? `相关节点 ${recommendation.relatedNodeCount} 个`
      : null,
    cardType !== "relation" &&
    cardType !== "path" &&
    recommendation.relationCount > 0
      ? `关系 ${recommendation.relationCount} 个`
      : null,
    recommendation.supplementCount > 0 ||
    recommendation.target?.supplementCount > 0
      ? `补充 ${
          recommendation.supplementCount ||
          recommendation.target?.supplementCount
        } 份`
      : null,
  ].filter(Boolean);
  const buttonLabel =
    cardType === "relation"
      ? "打开关系"
      : cardType === "path"
        ? "查看路径"
        : actionLabel;

  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && isVisible)
          onImpression?.(recommendation, "impression");
      },
      { threshold: 0.5 }
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [isVisible, onImpression, recommendation]);

  return (
    <article
      ref={ref}
      className="overview-glass-card group relative flex h-full min-h-[248px] flex-col rounded-[22px] p-5 motion-hover hover:-translate-y-0.5"
    >
      {onDismiss && (
        <button
          type="button"
          onClick={() => onDismiss(recommendation)}
          className="absolute right-3 top-3 rounded-md p-1 text-[color:var(--overview-text-secondary)] hover:bg-[color:var(--overview-glass-bg-strong)] hover:text-[color:var(--overview-text-primary)]"
          aria-label="隐藏该推荐"
        >
          <X size={14} />
        </button>
      )}
      <div className="min-h-0 flex-1">
        <div className="flex items-center gap-2 text-xs text-[color:var(--overview-accent)]">
          <Brain size={15} />
          推荐分 {recommendation.score}
          {cardLabel && (
            <span className="overview-glass-pill px-1.5 py-0.5 text-[10px]">
              {cardLabel}
            </span>
          )}
          {!cardLabel && recommendation.target?.hasSupplement && (
            <span className="overview-glass-pill px-1.5 py-0.5 text-[10px]">
              补充 {recommendation.target.supplementCount || 0}
            </span>
          )}
        </div>
        <h3 className="mt-3 line-clamp-2 pr-6 text-sm font-semibold leading-5 text-[color:var(--overview-text-primary)]">
          {title}
        </h3>
        {primaryText && (
          <p className="mt-3 line-clamp-2 text-xs leading-5 text-[color:var(--overview-text-secondary)]">
            {primaryText}
          </p>
        )}
        {supportLines.length > 0 && (
          <div className="mt-2 space-y-1">
            {supportLines.slice(0, 3).map((line, index) => (
              <p
                key={`${line}-${index}`}
                className="line-clamp-1 text-[11px] leading-5 text-[color:var(--overview-text-secondary)]"
              >
                {line}
              </p>
            ))}
          </div>
        )}
        {stats.length > 0 && (
          <div className="mt-3 line-clamp-1 text-[11px] font-medium text-[color:var(--overview-text-secondary)]">
            {stats.join(" · ")}
          </div>
        )}
      </div>
      <div className="mt-auto flex justify-center pt-3">
        <AppButton
          type="button"
          onClick={() => onActivate?.(recommendation)}
          size="sm"
          className="overview-card-primary-action"
          rightIcon={<ArrowRight weight="bold" />}
        >
          {buttonLabel}
        </AppButton>
      </div>
    </article>
  );
}

function SmallInsight({ item, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="overview-glass-card rounded-[20px] p-4 text-left hover:-translate-y-0.5"
    >
      <div className="text-xs text-[color:var(--overview-text-secondary)]">
        可信度 {item.confidence}
      </div>
      <div className="mt-1 text-sm font-semibold text-[color:var(--overview-text-primary)]">
        {item.title}
      </div>
      <p className="mt-2 line-clamp-2 text-xs leading-5 text-[color:var(--overview-text-secondary)]">
        {item.reasonZh?.[0] || "来自真实图谱信号。"}
      </p>
    </button>
  );
}

function StatsPanel({ overview }) {
  const summary = overview?.todaySummary || {};
  return (
    <section className="overview-glass-card rounded-[24px] p-5">
      <div className="flex items-center gap-2 font-semibold text-[color:var(--overview-text-primary)]">
        <Lightning size={18} className="text-[color:var(--overview-accent)]" />
        今日知识变化
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        <Metric label="证据" value={summary.evidenceAddedToday || 0} />
        <Metric label="关系" value={summary.relationsAddedToday || 0} />
        <Metric label="文档" value={summary.documentsUpdatedToday || 0} />
      </div>
      <div className="mt-4 space-y-2">
        {(summary.recentDocuments || []).slice(0, 4).map((doc) => (
          <div
            key={doc.docId}
            className="flex items-start gap-2 text-xs text-[color:var(--overview-text-secondary)]"
          >
            <FileText
              size={14}
              className="mt-0.5 text-[color:var(--overview-accent)]"
            />
            <span className="line-clamp-2">{doc.filename || doc.docpath}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Metric({ label, value }) {
  return (
    <div className="overview-glass-metric p-3 text-center">
      <div className="text-lg font-semibold text-[color:var(--overview-text-primary)]">
        {value}
      </div>
      <div className="text-xs text-[color:var(--overview-text-secondary)]">
        {label}
      </div>
    </div>
  );
}

function ActivityPanel({ activities }) {
  return (
    <section className="overview-glass-card rounded-[24px] p-5">
      <div className="flex items-center gap-2 font-semibold text-[color:var(--overview-text-primary)]">
        <Graph size={18} className="text-[color:var(--overview-accent)]" />
        最近变化
      </div>
      <div className="mt-4 space-y-3">
        {activities.slice(0, 6).map((activity, index) => (
          <div
            key={`${activity.type}-${index}`}
            className="border-l-2 border-[color:var(--overview-accent)] pl-3"
          >
            <div className="text-sm font-medium text-[color:var(--overview-text-primary)]">
              {activity.title}
            </div>
            <div className="text-xs leading-5 text-[color:var(--overview-text-secondary)]">
              {activity.detail}
            </div>
            <div className="text-[11px] text-[color:var(--overview-text-secondary)]">
              {formatTime(activity.createdAt)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function DebugPanel({ debug }) {
  if (!debug || import.meta.env.PROD) return null;
  return (
    <details className="overview-glass-card min-w-0 overflow-hidden rounded-[24px] p-5">
      <summary className="cursor-pointer text-sm font-semibold text-[color:var(--overview-text-primary)]">
        推荐调试信息
      </summary>
      <pre className="mt-3 block max-h-56 w-full max-w-full overflow-auto whitespace-pre rounded-lg bg-slate-950 p-3 text-[11px] leading-5 text-slate-100">
        {JSON.stringify(debug, null, 2)}
      </pre>
    </details>
  );
}
