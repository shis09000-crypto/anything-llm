import React, { useState } from "react";
import Sidebar from "@/components/SettingsSidebar";
import AppButton from "@/components/lib/AppButton";
import AppToast, { AppToastViewport } from "@/components/lib/AppToast";
import showToast from "@/utils/toast";
import { isMobile } from "react-device-detect";
import {
  ArrowDown,
  ArrowRight,
  Check,
  Sparkle,
  Star,
} from "@phosphor-icons/react";

const SIZE_VARIABLES = [
  "--app-button-sm-height",
  "--app-button-md-height",
  "--app-button-lg-height",
  "--app-button-sm-px",
  "--app-button-md-px",
  "--app-button-lg-px",
  "--app-button-sm-font-size",
  "--app-button-md-font-size",
  "--app-button-lg-font-size",
  "--app-button-sm-icon-size",
  "--app-button-md-icon-size",
  "--app-button-lg-icon-size",
  "--app-button-sm-icon-gap",
  "--app-button-md-icon-gap",
  "--app-button-lg-icon-gap",
  "--app-button-radius",
];

const SECONDARY_FIXED_TOKENS = [
  "--app-button-secondary-start: #ffffff",
  "--app-button-secondary-mid: #f8fafc",
  "--app-button-secondary-end: #e2e8f0",
  "--app-button-secondary-text: #334155",
  "--app-button-secondary-border-alpha: 0.78",
  "--app-button-secondary-shadow-alpha: 0.1",
  "--app-button-secondary-highlight-opacity: 0.62",
];

const TOAST_FIXED_TOKENS = [
  "--app-toast-width: 400px",
  "--app-toast-radius: 22px",
  "--app-toast-padding-x: 18px",
  "--app-toast-padding-y: 16px",
  "--app-toast-bg-alpha: 0.73",
  "--app-toast-border-alpha: 0.45",
  "--app-toast-shadow-alpha: 0.13",
  "--app-toast-blur: 13px",
  "--app-toast-progress-height: 4px",
  "--app-toast-icon-size: 35px",
  "--app-toast-title-size: 15px",
  "--app-toast-description-size: 13px",
  "--app-toast-success-color: #22c55e",
  "--app-toast-info-color: #3b82f6",
  "--app-toast-warning-color: #f59e0b",
  "--app-toast-error-color: #ef4444",
  "--app-toast-success-tint-alpha: 0.12",
  "--app-toast-info-tint-alpha: 0.12",
  "--app-toast-warning-tint-alpha: 0.13",
  "--app-toast-error-tint-alpha: 0.13",
  "--app-toast-motion-duration: 320ms",
];

const TOAST_RUNTIME_PROPS = {
  duration: 2_600,
  dismissOnClick: true,
  pauseOnHover: true,
};

const TOAST_EXAMPLES = [
  {
    type: "success",
    title: "保存成功",
    description: "设置已成功保存",
  },
  {
    type: "info",
    title: "上传完成",
    description: "文档已加入阅读列表",
  },
  {
    type: "warning",
    title: "空间不足",
    description: "当前可用空间偏低",
  },
  {
    type: "error",
    title: "同步失败",
    description: "请检查网络后重试",
  },
];

const LAB_TABS = [
  {
    key: "primary",
    label: "一级按钮",
    subLabel: "Primary",
  },
  {
    key: "secondary",
    label: "二级按钮",
    subLabel: "Secondary",
  },
  {
    key: "toast",
    label: "通知组件",
    subLabel: "Toast Notification",
  },
];

