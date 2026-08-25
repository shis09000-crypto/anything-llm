import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSoftSettingsShell } from "@/components/SoftSettings/context";
import { useMotion } from "@/contexts/MotionProvider";
import { cryptoHubFetch } from "@/hooks/cryptoHub/useCryptoHubQuery";
import { useCryptoDashboard } from "@/hooks/cryptoHub/useCryptoDashboard";
import { requestPriorityQueue } from "@/utils/chat/requestPriorityQueue";
import { tabletDesktopRuntimeActive } from "@/utils/mobileRuntime";
import CryptoTotalAssetCard from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/CryptoTotalAssetCard";
import {
  presetById,
  tradingPairMockPresets,
} from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/tradingPairMockPresets";
import { useTradingPairCandlestickData } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/useTradingPairCandlestickData";
import { useAssetAllocationDonutData } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/useAssetAllocationDonutData";
import { useTradingPairDetailData } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/useTradingPairDetailData";
import { assetAllocationDonutDefaultVisual } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/assetAllocationDonutVisual";
import type { AssetAllocationDonutCardProps } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/assetAllocationDonutTypes";
import type {
  CryptoTotalAssetCardProps,
  CryptoTrendPoint,
} from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/cryptoTotalAssetTypes";
import type { TradingPairCandlestickRange } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/tradingPairCandlestickTypes";
import type {
  TradingPairDetailCardProps,
  TradingPairDetailResponse,
  TradingPairMarketType,
  TradingPairPreset,
} from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/tradingPairDetailTypes";
import { markCryptoCenterPerf } from "./perf";
import { cryptoSectionScrollEnabled } from "./sectionScrollRuntime";
import { resolvePrivateConnectionStatus } from "./cryptoPrivateConnectionStatus";
import PortfolioRiskCard from "./PortfolioRiskCard";
import PortfolioAnalyticsCard from "./PortfolioAnalyticsCard";

const AssetAllocationDonutCard = React.lazy(
  () =>
    import(
      "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/AssetAllocationDonutCard"
    )
);
const TradingPairDetailCard = React.lazy(
  () =>
    import(
      "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/TradingPairDetailCard"
    )
);
const TradingPairCandlestickChart = React.lazy(
  () =>
    import(
      "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/TradingPairCandlestickChart"
    )
);
const FuturesTradingSection = React.lazy(
  () => import("./FuturesTradingSection")
);

const CRYPTO_CENTER_BACKGROUND_URL =
  "/crypto-center-backgrounds/crypto-center-background.png";
const FALLBACK_YESTERDAY_BASELINE_USD = 51685.38;
const BTC_PAIR = "BTC_USDT";
const BTC_MARKET = "spot";
const btcPreset = presetById(BTC_PAIR);
const ETH_PAIR = "ETH_USDT";
const ETH_MARKET = "spot";
const ETH_CHART_BACKGROUND_URL = "/crypto-chart-backgrounds/eth-background.png";
const ethPreset = presetById(ETH_PAIR);
const BTC_SPOT_DETAIL_CARD_WIDTH = 480;
const BTC_SPOT_CARD_HEIGHT = 560;
const BTC_SPOT_CHART_MAX_WIDTH = 720;
const BTC_SPOT_CONTENT_MAX_WIDTH = 1224;
const HERO_TOTAL_ASSET_CARD_WIDTH = 640;
const HERO_ASSET_ALLOCATION_CARD_WIDTH = 560;
const HERO_PORTFOLIO_CARD_HEIGHT = 380;
const TOP_SPOT_ASSET_LIMIT = 6;
const TOP_SPOT_EXCLUDED_ASSETS = ["BTC", "ETH", "USDT", "GUSD"];
const TOP_SPOT_CARD_HEIGHT = 560;
const TOP_SPOT_CARD_GAP = 24;
const TOP_SPOT_REORDER_DURATION_MS = 360;
const TOP_SPOT_MIN_TWO_COLUMN_WIDTH = 760;
const OPEN_FUTURES_POSITIONS_CARD_HEIGHT = 645;
const OPEN_FUTURES_VISIBLE_POSITION_COUNT = 6;
const TRADE_RECORDS_CARD_HEIGHT = 680;
const CRYPTO_VISIBLE_BACKGROUND_REFRESH_MS = 30_000;
const CRYPTO_HIDDEN_BACKGROUND_REFRESH_MS = 120_000;
const EQUITY_HISTORY_REFRESH_MS = CRYPTO_VISIBLE_BACKGROUND_REFRESH_MS;
function cryptoBackgroundRefreshDelay() {
  return document.visibilityState === "hidden"
    ? CRYPTO_HIDDEN_BACKGROUND_REFRESH_MS
    : CRYPTO_VISIBLE_BACKGROUND_REFRESH_MS;
}

const SECTION_SCROLL_TUNING = {
  minWidth: 900,
  tabletMinWidth: 768,
  boundaryPx: 24,
  gatePreviewPx: 24,
  minDeltaPx: 4,
  lineDeltaPx: 16,
  inertiaShield: {
    absorbMs: 140,
    rearmGapMs: 70,
    minIntentDeltaPx: 10,
    activePullDeltaPx: 28,
    activePullDistancePx: 40,
  },
  pullEase: {
    thresholdRatio: 0.26,
    minThresholdPx: 260,
    maxThresholdPx: 400,
    upFactor: 0.75,
    maxDeltaPx: 80,
  },
  visual: {
    gateBumpProgress: 0.08,
    idleResetMs: 220,
    maxPullPx: 36,
    settleMs: 260,
    releaseDelayMs: 120,
    snapDurationMs: 820,
    minScale: 0.982,
    minOpacity: 0.93,
  },
} as const;
const CRYPTO_CENTER_SECTION_IDS = [
  "overview-spot",
  "top-assets",
  "futures-trading",
] as const;

type CryptoCenterSectionId = (typeof CRYPTO_CENTER_SECTION_IDS)[number];
type SectionScrollTuning = {
  minWidth: number;
  tabletMinWidth: number;
  boundaryPx: number;
  gatePreviewPx: number;
  minDeltaPx: number;
  lineDeltaPx: number;
  inertiaShield: {
    absorbMs: number;
    rearmGapMs: number;
    minIntentDeltaPx: number;
    activePullDeltaPx: number;
    activePullDistancePx: number;
  };
  pullEase: {
    thresholdRatio: number;
    minThresholdPx: number;
    maxThresholdPx: number;
    upFactor: number;
    maxDeltaPx: number;
  };
  visual: {
    gateBumpProgress: number;
    idleResetMs: number;
    maxPullPx: number;
    settleMs: number;
    releaseDelayMs: number;
    snapDurationMs: number;
    minScale: number;
    minOpacity: number;
  };
};

type SectionMetric = {
  id: CryptoCenterSectionId;
  node: HTMLElement;
  top: number;
  bottom: number;
};

type BoundaryTransition = {
  direction: 1 | -1;
  currentSectionId: CryptoCenterSectionId;
  currentIndex: number;
  targetIndex: number;
  targetTop: number;
  gateTop: number;
};

type BoundaryScrollIntent = {
  phase: "gate" | "pull";
  direction: 1 | -1;
  sectionId: CryptoCenterSectionId;
  currentIndex: number;
  targetIndex: number;
  targetTop: number;
  lockedScrollTop: number;
  threshold: number;
  virtualPullDistance: number;
  lastEventAt: number;
  gateEnteredAt: number;
  gateUnlockAt: number;
  lastDeltaPx: number;
  postGatePullDistance: number;
};

type SectionScrollOwner = "page" | "gate" | "pull" | "snap";

type SectionPullVisualState = {
  sectionId: CryptoCenterSectionId | null;
  direction: 1 | -1;
  phase: "gate" | "pull";
  progress: number;
  settling: boolean;
  flashing: boolean;
};

type CryptoSectionScrollDebugState = {
  readonly owner: SectionScrollOwner;
  readonly intent: BoundaryScrollIntent | null;
  readonly pullVisual: SectionPullVisualState;
  readonly tuning: SectionScrollTuning;
  reset: () => void;
};

type CryptoSectionScrollDebugWindow = Window & {
  __cryptoSectionScrollDebug?: CryptoSectionScrollDebugState;
};

function isScrollableInDirection(
  node: HTMLElement,
  direction: 1 | -1
): boolean {
  const style = window.getComputedStyle(node);
  if (!/(auto|scroll|overlay)/.test(style.overflowY)) return false;
  if (node.scrollHeight <= node.clientHeight + 2) return false;

  if (direction > 0) {
    return node.scrollTop + node.clientHeight < node.scrollHeight - 2;
  }

  return node.scrollTop > 2;
}

function eventTargetShouldKeepScroll(
  target: EventTarget | null,
  root: HTMLElement,
  direction: 1 | -1
): boolean {
  if (!(target instanceof Element)) return false;

  let current: Element | null = target;
  while (current && current !== root) {
    if (
      current instanceof HTMLElement &&
      isScrollableInDirection(current, direction)
    ) {
      return true;
    }
    current = current.parentElement;
  }

  return false;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function readSectionScrollOverride(
  params: URLSearchParams,
  key: string,
  fallback: number,
  min: number,
  max: number
) {
  if (!params.has(key)) return fallback;
  const value = Number(params.get(key));
  if (!Number.isFinite(value)) return fallback;
  return clampNumber(value, min, max);
}

function createSectionScrollTuning(): SectionScrollTuning {
  const defaults = SECTION_SCROLL_TUNING;
  const baseTuning: SectionScrollTuning = {
    minWidth: defaults.minWidth,
    tabletMinWidth: defaults.tabletMinWidth,
    boundaryPx: defaults.boundaryPx,
    gatePreviewPx: defaults.gatePreviewPx,
    minDeltaPx: defaults.minDeltaPx,
    lineDeltaPx: defaults.lineDeltaPx,
    inertiaShield: { ...defaults.inertiaShield },
    pullEase: { ...defaults.pullEase },
    visual: { ...defaults.visual },
  };

  if (typeof window === "undefined") return baseTuning;

  const params = new URLSearchParams(window.location.search);
  const minThresholdPx = readSectionScrollOverride(
    params,
    "sectionScrollDownMin",
    baseTuning.pullEase.minThresholdPx,
    120,
    640
  );
  const maxThresholdPx = Math.max(
    minThresholdPx,
    readSectionScrollOverride(
      params,
      "sectionScrollDownMax",
      baseTuning.pullEase.maxThresholdPx,
      160,
      760
    )
  );

  return {
    ...baseTuning,
    inertiaShield: {
      ...baseTuning.inertiaShield,
      absorbMs: readSectionScrollOverride(
        params,
        "sectionScrollAbsorb",
        baseTuning.inertiaShield.absorbMs,
        0,
        600
      ),
      rearmGapMs: readSectionScrollOverride(
        params,
        "sectionScrollRearm",
        baseTuning.inertiaShield.rearmGapMs,
        0,
        240
      ),
      minIntentDeltaPx: readSectionScrollOverride(
        params,
        "sectionScrollIntentMin",
        baseTuning.inertiaShield.minIntentDeltaPx,
        0,
        80
      ),
      activePullDeltaPx: readSectionScrollOverride(
        params,
        "sectionScrollActiveDelta",
        baseTuning.inertiaShield.activePullDeltaPx,
        0,
        140
      ),
      activePullDistancePx: readSectionScrollOverride(
        params,
        "sectionScrollActiveDistance",
        baseTuning.inertiaShield.activePullDistancePx,
        0,
        240
      ),
    },
    pullEase: {
      ...baseTuning.pullEase,
      thresholdRatio: readSectionScrollOverride(
        params,
        "sectionScrollRatio",
        baseTuning.pullEase.thresholdRatio,
        0.12,
        0.5
      ),
      minThresholdPx,
      maxThresholdPx,
      maxDeltaPx: readSectionScrollOverride(
        params,
        "sectionScrollMaxDelta",
        baseTuning.pullEase.maxDeltaPx,
        24,
        160
      ),
    },
  };
}

function easeOutQuart(progress: number) {
  return 1 - Math.pow(1 - progress, 4);
}

function normalizeWheelDelta(event: WheelEvent, viewportHeight: number) {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return event.deltaY * SECTION_SCROLL_TUNING.lineDeltaPx;
  }

  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY * viewportHeight;
  }

  return event.deltaY;
}

