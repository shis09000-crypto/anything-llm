import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import CryptoHubLoadingOverlay from "@/components/CryptoHubLoadingOverlay";
import { useSoftSettingsShell } from "@/components/SoftSettings/context";
import { useMotion } from "@/contexts/MotionProvider";
import { useCryptoHubInit } from "@/hooks/cryptoHub/useCryptoHubInit";
import { cryptoHubFetch } from "@/hooks/cryptoHub/useCryptoHubQuery";
import AssetAllocationDonutCard from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/AssetAllocationDonutCard";
import CryptoTotalAssetCard from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/CryptoTotalAssetCard";
import OpenFuturesPositionsCard from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/OpenFuturesPositionsCard";
import TradeRecordsTable from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/TradeRecordsTable";
import TradingPairDetailCard from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/TradingPairDetailCard";
import TradingPairCandlestickChart from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/TradingPairCandlestickChart";
import {
  mockOpenFuturesPositions,
  mockOpenFuturesSummary,
} from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/openFuturesPositionsMockData";
import {
  presetById,
  tradingPairMockPresets,
} from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/tradingPairMockPresets";
import { useTradingPairCandlestickData } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/useTradingPairCandlestickData";
import { useAssetAllocationDonutData } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/useAssetAllocationDonutData";
import { useOpenFuturesPositionsData } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/useOpenFuturesPositionsData";
import { useTradeRecordsTableController } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/useTradeRecordsTableController";
import { useTradingPairDetailData } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/useTradingPairDetailData";
import { assetAllocationDonutDefaultVisual } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/assetAllocationDonutVisual";
import type { AssetAllocationDonutCardProps } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/assetAllocationDonutTypes";
import type {
  CryptoTotalAssetCardProps,
  CryptoTrendPoint,
} from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/cryptoTotalAssetTypes";
import type { OpenFuturesPositionsCardProps } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/openFuturesPositionsTypes";
import type { TradingPairCandlestickRange } from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/tradingPairCandlestickTypes";
import type {
  TradingPairDetailCardProps,
  TradingPairDetailResponse,
  TradingPairMarketType,
  TradingPairPreset,
} from "@/pages/GeneralSettings/Settings/CryptoComponentExperiment/tradingPairDetailTypes";

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
const SECTION_SCROLL_TUNING = {
  minWidth: 900,
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
    const query = window.matchMedia(
      `(min-width: ${tuning.minWidth}px) and (pointer: fine)`
    );
    const update = () => setSupportsSectionScroll(query.matches);

    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, [tuning.minWidth]);

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

function useTopSpotAssets() {
  const [state, setState] = useState<TopSpotAssetsState>({
    assets: [],
    status: "idle",
    error: null,
    asOf: null,
  });

  useEffect(() => {
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
        const payload = await cryptoHubFetch<TopSpotAssetsResponse>(
          `/top-assets?${query.toString()}`
        );
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
      }, 10_000);
    }

    loadTopAssets();
    schedule();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

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

function timestampFromTime(time: string) {
  const [hour = "0", minute = "0", second = "0"] = time.split(":");
  const date = new Date();
  date.setHours(Number(hour), Number(minute), Number(second), 0);
  return date.getTime();
}