export default function ButtonLab() {
  const [activeLab, setActiveLab] = useState("primary");
  const [liveToasts, setLiveToasts] = useState(() =>
    TOAST_EXAMPLES.map((toast, index) => ({
      ...toast,
      id: `initial-${index}`,
    }))
  );

  function pushToast(type) {
    const example = TOAST_EXAMPLES.find((item) => item.type === type);
    setLiveToasts((current) => [
      {
        ...example,
        id: `${type}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      },
      ...current,
    ]);
  }

  function pushRealToast(type) {
    const example = TOAST_EXAMPLES.find((item) => item.type === type);
    showToast(example.title, type, {
      clear: true,
      description: `真实业务 showToast 调用：${example.description}`,
      toastId: `button-lab-real-${type}`,
    });
  }

  function removeToast(id) {
    setLiveToasts((current) => current.filter((toast) => toast.id !== id));
  }

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
                <div className="flex h-9 w-9 items-center justify-center rounded-full border border-sky-200/70 bg-sky-100/70 text-sky-600 shadow-[0_10px_28px_rgb(59_130_246_/_0.18)] light:bg-sky-50">
                  <Sparkle className="h-5 w-5" weight="fill" />
                </div>
                <div>
                  <p className="text-lg font-bold leading-6 text-white light:text-slate-950">
                    按钮实验 / Button Lab
                  </p>
                  <p className="mt-1 text-xs leading-[18px] text-white/60 light:text-slate-500">
                    顶部切换一级与二级按钮视图；当前仅保留定型展示与沙箱接入检查。
                  </p>
                </div>
              </div>

              <div
                role="tablist"
                aria-label="按钮实验视图切换"
                className="grid gap-2 rounded-2xl border border-white/15 bg-white/10 p-1.5 backdrop-blur-xl light:border-slate-200 light:bg-white/70 sm:grid-cols-3"
              >
                {LAB_TABS.map((tab) => (
                  <LabTabButton
                    key={tab.key}
                    tab={tab}
                    active={activeLab === tab.key}
                    onClick={() => setActiveLab(tab.key)}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="mt-6 grid gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
            {activeLab === "primary" && <PrimaryPanel />}
            {activeLab === "secondary" && <SecondaryPanel />}
            {activeLab === "toast" && (
              <ToastPanel
                onPushToast={pushToast}
                onPushRealToast={pushRealToast}
                onClearToasts={() => setLiveToasts([])}
              />
            )}

            <section
              className={[
                "button-lab-preview overflow-hidden rounded-2xl border border-white/70 bg-gradient-to-br from-sky-50 via-blue-100 to-white p-5 text-slate-900 shadow-[0_24px_70px_rgb(37_99_235_/_0.14)]",
                activeLab === "toast" ? "toast-lab-preview" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <div className="rounded-2xl border border-white/70 bg-white/42 p-5 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.72),0_18px_54px_rgb(37_99_235_/_0.10)] backdrop-blur-2xl">
                {activeLab === "primary" ? (
                  <PrimaryShowcase />
                ) : activeLab === "secondary" ? (
                  <SecondaryShowcase />
                ) : (
                  <ToastShowcase
                    liveToasts={liveToasts}
                    onPushToast={pushToast}
                    onRemoveToast={removeToast}
                    onClearToasts={() => setLiveToasts([])}
                    toastProps={TOAST_RUNTIME_PROPS}
                  />
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

function LabTabButton({ tab, active, onClick }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={[
        "motion-hover flex min-h-[48px] items-center justify-center rounded-xl border px-5 text-left",
        active
          ? "border-sky-300/80 bg-sky-50 text-slate-950 shadow-[0_10px_28px_rgb(37_99_235_/_0.14)]"
          : "border-transparent bg-transparent text-white/70 hover:bg-white/10 light:text-slate-500 light:hover:bg-slate-50",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="flex flex-col leading-none">
        <span className="text-sm font-bold">{tab.label}</span>
        <span className="mt-1 text-[11px] font-semibold opacity-70">
          {tab.subLabel}
        </span>
      </span>
    </button>
  );
}

function PrimaryPanel() {
  return (
    <section className="rounded-2xl border border-white/15 bg-white/10 p-4 shadow-[0_18px_54px_rgb(0_0_0_/_0.18)] backdrop-blur-2xl light:border-white/70 light:bg-white/65 light:shadow-[0_18px_54px_rgb(15_23_42_/_0.10)]">
      <div className="text-sm font-semibold text-white light:text-slate-900">
        一级按钮定型说明
      </div>
      <p className="mt-2 text-xs leading-5 text-white/60 light:text-slate-500">
        视觉参数已固化到 AppButton primary
        样式中。后续业务页面若接入一级按钮，默认应使用组件提供的尺寸档位，不再通过实验页调参。
      </p>

      <div className="mt-5 rounded-2xl border border-white/15 bg-slate-950/70 p-4 light:border-slate-200 light:bg-slate-950">
        <div className="text-xs font-semibold text-sky-200">
          允许局部改变大小的接口
        </div>
        <div className="mt-3 space-y-3 text-xs leading-5 text-sky-50">
          <p>
            组件级：
            <code>size=&quot;sm&quot; | &quot;md&quot; | &quot;lg&quot;</code>、
            <code>fullWidth</code>、<code>className</code>。
          </p>
          <p>
            局部 CSS 变量：可通过父容器或 <code>style</code>{" "}
            局部覆盖以下尺寸变量，不会写入全局配置。
          </p>
        </div>
        <div className="mt-3 grid gap-1 rounded-xl bg-black/35 p-3 text-[11px] leading-5 text-sky-50">
          {SIZE_VARIABLES.map((item) => (
            <code key={item}>{item}</code>
          ))}
        </div>
      </div>

      <div className="mt-5 rounded-2xl border border-white/15 bg-white/5 p-4 light:border-slate-200 light:bg-white/60">
        <div className="text-xs font-semibold text-white light:text-slate-800">
          当前状态
        </div>
        <p className="mt-2 text-xs leading-5 text-white/55 light:text-slate-500">
          一级按钮实验前端已屏蔽；此视图只用于最终样式检查，不会开放颜色、阴影等调参。
        </p>
      </div>
    </section>
  );
}

function SecondaryPanel() {
  return (
    <section className="rounded-2xl border border-white/15 bg-white/10 p-4 shadow-[0_18px_54px_rgb(0_0_0_/_0.18)] backdrop-blur-2xl light:border-white/70 light:bg-white/65 light:shadow-[0_18px_54px_rgb(15_23_42_/_0.10)]">
      <div className="rounded-2xl border border-white/15 bg-white/5 p-4 light:border-slate-200 light:bg-white/60">
        <div className="text-sm font-semibold text-white light:text-slate-900">
          二级按钮定型说明
        </div>
        <p className="mt-2 text-xs leading-5 text-white/60 light:text-slate-500">
          二级按钮参数已固化到 AppButton secondary
          样式中。此视图只保留最终展示，不再开放二级按钮实验调参。
        </p>
      </div>

      <div className="mt-5 rounded-2xl border border-white/15 bg-slate-950/70 p-4 light:border-slate-200 light:bg-slate-950">
        <div className="text-xs font-semibold text-sky-200">
          当前固定视觉参数
        </div>
        <div className="mt-3 grid gap-1 rounded-xl bg-black/35 p-3 text-[11px] leading-5 text-sky-50">
          {SECONDARY_FIXED_TOKENS.map((item) => (
            <code key={item}>{item};</code>
          ))}
        </div>
      </div>
    </section>
  );
}

function ToastPanel({ onPushToast, onPushRealToast, onClearToasts }) {
  return (
    <section className="max-h-none overflow-y-visible rounded-2xl border border-white/15 bg-white/10 p-4 shadow-[0_18px_54px_rgb(0_0_0_/_0.18)] backdrop-blur-2xl light:border-white/70 light:bg-white/65 light:shadow-[0_18px_54px_rgb(15_23_42_/_0.10)] xl:max-h-[calc(100vh-180px)] xl:overflow-y-auto xl:pr-3">
      <div className="rounded-2xl border border-white/15 bg-white/5 p-4 light:border-slate-200 light:bg-white/60">
        <div className="text-sm font-semibold text-white light:text-slate-900">
          通知组件 / Toast Notification
        </div>
        <p className="mt-2 text-xs leading-5 text-white/60 light:text-slate-500">
          只用于短反馈：成功、信息、警告、错误。没有详情、跳转、撤销或业务操作按钮。
        </p>
      </div>

      <div className="mt-5 rounded-2xl border border-white/15 bg-white/5 p-4 light:border-slate-200 light:bg-white/60">
        <div className="mb-3 text-xs font-semibold text-white light:text-slate-800">
          触发按钮区
        </div>
        <div className="grid gap-3">
          <AppButton fullWidth onClick={() => onPushToast("success")}>
            触发成功通知
          </AppButton>
          <AppButton
            variant="secondary"
            fullWidth
            onClick={() => onPushToast("info")}
          >
            触发信息通知
          </AppButton>
          <AppButton
            variant="secondary"
            fullWidth
            onClick={() => onPushToast("warning")}
          >
            触发警告通知
          </AppButton>
          <AppButton
            variant="secondary"
            fullWidth
            onClick={() => onPushToast("error")}
          >
            触发错误通知
          </AppButton>
          <AppButton variant="secondary" fullWidth onClick={onClearToasts}>
            清空通知
          </AppButton>
          <AppButton fullWidth onClick={() => onPushRealToast("success")}>
            真实成功通知
          </AppButton>
          <AppButton
            variant="secondary"
            fullWidth
            onClick={() => onPushRealToast("info")}
          >
            真实信息通知
          </AppButton>
          <AppButton
            variant="secondary"
            fullWidth
            onClick={() => onPushRealToast("warning")}
          >
            真实警告通知
          </AppButton>
          <AppButton
            variant="secondary"
            fullWidth
            onClick={() => onPushRealToast("error")}
          >
            真实错误通知
          </AppButton>
        </div>
      </div>

      <div className="mt-5 rounded-2xl border border-white/15 bg-slate-950/70 p-4 light:border-slate-200 light:bg-slate-950">
        <div className="text-xs font-semibold text-sky-200">
          当前固定视觉参数
        </div>
        <p className="mt-2 text-[11px] leading-5 text-sky-100/70">
          通知组件参数已固化到 AppToast 默认样式中。此处只保留最终展示与全局
          showToast 接入检查。
        </p>
        <div className="mt-3 grid gap-1 rounded-xl bg-black/35 p-3 text-[11px] leading-5 text-sky-50">
          {TOAST_FIXED_TOKENS.map((item) => (
            <code key={item}>{item};</code>
          ))}
          <code>默认自动关闭时长: 2600ms;</code>
          <code>点击本体关闭: true;</code>
          <code>悬停暂停: true;</code>
        </div>
      </div>
    </section>
  );
}

function PrimaryShowcase() {
  return (
    <>
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-950">
            一级按钮最终展示
          </p>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500">
            定型后的 primary 按钮会继续在不同状态、尺寸和内容密度下保持一致。
          </p>
        </div>
        <AppButton
          leftIcon={<Check weight="bold" />}
          rightIcon={<ArrowRight weight="bold" />}
        >
          保存设计
        </AppButton>
      </div>

      <PreviewSection title="状态展示">
        <PreviewItem label="默认态">
          <AppButton>确认操作</AppButton>
        </PreviewItem>
        <PreviewItem label="悬停态">
          <AppButton data-preview-state="hover">悬停预览</AppButton>
        </PreviewItem>
        <PreviewItem label="按下态">
          <AppButton data-preview-state="active">按下预览</AppButton>
        </PreviewItem>
        <PreviewItem label="聚焦态">
          <AppButton data-preview-state="focus">键盘聚焦</AppButton>
        </PreviewItem>
        <PreviewItem label="选中态">
          <AppButton selected>已选中</AppButton>
        </PreviewItem>
        <PreviewItem label="禁用态">
          <AppButton disabled>不可用</AppButton>
        </PreviewItem>
        <PreviewItem label="加载态">
          <AppButton loading>正在生成</AppButton>
        </PreviewItem>
      </PreviewSection>

      <PreviewSection title="尺寸与内容密度">
        <PreviewItem label="大号">
          <AppButton size="lg">生成内容</AppButton>
        </PreviewItem>
        <PreviewItem label="中号">
          <AppButton>提交</AppButton>
        </PreviewItem>
        <PreviewItem label="小号">
          <AppButton size="sm">保存</AppButton>
        </PreviewItem>
        <PreviewItem label="短文字">
          <AppButton>确定</AppButton>
        </PreviewItem>
        <PreviewItem label="带左图标">
          <AppButton leftIcon={<Check weight="bold" />}>已完成</AppButton>
        </PreviewItem>
        <PreviewItem label="带右图标">
          <AppButton rightIcon={<ArrowRight weight="bold" />}>下一步</AppButton>
        </PreviewItem>
        <PreviewItem label="纯按钮躯壳">
          <AppButton aria-label="纯按钮躯壳示例" className="min-w-[164px]" />
        </PreviewItem>
        <PreviewItem label="铺满宽度">
          <AppButton fullWidth rightIcon={<ArrowRight weight="bold" />}>
            应用当前操作
          </AppButton>
        </PreviewItem>
      </PreviewSection>
    </>
  );
}

function SecondaryShowcase() {
  return (
    <>
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-900">
            二级按钮 / Secondary Button
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500">
            用于普通操作、辅助操作和可选操作，视觉权重低于一级按钮。
          </p>
        </div>
        <AppButton
          variant="secondary"
          leftIcon={<Star weight="bold" />}
          rightIcon={<ArrowRight weight="bold" />}
        >
          按钮内容
        </AppButton>
      </div>

      <PreviewSection title="二级按钮状态展示">
        <PreviewItem label="默认态">
          <AppButton variant="secondary">按钮内容</AppButton>
        </PreviewItem>
        <PreviewItem label="悬停态">
          <AppButton variant="secondary" data-preview-state="hover">
            悬停预览
          </AppButton>
        </PreviewItem>
        <PreviewItem label="按下态">
          <AppButton variant="secondary" data-preview-state="active">
            按下预览
          </AppButton>
        </PreviewItem>
        <PreviewItem label="聚焦态">
          <AppButton variant="secondary" data-preview-state="focus">
            键盘聚焦
          </AppButton>
        </PreviewItem>
        <PreviewItem label="选中态">
          <AppButton variant="secondary" selected>
            已选中
          </AppButton>
        </PreviewItem>
        <PreviewItem label="禁用态">
          <AppButton variant="secondary" disabled>
            不可用
          </AppButton>
        </PreviewItem>
        <PreviewItem label="加载态">
          <AppButton variant="secondary" loading>
            正在处理
          </AppButton>
        </PreviewItem>
      </PreviewSection>

      <PreviewSection title="二级按钮尺寸与图标">
        <PreviewItem label="大号">
          <AppButton variant="secondary" size="lg">
            按钮内容
          </AppButton>
        </PreviewItem>
        <PreviewItem label="中号">
          <AppButton variant="secondary">按钮内容</AppButton>
        </PreviewItem>
        <PreviewItem label="小号">
          <AppButton variant="secondary" size="sm">
            按钮内容
          </AppButton>
        </PreviewItem>
        <PreviewItem label="左图标">
          <AppButton variant="secondary" leftIcon={<Star weight="bold" />}>
            按钮内容
          </AppButton>
        </PreviewItem>
        <PreviewItem label="右图标">
          <AppButton
            variant="secondary"
            rightIcon={<ArrowRight weight="bold" />}
          >
            按钮内容
          </AppButton>
        </PreviewItem>
        <PreviewItem label="左右图标">
          <AppButton
            variant="secondary"
            leftIcon={<ArrowDown weight="bold" />}
            rightIcon={<ArrowRight weight="bold" />}
          >
            按钮内容
          </AppButton>
        </PreviewItem>
        <PreviewItem label="纯按钮躯壳">
          <AppButton
            variant="secondary"
            aria-label="二级纯按钮躯壳示例"
            className="min-w-[164px]"
          />
        </PreviewItem>
        <PreviewItem label="铺满宽度">
          <AppButton
            variant="secondary"
            fullWidth
            rightIcon={<ArrowRight weight="bold" />}
          >
            辅助操作
          </AppButton>
        </PreviewItem>
      </PreviewSection>
    </>
  );
}

function ToastShowcase({ liveToasts, onRemoveToast, toastProps }) {
  return (
    <>
      <div>
        <div>
          <div className="text-sm font-semibold text-slate-900">
            通知组件 / Toast Notification
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500">
            用于保存、上传、同步等短反馈，只表达状态，不承载复杂操作。
          </p>
        </div>
      </div>

      <ToastPreviewSection title="静态预览">
        <div className="grid gap-4 lg:grid-cols-2">
          {TOAST_EXAMPLES.map((toast) => (
            <div
              key={toast.type}
              className="rounded-2xl border border-white/70 bg-white/38 p-4 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.66),0_12px_30px_rgb(37_99_235_/_0.08)] backdrop-blur-xl"
            >
              <div className="mb-3 text-xs font-semibold text-slate-500">
                {toast.title}
              </div>
              <AppToast
                type={toast.type}
                title={toast.title}
                description={toast.description}
                duration={0}
                dismissOnClick={false}
              />
            </div>
          ))}
        </div>
      </ToastPreviewSection>

      <ToastPreviewSection title="实时堆叠预览">
        <div className="grid gap-4">
          <div className="rounded-2xl border border-white/70 bg-gradient-to-br from-sky-50 via-white to-blue-100 p-4 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.66),0_12px_30px_rgb(37_99_235_/_0.08)] backdrop-blur-xl">
            <div className="mb-3 text-xs font-semibold text-slate-500">
              右上角堆叠模拟
            </div>
            <AppToastViewport>
              {liveToasts.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-sky-200 bg-white/40 px-4 py-5 text-center text-xs font-semibold text-slate-500">
                  当前没有通知
                </div>
              ) : (
                liveToasts.map((toast) => (
                  <AppToast
                    key={toast.id}
                    type={toast.type}
                    title={toast.title}
                    description={toast.description}
                    onClose={() => onRemoveToast(toast.id)}
                    {...toastProps}
                  />
                ))
              )}
            </AppToastViewport>
          </div>
        </div>
      </ToastPreviewSection>
    </>
  );
}

function PreviewSection({ title, children }) {
  return (
    <div className="mt-6 border-t border-sky-200/70 pt-5">
      <div className="mb-4 text-sm font-semibold text-slate-900">{title}</div>
      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {children}
      </div>
    </div>
  );
}

function ToastPreviewSection({ title, children }) {
  return (
    <div className="mt-6 border-t border-sky-200/70 pt-5">
      <div className="mb-4 text-sm font-semibold text-slate-900">{title}</div>
      {children}
    </div>
  );
}

function PreviewItem({ label, children }) {
  return (
    <div className="rounded-2xl border border-white/70 bg-white/38 p-4 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.66),0_12px_30px_rgb(37_99_235_/_0.08)] backdrop-blur-xl">
      <div className="mb-3 text-xs font-semibold text-slate-500">{label}</div>
      <div className="flex min-h-[58px] items-center">{children}</div>
    </div>
  );
}