function useCryptoCenterSectionScroll(
  sectionIds: readonly CryptoCenterSectionId[]
) {
  const { reducedMotion } = useMotion();
  const tuning = useMemo(() => createSectionScrollTuning(), []);
  const debugEnabled = useMemo(() => {
    if (typeof window === "undefined") return false;
    const params = new URLSearchParams(window.location.search);
    return params.has("sectionScrollDebug") || params.has("scrollHandoffSmoke");
  }, []);
  const containerRef = useRef<HTMLElement | null>(null);
  const sectionRefs = useRef(
    new Map<CryptoCenterSectionId, HTMLElement | null>()
  );
  const boundaryIntentRef = useRef<BoundaryScrollIntent | null>(null);
  const scrollOwnerRef = useRef<SectionScrollOwner>("page");
  const animationFrameRef = useRef<number | null>(null);
  const releaseDelayTimerRef = useRef<number | null>(null);
  const idleResetTimerRef = useRef<number | null>(null);
  const pullSettleTimerRef = useRef<number | null>(null);
  const programmaticScrollFrameRef = useRef<number | null>(null);
  const programmaticScrollRef = useRef(false);
  const nativeOverscrollBehaviorYRef = useRef<string | null>(null);
  const nativeOverflowYRef = useRef<string | null>(null);
  const touchYRef = useRef<number | null>(null);
  const [supportsSectionScroll, setSupportsSectionScroll] = useState(false);
  const [pullVisual, setPullVisual] = useState<SectionPullVisualState>({
    sectionId: null,
    direction: 1,
    phase: "pull",
    progress: 0,
    settling: false,
    flashing: false,
  });

  useEffect(() => {
    const desktopWidthQuery = window.matchMedia(
      `(min-width: ${tuning.minWidth}px)`
    );
    const tabletWidthQuery = window.matchMedia(
      `(min-width: ${tuning.tabletMinWidth}px)`
    );
    const pointerQuery = window.matchMedia("(pointer: fine)");
    const update = () =>
      setSupportsSectionScroll(
        cryptoSectionScrollEnabled({
          desktopWidthMatches: desktopWidthQuery.matches,
          tabletWidthMatches: tabletWidthQuery.matches,
          finePointer: pointerQuery.matches,
          tabletDesktop: tabletDesktopRuntimeActive(),
          reducedMotion,
        })
      );

    update();
    desktopWidthQuery.addEventListener?.("change", update);
    tabletWidthQuery.addEventListener?.("change", update);
    pointerQuery.addEventListener?.("change", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      desktopWidthQuery.removeEventListener?.("change", update);
      tabletWidthQuery.removeEventListener?.("change", update);
      pointerQuery.removeEventListener?.("change", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, [reducedMotion, tuning.minWidth, tuning.tabletMinWidth]);

  useEffect(() => {
    return () => {
      if (animationFrameRef.current) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
      if (releaseDelayTimerRef.current) {
        window.clearTimeout(releaseDelayTimerRef.current);
      }
      if (idleResetTimerRef.current) {
        window.clearTimeout(idleResetTimerRef.current);
      }
      if (pullSettleTimerRef.current) {
        window.clearTimeout(pullSettleTimerRef.current);
      }
      if (programmaticScrollFrameRef.current) {
        window.cancelAnimationFrame(programmaticScrollFrameRef.current);
        programmaticScrollFrameRef.current = null;
      }
      programmaticScrollRef.current = false;
      const container = containerRef.current;
      if (container && nativeOverscrollBehaviorYRef.current !== null) {
        container.style.overscrollBehaviorY =
          nativeOverscrollBehaviorYRef.current;
        nativeOverscrollBehaviorYRef.current = null;
      }
      if (container && nativeOverflowYRef.current !== null) {
        container.style.overflowY = nativeOverflowYRef.current;
        nativeOverflowYRef.current = null;
      }
    };
  }, []);

  const enabled = supportsSectionScroll && !reducedMotion;

  const setSectionRef = useCallback(
    (id: CryptoCenterSectionId) => (node: HTMLElement | null) => {
      sectionRefs.current.set(id, node);
    },
    []
  );

  const clearIdleResetTimer = useCallback(() => {
    if (idleResetTimerRef.current) {
      window.clearTimeout(idleResetTimerRef.current);
      idleResetTimerRef.current = null;
    }
  }, []);

  const lockNativeScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    if (nativeOverscrollBehaviorYRef.current === null) {
      nativeOverscrollBehaviorYRef.current =
        container.style.overscrollBehaviorY;
    }
    if (nativeOverflowYRef.current === null) {
      nativeOverflowYRef.current = container.style.overflowY;
    }
    container.style.overscrollBehaviorY = "contain";
    container.style.overflowY = "hidden";
  }, []);

  const unlockNativeScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    if (nativeOverscrollBehaviorYRef.current !== null) {
      container.style.overscrollBehaviorY =
        nativeOverscrollBehaviorYRef.current;
      nativeOverscrollBehaviorYRef.current = null;
    }
    if (nativeOverflowYRef.current !== null) {
      container.style.overflowY = nativeOverflowYRef.current;
      nativeOverflowYRef.current = null;
    }
  }, []);

  const setProgrammaticScrollTop = useCallback(
    (container: HTMLElement, scrollTop: number) => {
      if (programmaticScrollFrameRef.current) {
        window.cancelAnimationFrame(programmaticScrollFrameRef.current);
      }

      programmaticScrollRef.current = true;
      container.scrollTop = scrollTop;
      programmaticScrollFrameRef.current = window.requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
        programmaticScrollFrameRef.current = null;
      });
    },
    []
  );

  const pinLockedScrollTop = useCallback(
    (container: HTMLElement, lockedScrollTop: number, tolerancePx = 1) => {
      const maxScrollTop = Math.max(
        0,
        container.scrollHeight - container.clientHeight
      );
      const pinnedTop = Math.round(
        clampNumber(lockedScrollTop, 0, maxScrollTop)
      );
      if (Math.abs(container.scrollTop - pinnedTop) <= tolerancePx) return;
      setProgrammaticScrollTop(container, pinnedTop);
    },
    [setProgrammaticScrollTop]
  );

  const lockedGateTopFor = useCallback(
    (container: HTMLElement, top: number) => {
      const maxScrollTop = Math.max(
        0,
        container.scrollHeight - container.clientHeight
      );
      return Math.round(clampNumber(top, 0, maxScrollTop));
    },
    []
  );

  const clearPullVisualNow = useCallback(() => {
    if (pullSettleTimerRef.current) {
      window.clearTimeout(pullSettleTimerRef.current);
      pullSettleTimerRef.current = null;
    }
    setPullVisual({
      sectionId: null,
      direction: 1,
      phase: "pull",
      progress: 0,
      settling: false,
      flashing: false,
    });
  }, []);

  const settlePullVisual = useCallback(() => {
    if (pullSettleTimerRef.current) {
      window.clearTimeout(pullSettleTimerRef.current);
      pullSettleTimerRef.current = null;
    }

    setPullVisual((current) => {
      if (!current.sectionId || (current.progress === 0 && !current.settling)) {
        return current;
      }

      return {
        ...current,
        progress: 0,
        settling: true,
        flashing: false,
      };
    });

    pullSettleTimerRef.current = window.setTimeout(() => {
      setPullVisual({
        sectionId: null,
        direction: 1,
        phase: "pull",
        progress: 0,
        settling: false,
        flashing: false,
      });
      pullSettleTimerRef.current = null;
    }, tuning.visual.settleMs);
  }, [tuning.visual.settleMs]);

  const updatePullVisual = useCallback(
    (
      sectionId: CryptoCenterSectionId,
      direction: 1 | -1,
      pullProgress: number,
      flashing = false,
      phase: "gate" | "pull" = "pull"
    ) => {
      if (pullSettleTimerRef.current) {
        window.clearTimeout(pullSettleTimerRef.current);
        pullSettleTimerRef.current = null;
      }

      setPullVisual({
        sectionId,
        direction,
        phase,
        progress: clampNumber(pullProgress, 0, 1),
        settling: false,
        flashing,
      });
    },
    []
  );

  const resetBoundaryIntent = useCallback(
    (shouldSettlePull = true) => {
      boundaryIntentRef.current = null;
      clearIdleResetTimer();
      if (
        scrollOwnerRef.current === "gate" ||
        scrollOwnerRef.current === "pull"
      ) {
        scrollOwnerRef.current = "page";
      }
      unlockNativeScroll();
      if (shouldSettlePull) settlePullVisual();
    },
    [clearIdleResetTimer, settlePullVisual, unlockNativeScroll]
  );

  useEffect(() => {
    if (!debugEnabled || typeof window === "undefined") return;

    const debugWindow = window as CryptoSectionScrollDebugWindow;
    debugWindow.__cryptoSectionScrollDebug = {
      get owner() {
        return scrollOwnerRef.current;
      },
      get intent() {
        return boundaryIntentRef.current;
      },
      get pullVisual() {
        return pullVisual;
      },
      tuning,
      reset: () => resetBoundaryIntent(),
    };

    return () => {
      delete debugWindow.__cryptoSectionScrollDebug;
    };
  }, [debugEnabled, pullVisual, resetBoundaryIntent, tuning]);

  const getSectionMetrics = useCallback((): SectionMetric[] => {
    const container = containerRef.current;
    if (!container) return [];

    const containerRect = container.getBoundingClientRect();
    return sectionIds
      .map((id) => {
        const node = sectionRefs.current.get(id);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        const top = rect.top - containerRect.top + container.scrollTop;
        return {
          id,
          node,
          top,
          bottom: top + rect.height,
        };
      })
      .filter((metric): metric is SectionMetric => Boolean(metric))
      .sort((a, b) => a.top - b.top);
  }, [sectionIds]);

  const findCurrentSectionIndex = useCallback(
    (metrics: SectionMetric[], scrollTop: number) => {
      let currentIndex = 0;
      for (let index = 0; index < metrics.length; index += 1) {
        if (metrics[index].top <= scrollTop + tuning.boundaryPx) {
          currentIndex = index;
        }
      }
      return currentIndex;
    },
    [tuning.boundaryPx]
  );

  const getBoundaryTransition = useCallback(
    (deltaY: number): BoundaryTransition | null => {
      const container = containerRef.current;
      if (!container) return null;

      const metrics = getSectionMetrics();
      if (metrics.length < 2) return null;

      const scrollTop = container.scrollTop;
      const currentIndex = findCurrentSectionIndex(metrics, scrollTop);
      const current = metrics[currentIndex];
      if (!current) return null;
      const direction: 1 | -1 = deltaY > 0 ? 1 : -1;
      const absDelta = Math.abs(deltaY);
      const maxScrollTop = Math.max(
        0,
        container.scrollHeight - container.clientHeight
      );

      if (direction > 0) {
        const target = metrics[currentIndex + 1];
        const boundaryTop = Math.max(
          0,
          current.bottom - container.clientHeight
        );
        const distanceToBoundary = boundaryTop - scrollTop;
        if (
          distanceToBoundary <= tuning.boundaryPx + absDelta &&
          currentIndex < metrics.length - 1 &&
          target
        ) {
          const gateTop = clampNumber(
            target.top - container.clientHeight + tuning.gatePreviewPx,
            0,
            maxScrollTop
          );
          return {
            direction,
            currentSectionId: current.id,
            currentIndex,
            targetIndex: currentIndex + 1,
            targetTop: target.top,
            gateTop,
          };
        }
      }

      if (direction < 0) {
        const target = metrics[currentIndex - 1];
        const boundaryTop = Math.max(0, current.top);
        const distanceToBoundary = scrollTop - boundaryTop;
        if (
          distanceToBoundary <= tuning.boundaryPx + absDelta &&
          currentIndex > 0 &&
          target
        ) {
          const gateTop = clampNumber(
            target.bottom - tuning.gatePreviewPx,
            0,
            maxScrollTop
          );
          return {
            direction,
            currentSectionId: current.id,
            currentIndex,
            targetIndex: currentIndex - 1,
            targetTop: target.top,
            gateTop,
          };
        }
      }

      return null;
    },
    [
      findCurrentSectionIndex,
      getSectionMetrics,
      tuning.boundaryPx,
      tuning.gatePreviewPx,
    ]
  );

  const getHandoffThreshold = useCallback(
    (container: HTMLElement, direction: 1 | -1) => {
      const baseThreshold = clampNumber(
        container.clientHeight * tuning.pullEase.thresholdRatio,
        tuning.pullEase.minThresholdPx,
        tuning.pullEase.maxThresholdPx
      );

      return direction < 0
        ? baseThreshold * tuning.pullEase.upFactor
        : baseThreshold;
    },
    [
      tuning.pullEase.maxThresholdPx,
      tuning.pullEase.minThresholdPx,
      tuning.pullEase.thresholdRatio,
      tuning.pullEase.upFactor,
    ]
  );

  const animateToSection = useCallback(
    (targetTop: number) => {
      const container = containerRef.current;
      if (!container) return;

      if (animationFrameRef.current) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      if (releaseDelayTimerRef.current) {
        window.clearTimeout(releaseDelayTimerRef.current);
        releaseDelayTimerRef.current = null;
      }

      const maxScrollTop = Math.max(
        0,
        container.scrollHeight - container.clientHeight
      );
      const clampedTarget = clampNumber(targetTop, 0, maxScrollTop);
      const startTop = container.scrollTop;
      const distance = clampedTarget - startTop;

      boundaryIntentRef.current = null;
      scrollOwnerRef.current = "snap";
      lockNativeScroll();
      clearIdleResetTimer();

      if (Math.abs(distance) < 1) {
        setProgrammaticScrollTop(container, clampedTarget);
        scrollOwnerRef.current = "page";
        unlockNativeScroll();
        clearPullVisualNow();
        return;
      }

      releaseDelayTimerRef.current = window.setTimeout(() => {
        releaseDelayTimerRef.current = null;
        settlePullVisual();
        const startedAt = performance.now();

        const step = (now: number) => {
          const progress = clampNumber(
            (now - startedAt) / tuning.visual.snapDurationMs,
            0,
            1
          );
          setProgrammaticScrollTop(
            container,
            startTop + distance * easeOutQuart(progress)
          );

          if (progress < 1) {
            animationFrameRef.current = window.requestAnimationFrame(step);
            return;
          }

          setProgrammaticScrollTop(container, clampedTarget);
          animationFrameRef.current = null;
          scrollOwnerRef.current = "page";
          unlockNativeScroll();
          clearPullVisualNow();
        };

        animationFrameRef.current = window.requestAnimationFrame(step);
      }, tuning.visual.releaseDelayMs);
    },
    [
      clearIdleResetTimer,
      clearPullVisualNow,
      lockNativeScroll,
      settlePullVisual,
      setProgrammaticScrollTop,
      tuning.visual.releaseDelayMs,
      tuning.visual.snapDurationMs,
      unlockNativeScroll,
    ]
  );

  const handleBoundaryIntent = useCallback(
    (deltaY: number, target: EventTarget | null, eventTime: number) => {
      if (!enabled || Math.abs(deltaY) < tuning.minDeltaPx) {
        return false;
      }

      const container = containerRef.current;
      if (!container) return false;

      const direction: 1 | -1 = deltaY > 0 ? 1 : -1;
      if (scrollOwnerRef.current === "snap") return true;

      const previous = boundaryIntentRef.current;
      if (
        !previous &&
        eventTargetShouldKeepScroll(target, container, direction)
      ) {
        resetBoundaryIntent();
        return false;
      }

      const absDelta = Math.abs(deltaY);
      const cappedDelta = Math.min(absDelta, tuning.pullEase.maxDeltaPx);

      if (previous && previous.direction !== direction) {
        const nextVirtualPullDistance =
          previous.virtualPullDistance - cappedDelta;

        if (previous.phase === "pull" && nextVirtualPullDistance > 0) {
          pinLockedScrollTop(container, previous.lockedScrollTop);

          const pullProgress = clampNumber(
            nextVirtualPullDistance / previous.threshold,
            0,
            1
          );
          boundaryIntentRef.current = {
            ...previous,
            virtualPullDistance: nextVirtualPullDistance,
            postGatePullDistance: nextVirtualPullDistance,
            lastDeltaPx: cappedDelta,
            lastEventAt: eventTime,
          };
          scrollOwnerRef.current = "pull";
          lockNativeScroll();
          updatePullVisual(
            previous.sectionId,
            previous.direction,
            pullProgress
          );
          clearIdleResetTimer();
          idleResetTimerRef.current = window.setTimeout(() => {
            resetBoundaryIntent();
          }, tuning.visual.idleResetMs);
          return true;
        }

        resetBoundaryIntent();
        return false;
      }

      if (previous && previous.direction === direction) {
        pinLockedScrollTop(container, previous.lockedScrollTop);

        if (previous.phase === "gate") {
          const timeSinceLastGateInput = eventTime - previous.lastEventAt;
          const timeSinceGateEntered = eventTime - previous.gateEnteredAt;
          const isAbsorbing =
            timeSinceGateEntered < tuning.inertiaShield.absorbMs;
          const isTinyIntent =
            cappedDelta < tuning.inertiaShield.minIntentDeltaPx;
          const hasRearmGap =
            timeSinceLastGateInput >= tuning.inertiaShield.rearmGapMs;
          const isClearlyDecelerating =
            previous.lastDeltaPx > 0 &&
            timeSinceLastGateInput < tuning.inertiaShield.rearmGapMs &&
            cappedDelta <= previous.lastDeltaPx * 0.96;
          const isReaccelerating =
            cappedDelta >= tuning.inertiaShield.activePullDeltaPx &&
            cappedDelta >=
              previous.lastDeltaPx + tuning.inertiaShield.minIntentDeltaPx;
          const hasConfirmedIntent = hasRearmGap || isReaccelerating;
          const shouldCountAsActivePull =
            !isAbsorbing &&
            !isTinyIntent &&
            !isClearlyDecelerating &&
            hasConfirmedIntent;
          const nextPostGatePullDistance = shouldCountAsActivePull
            ? previous.postGatePullDistance + cappedDelta
            : previous.postGatePullDistance;
          const hasActivePullDistance =
            nextPostGatePullDistance >=
            tuning.inertiaShield.activePullDistancePx;
          const shouldEnterPull =
            !isAbsorbing &&
            !isTinyIntent &&
            (hasRearmGap || isReaccelerating || hasActivePullDistance);

          if (!shouldEnterPull) {
            boundaryIntentRef.current = {
              ...previous,
              lastEventAt: eventTime,
              lastDeltaPx: cappedDelta,
              postGatePullDistance: nextPostGatePullDistance,
            };
            scrollOwnerRef.current = "gate";
            lockNativeScroll();
            updatePullVisual(
              previous.sectionId,
              previous.direction,
              tuning.visual.gateBumpProgress,
              false,
              "gate"
            );
            clearIdleResetTimer();
            return true;
          }

          const virtualPullDistance = Math.min(
            Math.max(nextPostGatePullDistance, cappedDelta),
            tuning.pullEase.maxDeltaPx
          );
          const pullProgress = clampNumber(
            virtualPullDistance / previous.threshold,
            0,
            1
          );
          boundaryIntentRef.current = {
            ...previous,
            phase: "pull",
            virtualPullDistance,
            postGatePullDistance: virtualPullDistance,
            lastDeltaPx: cappedDelta,
            lastEventAt: eventTime,
          };
          scrollOwnerRef.current = "pull";
          lockNativeScroll();
          updatePullVisual(
            previous.sectionId,
            previous.direction,
            pullProgress,
            pullProgress >= 1
          );

          if (pullProgress >= 1) {
            clearIdleResetTimer();
            animateToSection(previous.targetTop);
          } else {
            clearIdleResetTimer();
            idleResetTimerRef.current = window.setTimeout(() => {
              resetBoundaryIntent();
            }, tuning.visual.idleResetMs);
          }

          return true;
        }

        const virtualPullDistance = previous.virtualPullDistance + cappedDelta;
        const pullProgress = clampNumber(
          virtualPullDistance / previous.threshold,
          0,
          1
        );
        boundaryIntentRef.current = {
          ...previous,
          virtualPullDistance,
          postGatePullDistance: virtualPullDistance,
          lastDeltaPx: cappedDelta,
          lastEventAt: eventTime,
        };
        scrollOwnerRef.current = "pull";
        lockNativeScroll();
        updatePullVisual(
          previous.sectionId,
          previous.direction,
          pullProgress,
          pullProgress >= 1
        );

        if (pullProgress >= 1) {
          clearIdleResetTimer();
          animateToSection(previous.targetTop);
        } else {
          clearIdleResetTimer();
          idleResetTimerRef.current = window.setTimeout(() => {
            resetBoundaryIntent();
          }, tuning.visual.idleResetMs);
        }

        return true;
      }

      const transition = getBoundaryTransition(deltaY);
      if (!transition) {
        resetBoundaryIntent();
        return false;
      }

      const lockedGateTop = lockedGateTopFor(container, transition.gateTop);
      pinLockedScrollTop(container, lockedGateTop, 0);

      const threshold = getHandoffThreshold(container, transition.direction);

      boundaryIntentRef.current = {
        phase: "gate",
        direction: transition.direction,
        sectionId: transition.currentSectionId,
        currentIndex: transition.currentIndex,
        targetIndex: transition.targetIndex,
        targetTop: transition.targetTop,
        lockedScrollTop: lockedGateTop,
        threshold,
        virtualPullDistance: 0,
        lastEventAt: eventTime,
        gateEnteredAt: eventTime,
        gateUnlockAt: eventTime + tuning.inertiaShield.absorbMs,
        lastDeltaPx: cappedDelta,
        postGatePullDistance: 0,
      };
      scrollOwnerRef.current = "gate";
      lockNativeScroll();
      updatePullVisual(
        transition.currentSectionId,
        transition.direction,
        tuning.visual.gateBumpProgress,
        false,
        "gate"
      );
      clearIdleResetTimer();

      return true;
    },
    [
      animateToSection,
      enabled,
      getBoundaryTransition,
      getHandoffThreshold,
      lockedGateTopFor,
      resetBoundaryIntent,
      clearIdleResetTimer,
      lockNativeScroll,
      pinLockedScrollTop,
      updatePullVisual,
      tuning.inertiaShield.absorbMs,
      tuning.inertiaShield.activePullDeltaPx,
      tuning.inertiaShield.activePullDistancePx,
      tuning.inertiaShield.minIntentDeltaPx,
      tuning.inertiaShield.rearmGapMs,
      tuning.minDeltaPx,
      tuning.pullEase.maxDeltaPx,
      tuning.visual.gateBumpProgress,
      tuning.visual.idleResetMs,
    ]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onWheel = (event: WheelEvent) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ) {
        return;
      }

      const deltaY = normalizeWheelDelta(event, container.clientHeight);
      if (handleBoundaryIntent(deltaY, event.target, performance.now())) {
        event.preventDefault();
      }
    };

    const onTouchStart = (event: TouchEvent) => {
      touchYRef.current =
        event.touches.length === 1 ? event.touches[0].clientY : null;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (touchYRef.current === null || event.touches.length !== 1) return;
      const currentY = event.touches[0].clientY;
      const deltaY = touchYRef.current - currentY;
      touchYRef.current = currentY;

      if (handleBoundaryIntent(deltaY, event.target, performance.now())) {
        event.preventDefault();
      }
    };

    const onTouchEnd = () => {
      touchYRef.current = null;
      if (scrollOwnerRef.current === "pull") {
        resetBoundaryIntent();
        return;
      }
      if (scrollOwnerRef.current === "gate") {
        settlePullVisual();
      }
    };

    const onScroll = () => {
      if (programmaticScrollRef.current) return;

      if (
        (scrollOwnerRef.current === "gate" ||
          scrollOwnerRef.current === "pull") &&
        boundaryIntentRef.current
      ) {
        const lockedScrollTop = boundaryIntentRef.current.lockedScrollTop;
        pinLockedScrollTop(container, lockedScrollTop, 2);
        return;
      }

      if (scrollOwnerRef.current === "page") {
        boundaryIntentRef.current = null;
      }
    };

    container.addEventListener("wheel", onWheel, {
      passive: false,
      capture: true,
    });
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, {
      passive: false,
      capture: true,
    });
    container.addEventListener("touchend", onTouchEnd, { passive: true });
    container.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      container.removeEventListener("wheel", onWheel, { capture: true });
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove, {
        capture: true,
      });
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("scroll", onScroll);
    };
  }, [
    handleBoundaryIntent,
    pinLockedScrollTop,
    resetBoundaryIntent,
    settlePullVisual,
  ]);

  const getSectionStyle = useCallback(
    (sectionId: CryptoCenterSectionId): React.CSSProperties => {
      if (
        !enabled ||
        pullVisual.sectionId !== sectionId ||
        pullVisual.phase === "gate"
      ) {
        return {
          transform: "none",
          opacity: 1,
          willChange: enabled ? "transform, opacity" : "auto",
        };
      }

      const pullProgress = clampNumber(pullVisual.progress, 0, 1);
      const visualProgress = 1 - Math.exp(-pullProgress * 3.2);
      const pullOffset =
        tuning.visual.maxPullPx *
        visualProgress *
        (pullVisual.direction > 0 ? -1 : 1);
      const scale = 1 - (1 - tuning.visual.minScale) * visualProgress;
      const opacity = 1 - (1 - tuning.visual.minOpacity) * visualProgress;
      const transition = pullVisual.settling
        ? `transform ${tuning.visual.settleMs}ms cubic-bezier(.22,1,.36,1), opacity ${tuning.visual.settleMs}ms cubic-bezier(.22,1,.36,1)`
        : "none";

      return {
        transform: `translate3d(0, ${pullOffset}px, 0) scale(${scale})`,
        transformOrigin:
          pullVisual.direction > 0 ? "center bottom" : "center top",
        opacity,
        transition,
        backfaceVisibility: "hidden",
        willChange: "transform, opacity",
      };
    },
    [
      enabled,
      pullVisual,
      tuning.visual.maxPullPx,
      tuning.visual.minOpacity,
      tuning.visual.minScale,
      tuning.visual.settleMs,
    ]
  );

  const getBoundaryEdgeStyle = useCallback(
    (sectionId: CryptoCenterSectionId): React.CSSProperties => {
      if (!enabled || pullVisual.sectionId !== sectionId) {
        return {
          opacity: 0,
          transform: "scaleX(0.22)",
          top: "auto",
          bottom: 0,
        };
      }

      const pullProgress = clampNumber(pullVisual.progress, 0, 1);
      const visualProgress = 1 - Math.exp(-pullProgress * 3.2);
      const opacity = pullVisual.flashing
        ? 1
        : clampNumber((visualProgress - 0.12) / 0.88, 0, 0.86);
      const shadowAlpha = pullVisual.flashing
        ? 0.78
        : 0.12 + visualProgress * 0.52;
      const blurPx = 1 + visualProgress * 1.4;
      const scaleX = 0.24 + visualProgress * 0.76;

      return {
        top: pullVisual.direction < 0 ? 0 : "auto",
        bottom: pullVisual.direction > 0 ? 0 : "auto",
        height: pullVisual.flashing ? 2 : 1 + visualProgress,
        opacity,
        transform: `scaleX(${scaleX})`,
        transformOrigin: "center",
        background: `linear-gradient(90deg, transparent, rgba(214,168,79,${
          0.32 + visualProgress * 0.58
        }), transparent)`,
        boxShadow: `0 0 16px rgba(214,168,79,${shadowAlpha})`,
        filter: `blur(${blurPx}px)`,
        transition: pullVisual.settling
          ? `opacity ${tuning.visual.settleMs}ms cubic-bezier(.22,1,.36,1), transform ${tuning.visual.settleMs}ms cubic-bezier(.22,1,.36,1), filter ${tuning.visual.settleMs}ms cubic-bezier(.22,1,.36,1)`
          : "none",
        willChange: "opacity, transform, filter",
      };
    },
    [enabled, pullVisual, tuning.visual.settleMs]
  );

  return {
    containerRef,
    getBoundaryEdgeStyle,
    getSectionStyle,
    setSectionRef,
  };
}