function buildSpotDetailParams({
  response,
  error,
  preset,
  market,
  currentTime,
  visual,
}: {
  response: TradingPairDetailResponse | null;
  error: string | null;
  preset: TradingPairPreset;
  market: TradingPairMarketType;
  currentTime: string;
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
    holdingValueQuote: real
      ? response?.holdingValueQuote || preset.holdingValueQuote
      : preset.holdingValueQuote,
    holdingValueUsd: real
      ? (response?.holdingValueUsd ?? preset.holdingValueUsd)
      : preset.holdingValueUsd,
    change24hPct: real ? (response?.change24hPct ?? null) : preset.change24hPct,
    change24hQuote: real
      ? (response?.change24hQuote ?? null)
      : preset.change24hQuote,
    averageBuyPriceQuote: real
      ? (response?.averageBuyPriceQuote ?? null)
      : preset.averageBuyPriceQuote || null,
    averageBuyPriceMethod: real
      ? response?.averageBuyPriceMethod || "unknown"
      : preset.averageBuyPriceMethod,
    averageBuyPriceScope: real
      ? response?.averageBuyPriceScope || "unknown"
      : "full",
    currentPriceQuote: real
      ? response?.currentPriceQuote || preset.currentPriceQuote
      : preset.currentPriceQuote,
    holdingAmountBase: real
      ? response?.holdingAmountBase || preset.holdingAmountBase
      : preset.holdingAmountBase,
    lastUpdatedAt: real
      ? response?.lastUpdatedAt || response?.asOf || null
      : timestampFromTime(currentTime),
    connectionStatus: real
      ? response?.connectionStatus || "connected"
      : error
        ? "degraded"
        : "degraded",
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
  currentTime,
}: {
  asset: TopSpotAsset;
  cardWidth: number;
  currentTime: string;
}) {
  const preset = useMemo(() => presetForTopSpotAsset(asset), [asset]);
  const detail = useTradingPairDetailData({
    mode: "gate-api",
    pair: asset.pair,
    market: "spot",
  });
  const visual = useMemo(
    () => ({
      ...btcDetailVisual,
      cardWidth,
      cardHeight: TOP_SPOT_CARD_HEIGHT,
    }),
    [cardWidth]
  );
  const params = useMemo<TradingPairDetailCardProps>(() => {
    return buildSpotDetailParams({
      response: detail.response,
      error: detail.error,
      preset,
      market: "spot",
      currentTime,
      visual,
    });
  }, [currentTime, detail.error, detail.response, preset, visual]);

  return <TradingPairDetailCard {...params} />;
}

function AnimatedTopSpotAssetGrid({
  assets,
  currentTime,
}: {
  assets: TopSpotAsset[];
  currentTime: string;
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
              height: TOP_SPOT_CARD_HEIGHT,
            } as React.CSSProperties
          }
        >
          <TopSpotAssetDetailCard
            asset={asset}
            cardWidth={cardWidth}
            currentTime={currentTime}
          />
        </div>
      ))}
    </div>
  );
}

