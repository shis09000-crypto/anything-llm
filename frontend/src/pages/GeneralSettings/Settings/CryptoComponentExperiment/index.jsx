import React, { useState } from "react";
import Sidebar from "@/components/SettingsSidebar";
import { CurrencyBtc } from "@phosphor-icons/react";
import { isMobile } from "react-device-detect";
import BtcSpotAssetCardExperiment from "./BtcSpotAssetCardExperiment";
import CryptoTotalAssetCardExperiment from "./CryptoTotalAssetCardExperiment";
import TradingPairCandlestickChartExperiment from "./TradingPairCandlestickChartExperiment";
import TradingPairDetailCardExperiment from "./TradingPairDetailCardExperiment";

const experimentTabs = [
  { id: "total-asset", label: "总资产组件实验", hint: "Crypto Portfolio" },
  { id: "btc-spot", label: "BTC 现货卡片实验", hint: "BTC Spot Card" },
  {
    id: "trading-pair-detail",
    label: "通用交易对详情组件实验",
    hint: "Trading Pair Detail",
  },
  {
    id: "trading-pair-candlestick",
    label: "交易对K线趋势图实验",
    hint: "Candlestick Chart",
  },
];

export default function CryptoComponentExperiment() {
  const [activeExperiment, setActiveExperiment] = useState(
    "trading-pair-candlestick"
  );

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll p-4 md:p-0"
      >
        <div className="flex w-full flex-col px-1 py-16 md:py-6 md:pl-6 md:pr-[86px]">
          <div className="w-full border-b-2 border-white border-opacity-10 pb-6 light:border-theme-sidebar-border">
            <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full border border-[#D6A84F]/60 bg-[#D6A84F]/10 text-[#D6A84F] shadow-[0_10px_28px_rgb(214_168_79_/_0.14)]">
                  <CurrencyBtc className="h-5 w-5" weight="bold" />
                </div>
                <div>
                  <p className="text-lg font-bold leading-6 text-white light:text-slate-950">
                    加密组件实验 / Crypto Component Experiment
                  </p>
                  <p className="mt-1 text-xs leading-[18px] text-white/60 light:text-slate-500">
                    预览未来 Crypto Center 组件；支持 mock 参数与只读 Gate
                    实验数据。
                  </p>
                </div>
              </div>

              <div className="w-fit rounded-full border border-[#D6A84F]/25 bg-[#D6A84F]/10 px-4 py-2 text-xs font-bold text-[#D6A84F]">
                Appearance Sandbox
              </div>
            </div>
          </div>

          <div className="mt-6">
            <div className="mb-5 grid gap-3 rounded-[22px] border border-white/10 bg-white/[.035] p-2 shadow-[0_18px_44px_rgb(0_0_0_/_0.12)] light:border-slate-200 light:bg-white/70 md:grid-cols-4">
              {experimentTabs.map((tab) => {
                const active = activeExperiment === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveExperiment(tab.id)}
                    className={[
                      "rounded-[18px] px-4 py-3 text-left transition",
                      active
                        ? "border border-[#D6A84F]/35 bg-[#D6A84F]/15 text-[#F8FAFC] shadow-[0_14px_34px_rgb(214_168_79_/_0.12)] light:text-slate-950"
                        : "border border-transparent text-white/55 hover:bg-white/[.04] light:text-slate-500 light:hover:bg-slate-100",
                    ].join(" ")}
                  >
                    <div className="text-sm font-bold">{tab.label}</div>
                    <div className="mt-1 text-xs font-semibold opacity-70">
                      {tab.hint}
                    </div>
                  </button>
                );
              })}
            </div>

            {activeExperiment === "total-asset" ? (
              <CryptoTotalAssetCardExperiment />
            ) : activeExperiment === "btc-spot" ? (
              <BtcSpotAssetCardExperiment />
            ) : activeExperiment === "trading-pair-candlestick" ? (
              <TradingPairCandlestickChartExperiment />
            ) : (
              <TradingPairDetailCardExperiment />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