function useMeasuredElementWidth(ref: React.RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;

    let frame: number | null = null;
    const measure = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        setWidth(Math.round(node.getBoundingClientRect().width));
      });
    };

    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(node);
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
  }, [ref]);

  return width;
}

const btcDetailVisual = {
  cardWidth: BTC_SPOT_DETAIL_CARD_WIDTH,
  cardHeight: BTC_SPOT_CARD_HEIGHT,
  borderRadius: 28,
  glowIntensity: 0.75,
  iconSize: 62,
  iconCropScale: 1.21,
  iconCropX: 0,
  iconCropY: 0,
  showUsdEstimate: true,
  showMarketBadge: true,
  showInfoIcons: true,
  compactMode: false,
};

const btcCandlestickVisual = {
  cardHeight: BTC_SPOT_CARD_HEIGHT,
  borderRadius: 24,
  glowIntensity: 0.72,
  accentColor: "#D6A84F",
  iconSize: 62,
  iconCropScale: 1.21,
  iconCropX: 0,
  iconCropY: 0,
  showVolume: true,
  showCrosshair: true,
  showCurrentPriceLine: true,
  showGrid: true,
  compactMode: true,
};

type GateEquityMode = "api_total" | "net_equity" | "account_sum";

type GateEquityHistory = {
  historyVersion: number;
  latestPointTs: number | null;
  incremental?: boolean;
  latestEquityUsd: number;
  todayPnlUsd: number;
  todayPnlPct: number;
  yesterdayBaselineUsd: number;
  yesterdayChangePct: number;
  lastUpdatedAt: string | null;
  lastUpdatedDate?: string | null;
  freshness?: {
    latestSnapshotAt: number | null;
    latestSampleAt?: number | null;
    lastError?: string | null;
  };
  points: CryptoTrendPoint[];
};