export default function CryptoCenter() {
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
  const {
    progress: hubProgress,
    error: hubError,
    ready: hubReady,
    retry: retryHubInit,
  } = useCryptoHubInit();
  const btcDetail = useTradingPairDetailData({
    mode: "gate-api",
    pair: BTC_PAIR,
    market: BTC_MARKET,
  });
  const btcCandlestick = useTradingPairCandlestickData({
    mode: "gate-api",
    pair: BTC_PAIR,
    range: btcRange,
    market: BTC_MARKET,
    currentPriceFallback: btcPreset.currentPriceQuote,
    change24hPctFallback: btcPreset.change24hPct,
  });
  const ethDetail = useTradingPairDetailData({
    mode: "gate-api",
    pair: ETH_PAIR,
    market: ETH_MARKET,
  });
  const ethCandlestick = useTradingPairCandlestickData({
    mode: "gate-api",
    pair: ETH_PAIR,
    range: ethRange,
    market: ETH_MARKET,
    currentPriceFallback: ethPreset.currentPriceQuote,
    change24hPctFallback: ethPreset.change24hPct,
  });
  const topSpotAssets = useTopSpotAssets();
  const assetAllocation = useAssetAllocationDonutData({
    initialMode: "gate",
  });
  const openFuturesPositions = useOpenFuturesPositionsData({
    mode: "gate-api",
    mockPositions: mockOpenFuturesPositions,
    mockSummary: mockOpenFuturesSummary,
  });
  const tradeRecordsController = useTradeRecordsTableController({
    mode: "gate-api",
    initialRangePreset: "30d",
    initialPageSize: 10,
  });
  const sectionScroll = useCryptoCenterSectionScroll(CRYPTO_CENTER_SECTION_IDS);

  useEffect(() => {
    gateHistoryRef.current = gateHistory;
  }, [gateHistory]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setCurrentDateTime(currentShanghaiDateTime());
    }, 1_000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
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

        const payload = await cryptoHubFetch<{
          success: boolean;
          history?: GateEquityHistory;
          error?: string;
        }>(`/equity-history?${query.toString()}`, {
          signal: controller.signal,
        });
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

    loadHistory();
    timer = window.setInterval(loadHistory, 500);

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
      inflightController?.abort();
    };
  }, [equityMode]);

  const totalAssetParams = useMemo<CryptoTotalAssetCardProps>(() => {
    const timeStampedParams = {
      ...defaultTotalAssetParams,
      lastUpdatedAt: currentDateTime.time,
      lastUpdatedDate: currentDateTime.date,
      connectionStatus:
        gateHistoryStatus === "connected"
          ? ("connected" as const)
          : gateHistoryStatus === "error"
            ? ("disconnected" as const)
            : ("degraded" as const),
    };

    if (!gateHistory) return timeStampedParams;

    return {
      ...timeStampedParams,
      totalEquityUsd: gateHistory.latestEquityUsd,
      todayPnlUsd: gateHistory.todayPnlUsd,
      todayPnlPct: gateHistory.todayPnlPct,
      yesterdayBaselineUsd: gateHistory.yesterdayBaselineUsd,
      yesterdayChangePct: gateHistory.yesterdayChangePct,
      trendPoints: gateHistory.points,
    };
  }, [currentDateTime, gateHistory, gateHistoryStatus]);

  const btcDetailParams = useMemo<TradingPairDetailCardProps>(() => {
    return buildSpotDetailParams({
      response: btcDetail.response,
      error: btcDetail.error,
      preset: btcPreset,
      market: BTC_MARKET,
      currentTime: currentDateTime.time,
      visual: btcDetailVisual,
    });
  }, [btcDetail.error, btcDetail.response, currentDateTime.time]);

  const ethDetailParams = useMemo<TradingPairDetailCardProps>(() => {
    return buildSpotDetailParams({
      response: ethDetail.response,
      error: ethDetail.error,
      preset: ethPreset,
      market: ETH_MARKET,
      currentTime: currentDateTime.time,
      visual: btcDetailVisual,
    });
  }, [ethDetail.error, ethDetail.response, currentDateTime.time]);

  const assetAllocationParams = useMemo<AssetAllocationDonutCardProps>(
    () => ({
      title: "资产分布",
      totalValueUsd: assetAllocation.activeTotalValueUsd,
      items: assetAllocation.activeItems,
      selectedAsset: selectedAllocationAsset,
      onSelectAsset: setSelectedAllocationAsset,
      ...assetAllocationDonutDefaultVisual,
      cardHeight: HERO_PORTFOLIO_CARD_HEIGHT,
      borderRadius: 23,
      cardWidth: HERO_ASSET_ALLOCATION_CARD_WIDTH,
    }),
    [
      assetAllocation.activeItems,
      assetAllocation.activeTotalValueUsd,
      selectedAllocationAsset,
    ]
  );

  const openFuturesPositionsParams = useMemo<OpenFuturesPositionsCardProps>(
    () => ({
      positions: openFuturesPositions.positions,
      summary: openFuturesPositions.summary,
      filterLabel: "全部合约",
      lastUpdatedAt: openFuturesPositions.lastUpdatedAt,
      loading: openFuturesPositions.loading,
      error: openFuturesPositions.error,
      status: openFuturesPositions.status,
      onRefresh: openFuturesPositions.refresh,
      cardWidth: BTC_SPOT_CONTENT_MAX_WIDTH,
      cardHeight: OPEN_FUTURES_POSITIONS_CARD_HEIGHT,
      visiblePositionCount: OPEN_FUTURES_VISIBLE_POSITION_COUNT,
      borderRadius: 28,
      compactMode: false,
      showSummaryFooter: true,
      showLeverageBars: true,
    }),
    [openFuturesPositions]
  );

  return (
    <div
      className={[
        "overflow-hidden bg-[#08090b] text-slate-100",
        hasPersistentSettingsShell ? "h-full w-full" : "h-screen w-screen",
      ].join(" ")}
    >
      <div className="pointer-events-none fixed inset-0 z-0 h-screen w-screen">
        <div
          className="fixed inset-0 h-screen w-screen bg-cover bg-center bg-no-repeat"
          style={{
            backgroundImage: `url("${CRYPTO_CENTER_BACKGROUND_URL}")`,
          }}
        />
        <div className="fixed inset-0 h-screen w-screen bg-[linear-gradient(180deg,rgba(5,5,5,.42),rgba(5,5,5,.72)),radial-gradient(circle_at_20%_0%,rgba(214,168,79,.14),transparent_34%)]" />
        <div className="fixed inset-0 h-screen w-screen bg-[#050505]/25" />
      </div>
      <main
        ref={sectionScroll.containerRef}
        className="relative z-10 h-full w-full overflow-y-auto bg-transparent"
      >
        <div className="relative min-h-full overflow-hidden px-4 py-6 md:px-6 md:py-8">
          <div
            className="relative z-10 mx-auto min-h-[calc(100vh-48px)] w-full"
            style={{ maxWidth: BTC_SPOT_CONTENT_MAX_WIDTH }}
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
                      "--crypto-hero-columns": `${HERO_TOTAL_ASSET_CARD_WIDTH}px ${HERO_ASSET_ALLOCATION_CARD_WIDTH}px`,
                      maxWidth: BTC_SPOT_CONTENT_MAX_WIDTH,
                    } as React.CSSProperties
                  }
                >
                  <div className="min-h-[380px] w-full min-w-0 xl:h-[380px] xl:w-[640px]">
                    <CryptoTotalAssetCard {...totalAssetParams} />
                  </div>
                  <div className="h-[380px] w-full min-w-0 xl:w-[560px]">
                    <AssetAllocationDonutCard {...assetAllocationParams} />
                  </div>
                </div>
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
                  className="mx-auto flex w-full max-w-full items-start justify-center gap-6 overflow-x-hidden"
                  style={{ maxWidth: BTC_SPOT_CONTENT_MAX_WIDTH }}
                >
                  <div
                    className="shrink-0"
                    style={{
                      width: BTC_SPOT_DETAIL_CARD_WIDTH,
                      height: BTC_SPOT_CARD_HEIGHT,
                    }}
                  >
                    <TradingPairDetailCard {...btcDetailParams} />
                  </div>
                  <div
                    className="min-w-0 flex-1"
                    data-crypto-section-scroll-ignore="true"
                    style={{
                      maxWidth: BTC_SPOT_CHART_MAX_WIDTH,
                      height: BTC_SPOT_CARD_HEIGHT,
                    }}
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
                      iconSize={btcCandlestickVisual.iconSize}
                      iconCropScale={btcCandlestickVisual.iconCropScale}
                      iconCropX={btcCandlestickVisual.iconCropX}
                      iconCropY={btcCandlestickVisual.iconCropY}
                      candles={btcCandlestick.activeCandles}
                      currentPriceQuote={btcCandlestick.currentPriceQuote}
                      currentPriceUsd={btcCandlestick.currentPriceQuote}
                      change24hPct={btcCandlestick.change24hPct}
                      status={btcCandlestick.status}
                      autoRefreshSeconds={30}
                      showVolume={btcCandlestickVisual.showVolume}
                      showCrosshair={btcCandlestickVisual.showCrosshair}
                      showCurrentPriceLine={
                        btcCandlestickVisual.showCurrentPriceLine
                      }
                      showGrid={btcCandlestickVisual.showGrid}
                      compactMode={btcCandlestickVisual.compactMode}
                      cardHeight={btcCandlestickVisual.cardHeight}
                      borderRadius={btcCandlestickVisual.borderRadius}
                      glowIntensity={btcCandlestickVisual.glowIntensity}
                      accentColor={btcCandlestickVisual.accentColor}
                      loading={btcCandlestick.loading}
                      historyLoading={btcCandlestick.historyLoading}
                      error={btcCandlestick.error}
                      onRangeChange={setBtcRange}
                      onLoadMoreHistory={btcCandlestick.loadMoreHistory}
                    />
                  </div>
                </div>
                <div
                  className="mx-auto h-px w-full bg-gradient-to-r from-[#D6A84F]/90 via-[#D6A84F]/45 to-transparent shadow-[0_0_20px_rgba(214,168,79,.28)]"
                  style={{ maxWidth: BTC_SPOT_CONTENT_MAX_WIDTH }}
                />
                <div
                  className="mx-auto flex w-full max-w-full items-start justify-center gap-6 overflow-x-hidden"
                  style={{ maxWidth: BTC_SPOT_CONTENT_MAX_WIDTH }}
                >
                  <div
                    className="shrink-0"
                    style={{
                      width: BTC_SPOT_DETAIL_CARD_WIDTH,
                      height: BTC_SPOT_CARD_HEIGHT,
                    }}
                  >
                    <TradingPairDetailCard {...ethDetailParams} />
                  </div>
                  <div
                    className="min-w-0 flex-1"
                    data-crypto-section-scroll-ignore="true"
                    style={{
                      maxWidth: BTC_SPOT_CHART_MAX_WIDTH,
                      height: BTC_SPOT_CARD_HEIGHT,
                    }}
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
                      iconSize={btcCandlestickVisual.iconSize}
                      iconCropScale={btcCandlestickVisual.iconCropScale}
                      iconCropX={btcCandlestickVisual.iconCropX}
                      iconCropY={btcCandlestickVisual.iconCropY}
                      candles={ethCandlestick.activeCandles}
                      currentPriceQuote={ethCandlestick.currentPriceQuote}
                      currentPriceUsd={ethCandlestick.currentPriceQuote}
                      change24hPct={ethCandlestick.change24hPct}
                      status={ethCandlestick.status}
                      autoRefreshSeconds={30}
                      showVolume={btcCandlestickVisual.showVolume}
                      showCrosshair={btcCandlestickVisual.showCrosshair}
                      showCurrentPriceLine={
                        btcCandlestickVisual.showCurrentPriceLine
                      }
                      showGrid={btcCandlestickVisual.showGrid}
                      compactMode={btcCandlestickVisual.compactMode}
                      cardHeight={btcCandlestickVisual.cardHeight}
                      borderRadius={btcCandlestickVisual.borderRadius}
                      glowIntensity={btcCandlestickVisual.glowIntensity}
                      accentColor={ethPreset.accentColor}
                      chartBackgroundImage={ETH_CHART_BACKGROUND_URL}
                      loading={ethCandlestick.loading}
                      historyLoading={ethCandlestick.historyLoading}
                      error={ethCandlestick.error}
                      onRangeChange={setEthRange}
                      onLoadMoreHistory={ethCandlestick.loadMoreHistory}
                    />
                  </div>
                </div>
                <div
                  className="mx-auto h-px w-full bg-gradient-to-r from-[#D6A84F]/90 via-[#D6A84F]/45 to-transparent shadow-[0_0_20px_rgba(214,168,79,.28)]"
                  data-crypto-section-gate="overview-spot-to-top-assets"
                  style={{ maxWidth: BTC_SPOT_CONTENT_MAX_WIDTH }}
                />
              </section>
              <section
                ref={sectionScroll.setSectionRef("top-assets")}
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
                  style={{ maxWidth: BTC_SPOT_CONTENT_MAX_WIDTH }}
                >
                  {topSpotAssets.assets.length ? (
                    <AnimatedTopSpotAssetGrid
                      assets={topSpotAssets.assets}
                      currentTime={currentDateTime.time}
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
                  style={{ maxWidth: BTC_SPOT_CONTENT_MAX_WIDTH }}
                />
              </section>
              <section
                ref={sectionScroll.setSectionRef("futures-trading")}
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
                <div
                  className="mx-auto w-full max-w-full overflow-x-hidden"
                  style={{ maxWidth: BTC_SPOT_CONTENT_MAX_WIDTH }}
                >
                  <OpenFuturesPositionsCard {...openFuturesPositionsParams} />
                </div>
                <div
                  className="mx-auto w-full max-w-full overflow-x-hidden"
                  style={{ maxWidth: BTC_SPOT_CONTENT_MAX_WIDTH }}
                >
                  <TradeRecordsTable
                    {...tradeRecordsController.tableProps}
                    cardWidth={BTC_SPOT_CONTENT_MAX_WIDTH}
                    cardHeight={TRADE_RECORDS_CARD_HEIGHT}
                    borderRadius={28}
                    compactMode={false}
                  />
                </div>
              </section>
            </div>
          </div>
        </div>
      </main>
      {!hubReady ? (
        <CryptoHubLoadingOverlay
          progress={hubProgress}
          error={hubError}
          onRetry={retryHubInit}
        />
      ) : null}
    </div>
  );
}
