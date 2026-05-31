import React from "react";
import {
  ArrowCounterClockwise,
  ArrowsClockwise,
  BookOpen,
  Check,
  Copy,
  DotsThree,
  FloppyDisk,
  Gear,
  GitBranch,
  Graph,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  SpeakerHigh,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import "./styles.css";

const ICONS = {
  close: X,
  check: Check,
  save: FloppyDisk,
  copy: Copy,
  refresh: ArrowsClockwise,
  reset: ArrowCounterClockwise,
  more: DotsThree,
  search: MagnifyingGlass,
  settings: Gear,
  sound: SpeakerHigh,
  reading: BookOpen,
  mindMap: Graph,
  branch: GitBranch,
  upload: UploadSimple,
  edit: PencilSimple,
  add: Plus,
};

const SIZE_CLASSES = {
  xs: "app-icon-size-xs",
  sm: "app-icon-size-sm",
  md: "app-icon-size-md",
  lg: "app-icon-size-lg",
  xl: "app-icon-size-xl",
};

const TONE_CLASSES = {
  default: "app-icon-tone-default",
  muted: "app-icon-tone-muted",
  subtle: "app-icon-tone-subtle",
  primary: "app-icon-tone-primary",
  info: "app-icon-tone-info",
  success: "app-icon-tone-success",
  warning: "app-icon-tone-warning",
  danger: "app-icon-tone-danger",
};

export default function AppIcon({
  name,
  size = "md",
  tone = "default",
  weight = "regular",
  className = "",
  style,
}) {
  const Icon = ICONS[name];
  if (!Icon) return null;

  const sizeClass = SIZE_CLASSES[size] || SIZE_CLASSES.md;
  const toneClass = TONE_CLASSES[tone] || TONE_CLASSES.default;

  return (
    <span
      aria-hidden="true"
      style={style}
      className={["app-icon", sizeClass, toneClass, className]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="app-icon-shell">
        <Icon className="app-icon-symbol" weight={weight} />
      </span>
    </span>
  );
}