type TopSpotAsset = {
  pair: string;
  baseAsset: string;
  quoteAsset: string;
  symbol: string;
  holdingAmountBase: string;
  holdingValueQuote: string;
  holdingValueUsd?: string | null;
  currentPriceQuote: string;
  change24hPct?: string | null;
};

type TopSpotAssetsResponse = {
  success: boolean;
  asOf?: number;
  connectionStatus?: "connected" | "degraded" | "disconnected";
  safeErrorMessage?: string;
  assets?: TopSpotAsset[];
};

type TopSpotAssetsState = {
  assets: TopSpotAsset[];
  status: "idle" | "loading" | "connected" | "error";
  error: string | null;
  asOf: number | null;
};

const defaultTotalAssetParams: CryptoTotalAssetCardProps = {
  totalEquityUsd: 0,
  todayPnlUsd: 0,
  todayPnlPct: 0,
  yesterdayChangePct: 0,
  yesterdayBaselineUsd: FALLBACK_YESTERDAY_BASELINE_USD,
  connectionStatus: "degraded",
  lastUpdatedAt: "--:--:--",
  lastUpdatedDate: "",
  cardHeight: HERO_PORTFOLIO_CARD_HEIGHT,
  borderRadius: 23,
  backgroundMode: "gradient",
  backgroundImage: "",
  showTrendChart: true,
  showEyeIcon: true,
  showStatusBadge: true,
  glowIntensity: 0.67,
  chartTone: "green",
  profitChartTone: "gold",
  lossChartTone: "red",
  trendScenario: "mixed",
  numberSize: 42,
  compactMode: false,
};

function CryptoComponentFallback({
  height,
  label = "正在加载组件",
}: {
  height: number;
  label?: string;
}) {
  return (
    <div
      className="grid w-full place-items-center overflow-hidden rounded-[28px] border border-[#D6A84F]/12 bg-black/25 text-xs font-black text-[#E8C46B]/55 shadow-[0_24px_90px_rgba(0,0,0,.26)]"
      style={{ height }}
    >
      <div className="grid justify-items-center gap-3">
        <div className="h-2 w-28 overflow-hidden rounded-full bg-white/10">
          <div className="h-full w-1/2 animate-pulse rounded-full bg-[#D6A84F]/45" />
        </div>
        <span>{label}</span>
      </div>
    </div>
  );
}

function useEnableWhenNearViewport({
  rootRef,
  rootMargin = "900px",
  fallbackDelayMs = 1_500,
}: {
  rootRef: React.RefObject<HTMLElement | null>;
  rootMargin?: string;
  fallbackDelayMs?: number;
}) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (enabled || !node) return;

    let timer: number | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setEnabled(true);
        }
      },
      {
        root: rootRef.current,
        rootMargin,
        threshold: 0.01,
      }
    );

    observer.observe(node);
    timer = window.setTimeout(() => setEnabled(true), fallbackDelayMs);

    return () => {
      observer.disconnect();
      if (timer) window.clearTimeout(timer);
    };
  }, [enabled, fallbackDelayMs, node, rootMargin, rootRef]);

  return [enabled, setNode] as const;
}

function useTopSpotAssets({ enabled = true } = {}) {
  const [state, setState] = useState<TopSpotAssetsState>({
    assets: [],
    status: "idle",
    error: null,
    asOf: null,
  });

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timer: number | null = null;

    async function loadTopAssets() {
      setState((current) => ({
        ...current,
        status: current.status === "connected" ? "connected" : "loading",
      }));

      try {
        const query = new URLSearchParams({
          limit: String(TOP_SPOT_ASSET_LIMIT),
          exclude: TOP_SPOT_EXCLUDED_ASSETS.join(","),
          quote: "USDT",
        });
        const payload = await requestPriorityQueue.schedule(
          ({ signal }: { signal: AbortSignal }) =>
            cryptoHubFetch<TopSpotAssetsResponse>(
              `/top-assets?${query.toString()}`,
              { signal, task: false }
            ),
          {
            priority: "P1",
            label: "crypto:top-assets",
            kind: "crypto",
            scope: {
              route: "crypto-center",
              surface: "top-assets",
            },
            policy: "visible",
            dedupeKey: "crypto:top-assets",
          }
        );
        if (!payload) return;
        if (cancelled) return;

        setState({
          assets: Array.isArray(payload.assets) ? payload.assets : [],
          status:
            payload.connectionStatus === "degraded" ? "connected" : "connected",
          error: null,
          asOf: payload.asOf || Date.now(),
        });
      } catch (error) {
        if (cancelled) return;
        setState((current) => ({
          ...current,
          status: "error",
          error:
            error instanceof Error
              ? error.message
              : "Gate 现货前六资产读取失败",
        }));
      }
    }

    function schedule() {
      timer = window.setTimeout(async () => {
        await loadTopAssets();
        if (!cancelled) schedule();
      }, cryptoBackgroundRefreshDelay());
    }

    loadTopAssets();
    schedule();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [enabled]);

  return state;
}

