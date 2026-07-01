import { useEffect, useRef, useState } from "react";
import {
  Camera,
  GlobeHemisphereEast,
  PencilSimpleLine,
  Trash,
  UserCircle,
} from "@phosphor-icons/react";
import { getStoredAuthUser, setStoredAuthUser } from "@/utils/authUserStorage";
import AppButton from "@/components/lib/AppButton";
import AppConfirmDialog from "@/components/lib/AppConfirmDialog";
import { showAppConfirm } from "@/components/lib/AppConfirmDialog/confirm";
import showToast from "@/utils/toast";
import usePfp from "@/hooks/usePfp";
import { useLanguageOptions } from "@/hooks/useLanguageOptions";
import { useTheme } from "@/hooks/useTheme";
import AccountSettingsApi from "./accountSettingsApi";
import { roleLabel as accountRoleLabel } from "@/utils/authz";

export default function ProfileCard({ user, onUserUpdated }) {
  const { pfp, setPfp } = usePfp();
  const fileInputRef = useRef(null);
  const {
    currentLanguage,
    supportedLanguages,
    getLanguageName,
    changeLanguage,
  } = useLanguageOptions();
  const { theme, setTheme, availableThemes } = useTheme();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [avatarCrop, setAvatarCrop] = useState(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [displayName, setDisplayName] = useState(
    user?.displayName || user?.username || ""
  );

  useEffect(() => {
    setDisplayName(user?.displayName || user?.username || "");
  }, [user?.displayName, user?.username]);

  useEffect(() => {
    return () => {
      if (avatarCrop?.url) URL.revokeObjectURL(avatarCrop.url);
    };
  }, [avatarCrop?.url]);

  function clearAvatarInput() {
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function closeAvatarCropDialog() {
    if (avatarCrop?.url) URL.revokeObjectURL(avatarCrop.url);
    setAvatarCrop(null);
    clearAvatarInput();
  }

  function prepareProfilePicture(event) {
    const file = event.target.files?.[0];
    if (!file) {
      clearAvatarInput();
      return;
    }
    if (!file.type?.startsWith("image/")) {
      showToast("请选择图片文件。", "error");
      clearAvatarInput();
      return;
    }
    if (avatarCrop?.url) URL.revokeObjectURL(avatarCrop.url);
    setAvatarCrop({
      url: URL.createObjectURL(file),
      fileName: file.name || "avatar.jpg",
      mimeType: file.type || "image/jpeg",
    });
  }

  async function uploadProfilePicture(blob, fileName) {
    const formData = new FormData();
    formData.append("file", new File([blob], fileName, { type: blob.type }));
    const { success, error } =
      await AccountSettingsApi.uploadProfilePicture(formData);
    if (!success) {
      showToast(`上传头像失败：${error}`, "error");
      return;
    }
    const nextPfp = user?.id
      ? await AccountSettingsApi.fetchProfilePicture(user.id)
      : null;
    setPfp(nextPfp);
    showToast("头像已更新。", "success");
    closeAvatarCropDialog();
  }

  async function removeProfilePicture() {
    const confirmed = await showAppConfirm({
      tone: "danger",
      title: "移除头像？",
      description: "移除后将恢复默认头像，此操作不会影响账号资料。",
      cancelText: "取消",
      confirmText: "移除头像",
    });
    if (!confirmed) return;

    const { success, error } = await AccountSettingsApi.removeProfilePicture();
    if (!success) {
      showToast(`移除头像失败：${error}`, "error");
      return;
    }
    setPfp(null);
    showToast("头像已移除。", "success");
  }

  async function saveProfile() {
    setSaving(true);
    const result = await AccountSettingsApi.updateProfile({
      displayName,
    });
    setSaving(false);

    if (!result.success) {
      showToast(`更新个人资料失败：${result.error}`, "error");
      return;
    }

    const storedUser = getStoredAuthUser();
    const nextUser = {
      ...(storedUser || user),
      displayName,
    };
    setStoredAuthUser(nextUser);
    onUserUpdated?.(nextUser);
    setEditing(false);
    showToast("个人资料已更新。", "success");
  }

  const createdAt = formatDate(user?.createdAt);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const resolvedDisplayName = user?.displayName || user?.username || "Account";

  return (
    <section
      id="profile"
      className="scroll-mt-6 rounded-[28px] bg-white p-6 shadow-[0_18px_50px_rgba(15,23,42,0.08)] ring-1 ring-slate-200/70"
    >
      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <div className="flex flex-col items-center gap-3">
          <label className="group relative flex h-28 w-28 cursor-pointer items-center justify-center overflow-hidden rounded-full bg-slate-100 ring-1 ring-slate-200">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={prepareProfilePicture}
            />
            {pfp ? (
              <img
                src={pfp}
                alt="User profile picture"
                className="h-full w-full object-cover"
              />
            ) : (
              <UserCircle className="h-20 w-20 text-slate-300" weight="thin" />
            )}
            <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-slate-950/50 py-2 text-xs font-semibold text-white opacity-0 transition group-hover:opacity-100">
              <Camera className="h-3.5 w-3.5" />
              更换
            </span>
          </label>
          {pfp && (
            <AppButton
              type="button"
              onClick={removeProfilePicture}
              size="sm"
              variant="secondary"
              className="account-button-danger"
              leftIcon={<Trash className="h-3.5 w-3.5" />}
            >
              移除头像
            </AppButton>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="truncate text-3xl font-semibold tracking-normal text-slate-950">
                {resolvedDisplayName}
              </h1>
              <p className="mt-1 text-sm text-slate-500">
                账号名 @{user?.username || "local-user"}
              </p>
              <p className="mt-2 text-sm text-slate-500">
                {user?.email || "未绑定邮箱"} · {roleLabel(user?.role)}
              </p>
            </div>
            <AppButton
              type="button"
              onClick={() => setEditing((current) => !current)}
              size="md"
              variant="secondary"
              leftIcon={<PencilSimpleLine className="h-4 w-4" />}
            >
              编辑
            </AppButton>
          </div>

          {editing && (
            <div className="mt-6 grid gap-3 rounded-3xl border border-slate-200 bg-slate-50 p-4">
              <label className="grid gap-2 text-sm font-semibold text-slate-700">
                用户名
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  className="h-11 rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-950 outline-none focus:border-sky-400"
                />
              </label>
              <div className="rounded-2xl bg-white px-4 py-3 text-sm text-slate-500 ring-1 ring-slate-200">
                登录账号名：{" "}
                <span className="font-semibold text-slate-700">
                  {user?.username || "local-user"}
                </span>
              </div>
              <div className="flex justify-end gap-2">
                <AppButton
                  type="button"
                  onClick={() => setEditing(false)}
                  size="md"
                  variant="secondary"
                >
                  取消
                </AppButton>
                <AppButton
                  type="button"
                  onClick={saveProfile}
                  disabled={saving}
                  loading={saving}
                  size="md"
                  variant="primary"
                >
                  保存
                </AppButton>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="mt-6 grid gap-3 border-t border-slate-100 pt-5 md:grid-cols-4">
        <MetaItem label="语言">
          <select
            value={currentLanguage || "en"}
            onChange={(event) => changeLanguage(event.target.value)}
            className="max-w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 outline-none"
          >
            {supportedLanguages.map((lang) => (
              <option key={lang} value={lang}>
                {getLanguageName(lang)}
              </option>
            ))}
          </select>
        </MetaItem>
        <MetaItem label="主题">
          <select
            value={theme}
            onChange={(event) => setTheme(event.target.value)}
            className="max-w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 outline-none"
          >
            {Object.entries(availableThemes).map(([key, value]) => (
              <option key={key} value={key}>
                {value}
              </option>
            ))}
          </select>
        </MetaItem>
        <MetaItem label="时区">
          <span className="inline-flex items-center gap-1 text-sm font-semibold text-slate-700">
            <GlobeHemisphereEast className="h-4 w-4 text-slate-400" />
            {timezone}
          </span>
        </MetaItem>
        <MetaItem label="账号创建时间">
          <span className="text-sm font-semibold text-slate-700">
            {createdAt || "待确认"}
          </span>
        </MetaItem>
      </div>
      {avatarCrop && (
        <AvatarCropDialog
          source={avatarCrop}
          uploading={avatarUploading}
          onCancel={closeAvatarCropDialog}
          onImageError={() => {
            showToast("无法读取图片，请选择其他图片。", "error");
            closeAvatarCropDialog();
          }}
          onSave={async (blob) => {
            setAvatarUploading(true);
            await uploadProfilePicture(blob, avatarCrop.fileName);
            setAvatarUploading(false);
          }}
        />
      )}
    </section>
  );
}

function AvatarCropDialog({
  source,
  uploading = false,
  onCancel,
  onImageError,
  onSave,
}) {
  const imageRef = useRef(null);
  const dragRef = useRef(null);
  const cropSize = 280;
  const [imageSize, setImageSize] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  const metrics = imageSize
    ? cropMetrics({ imageSize, cropSize, zoom, offset })
    : null;

  function clampOffset(nextOffset, nextZoom = zoom) {
    if (!imageSize) return nextOffset;
    const { maxX, maxY } = cropMetrics({
      imageSize,
      cropSize,
      zoom: nextZoom,
      offset: nextOffset,
    });
    return {
      x: clamp(nextOffset.x, -maxX, maxX),
      y: clamp(nextOffset.y, -maxY, maxY),
    };
  }

  function handleZoomChange(event) {
    const nextZoom = Number(event.target.value);
    setZoom(nextZoom);
    setOffset((current) => clampOffset(current, nextZoom));
  }

  function handlePointerDown(event) {
    if (!imageSize || uploading) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offset,
    };
  }

  function handlePointerMove(event) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const nextOffset = {
      x: drag.offset.x + event.clientX - drag.startX,
      y: drag.offset.y + event.clientY - drag.startY,
    };
    setOffset(clampOffset(nextOffset));
  }

  function handlePointerUp(event) {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  }

  async function handleSave() {
    if (!imageRef.current || !imageSize) return;
    const blob = await cropAvatarBlob({
      image: imageRef.current,
      imageSize,
      cropSize,
      zoom,
      offset,
      mimeType: source.mimeType,
    });
    if (!blob) {
      onImageError?.();
      return;
    }
    await onSave(blob);
  }

  return (
    <AppConfirmDialog
      open
      tone="info"
      title="裁切头像"
      description="拖动图片调整位置，使用缩放控制头像范围。"
      closeOnEscape={!uploading}
      closeOnBackdrop={false}
      loading={uploading}
      onClose={onCancel}
      className="max-w-[520px]"
      footer={
        <>
          <AppButton
            type="button"
            variant="secondary"
            size="md"
            disabled={uploading}
            onClick={onCancel}
          >
            取消
          </AppButton>
          <AppButton
            type="button"
            variant="primary"
            size="md"
            loading={uploading}
            disabled={!imageSize || uploading}
            onClick={handleSave}
          >
            保存头像
          </AppButton>
        </>
      }
    >
      <div className="grid gap-4 text-left">
        <div
          className="relative mx-auto touch-none overflow-hidden rounded-[32px] bg-slate-100 shadow-inner ring-1 ring-slate-200"
          style={{ width: cropSize, height: cropSize }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <img
            ref={imageRef}
            src={source.url}
            alt="头像裁切预览"
            draggable={false}
            className="absolute left-1/2 top-1/2 max-w-none select-none"
            style={
              metrics
                ? {
                    width: metrics.renderWidth,
                    height: metrics.renderHeight,
                    transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
                  }
                : { opacity: 0 }
            }
            onLoad={(event) => {
              const nextSize = {
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              };
              setImageSize(nextSize);
              setOffset({ x: 0, y: 0 });
              setZoom(1);
            }}
            onError={onImageError}
          />
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              boxShadow: `0 0 0 ${cropSize}px rgb(15 23 42 / 0.34)`,
              borderRadius: "999px",
            }}
          />
          <div className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-white/90" />
        </div>

        <label className="grid gap-2 text-sm font-semibold text-slate-700">
          缩放
          <input
            type="range"
            min="1"
            max="3"
            step="0.01"
            value={zoom}
            disabled={!imageSize || uploading}
            onChange={handleZoomChange}
            className="w-full accent-[#007AFF]"
          />
        </label>
      </div>
    </AppConfirmDialog>
  );
}

function MetaItem({ label, children }) {
  return (
    <div className="rounded-2xl bg-slate-50 p-4">
      <div className="text-xs font-semibold text-slate-400">{label}</div>
      <div className="mt-2 min-h-[36px]">{children}</div>
    </div>
  );
}

function cropMetrics({ imageSize, cropSize, zoom, offset }) {
  const baseScale = cropSize / Math.min(imageSize.width, imageSize.height);
  const displayScale = baseScale * zoom;
  const renderWidth = imageSize.width * displayScale;
  const renderHeight = imageSize.height * displayScale;
  const maxX = Math.max(0, (renderWidth - cropSize) / 2);
  const maxY = Math.max(0, (renderHeight - cropSize) / 2);

  return {
    baseScale,
    displayScale,
    renderWidth,
    renderHeight,
    maxX,
    maxY,
    imageLeft: (cropSize - renderWidth) / 2 + offset.x,
    imageTop: (cropSize - renderHeight) / 2 + offset.y,
  };
}

async function cropAvatarBlob({
  image,
  imageSize,
  cropSize,
  zoom,
  offset,
  mimeType,
}) {
  const metrics = cropMetrics({ imageSize, cropSize, zoom, offset });
  const outputSize = 512;
  const sx = Math.max(0, (0 - metrics.imageLeft) / metrics.displayScale);
  const sy = Math.max(0, (0 - metrics.imageTop) / metrics.displayScale);
  const sw = Math.min(imageSize.width - sx, cropSize / metrics.displayScale);
  const sh = Math.min(imageSize.height - sy, cropSize / metrics.displayScale);

  const canvas = document.createElement("canvas");
  canvas.width = outputSize;
  canvas.height = outputSize;
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, outputSize, outputSize);
  context.drawImage(image, sx, sy, sw, sh, 0, 0, outputSize, outputSize);

  const outputType = mimeType === "image/png" ? "image/png" : "image/jpeg";
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => resolve(blob),
      outputType,
      outputType === "image/jpeg" ? 0.92 : undefined
    );
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roleLabel(role) {
  return accountRoleLabel(role);
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString();
}
