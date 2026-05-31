import React, { useState } from "react";
import Sidebar from "@/components/SettingsSidebar";
import AppButton from "@/components/lib/AppButton";
import AppConfirmDialog from "@/components/lib/AppConfirmDialog";
import AppDropdownButton from "@/components/lib/AppDropdownButton";
import AppIcon from "@/components/lib/AppIcon";
import AppToast, { AppToastViewport } from "@/components/lib/AppToast";
import AppToggleButton from "@/components/lib/AppToggleButton";
import showToast from "@/utils/toast";
import { isMobile } from "react-device-detect";
import {
  ArrowDown,
  ArrowRight,
  BookmarkSimple,
  Check,
  ClockCounterClockwise,
  CloudArrowUp,
  FolderOpen,
  Info,
  ListBullets,
  Moon,
  Plus,
  Question,
  Sparkle,
  SpinnerGap,
  Star,
  Warning,
  WarningCircle,
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

const CONFIRM_DIALOG_DEFAULT_PARAMS = {
  width: 460,
  radius: 24,
  padding: 24,
  bgAlpha: 0.72,
  borderAlpha: 0.62,
  shadowAlpha: 0.22,
  blur: 20,
  iconSize: 56,
  titleSize: 22,
  descriptionSize: 14,
  defaultColor: "#7ea7ff",
  infoColor: "#60a5fa",
  warningColor: "#f59e0b",
  dangerColor: "#ef4444",
};

const CONFIRM_DIALOG_VARIABLES = [
  "--app-confirm-dialog-width",
  "--app-confirm-dialog-radius",
  "--app-confirm-dialog-padding",
  "--app-confirm-dialog-bg-alpha",
  "--app-confirm-dialog-border-alpha",
  "--app-confirm-dialog-shadow-alpha",
  "--app-confirm-dialog-blur",
  "--app-confirm-dialog-icon-size",
  "--app-confirm-dialog-title-size",
  "--app-confirm-dialog-description-size",
  "--app-confirm-dialog-default-color",
  "--app-confirm-dialog-info-color",
  "--app-confirm-dialog-warning-color",
  "--app-confirm-dialog-danger-color",
];

const CONFIRM_DIALOG_TONES = [
  {
    tone: "default",
    label: "默认",
    subLabel: "Default",
    icon: <Question weight="bold" />,
  },
  {
    tone: "info",
    label: "信息",
    subLabel: "Info",
    icon: <Info weight="bold" />,
  },
  {
    tone: "warning",
    label: "警告",
    subLabel: "Warning",
    icon: <Warning weight="bold" />,
  },
  {
    tone: "danger",
    label: "危险",
    subLabel: "Danger",
    icon: <WarningCircle weight="bold" />,
  },
];

const ICON_DEFAULT_PARAMS = {
  shellSize: 38,
  symbolSize: 18,
  radius: 999,
  bgAlpha: 0.29,
  borderAlpha: 0.22,
  shadowAlpha: 0.06,
  blur: 12,
  strokeWidth: 1.8,
  highlightAlpha: 0.68,
  defaultColor: "#64748b",
  mutedColor: "#94a3b8",
  subtleColor: "#7c8aa5",
  primaryColor: "#2563eb",
  infoColor: "#0ea5e9",
  successColor: "#22c55e",
  warningColor: "#f59e0b",
  dangerColor: "#ef4444",
};

const ICON_VARIABLES = [
  "--app-icon-shell-size",
  "--app-icon-symbol-size",
  "--app-icon-radius",
  "--app-icon-bg-alpha",
  "--app-icon-border-alpha",
  "--app-icon-shadow-alpha",
  "--app-icon-blur",
  "--app-icon-stroke-width",
  "--app-icon-highlight-alpha",
  "--app-icon-default-color",
  "--app-icon-muted-color",
  "--app-icon-subtle-color",
  "--app-icon-primary-color",
  "--app-icon-info-color",
  "--app-icon-success-color",
  "--app-icon-warning-color",
  "--app-icon-danger-color",
];

const ICON_NAMES = [
  ["close", "关闭", "Close"],
  ["check", "完成", "Check"],
  ["save", "保存", "Save"],
  ["copy", "复制", "Copy"],
  ["refresh", "刷新", "Refresh"],
  ["reset", "重置", "Reset"],
  ["more", "更多", "More"],
  ["search", "搜索", "Search"],
  ["settings", "设置", "Settings"],
  ["sound", "声音", "Sound"],
  ["reading", "阅读", "Reading"],
  ["mindMap", "思维导图", "Mind map"],
  ["branch", "分支", "Branch"],
  ["upload", "上传", "Upload"],
  ["edit", "编辑", "Edit"],
  ["add", "添加", "Add"],
];

const ICON_GROUPS = [
  {
    title: "基础操作",
    description: "关闭、完成、更多等低层级操作符号。",
    icons: ["close", "check", "more"],
  },
  {
    title: "文件与编辑",
    description: "保存、复制、上传、编辑、添加等内容处理符号。",
    icons: ["save", "copy", "upload", "edit", "add"],
  },
  {
    title: "阅读与工具",
    description: "搜索、设置、声音、阅读、思维导图和分支相关符号。",
    icons: ["search", "settings", "sound", "reading", "mindMap", "branch"],
  },
  {
    title: "状态刷新",
    description: "刷新与重置这类回到当前或初始状态的符号。",
    icons: ["refresh", "reset"],
  },
];

const ICON_SIZES = ["xs", "sm", "md", "lg", "xl"];
const ICON_TONES = [
  "default",
  "muted",
  "subtle",
  "primary",
  "info",
  "success",
  "warning",
  "danger",
];
const ICON_WEIGHTS = ["regular", "bold", "fill", "duotone"];

const INTERACTION_BUTTON_DEFAULT_PARAMS = {
  dropdownHeight: 38,
  dropdownRadius: 999,
  dropdownBgAlpha: 0.61,
  dropdownBorderAlpha: 0.38,
  dropdownShadowAlpha: 0.13,
  dropdownMenuBgAlpha: 0.6,
  dropdownMenuRadius: 20,
  dropdownMenuGap: 5,
  dropdownMenuShadowAlpha: 0.16,
  dropdownOpenColor: "#2563eb",
  toggleHeight: 38,
  toggleRadius: 999,
  toggleContentInlineInset: 24,
  toggleBgAlpha: 0.78,
  toggleBorderAlpha: 0.42,
  toggleShadowAlpha: 0.1,
  toggleSelectedColor: "#2563eb",
  toggleSelectedBgAlpha: 0.72,
  toggleSelectedBorderAlpha: 0.42,
  toggleSelectedShadowAlpha: 0.18,
};

const INTERACTION_BUTTON_VARIABLES = [
  "--app-dropdown-button-height",
  "--app-dropdown-button-radius",
  "--app-dropdown-button-bg-alpha",
  "--app-dropdown-button-border-alpha",
  "--app-dropdown-button-shadow-alpha",
  "--app-dropdown-button-blur",
  "--app-dropdown-button-text",
  "--app-dropdown-button-open-color",
  "--app-dropdown-menu-bg-alpha",
  "--app-dropdown-menu-radius",
  "--app-dropdown-menu-gap",
  "--app-dropdown-menu-shadow-alpha",
  "--app-toggle-button-height",
  "--app-toggle-button-radius",
  "--app-toggle-button-content-inline-inset",
  "--app-toggle-button-bg-alpha",
  "--app-toggle-button-border-alpha",
  "--app-toggle-button-shadow-alpha",
  "--app-toggle-button-text",
  "--app-toggle-button-selected-color",
  "--app-toggle-button-selected-bg-alpha",
  "--app-toggle-button-selected-border-alpha",
  "--app-toggle-button-selected-shadow-alpha",
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
  {
    key: "confirm-dialog",
    label: "确认弹窗",
    subLabel: "Confirm Dialog",
  },
  {
    key: "functional-icon",
    label: "圆形功能图标",
    subLabel: "Functional Icon",
  },
  {
    key: "interaction-buttons",
    label: "交互按钮",
    subLabel: "Interaction Buttons",
  },
];

export default function ButtonLab() {
  const [activeLab, setActiveLab] = useState("primary");
  const [confirmDialogTone, setConfirmDialogTone] = useState("default");
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [interactionParams, setInteractionParams] = useState(
    INTERACTION_BUTTON_DEFAULT_PARAMS
  );
  const [dropdownOpen, setDropdownOpen] = useState(true);
  const [toggleSelected, setToggleSelected] = useState(true);
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

  const confirmDialogStyle = confirmDialogStyleFromParams(
    CONFIRM_DIALOG_DEFAULT_PARAMS
  );
  const iconStyle = iconStyleFromParams(ICON_DEFAULT_PARAMS);
  const interactionButtonStyle =
    interactionButtonStyleFromParams(interactionParams);

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
                className="grid gap-2 rounded-2xl border border-white/15 bg-white/10 p-1.5 backdrop-blur-xl light:border-slate-200 light:bg-white/70 sm:grid-cols-2 xl:grid-cols-6"
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
            {activeLab === "confirm-dialog" && (
              <ConfirmDialogPanel
                params={CONFIRM_DIALOG_DEFAULT_PARAMS}
                tone={confirmDialogTone}
                onToneChange={setConfirmDialogTone}
                onOpen={() => setConfirmDialogOpen(true)}
              />
            )}
            {activeLab === "functional-icon" && (
              <IconPanel params={ICON_DEFAULT_PARAMS} />
            )}
            {activeLab === "interaction-buttons" && (
              <InteractionButtonPanel
                params={interactionParams}
                onParamChange={(key, value) =>
                  setInteractionParams((current) => ({
                    ...current,
                    [key]: value,
                  }))
                }
                onReset={() =>
                  setInteractionParams(INTERACTION_BUTTON_DEFAULT_PARAMS)
                }
              />
            )}

            <section
              className={[
                "button-lab-preview overflow-hidden rounded-2xl border border-white/70 bg-gradient-to-br from-sky-50 via-blue-100 to-white p-5 text-slate-900 shadow-[0_24px_70px_rgb(37_99_235_/_0.14)]",
                activeLab === "toast" ? "toast-lab-preview" : "",
                activeLab === "confirm-dialog"
                  ? "confirm-dialog-lab-preview"
                  : "",
                activeLab === "functional-icon" ? "icon-lab-preview" : "",
                activeLab === "interaction-buttons"
                  ? "interaction-button-lab-preview"
                  : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={
                activeLab === "confirm-dialog"
                  ? confirmDialogStyle
                  : activeLab === "functional-icon"
                    ? iconStyle
                    : activeLab === "interaction-buttons"
                      ? interactionButtonStyle
                      : null
              }
            >
              <div className="rounded-2xl border border-white/70 bg-white/42 p-5 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.72),0_18px_54px_rgb(37_99_235_/_0.10)] backdrop-blur-2xl">
                {activeLab === "primary" ? (
                  <PrimaryShowcase />
                ) : activeLab === "secondary" ? (
                  <SecondaryShowcase />
                ) : activeLab === "confirm-dialog" ? (
                  <ConfirmDialogShowcase
                    tone={confirmDialogTone}
                    dialogOpen={confirmDialogOpen}
                    onOpen={() => setConfirmDialogOpen(true)}
                    onClose={() => setConfirmDialogOpen(false)}
                  />
                ) : activeLab === "functional-icon" ? (
                  <IconShowcase />
                ) : activeLab === "interaction-buttons" ? (
                  <InteractionButtonShowcase
                    dropdownOpen={dropdownOpen}
                    onDropdownOpenChange={setDropdownOpen}
                    toggleSelected={toggleSelected}
                    onToggleSelectedChange={setToggleSelected}
                  />
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

function confirmDialogStyleFromParams(params) {
  return {
    "--app-confirm-dialog-width": `${params.width}px`,
    "--app-confirm-dialog-radius": `${params.radius}px`,
    "--app-confirm-dialog-padding": `${params.padding}px`,
    "--app-confirm-dialog-bg-alpha": params.bgAlpha,
    "--app-confirm-dialog-border-alpha": params.borderAlpha,
    "--app-confirm-dialog-shadow-alpha": params.shadowAlpha,
    "--app-confirm-dialog-blur": `${params.blur}px`,
    "--app-confirm-dialog-icon-size": `${params.iconSize}px`,
    "--app-confirm-dialog-title-size": `${params.titleSize}px`,
    "--app-confirm-dialog-description-size": `${params.descriptionSize}px`,
    "--app-confirm-dialog-default-color": params.defaultColor,
    "--app-confirm-dialog-info-color": params.infoColor,
    "--app-confirm-dialog-warning-color": params.warningColor,
    "--app-confirm-dialog-danger-color": params.dangerColor,
  };
}

function iconStyleFromParams(params) {
  return {
    "--app-icon-shell-size": `${params.shellSize}px`,
    "--app-icon-symbol-size": `${params.symbolSize}px`,
    "--app-icon-radius":
      Number(params.radius) >= 999 ? "999px" : `${params.radius}px`,
    "--app-icon-bg-alpha": params.bgAlpha,
    "--app-icon-border-alpha": params.borderAlpha,
    "--app-icon-shadow-alpha": params.shadowAlpha,
    "--app-icon-blur": `${params.blur}px`,
    "--app-icon-stroke-width": params.strokeWidth,
    "--app-icon-highlight-alpha": params.highlightAlpha,
    "--app-icon-default-color": params.defaultColor,
    "--app-icon-muted-color": params.mutedColor,
    "--app-icon-subtle-color": params.subtleColor,
    "--app-icon-primary-color": params.primaryColor,
    "--app-icon-info-color": params.infoColor,
    "--app-icon-success-color": params.successColor,
    "--app-icon-warning-color": params.warningColor,
    "--app-icon-danger-color": params.dangerColor,
  };
}

function interactionButtonStyleFromParams(params) {
  return {
    "--app-dropdown-button-height": `${params.dropdownHeight}px`,
    "--app-dropdown-button-radius":
      Number(params.dropdownRadius) >= 999
        ? "999px"
        : `${params.dropdownRadius}px`,
    "--app-dropdown-button-bg-alpha": params.dropdownBgAlpha,
    "--app-dropdown-button-border-alpha": params.dropdownBorderAlpha,
    "--app-dropdown-button-shadow-alpha": params.dropdownShadowAlpha,
    "--app-dropdown-button-blur": "18px",
    "--app-dropdown-button-text": "#0f172a",
    "--app-dropdown-button-open-color": params.dropdownOpenColor,
    "--app-dropdown-menu-bg-alpha": params.dropdownMenuBgAlpha,
    "--app-dropdown-menu-radius": `${params.dropdownMenuRadius}px`,
    "--app-dropdown-menu-gap": `${params.dropdownMenuGap}px`,
    "--app-dropdown-menu-shadow-alpha": params.dropdownMenuShadowAlpha,
    "--app-toggle-button-height": `${params.toggleHeight}px`,
    "--app-toggle-button-radius":
      Number(params.toggleRadius) >= 999 ? "999px" : `${params.toggleRadius}px`,
    "--app-toggle-button-content-inline-inset": `${params.toggleContentInlineInset}px`,
    "--app-toggle-button-bg-alpha": params.toggleBgAlpha,
    "--app-toggle-button-border-alpha": params.toggleBorderAlpha,
    "--app-toggle-button-shadow-alpha": params.toggleShadowAlpha,
    "--app-toggle-button-text": "#0f172a",
    "--app-toggle-button-selected-color": params.toggleSelectedColor,
    "--app-toggle-button-selected-bg-alpha": params.toggleSelectedBgAlpha,
    "--app-toggle-button-selected-border-alpha":
      params.toggleSelectedBorderAlpha,
    "--app-toggle-button-selected-shadow-alpha":
      params.toggleSelectedShadowAlpha,
  };
}

function InteractionButtonPanel({ params, onParamChange, onReset }) {
  const style = interactionButtonStyleFromParams(params);
  const cssPreview = INTERACTION_BUTTON_VARIABLES.map(
    (variable) => `${variable}: ${style[variable]};`
  );

  return (
    <section className="max-h-none overflow-y-visible rounded-2xl border border-white/15 bg-white/10 p-4 shadow-[0_18px_54px_rgb(0_0_0_/_0.18)] backdrop-blur-2xl light:border-white/70 light:bg-white/65 light:shadow-[0_18px_54px_rgb(15_23_42_/_0.10)] xl:max-h-[calc(100vh-180px)] xl:overflow-y-auto xl:pr-3">
      <div className="rounded-2xl border border-white/15 bg-white/5 p-4 light:border-slate-200 light:bg-white/60">
        <div className="text-sm font-semibold text-white light:text-slate-900">
          交互按钮 / Interaction Buttons
        </div>
        <p className="mt-2 text-xs leading-5 text-white/60 light:text-slate-500">
          只展示 AppDropdownButton 和 AppToggleButton。
          <br />
          它们不属于一级/二级按钮体系，也不会接入真实业务页面。
        </p>
      </div>

      <div className="mt-5 rounded-2xl border border-white/15 bg-white/5 p-4 light:border-slate-200 light:bg-white/60">
        <div className="mb-3 text-xs font-semibold text-white light:text-slate-800">
          Dropdown 参数
        </div>
        <div className="grid gap-3">
          <LabRangeControl
            label="按钮高度"
            value={params.dropdownHeight}
            min={32}
            max={52}
            suffix="px"
            onChange={(value) => onParamChange("dropdownHeight", value)}
          />
          <LabRangeControl
            label="按钮圆角"
            value={params.dropdownRadius}
            min={12}
            max={999}
            suffix="px"
            onChange={(value) => onParamChange("dropdownRadius", value)}
          />
          <LabRangeControl
            label="按钮背景透明度"
            value={params.dropdownBgAlpha}
            min={0.4}
            max={0.95}
            step={0.01}
            onChange={(value) => onParamChange("dropdownBgAlpha", value)}
          />
          <LabRangeControl
            label="按钮边框透明度"
            value={params.dropdownBorderAlpha}
            min={0.18}
            max={0.8}
            step={0.01}
            onChange={(value) => onParamChange("dropdownBorderAlpha", value)}
          />
          <LabRangeControl
            label="按钮阴影强度"
            value={params.dropdownShadowAlpha}
            min={0.02}
            max={0.3}
            step={0.01}
            onChange={(value) => onParamChange("dropdownShadowAlpha", value)}
          />
          <LabRangeControl
            label="菜单背景透明度"
            value={params.dropdownMenuBgAlpha}
            min={0.45}
            max={0.98}
            step={0.01}
            onChange={(value) => onParamChange("dropdownMenuBgAlpha", value)}
          />
          <LabRangeControl
            label="菜单圆角"
            value={params.dropdownMenuRadius}
            min={14}
            max={28}
            suffix="px"
            onChange={(value) => onParamChange("dropdownMenuRadius", value)}
          />
          <LabRangeControl
            label="菜单与按钮间距"
            value={params.dropdownMenuGap}
            min={2}
            max={12}
            suffix="px"
            onChange={(value) => onParamChange("dropdownMenuGap", value)}
          />
          <LabRangeControl
            label="菜单阴影强度"
            value={params.dropdownMenuShadowAlpha}
            min={0.04}
            max={0.34}
            step={0.01}
            onChange={(value) =>
              onParamChange("dropdownMenuShadowAlpha", value)
            }
          />
          <LabColorControl
            label="open 状态颜色"
            value={params.dropdownOpenColor}
            onChange={(value) => onParamChange("dropdownOpenColor", value)}
          />
        </div>
      </div>

      <div className="mt-5 rounded-2xl border border-white/15 bg-white/5 p-4 light:border-slate-200 light:bg-white/60">
        <div className="mb-3 text-xs font-semibold text-white light:text-slate-800">
          Toggle 参数
        </div>
        <div className="grid gap-3">
          <LabRangeControl
            label="按钮高度"
            value={params.toggleHeight}
            min={32}
            max={52}
            suffix="px"
            onChange={(value) => onParamChange("toggleHeight", value)}
          />
          <LabRangeControl
            label="按钮圆角"
            value={params.toggleRadius}
            min={12}
            max={999}
            suffix="px"
            onChange={(value) => onParamChange("toggleRadius", value)}
          />
          <LabRangeControl
            label="图标文本左右边距"
            value={params.toggleContentInlineInset}
            min={14}
            max={58}
            suffix="px"
            onChange={(value) =>
              onParamChange("toggleContentInlineInset", value)
            }
          />
          <LabRangeControl
            label="默认背景透明度"
            value={params.toggleBgAlpha}
            min={0.4}
            max={0.95}
            step={0.01}
            onChange={(value) => onParamChange("toggleBgAlpha", value)}
          />
          <LabRangeControl
            label="默认边框透明度"
            value={params.toggleBorderAlpha}
            min={0.18}
            max={0.8}
            step={0.01}
            onChange={(value) => onParamChange("toggleBorderAlpha", value)}
          />
          <LabRangeControl
            label="默认阴影强度"
            value={params.toggleShadowAlpha}
            min={0.02}
            max={0.3}
            step={0.01}
            onChange={(value) => onParamChange("toggleShadowAlpha", value)}
          />
          <LabColorControl
            label="选中颜色"
            value={params.toggleSelectedColor}
            onChange={(value) => onParamChange("toggleSelectedColor", value)}
          />
          <LabRangeControl
            label="选中背景透明度"
            value={params.toggleSelectedBgAlpha}
            min={0.35}
            max={0.95}
            step={0.01}
            onChange={(value) => onParamChange("toggleSelectedBgAlpha", value)}
          />
          <LabRangeControl
            label="选中边框透明度"
            value={params.toggleSelectedBorderAlpha}
            min={0.18}
            max={0.8}
            step={0.01}
            onChange={(value) =>
              onParamChange("toggleSelectedBorderAlpha", value)
            }
          />
          <LabRangeControl
            label="选中阴影强度"
            value={params.toggleSelectedShadowAlpha}
            min={0.04}
            max={0.36}
            step={0.01}
            onChange={(value) =>
              onParamChange("toggleSelectedShadowAlpha", value)
            }
          />
        </div>
      </div>

      <div className="mt-5">
        <AppButton variant="secondary" fullWidth onClick={onReset}>
          重置实验参数
        </AppButton>
      </div>

      <div className="mt-5 rounded-2xl border border-white/15 bg-slate-950/70 p-4 light:border-slate-200 light:bg-slate-950">
        <div className="text-xs font-semibold text-sky-200">当前 CSS 变量</div>
        <div className="mt-3 grid gap-1 rounded-xl bg-black/35 p-3 text-[11px] leading-5 text-sky-50">
          {cssPreview.map((item) => (
            <code key={item}>{item}</code>
          ))}
        </div>
      </div>
    </section>
  );
}

function LabRangeControl({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = "",
  onChange,
}) {
  return (
    <label className="grid gap-2 rounded-xl border border-white/10 bg-white/5 p-3 light:border-slate-200 light:bg-white/55">
      <span className="flex items-center justify-between gap-3 text-xs font-semibold text-white light:text-slate-700">
        {label}
        <span className="font-mono text-[11px] text-sky-200 light:text-sky-700">
          {value}
          {suffix}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-sky-500"
      />
    </label>
  );
}

function LabColorControl({ label, value, onChange }) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 p-3 light:border-slate-200 light:bg-white/55">
      <span className="text-xs font-semibold text-white light:text-slate-700">
        {label}
      </span>
      <span className="flex items-center gap-2">
        <code className="text-[11px] text-sky-200 light:text-sky-700">
          {value}
        </code>
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-7 w-9 cursor-pointer rounded border border-white/40 bg-transparent"
        />
      </span>
    </label>
  );
}

function IconPanel({ params }) {
  const style = iconStyleFromParams(params);
  const cssPreview = ICON_VARIABLES.map(
    (variable) => `${variable}: ${style[variable]};`
  );

  return (
    <section className="max-h-none overflow-y-visible rounded-2xl border border-white/15 bg-white/10 p-4 shadow-[0_18px_54px_rgb(0_0_0_/_0.18)] backdrop-blur-2xl light:border-white/70 light:bg-white/65 light:shadow-[0_18px_54px_rgb(15_23_42_/_0.10)] xl:max-h-[calc(100vh-180px)] xl:overflow-y-auto xl:pr-3">
      <div className="rounded-2xl border border-white/15 bg-white/5 p-4 light:border-slate-200 light:bg-white/60">
        <div className="text-sm font-semibold text-white light:text-slate-900">
          圆形功能图标 / Functional Icon
        </div>
        <p className="mt-2 text-xs leading-5 text-white/60 light:text-slate-500">
          只实验纯图标符号和圆形玻璃视觉，不包含 button、onClick、hover
          或真实业务替换。
        </p>
      </div>

      <div className="mt-5 rounded-2xl border border-white/15 bg-white/5 p-4 light:border-slate-200 light:bg-white/60">
        <div className="text-xs font-semibold text-white light:text-slate-800">
          定型状态
        </div>
        <p className="mt-2 text-xs leading-5 text-white/60 light:text-slate-500">
          图标参数已根据后端保存值固化。此视图只保留最终样式检查、分类展示和变量查阅，不再开放实时调参。
        </p>
      </div>

      <div className="mt-5 rounded-2xl border border-white/15 bg-slate-950/70 p-4 light:border-slate-200 light:bg-slate-950">
        <div className="text-xs font-semibold text-sky-200">当前 CSS 变量</div>
        <div className="mt-3 grid gap-1 rounded-xl bg-black/35 p-3 text-[11px] leading-5 text-sky-50">
          {cssPreview.map((item) => (
            <code key={item}>{item}</code>
          ))}
        </div>
      </div>
    </section>
  );
}

function IconShowcase() {
  const iconMeta = Object.fromEntries(
    ICON_NAMES.map(([name, label, subLabel]) => [name, { label, subLabel }])
  );

  return (
    <>
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-900">
            圆形功能图标 / Functional Icon
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500">
            AppIcon 是纯符号组件，只负责圆形玻璃图标视觉。它不渲染按钮，
            也不承载点击行为。
          </p>
        </div>
        <div className="rounded-full border border-sky-200 bg-white/55 px-3 py-1 text-xs font-bold text-sky-700">
          display only
        </div>
      </div>

      {ICON_GROUPS.map((group) => (
        <ToastPreviewSection key={group.title} title={group.title}>
          <p className="-mt-2 mb-4 text-xs leading-5 text-slate-500">
            {group.description}
          </p>
          <div className="grid gap-5 2xl:grid-cols-2">
            {group.icons.map((name) => (
              <IconVariantCard
                key={name}
                name={name}
                label={iconMeta[name].label}
                subLabel={iconMeta[name].subLabel}
              />
            ))}
          </div>
        </ToastPreviewSection>
      ))}
    </>
  );
}

function IconVariantCard({ name, label, subLabel }) {
  return (
    <div className="rounded-2xl border border-white/70 bg-white/38 p-4 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.66),0_12px_30px_rgb(37_99_235_/_0.08)] backdrop-blur-xl">
      <div className="flex items-center gap-3">
        <AppIcon name={name} tone="primary" />
        <div>
          <div className="text-xs font-bold text-slate-800">{label}</div>
          <div className="mt-1 text-[11px] font-semibold text-slate-400">
            {subLabel} · {name}
          </div>
        </div>
      </div>

      <IconVariantRow label="size">
        {ICON_SIZES.map((size) => (
          <IconVariantSample key={size} label={size}>
            <AppIcon name={name} size={size} tone="primary" />
          </IconVariantSample>
        ))}
      </IconVariantRow>

      <IconVariantRow label="tone">
        {ICON_TONES.map((tone) => (
          <IconVariantSample key={tone} label={tone}>
            <AppIcon name={name} tone={tone} />
          </IconVariantSample>
        ))}
      </IconVariantRow>

      <IconVariantRow label="weight">
        {ICON_WEIGHTS.map((weight) => (
          <IconVariantSample key={weight} label={weight}>
            <AppIcon name={name} tone="primary" weight={weight} />
          </IconVariantSample>
        ))}
      </IconVariantRow>
    </div>
  );
}

function IconVariantRow({ label, children }) {
  return (
    <div className="mt-4">
      <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.08em] text-slate-400">
        {label}
      </div>
      <div className="flex flex-wrap items-end gap-3">{children}</div>
    </div>
  );
}

function IconVariantSample({ label, children }) {
  return (
    <div className="flex min-w-[52px] flex-col items-center gap-2 rounded-xl border border-white/60 bg-white/35 px-2 py-2">
      {children}
      <span className="text-[10px] font-semibold leading-none text-slate-400">
        {label}
      </span>
    </div>
  );
}

function InteractionButtonShowcase({
  dropdownOpen,
  onDropdownOpenChange,
  toggleSelected,
  onToggleSelectedChange,
}) {
  const dropdownMenu = (
    <>
      <AppDropdownButton.Item
        icon={<ClockCounterClockwise weight="bold" />}
        onClick={() => onDropdownOpenChange(false)}
      >
        从历史加入
      </AppDropdownButton.Item>
      <AppDropdownButton.Item
        icon={<CloudArrowUp weight="bold" />}
        onClick={() => onDropdownOpenChange(false)}
      >
        上传新书
      </AppDropdownButton.Item>
      <AppDropdownButton.Item
        icon={<FolderOpen weight="bold" />}
        onClick={() => onDropdownOpenChange(false)}
      >
        从本地选择
      </AppDropdownButton.Item>
    </>
  );

  return (
    <>
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-900">
            交互按钮 / Interaction Buttons
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500">
            AppDropdownButton 用于展开一组选项；AppToggleButton
            用于表达持续选中状态。当前只在 Button Lab 中展示。
          </p>
        </div>
        <div className="rounded-full border border-sky-200 bg-white/55 px-3 py-1 text-xs font-bold text-sky-700">
          sandbox only
        </div>
      </div>

      <ToastPreviewSection title="下拉菜单按钮状态展示">
        <div className="grid gap-5 md:grid-cols-2 2xl:grid-cols-3">
          <PreviewItem label="默认（Default）">
            <AppDropdownButton menu={dropdownMenu}>加入书籍</AppDropdownButton>
          </PreviewItem>
          <PreviewItem label="悬停（Hover）">
            <AppDropdownButton data-preview-state="hover" menu={dropdownMenu}>
              加入书籍
            </AppDropdownButton>
          </PreviewItem>
          <PreviewItem label="按下（Active）">
            <AppDropdownButton data-preview-state="active" menu={dropdownMenu}>
              加入书籍
            </AppDropdownButton>
          </PreviewItem>
          <PreviewItem label="禁用（Disabled）">
            <AppDropdownButton disabled menu={dropdownMenu}>
              加入书籍
            </AppDropdownButton>
          </PreviewItem>
          <PreviewItem label="带图标（With Icon）">
            <AppDropdownButton
              icon={<Plus weight="bold" />}
              menu={dropdownMenu}
            >
              加入书籍
            </AppDropdownButton>
          </PreviewItem>
          <PreviewItem label="铺满宽度（Full Width）">
            <AppDropdownButton fullWidth menu={dropdownMenu}>
              加入书籍
            </AppDropdownButton>
          </PreviewItem>
        </div>
      </ToastPreviewSection>

      <ToastPreviewSection title="下拉菜单展开一体化示例">
        <div className="grid gap-5 lg:grid-cols-[minmax(250px,360px)_1fr]">
          <div className="min-h-[220px] rounded-2xl border border-white/70 bg-white/38 p-5 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.66),0_12px_30px_rgb(37_99_235_/_0.08)] backdrop-blur-xl">
            <div className="mb-4 text-xs font-semibold text-slate-500">
              实时展开组件
            </div>
            <AppDropdownButton
              open={dropdownOpen}
              icon={<Plus weight="bold" />}
              menu={dropdownMenu}
              onClick={() => onDropdownOpenChange(!dropdownOpen)}
            >
              加入书籍
            </AppDropdownButton>
          </div>
          <div className="rounded-2xl border border-white/70 bg-white/32 p-5 text-sm leading-7 text-slate-600 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.66)] backdrop-blur-xl">
            <div className="font-bold text-slate-900">设计说明</div>
            <p className="mt-2">
              展开态中按钮和菜单使用同一组玻璃底、蓝灰描边、柔和内高光与阴影。
              菜单默认与按钮居中连接，并保留轻微连接高光，避免看起来像孤立浮层。
            </p>
          </div>
        </div>
      </ToastPreviewSection>

      <ToastPreviewSection title="选中状态按钮状态展示">
        <div className="grid gap-5 md:grid-cols-2 2xl:grid-cols-3">
          <PreviewItem label="关闭（Off / Default）">
            <AppToggleButton icon={<Star weight="regular" />}>
              专注模式
            </AppToggleButton>
          </PreviewItem>
          <PreviewItem label="悬停（Hover）">
            <AppToggleButton
              data-preview-state="hover"
              icon={<Star weight="regular" />}
            >
              专注模式
            </AppToggleButton>
          </PreviewItem>
          <PreviewItem label="按下（Active）">
            <AppToggleButton
              data-preview-state="active"
              icon={<Star weight="regular" />}
            >
              专注模式
            </AppToggleButton>
          </PreviewItem>
          <PreviewItem label="选中中（On / Selected）">
            <AppToggleButton selected icon={<Star weight="fill" />}>
              专注模式
            </AppToggleButton>
          </PreviewItem>
          <PreviewItem label="禁用（Disabled）">
            <AppToggleButton disabled icon={<Star weight="regular" />}>
              专注模式
            </AppToggleButton>
          </PreviewItem>
          <PreviewItem label="实时切换">
            <AppToggleButton
              selected={toggleSelected}
              icon={<Check weight={toggleSelected ? "fill" : "regular"} />}
              onClick={() => onToggleSelectedChange(!toggleSelected)}
            >
              {toggleSelected ? "已选中" : "未选中"}
            </AppToggleButton>
          </PreviewItem>
        </div>
      </ToastPreviewSection>

      <ToastPreviewSection title="选中状态按钮语义示例">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <AppToggleButton icon={<BookmarkSimple weight="regular" />}>
            书签模式
          </AppToggleButton>
          <AppToggleButton selected icon={<BookmarkSimple weight="bold" />}>
            书签模式
          </AppToggleButton>
          <AppToggleButton icon={<ListBullets weight="regular" />}>
            专注阅读
          </AppToggleButton>
          <AppToggleButton selected icon={<ListBullets weight="bold" />}>
            专注阅读
          </AppToggleButton>
          <AppToggleButton icon={<Moon weight="regular" />}>
            夜间模式
          </AppToggleButton>
          <AppToggleButton selected icon={<Moon weight="bold" />}>
            夜间模式
          </AppToggleButton>
          <AppToggleButton loading icon={<Check weight="bold" />}>
            测试模式
          </AppToggleButton>
          <AppToggleButton fullWidth selected icon={<Check weight="bold" />}>
            选择模式
          </AppToggleButton>
        </div>
      </ToastPreviewSection>
    </>
  );
}

function ConfirmDialogPanel({ params, tone, onToneChange, onOpen }) {
  const style = confirmDialogStyleFromParams(params);
  const cssPreview = CONFIRM_DIALOG_VARIABLES.map(
    (variable) => `${variable}: ${style[variable]};`
  );

  return (
    <section className="max-h-none overflow-y-visible rounded-2xl border border-white/15 bg-white/10 p-4 shadow-[0_18px_54px_rgb(0_0_0_/_0.18)] backdrop-blur-2xl light:border-white/70 light:bg-white/65 light:shadow-[0_18px_54px_rgb(15_23_42_/_0.10)] xl:max-h-[calc(100vh-180px)] xl:overflow-y-auto xl:pr-3">
      <div className="rounded-2xl border border-white/15 bg-white/5 p-4 light:border-slate-200 light:bg-white/60">
        <div className="text-sm font-semibold text-white light:text-slate-900">
          确认弹窗 / Confirm Dialog
        </div>
        <p className="mt-2 text-xs leading-5 text-white/60 light:text-slate-500">
          只实验确认弹窗容器。没有右上角关闭按钮，取消与确认都由 footer
          中传入的一级/二级按钮承担。
        </p>
      </div>

      <div className="mt-5 rounded-2xl border border-white/15 bg-white/5 p-4 light:border-slate-200 light:bg-white/60">
        <div className="mb-3 text-xs font-semibold text-white light:text-slate-800">
          定型状态
        </div>
        <p className="text-xs leading-5 text-white/60 light:text-slate-500">
          参数已固定为当前确认弹窗样式；关闭逻辑也已固定，只能通过 footer
          中的取消或确认按钮关闭。
        </p>
        <div className="mt-4">
          <AppButton fullWidth onClick={onOpen}>
            打开确认弹窗
          </AppButton>
        </div>
      </div>

      <div className="mt-5 rounded-2xl border border-white/15 bg-white/5 p-4 light:border-slate-200 light:bg-white/60">
        <div className="mb-3 text-xs font-semibold text-white light:text-slate-800">
          类型风格
        </div>
        <div className="grid grid-cols-2 gap-2">
          {CONFIRM_DIALOG_TONES.map((item) => (
            <button
              key={item.tone}
              type="button"
              onClick={() => onToneChange(item.tone)}
              className={[
                "rounded-xl border px-3 py-2 text-left text-xs font-bold transition",
                tone === item.tone
                  ? "border-sky-300 bg-sky-50 text-slate-950 shadow-[0_10px_22px_rgb(37_99_235_/_0.12)]"
                  : "border-white/15 bg-white/5 text-white/72 hover:bg-white/10 light:border-slate-200 light:bg-white/60 light:text-slate-600 light:hover:bg-slate-50",
              ].join(" ")}
            >
              {item.label}
              <span className="ml-1 font-semibold opacity-60">
                {item.subLabel}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5 rounded-2xl border border-white/15 bg-slate-950/70 p-4 light:border-slate-200 light:bg-slate-950">
        <div className="text-xs font-semibold text-sky-200">当前 CSS 变量</div>
        <div className="mt-3 grid gap-1 rounded-xl bg-black/35 p-3 text-[11px] leading-5 text-sky-50">
          {cssPreview.map((item) => (
            <code key={item}>{item}</code>
          ))}
        </div>
      </div>
    </section>
  );
}

function ConfirmDialogShowcase({ tone, dialogOpen, onOpen, onClose }) {
  const selectedTone =
    CONFIRM_DIALOG_TONES.find((item) => item.tone === tone) ||
    CONFIRM_DIALOG_TONES[0];

  return (
    <>
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-900">
            确认弹窗容器 / Confirm Dialog Container
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500">
            容器专注内容承载与操作区分层；按钮直接复用已有
            AppButton，不新增业务行为。
          </p>
        </div>
        <AppButton onClick={onOpen}>打开实时预览</AppButton>
      </div>

      <ToastPreviewSection title="实时容器预览">
        <div className="flex justify-center rounded-2xl border border-white/70 bg-white/35 p-5 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.65)]">
          <div
            className={[
              "app-confirm-dialog",
              `app-confirm-dialog-${tone}`,
            ].join(" ")}
          >
            <div className="app-confirm-dialog-sheen" aria-hidden="true" />
            <div className="app-confirm-dialog-icon">{selectedTone.icon}</div>
            <h3 className="app-confirm-dialog-title">
              {selectedTone.label}确认
            </h3>
            <p className="app-confirm-dialog-description">
              参数已经定型；此处只用于验证容器结构、类型风格和底部按钮关闭逻辑。
            </p>
            <div className="app-confirm-dialog-footer">
              <AppButton variant="secondary" size="sm">
                取消
              </AppButton>
              <AppButton size="sm">确认</AppButton>
            </div>
          </div>
        </div>
      </ToastPreviewSection>

      <ToastPreviewSection title="类型风格">
        <div className="grid gap-4 lg:grid-cols-2">
          {CONFIRM_DIALOG_TONES.map((item) => (
            <ConfirmDialogStaticCard key={item.tone} item={item} />
          ))}
        </div>
      </ToastPreviewSection>

      <ToastPreviewSection title="状态示例">
        <div className="grid gap-4 lg:grid-cols-3">
          <ConfirmDialogStaticCard
            item={CONFIRM_DIALOG_TONES[0]}
            label="默认状态"
          />
          <ConfirmDialogStaticCard
            item={CONFIRM_DIALOG_TONES[1]}
            label="聚焦状态"
            focused
          />
          <ConfirmDialogStaticCard
            item={CONFIRM_DIALOG_TONES[3]}
            label="禁用 / 加载状态"
            loading
          />
        </div>
      </ToastPreviewSection>

      <ToastPreviewSection title="交互配置">
        <div className="grid gap-4 md:grid-cols-2">
          <PreviewItem label="遮罩点击">
            <div className="text-xs font-semibold text-slate-600">
              当前：禁止关闭
            </div>
          </PreviewItem>
          <PreviewItem label="Escape">
            <div className="text-xs font-semibold text-slate-600">
              当前：禁止关闭
            </div>
          </PreviewItem>
        </div>
      </ToastPreviewSection>

      <AppConfirmDialog
        open={dialogOpen}
        tone={tone}
        title={`${selectedTone.label}确认`}
        description="这里是对当前操作的一步说明和提示，帮助用户了解后果或注意事项。"
        icon={selectedTone.icon}
        closeOnBackdrop={false}
        closeOnEscape={false}
        onClose={onClose}
        footer={
          <>
            <AppButton variant="secondary" onClick={onClose}>
              取消
            </AppButton>
            <AppButton onClick={onClose}>确认操作</AppButton>
          </>
        }
      >
        当前只是 Button Lab
        实验弹窗，不会触发删除、上传、历史清理或任何真实业务流程。
      </AppConfirmDialog>
    </>
  );
}

function ConfirmDialogStaticCard({
  item,
  label = null,
  focused = false,
  loading = false,
}) {
  return (
    <div>
      <div
        className={[
          "app-confirm-dialog",
          `app-confirm-dialog-${item.tone}`,
          focused ? "ring-2 ring-sky-200" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        data-loading={loading ? "" : undefined}
        style={{ width: "100%", minHeight: "220px" }}
      >
        <div className="app-confirm-dialog-sheen" aria-hidden="true" />
        <div className="app-confirm-dialog-icon">
          {loading ? <SpinnerGap className="animate-spin" /> : item.icon}
        </div>
        <h3 className="app-confirm-dialog-title">
          {loading ? "正在处理" : "标题区域"}
        </h3>
        <p className="app-confirm-dialog-description">
          这里是对当前操作的一步说明和提示，帮助用户了解后果或注意事项。
        </p>
        <div className="app-confirm-dialog-footer">
          <AppButton variant="secondary" size="sm" disabled={loading}>
            取消
          </AppButton>
          <AppButton size="sm" loading={loading}>
            确认
          </AppButton>
        </div>
      </div>
      <div className="mt-3 text-center text-xs font-semibold text-slate-500">
        {label || `${item.label} · ${item.subLabel}`}
      </div>
    </div>
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