function currentShanghaiDateTime() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date()).map((part) => [part.type, part.value])
  );

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

function trendPointKey(point: CryptoTrendPoint) {
  return `${point.ts || point.time}:${point.apiId || "main_account"}:${
    point.equityMode || "api_total"
  }`;
}

function mergeTrendPoints(
  currentPoints: CryptoTrendPoint[] = [],
  nextPoints: CryptoTrendPoint[] = []
) {
  if (!nextPoints.length) return currentPoints;

  const merged = new Map<string, CryptoTrendPoint>();
  currentPoints.forEach((point) => merged.set(trendPointKey(point), point));
  nextPoints.forEach((point) => merged.set(trendPointKey(point), point));

  return [...merged.values()].sort((left, right) => {
    const leftTs = left.ts || 0;
    const rightTs = right.ts || 0;
    if (leftTs !== rightTs) return leftTs - rightTs;
    return trendPointKey(left).localeCompare(trendPointKey(right));
  });
}

function buildSpotDetailParams({
  response,
  error,
  preset,
  market,
  visual,
}: {
  response: TradingPairDetailResponse | null;
  error: string | null;
  preset: TradingPairPreset;
  market: TradingPairMarketType;
  visual: typeof btcDetailVisual;
}): TradingPairDetailCardProps {
  const real = Boolean(response?.success);

  return {
    baseAsset: real
      ? response?.baseAsset || preset.baseAsset
      : preset.baseAsset,
    quoteAsset: real
      ? response?.quoteAsset || preset.quoteAsset
      : preset.quoteAsset,
    symbol: real ? response?.symbol || preset.symbol : preset.symbol,
    gateCurrencyPair: preset.gateCurrencyPair,
    assetName: preset.assetName,
    assetNameCn: preset.assetNameCn,
    marketType: market,
    iconText: preset.iconText,
    iconImage: preset.iconImage,
    accentColor: preset.accentColor,
    holdingValueQuote: real ? (response?.holdingValueQuote ?? null) : null,
    holdingValueUsd: real ? (response?.holdingValueUsd ?? null) : null,
    change24hPct: real ? (response?.change24hPct ?? null) : null,
    change24hQuote: real ? (response?.change24hQuote ?? null) : null,
    averageBuyPriceQuote: real
      ? (response?.averageBuyPriceQuote ?? null)
      : null,
    averageBuyPriceMethod: real
      ? response?.averageBuyPriceMethod || "unknown"
      : "unknown",
    averageBuyPriceScope: real
      ? response?.averageBuyPriceScope || "unknown"
      : "unknown",
    currentPriceQuote: real ? (response?.currentPriceQuote ?? null) : null,
    holdingAmountBase: real ? (response?.holdingAmountBase ?? null) : null,
    lastUpdatedAt: real
      ? response?.lastUpdatedAt || response?.asOf || null
      : null,
    connectionStatus: resolvePrivateConnectionStatus({
      hasTrustedData: real,
      requestError: error,
      upstreamStatus: response?.connectionStatus,
    }),
    ...visual,
  };
}

function presetForTopSpotAsset(asset: TopSpotAsset): TradingPairPreset {
  const preset = tradingPairMockPresets.find(
    (candidate) => candidate.id === asset.pair
  );
  if (preset) return preset;

  const isNvdaOn = asset.pair === "NVDAON_USDT";

  return {
    id: asset.pair,
    baseAsset: asset.baseAsset,
    quoteAsset: asset.quoteAsset,
    symbol: asset.symbol,
    gateCurrencyPair: asset.pair,
    assetName: isNvdaOn ? "NVIDIA" : asset.baseAsset,
    assetNameCn: isNvdaOn ? "NVDAON" : asset.baseAsset,
    iconText: asset.baseAsset,
    iconImage: isNvdaOn ? "/stock-icons/nvda.PNG" : undefined,
    accentColor: isNvdaOn ? "#1fff9e" : "#D6A84F",
    holdingValueQuote: asset.holdingValueQuote,
    holdingValueUsd: asset.holdingValueUsd || asset.holdingValueQuote,
    change24hPct: asset.change24hPct || "0",
    change24hQuote: "0",
    averageBuyPriceQuote: null,
    averageBuyPriceMethod: "unknown",
    currentPriceQuote: asset.currentPriceQuote,
    holdingAmountBase: asset.holdingAmountBase,
  };
}

function TopSpotAssetDetailCard({
  asset,
  cardWidth,
  cardHeight,
  enabled,
}: {
  asset: TopSpotAsset;
  cardWidth: number;
  cardHeight: number;
  enabled: boolean;
}) {
  const preset = useMemo(() => presetForTopSpotAsset(asset), [asset]);
  const detail = useTradingPairDetailData({
    mode: "gate-api",
    pair: asset.pair,
    market: "spot",
    enabled,
  });
  const visual = useMemo(
    () => ({
      ...btcDetailVisual,
      cardWidth,
      cardHeight,
    }),
    [cardHeight, cardWidth]
  );
  const params = useMemo<TradingPairDetailCardProps>(() => {
    return buildSpotDetailParams({
      response: detail.response,
      error: detail.error,
      preset,
      market: "spot",
      visual,
    });
  }, [detail.error, detail.response, preset, visual]);

  return (
    <React.Suspense
      fallback={
        <CryptoComponentFallback
          height={cardHeight}
          label={`${asset.symbol} 行情组件加载中`}
        />
      }
    >
      <TradingPairDetailCard {...params} />
    </React.Suspense>
  );
}

function AnimatedTopSpotAssetGrid({
  assets,
  cardHeight = TOP_SPOT_CARD_HEIGHT,
  enabled,
}: {
  assets: TopSpotAsset[];
  cardHeight?: number;
  enabled: boolean;
}) {
  const { reducedMotion, requestMotion } = useMotion();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const itemRefsRef = useRef(new Map<string, HTMLDivElement>());
  const previousRectsRef = useRef(new Map<string, DOMRect>());
  const previousKeysRef = useRef<string[]>([]);
  const [containerWidth, setContainerWidth] = useState(
    BTC_SPOT_CONTENT_MAX_WIDTH
  );
  const orderedPairs = assets.map((asset) => asset.pair).join("|");

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    function updateWidth() {
      setContainerWidth(Math.floor(node.getBoundingClientRect().width));
    }

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const twoColumns = containerWidth >= TOP_SPOT_MIN_TWO_COLUMN_WIDTH;
  const cardWidth = Math.max(
    320,
    Math.floor(
      (containerWidth - (twoColumns ? TOP_SPOT_CARD_GAP : 0)) /
        (twoColumns ? 2 : 1)
    )
  );

  const setItemRef = useCallback(
    (pair: string) => (node: HTMLDivElement | null) => {
      if (node) itemRefsRef.current.set(pair, node);
      else itemRefsRef.current.delete(pair);
    },
    []
  );

  useLayoutEffect(() => {
    const currentKeys = assets.map((asset) => asset.pair);
    const previousKeys = previousKeysRef.current;
    const previousRects = previousRectsRef.current;
    const currentRects = new Map<string, DOMRect>();

    for (const pair of currentKeys) {
      const node = itemRefsRef.current.get(pair);
      if (node) currentRects.set(pair, node.getBoundingClientRect());
    }

    const sameAssetSet =
      previousKeys.length === currentKeys.length &&
      currentKeys.every((pair) => previousRects.has(pair)) &&
      previousKeys.every((pair) => currentKeys.includes(pair));
    const orderChanged =
      sameAssetSet &&
      currentKeys.some((pair, index) => pair !== previousKeys[index]);

    if (orderChanged && !reducedMotion) {
      const motion = requestMotion({
        category: "list",
        token: "crypto-top-spot-assets-reorder",
        duration: TOP_SPOT_REORDER_DURATION_MS,
      });
      if (motion.allowed) {
        for (const pair of currentKeys) {
          const node = itemRefsRef.current.get(pair);
          const previous = previousRects.get(pair);
          const current = currentRects.get(pair);
          if (!node || !previous || !current) continue;

          const deltaX = previous.left - current.left;
          const deltaY = previous.top - current.top;
          if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) continue;

          node.style.transition = "none";
          node.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
          node.style.willChange = "transform";
          node.style.zIndex = "2";

          window.requestAnimationFrame(() => {
            node.style.transition = `transform ${TOP_SPOT_REORDER_DURATION_MS}ms var(--motion-ease-emphasized, cubic-bezier(0.2, 0, 0, 1))`;
            node.style.transform = "translate(0, 0)";
          });
        }

        window.setTimeout(() => {
          for (const pair of currentKeys) {
            const node = itemRefsRef.current.get(pair);
            if (!node) continue;
            node.style.transition = "";
            node.style.transform = "";
            node.style.willChange = "";
            node.style.zIndex = "";
          }
          motion.end?.();
        }, TOP_SPOT_REORDER_DURATION_MS + 60);
      }
    }

    previousRectsRef.current = currentRects;
    previousKeysRef.current = currentKeys;
  }, [assets, orderedPairs, reducedMotion, requestMotion]);

  return (
    <div
      ref={containerRef}
      className="grid w-full max-w-full justify-center gap-6 overflow-visible"
      style={{
        gridTemplateColumns: twoColumns
          ? `${cardWidth}px ${cardWidth}px`
          : `${cardWidth}px`,
      }}
    >
      {assets.map((asset, index) => (
        <div
          key={asset.pair}
          ref={setItemRef(asset.pair)}
          className="relative motion-list-item"
          style={
            {
              "--motion-list-index": index,
              width: cardWidth,
              height: cardHeight,
            } as React.CSSProperties
          }
        >
          <TopSpotAssetDetailCard
            asset={asset}
            cardWidth={cardWidth}
            cardHeight={cardHeight}
            enabled={enabled}
          />
        </div>
      ))}
    </div>
  );
}

export default function CryptoCenterContent() {
  const hasPersistentSettingsShell = useSoftSettingsShell();
  const equityMode: GateEquityMode = "api_total";
  const [btcRange, setBtcRange] = useState<TradingPairCandlestickRange>("1h");
  const [ethRange, setEthRange] = useState<TradingPairCandlestickRange>("1h");
  const [gateHistory, setGateHistory] = useState<GateEquityHistory | null>(
    null
  );
  const [gateHistoryStatus, setGateHistoryStatus] = useState<
    "idle" | "loading" | "connected" | "error"
  >("idle");
  const [selectedAllocationAsset, setSelectedAllocationAsset] = useState<
    string | null
  >(null);
  const [currentDateTime, setCurrentDateTime] = useState(
    currentShanghaiDateTime
  );
  const gateHistoryRef = useRef<GateEquityHistory | null>(null);
  const heroDataPerfMarkedRef = useRef(false);
  const firstChartPerfMarkedRef = useRef(false);
  const [marketChartsEnabled, setMarketChartsEnabled] = useState(false);
  const [fullBackgroundEnabled, setFullBackgroundEnabled] = useState(false);
  const dashboard = useCryptoDashboard({ enabled: true });
  const useLegacyHeroFallback = dashboard.status === "error";

  useEffect(() => {
    return () => {
      requestPriorityQueue.cancelScope(
        { route: "crypto-center" },
        "crypto-center-unmount"
      );
    };
  }, []);

  const sectionScroll = useCryptoCenterSectionScroll(CRYPTO_CENTER_SECTION_IDS);
  const measuredViewportWidth = useMeasuredElementWidth(
    sectionScroll.containerRef
  );
  const tabletDesktopLayout =
    typeof window !== "undefined" && tabletDesktopRuntimeActive();
  const responsiveLayout = useMemo(() => {
    const fallbackWidth =
      typeof window === "undefined"
        ? BTC_SPOT_CONTENT_MAX_WIDTH
        : window.innerWidth;
    const viewportWidth = measuredViewportWidth || fallbackWidth;
    const contentChromePx = viewportWidth <= 900 ? 32 : 48;
    const availableWidth = Math.max(360, viewportWidth - contentChromePx);
    const scale = tabletDesktopLayout
      ? Math.min(1, Math.max(0.78, availableWidth / BTC_SPOT_CONTENT_MAX_WIDTH))
      : 1;
    const cardScale = Math.max(scale, 0.84);
    const heroScale = Math.max(scale, 0.88);

    return {
      contentMaxWidth: tabletDesktopLayout
        ? Math.min(BTC_SPOT_CONTENT_MAX_WIDTH, availableWidth)
        : BTC_SPOT_CONTENT_MAX_WIDTH,
      heroPortfolioHeight: Math.round(HERO_PORTFOLIO_CARD_HEIGHT * heroScale),
      heroAssetCardWidth: Math.round(
        HERO_ASSET_ALLOCATION_CARD_WIDTH * Math.max(scale, 0.82)
      ),
      spotDetailWidth: Math.round(BTC_SPOT_DETAIL_CARD_WIDTH * cardScale),
      spotCardHeight: Math.round(BTC_SPOT_CARD_HEIGHT * cardScale),
      spotChartMaxWidth: Math.round(BTC_SPOT_CHART_MAX_WIDTH * cardScale),
      spotBorderRadius: Math.round(24 * Math.max(scale, 0.9)),
      detailBorderRadius: Math.round(28 * Math.max(scale, 0.9)),
      iconSize: Math.round(62 * Math.max(scale, 0.86)),
      topSpotCardHeight: Math.round(TOP_SPOT_CARD_HEIGHT * cardScale),
      futuresPositionsHeight: Math.round(
        OPEN_FUTURES_POSITIONS_CARD_HEIGHT * Math.max(scale, 0.86)
      ),
      tradeRecordsHeight: Math.round(
        TRADE_RECORDS_CARD_HEIGHT * Math.max(scale, 0.86)
      ),
    };
  }, [measuredViewportWidth, tabletDesktopLayout]);
  const [topAssetsEnabled, setTopAssetsNearRef] = useEnableWhenNearViewport({
    rootRef: sectionScroll.containerRef,
    rootMargin: "960px",
    fallbackDelayMs: 1_800,
  });
  const [futuresEnabled, setFuturesNearRef] = useEnableWhenNearViewport({
    rootRef: sectionScroll.containerRef,
    rootMargin: "1100px",
    fallbackDelayMs: 2_800,
  });
  const btcDetail = useTradingPairDetailData({
    mode: "gate-api",
    pair: BTC_PAIR,
    market: BTC_MARKET,
    enabled: useLegacyHeroFallback,
  });
  const btcCandlestick = useTradingPairCandlestickData({
    mode: "gate-api",
    pair: BTC_PAIR,
    range: btcRange,
    market: BTC_MARKET,
    currentPriceFallback: btcPreset.currentPriceQuote,
    change24hPctFallback: btcPreset.change24hPct,
    enabled: marketChartsEnabled,
  });
  const ethDetail = useTradingPairDetailData({
    mode: "gate-api",
    pair: ETH_PAIR,
    market: ETH_MARKET,
    enabled: useLegacyHeroFallback,
  });
  const ethCandlestick = useTradingPairCandlestickData({
    mode: "gate-api",
    pair: ETH_PAIR,
    range: ethRange,
    market: ETH_MARKET,
    currentPriceFallback: ethPreset.currentPriceQuote,
    change24hPctFallback: ethPreset.change24hPct,
    enabled: marketChartsEnabled,
  });
  const topSpotAssets = useTopSpotAssets({ enabled: topAssetsEnabled });
  const assetAllocation = useAssetAllocationDonutData({
    initialMode: "gate",
    enabled: useLegacyHeroFallback,
  });

  useEffect(() => {
    if (heroDataPerfMarkedRef.current) return;
    const hasHeroData =
      Boolean(dashboard.snapshot?.portfolio?.invariant?.valid) ||
      gateHistoryStatus === "connected" ||
      Boolean(btcDetail.response?.success) ||
      Boolean(ethDetail.response?.success) ||
      assetAllocation.gateStatus === "connected" ||
      assetAllocation.gateStatus === "degraded";
    if (!hasHeroData) return;

    heroDataPerfMarkedRef.current = true;
    markCryptoCenterPerf("hero_data_ready", {
      gateHistoryStatus,
      btcStatus: btcDetail.response?.success
        ? "ready"
        : btcDetail.loading
          ? "loading"
          : btcDetail.error
            ? "error"
            : "idle",
      ethStatus: ethDetail.response?.success
        ? "ready"
        : ethDetail.loading
          ? "loading"
          : ethDetail.error
            ? "error"
            : "idle",
      allocationStatus: assetAllocation.gateStatus,
      dashboardStatus: dashboard.status,
    });
  }, [
    assetAllocation.gateStatus,
    btcDetail.error,
    btcDetail.loading,
    btcDetail.response?.success,
    ethDetail.error,
    ethDetail.loading,
    ethDetail.response?.success,
    gateHistoryStatus,
    dashboard.snapshot?.portfolio?.invariant?.valid,
    dashboard.status,
  ]);

  useEffect(() => {
    if (firstChartPerfMarkedRef.current || !marketChartsEnabled) return;
    const firstReadyChart = btcCandlestick.activeCandles.length
      ? "BTC"
      : ethCandlestick.activeCandles.length
        ? "ETH"
        : null;
    if (!firstReadyChart) return;

    firstChartPerfMarkedRef.current = true;
    markCryptoCenterPerf("first_chart_ready", {
      pair: firstReadyChart,
      btcCandles: btcCandlestick.activeCandles.length,
      ethCandles: ethCandlestick.activeCandles.length,
    });
  }, [
    btcCandlestick.activeCandles.length,
    ethCandlestick.activeCandles.length,
    marketChartsEnabled,
  ]);
  const setTopAssetsSectionNode = useCallback(
    (node: HTMLElement | null) => {
      sectionScroll.setSectionRef("top-assets")(node);
      setTopAssetsNearRef(node);
    },
    [sectionScroll, setTopAssetsNearRef]
  );

  const setFuturesSectionNode = useCallback(
    (node: HTMLElement | null) => {
      sectionScroll.setSectionRef("futures-trading")(node);
      setFuturesNearRef(node);
    },
    [sectionScroll, setFuturesNearRef]
  );

  useEffect(() => {
    let timeout: number | null = null;
    const raf = window.requestAnimationFrame(() => {
      timeout = window.setTimeout(() => setMarketChartsEnabled(true), 220);
    });
    return () => {
      window.cancelAnimationFrame(raf);
      if (timeout) window.clearTimeout(timeout);
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setFullBackgroundEnabled(true), 520);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    gateHistoryRef.current = gateHistory;
  }, [gateHistory]);

  useEffect(() => {
    const history = dashboard.snapshot?.equityHistory as
      | GateEquityHistory
      | undefined;
    if (!history?.points) return;
    setGateHistory(history);
    setGateHistoryStatus("connected");
  }, [dashboard.snapshot?.asOf, dashboard.snapshot?.equityHistory]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setCurrentDateTime(currentShanghaiDateTime());
    }, 1_000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (dashboard.status !== "error") return;
    let cancelled = false;
    let timer: number | null = null;
    let inflightController: AbortController | null = null;
    let loadedFullHistory = false;

    async function loadHistory() {
      if (cancelled) return;
      if (inflightController && !inflightController.signal.aborted) return;
      const controller = new AbortController();
      inflightController = controller;

      setGateHistoryStatus((current) =>
        current === "connected" ? "connected" : "loading"
      );

      try {
        const query = new URLSearchParams({
          window: "today",
          equityMode,
        });
        const currentHistory = gateHistoryRef.current;
        const lastPointTs =
          currentHistory?.latestPointTs ||
          currentHistory?.points?.[currentHistory.points.length - 1]?.ts;
        if (loadedFullHistory && lastPointTs) {
          query.set("sinceTs", String(lastPointTs));
        }

        const payload = await requestPriorityQueue.schedule(
          ({ signal }: { signal: AbortSignal }) =>
            cryptoHubFetch<{
              success: boolean;
              history?: GateEquityHistory;
              error?: string;
            }>(`/equity-history?${query.toString()}`, {
              signal,
              task: false,
            }),
          {
            priority: loadedFullHistory ? "P2" : "P1",
            label: "crypto:equity-history",
            kind: "crypto",
            scope: {
              route: "crypto-center",
              surface: "equity-history",
              equityMode,
            },
            policy: loadedFullHistory ? "background" : "visible",
            signal: controller.signal,
            dedupeKey: `crypto:equity-history:${equityMode}`,
          }
        );
        if (!payload) return;
        if (!payload?.history) {
          throw new Error(payload?.error || "Gate 今日历史数据读取失败");
        }
        if (cancelled || controller.signal.aborted) return;

        setGateHistory((current) => {
          const nextHistory = payload.history as GateEquityHistory;
          loadedFullHistory = true;

          if (!nextHistory.incremental || !current) return nextHistory;

          const unchanged =
            current.historyVersion === nextHistory.historyVersion &&
            current.freshness?.latestSnapshotAt ===
              nextHistory.freshness?.latestSnapshotAt &&
            current.latestEquityUsd === nextHistory.latestEquityUsd;
          if (unchanged && !nextHistory.points.length) return current;

          return {
            ...nextHistory,
            points: mergeTrendPoints(current.points, nextHistory.points),
          };
        });
        setGateHistoryStatus("connected");
      } catch (error) {
        if (
          cancelled ||
          controller.signal.aborted ||
          (error as Error)?.name === "AbortError"
        )
          return;
        setGateHistoryStatus("error");
      } finally {
        if (inflightController === controller) inflightController = null;
      }
    }

    function scheduleHistoryRefresh() {
      timer = window.setTimeout(async () => {
        await loadHistory();
        if (!cancelled) scheduleHistoryRefresh();
      }, EQUITY_HISTORY_REFRESH_MS);
    }

    loadHistory();
    scheduleHistoryRefresh();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      inflightController?.abort();
    };
  }, [dashboard.status, equityMode]);

  const totalAssetParams = useMemo<CryptoTotalAssetCardProps>(() => {
    const gateConnectionStatus =
      dashboard.snapshot?.connectionStatus === "connected"
        ? ("connected" as const)
        : dashboard.snapshot?.connectionStatus === "disconnected"
          ? ("disconnected" as const)
          : gateHistoryStatus === "connected"
            ? ("degraded" as const)
            : gateHistoryStatus === "error"
              ? ("disconnected" as const)
              : ("degraded" as const);
    const timeStampedParams = {
      ...defaultTotalAssetParams,
      cardHeight: responsiveLayout.heroPortfolioHeight,
      borderRadius: responsiveLayout.spotBorderRadius,
      numberSize: Math.round(
        42 *
          Math.max(
            0.88,
            responsiveLayout.heroPortfolioHeight / HERO_PORTFOLIO_CARD_HEIGHT
          )
      ),
      lastUpdatedAt: currentDateTime.time,
      lastUpdatedDate: currentDateTime.date,
      latestSampleAt: gateHistory?.freshness?.latestSampleAt || null,
      connectionStatus: gateConnectionStatus,
    };

    if (!gateHistory && !dashboard.snapshot) return timeStampedParams;

    return {
      ...timeStampedParams,
      totalEquityUsd: dashboard.snapshot
        ? Number(dashboard.snapshot.portfolio.totalValueUsd)
        : gateHistory?.latestEquityUsd || 0,
      todayPnlUsd: gateHistory?.todayPnlUsd || 0,
      todayPnlPct: gateHistory?.todayPnlPct || 0,
      yesterdayBaselineUsd:
        gateHistory?.yesterdayBaselineUsd || FALLBACK_YESTERDAY_BASELINE_USD,
      yesterdayChangePct: gateHistory?.yesterdayChangePct || 0,
      trendPoints: gateHistory?.points || [],
    };
  }, [
    currentDateTime,
    dashboard.snapshot,
    gateHistory,
    gateHistoryStatus,
    responsiveLayout.heroPortfolioHeight,
    responsiveLayout.spotBorderRadius,
  ]);

  const responsiveDetailVisual = useMemo(
    () => ({
      ...btcDetailVisual,
      cardWidth: responsiveLayout.spotDetailWidth,
      cardHeight: responsiveLayout.spotCardHeight,
      borderRadius: responsiveLayout.detailBorderRadius,
      iconSize: responsiveLayout.iconSize,
    }),
    [
      responsiveLayout.detailBorderRadius,
      responsiveLayout.iconSize,
      responsiveLayout.spotCardHeight,
      responsiveLayout.spotDetailWidth,
    ]
  );

  const responsiveCandlestickVisual = useMemo(
    () => ({
      ...btcCandlestickVisual,
      cardHeight: responsiveLayout.spotCardHeight,
      borderRadius: responsiveLayout.spotBorderRadius,
      iconSize: responsiveLayout.iconSize,
    }),
    [
      responsiveLayout.iconSize,
      responsiveLayout.spotBorderRadius,
      responsiveLayout.spotCardHeight,
    ]
  );

  const btcDetailParams = useMemo<TradingPairDetailCardProps>(() => {
    return buildSpotDetailParams({
      response: dashboard.snapshot?.spotDetails.BTC || btcDetail.response,
      error: dashboard.error || btcDetail.error,
      preset: btcPreset,
      market: BTC_MARKET,
      visual: responsiveDetailVisual,
    });
  }, [
    btcDetail.error,
    btcDetail.response,
    dashboard.error,
    dashboard.snapshot?.spotDetails.BTC,
    responsiveDetailVisual,
  ]);

  const ethDetailParams = useMemo<TradingPairDetailCardProps>(() => {
    return buildSpotDetailParams({
      response: dashboard.snapshot?.spotDetails.ETH || ethDetail.response,
      error: dashboard.error || ethDetail.error,
      preset: ethPreset,
      market: ETH_MARKET,
      visual: responsiveDetailVisual,
    });
  }, [
    ethDetail.error,
    ethDetail.response,
    dashboard.error,
    dashboard.snapshot?.spotDetails.ETH,
    responsiveDetailVisual,
  ]);

  const assetAllocationParams = useMemo<AssetAllocationDonutCardProps>(() => {
    const dashboardItems = dashboard.snapshot?.portfolio.items || [];
    const displayItems = dashboardItems.length
      ? dashboardItems
      : assetAllocation.activeItems;
    const displayTotal = dashboardItems.length
      ? dashboard.snapshot?.portfolio.totalValueUsd || "0.00"
      : assetAllocation.activeTotalValueUsd;

    return {
      title: "资产分布",
      totalValueUsd: displayTotal,
      items: displayItems,
      selectedAsset: selectedAllocationAsset,
      onSelectAsset: setSelectedAllocationAsset,
      ...assetAllocationDonutDefaultVisual,
      cardHeight: responsiveLayout.heroPortfolioHeight,
      borderRadius: responsiveLayout.spotBorderRadius,
      cardWidth: responsiveLayout.heroAssetCardWidth,
    };
  }, [
    assetAllocation.activeItems,
    assetAllocation.activeTotalValueUsd,
    assetAllocation.gateStatus,
    dashboard.snapshot?.portfolio.items,
    dashboard.snapshot?.portfolio.totalValueUsd,
    responsiveLayout.heroAssetCardWidth,
    responsiveLayout.heroPortfolioHeight,
    responsiveLayout.spotBorderRadius,
    selectedAllocationAsset,
  ]);

  return (
    <div
      className={[
        "overflow-hidden bg-[#08090b] text-slate-100",
        hasPersistentSettingsShell ? "h-full w-full" : "h-[100dvh] w-screen",
      ].join(" ")}
    >
      <div className="pointer-events-none fixed inset-0 z-0 h-[100dvh] w-screen">
        <div
          className="fixed inset-0 h-[100dvh] w-screen bg-cover bg-center bg-no-repeat transition-opacity duration-500"
          style={{
            backgroundImage: fullBackgroundEnabled
              ? `url("${CRYPTO_CENTER_BACKGROUND_URL}")`
              : "none",
            opacity: fullBackgroundEnabled ? 1 : 0,
          }}
        />
        <div className="fixed inset-0 h-[100dvh] w-screen bg-[linear-gradient(180deg,rgba(5,5,5,.42),rgba(5,5,5,.72)),radial-gradient(circle_at_20%_0%,rgba(214,168,79,.14),transparent_34%)]" />
        <div className="fixed inset-0 h-[100dvh] w-screen bg-[#050505]/25" />
      </div>
      <main
        ref={sectionScroll.containerRef}
        className="relative z-10 h-full w-full overflow-y-auto overscroll-contain bg-transparent"
      >
        <div className="relative min-h-full overflow-hidden px-4 py-6 md:px-6 md:py-8">
          <div
            className="relative z-10 mx-auto min-h-[calc(100dvh-48px)] w-full"
            style={{ maxWidth: responsiveLayout.contentMaxWidth }}
          >
            <div className="grid w-full content-start gap-6 overflow-x-hidden pb-2">
              <section
                ref={sectionScroll.setSectionRef("overview-spot")}
                className="relative grid w-full scroll-mt-0 content-start gap-6"
                data-crypto-center-section="overview-spot"
                style={sectionScroll.getSectionStyle("overview-spot")}
              >
                <div
                  className="pointer-events-none absolute inset-x-0 z-20 rounded-full"
                  data-crypto-section-edge="true"
                  style={sectionScroll.getBoundaryEdgeStyle("overview-spot")}
                />
                <header className="w-full pt-1">
                  <h1 className="text-3xl font-black tracking-normal text-[#D6A84F] drop-shadow-[0_0_22px_rgba(214,168,79,.22)] md:text-5xl">
                    加密货币专区
                  </h1>
                  <p className="mt-2 text-sm font-semibold text-[#E8C46B]/70">
                    Crypto Center
                  </p>
                  <div className="mt-5 h-px w-full bg-gradient-to-r from-[#D6A84F]/85 via-[#D6A84F]/42 to-transparent shadow-[0_0_18px_rgba(214,168,79,.26)]" />
                </header>
                <div
                  className="grid w-full max-w-full items-start gap-6 xl:grid-cols-[var(--crypto-hero-columns)]"
                  style={
                    {
                      "--crypto-hero-columns": `${Math.min(
                        HERO_TOTAL_ASSET_CARD_WIDTH,
                        responsiveLayout.contentMaxWidth
                      )}px ${responsiveLayout.heroAssetCardWidth}px`,
                      maxWidth: responsiveLayout.contentMaxWidth,
                    } as React.CSSProperties
                  }
                >
                  <div
                    className="w-full min-w-0"
                    style={{
                      minHeight: responsiveLayout.heroPortfolioHeight,
                    }}
                  >
                    <CryptoTotalAssetCard {...totalAssetParams} />
                  </div>
                  <div
                    className="w-full min-w-0"
                    style={{
                      height: responsiveLayout.heroPortfolioHeight,
                    }}
                  >
                    {marketChartsEnabled ? (
                      <React.Suspense
                        fallback={
                          <CryptoComponentFallback
                            height={responsiveLayout.heroPortfolioHeight}
                            label="资产分布组件加载中"
                          />
                        }
                      >
                        <AssetAllocationDonutCard {...assetAllocationParams} />
                      </React.Suspense>
                    ) : (
                      <CryptoComponentFallback
                        height={responsiveLayout.heroPortfolioHeight}
                        label="资产分布稍后加载"
                      />
                    )}
                  </div>
                </div>
                <div className="grid gap-3 rounded-2xl border border-[#D6A84F]/12 bg-black/35 px-4 py-3 text-xs text-white/50 sm:grid-cols-3">
                  <div>
                    <span className="font-black text-[#E8C46B]/80">
                      Gate 实盘
                    </span>
                    <span className="ml-2">
                      $
                      {dashboard.snapshot?.portfolio.gate.totalValueUsd || "--"}
                    </span>
                  </div>
                  <div>
                    <span className="font-black text-[#E8C46B]/80">
                      补充持仓
                    </span>
                    <span className="ml-2">
                      $
                      {dashboard.snapshot?.portfolio.supplemental
                        .totalValueUsd || "--"}
                    </span>
                  </div>
                  <div>
                    <span className="font-black text-[#E8C46B]/80">
                      数据口径
                    </span>
                    <span className="ml-2">
                      补充持仓不计入 Gate 盈亏与成交历史
                    </span>
                  </div>
                </div>
                <PortfolioRiskCard snapshot={dashboard.snapshot} />
                <PortfolioAnalyticsCard snapshot={dashboard.snapshot} />
                <div className="h-px w-full bg-gradient-to-r from-[#D6A84F]/90 via-[#D6A84F]/45 to-transparent shadow-[0_0_20px_rgba(214,168,79,.28)]" />
                <div className="flex w-full items-end justify-between gap-6">
                  <div>
                    <h2 className="text-2xl font-black tracking-normal text-[#D6A84F] drop-shadow-[0_0_18px_rgba(214,168,79,.20)] md:text-3xl">
                      现货：BTC ETH专区
                    </h2>
                    <p className="mt-1 text-xs font-semibold uppercase tracking-normal text-[#E8C46B]/62">
                      Spot Market
                    </p>
                  </div>
                </div>
                <div
                  className="mx-auto flex w-full max-w-full flex-wrap items-start justify-center gap-6 overflow-x-hidden"
                  style={{ maxWidth: responsiveLayout.contentMaxWidth }}
                >
                  <div
                    className="shrink-0"
                    style={{
                      width: responsiveLayout.spotDetailWidth,
                      height: responsiveLayout.spotCardHeight,
                    }}
                  >
                    <React.Suspense
                      fallback={
                        <CryptoComponentFallback
                          height={responsiveLayout.spotCardHeight}
                          label="BTC 持仓组件加载中"
                        />
                      }
                    >
                      <TradingPairDetailCard {...btcDetailParams} />
                    </React.Suspense>
                  </div>
                  <div
                    className="min-w-0 flex-1"
                    data-crypto-section-scroll-ignore="true"
                    style={{
                      maxWidth: responsiveLayout.spotChartMaxWidth,
                      minWidth: Math.min(320, responsiveLayout.contentMaxWidth),
                      height: responsiveLayout.spotCardHeight,
                    }}
                  >
                    {marketChartsEnabled ? (
                      <React.Suspense
                        fallback={
                          <CryptoComponentFallback
                            height={responsiveLayout.spotCardHeight}
                            label="BTC K 线组件加载中"
                          />
                        }
                      >
                        <TradingPairCandlestickChart
                          mode="gate-api"
                          pair={BTC_PAIR}
                          range={btcRange}
                          market={BTC_MARKET}
                          baseAsset={btcPreset.baseAsset}
                          quoteAsset={btcPreset.quoteAsset}
                          symbol={btcPreset.symbol}
                          assetName={btcPreset.assetName}
                          assetNameCn={btcPreset.assetNameCn}
                          iconText={btcPreset.iconText}
                          iconImage={btcPreset.iconImage}
                          iconSize={responsiveCandlestickVisual.iconSize}
                          iconCropScale={
                            responsiveCandlestickVisual.iconCropScale
                          }
                          iconCropX={responsiveCandlestickVisual.iconCropX}
                          iconCropY={responsiveCandlestickVisual.iconCropY}
                          candles={btcCandlestick.activeCandles}
                          currentPriceQuote={btcCandlestick.currentPriceQuote}
                          currentPriceUsd={btcCandlestick.currentPriceQuote}
                          change24hPct={btcCandlestick.change24hPct}
                          status={btcCandlestick.status}
                          autoRefreshSeconds={30}
                          showVolume={responsiveCandlestickVisual.showVolume}
                          showCrosshair={
                            responsiveCandlestickVisual.showCrosshair
                          }
                          showCurrentPriceLine={
                            responsiveCandlestickVisual.showCurrentPriceLine
                          }
                          showGrid={responsiveCandlestickVisual.showGrid}
                          compactMode={responsiveCandlestickVisual.compactMode}
                          cardHeight={responsiveCandlestickVisual.cardHeight}
                          borderRadius={
                            responsiveCandlestickVisual.borderRadius
                          }
                          glowIntensity={
                            responsiveCandlestickVisual.glowIntensity
                          }
                          accentColor={responsiveCandlestickVisual.accentColor}
                          loading={btcCandlestick.loading}
                          historyLoading={btcCandlestick.historyLoading}
                          error={btcCandlestick.error}
                          onRangeChange={setBtcRange}
                          onLoadMoreHistory={btcCandlestick.loadMoreHistory}
                        />
                      </React.Suspense>
                    ) : (
                      <CryptoComponentFallback
                        height={responsiveLayout.spotCardHeight}
                        label="BTC K 线稍后加载"
                      />
                    )}
                  </div>
                </div>
                <div
                  className="mx-auto h-px w-full bg-gradient-to-r from-[#D6A84F]/90 via-[#D6A84F]/45 to-transparent shadow-[0_0_20px_rgba(214,168,79,.28)]"
                  style={{ maxWidth: responsiveLayout.contentMaxWidth }}
                />
                <div
                  className="mx-auto flex w-full max-w-full flex-wrap items-start justify-center gap-6 overflow-x-hidden"
                  style={{ maxWidth: responsiveLayout.contentMaxWidth }}
                >
                  <div
                    className="shrink-0"
                    style={{
                      width: responsiveLayout.spotDetailWidth,
                      height: responsiveLayout.spotCardHeight,
                    }}
                  >
                    <React.Suspense
                      fallback={
                        <CryptoComponentFallback
                          height={responsiveLayout.spotCardHeight}
                          label="ETH 持仓组件加载中"
                        />
                      }
                    >
                      <TradingPairDetailCard {...ethDetailParams} />
                    </React.Suspense>
                  </div>
                  <div
                    className="min-w-0 flex-1"
                    data-crypto-section-scroll-ignore="true"
                    style={{
                      maxWidth: responsiveLayout.spotChartMaxWidth,
                      minWidth: Math.min(320, responsiveLayout.contentMaxWidth),
                      height: responsiveLayout.spotCardHeight,
                    }}
                  >
                    {marketChartsEnabled ? (
                      <React.Suspense
                        fallback={
                          <CryptoComponentFallback
                            height={responsiveLayout.spotCardHeight}
                            label="ETH K 线组件加载中"
                          />
                        }
                      >
                        <TradingPairCandlestickChart
                          mode="gate-api"
                          pair={ETH_PAIR}
                          range={ethRange}
                          market={ETH_MARKET}
                          baseAsset={ethPreset.baseAsset}
                          quoteAsset={ethPreset.quoteAsset}
                          symbol={ethPreset.symbol}
                          assetName={ethPreset.assetName}
                          assetNameCn={ethPreset.assetNameCn}
                          iconText={ethPreset.iconText}
                          iconImage={ethPreset.iconImage}
                          iconSize={responsiveCandlestickVisual.iconSize}
                          iconCropScale={
                            responsiveCandlestickVisual.iconCropScale
                          }
                          iconCropX={responsiveCandlestickVisual.iconCropX}
                          iconCropY={responsiveCandlestickVisual.iconCropY}
                          candles={ethCandlestick.activeCandles}
                          currentPriceQuote={ethCandlestick.currentPriceQuote}
                          currentPriceUsd={ethCandlestick.currentPriceQuote}
                          change24hPct={ethCandlestick.change24hPct}
                          status={ethCandlestick.status}
                          autoRefreshSeconds={30}
                          showVolume={responsiveCandlestickVisual.showVolume}
                          showCrosshair={
                            responsiveCandlestickVisual.showCrosshair
                          }
                          showCurrentPriceLine={
                            responsiveCandlestickVisual.showCurrentPriceLine
                          }
                          showGrid={responsiveCandlestickVisual.showGrid}
                          compactMode={responsiveCandlestickVisual.compactMode}
                          cardHeight={responsiveCandlestickVisual.cardHeight}
                          borderRadius={
                            responsiveCandlestickVisual.borderRadius
                          }
                          glowIntensity={
                            responsiveCandlestickVisual.glowIntensity
                          }
                          accentColor={ethPreset.accentColor}
                          chartBackgroundImage={ETH_CHART_BACKGROUND_URL}
                          loading={ethCandlestick.loading}
                          historyLoading={ethCandlestick.historyLoading}
                          error={ethCandlestick.error}
                          onRangeChange={setEthRange}
                          onLoadMoreHistory={ethCandlestick.loadMoreHistory}
                        />
                      </React.Suspense>
                    ) : (
                      <CryptoComponentFallback
                        height={responsiveLayout.spotCardHeight}
                        label="ETH K 线稍后加载"
                      />
                    )}
                  </div>
                </div>
                <div
                  className="mx-auto h-px w-full bg-gradient-to-r from-[#D6A84F]/90 via-[#D6A84F]/45 to-transparent shadow-[0_0_20px_rgba(214,168,79,.28)]"
                  data-crypto-section-gate="overview-spot-to-top-assets"
                  style={{ maxWidth: responsiveLayout.contentMaxWidth }}
                />
              </section>
              <section
                ref={setTopAssetsSectionNode}
                className="relative grid w-full scroll-mt-0 content-start gap-6"
                data-crypto-center-section="top-assets"
                style={sectionScroll.getSectionStyle("top-assets")}
              >
                <div
                  className="pointer-events-none absolute inset-x-0 z-20 rounded-full"
                  data-crypto-section-edge="true"
                  style={sectionScroll.getBoundaryEdgeStyle("top-assets")}
                />
                <div className="flex w-full items-end justify-between gap-6">
                  <div>
                    <h2 className="text-2xl font-black tracking-normal text-[#D6A84F] drop-shadow-[0_0_18px_rgba(214,168,79,.20)] md:text-3xl">
                      现货前六资产专区
                    </h2>
                    <p className="mt-1 text-xs font-semibold uppercase tracking-normal text-[#E8C46B]/62">
                      Top Spot Assets
                    </p>
                  </div>
                  {topSpotAssets.status === "loading" ? (
                    <div className="rounded-full border border-[#D6A84F]/20 bg-[#D6A84F]/10 px-4 py-2 text-xs font-black text-[#E8C46B]/75">
                      加载中
                    </div>
                  ) : topSpotAssets.status === "error" ? (
                    <div className="max-w-[420px] truncate rounded-full border border-red-400/20 bg-red-500/10 px-4 py-2 text-xs font-black text-red-200/80">
                      {topSpotAssets.error || "前六资产读取失败"}
                    </div>
                  ) : null}
                </div>
                <div
                  className="mx-auto w-full max-w-full overflow-x-hidden"
                  style={{ maxWidth: responsiveLayout.contentMaxWidth }}
                >
                  {!topAssetsEnabled ? (
                    <CryptoComponentFallback
                      height={responsiveLayout.topSpotCardHeight}
                      label="继续向下时加载前六资产"
                    />
                  ) : topSpotAssets.assets.length ? (
                    <AnimatedTopSpotAssetGrid
                      assets={topSpotAssets.assets}
                      cardHeight={responsiveLayout.topSpotCardHeight}
                      enabled={topAssetsEnabled}
                    />
                  ) : (
                    <div className="flex h-40 items-center justify-center rounded-[24px] border border-[#D6A84F]/15 bg-black/20 text-sm font-bold text-[#E8C46B]/60">
                      正在读取 Gate 现货资产...
                    </div>
                  )}
                </div>
                <div
                  className="mx-auto h-px w-full bg-gradient-to-r from-[#D6A84F]/90 via-[#D6A84F]/45 to-transparent shadow-[0_0_20px_rgba(214,168,79,.28)]"
                  data-crypto-section-gate="top-assets-to-futures-trading"
                  style={{ maxWidth: responsiveLayout.contentMaxWidth }}
                />
              </section>
              <section
                ref={setFuturesSectionNode}
                className="relative grid w-full scroll-mt-0 content-start gap-6"
                data-crypto-center-section="futures-trading"
                style={sectionScroll.getSectionStyle("futures-trading")}
              >
                <div
                  className="pointer-events-none absolute inset-x-0 z-20 rounded-full"
                  data-crypto-section-edge="true"
                  style={sectionScroll.getBoundaryEdgeStyle("futures-trading")}
                />
                <div className="flex w-full items-end justify-between gap-6">
                  <div>
                    <h2 className="text-2xl font-black tracking-normal text-[#D6A84F] drop-shadow-[0_0_18px_rgba(214,168,79,.20)] md:text-3xl">
                      合约与交易详情专区
                    </h2>
                    <p className="mt-1 text-xs font-semibold uppercase tracking-normal text-[#E8C46B]/62">
                      Futures & Trading Details
                    </p>
                  </div>
                </div>
                {futuresEnabled ? (
                  <React.Suspense
                    fallback={
                      <>
                        <div
                          className="mx-auto w-full max-w-full overflow-x-hidden"
                          style={{ maxWidth: responsiveLayout.contentMaxWidth }}
                        >
                          <CryptoComponentFallback
                            height={responsiveLayout.futuresPositionsHeight}
                            label="合约组件加载中"
                          />
                        </div>
                        <div
                          className="mx-auto w-full max-w-full overflow-x-hidden"
                          style={{ maxWidth: responsiveLayout.contentMaxWidth }}
                        >
                          <CryptoComponentFallback
                            height={responsiveLayout.tradeRecordsHeight}
                            label="交易明细组件加载中"
                          />
                        </div>
                      </>
                    }
                  >
                    <FuturesTradingSection
                      contentMaxWidth={responsiveLayout.contentMaxWidth}
                      positionsHeight={responsiveLayout.futuresPositionsHeight}
                      visiblePositionCount={OPEN_FUTURES_VISIBLE_POSITION_COUNT}
                      tradeRecordsHeight={responsiveLayout.tradeRecordsHeight}
                    />
                  </React.Suspense>
                ) : (
                  <>
                    <div
                      className="mx-auto w-full max-w-full overflow-x-hidden"
                      style={{ maxWidth: responsiveLayout.contentMaxWidth }}
                    >
                      <CryptoComponentFallback
                        height={responsiveLayout.futuresPositionsHeight}
                        label="继续向下时加载合约数据"
                      />
                    </div>
                    <div
                      className="mx-auto w-full max-w-full overflow-x-hidden"
                      style={{ maxWidth: responsiveLayout.contentMaxWidth }}
                    >
                      <CryptoComponentFallback
                        height={responsiveLayout.tradeRecordsHeight}
                        label="继续向下时加载交易明细"
                      />
                    </div>
                  </>
                )}
              </section>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
