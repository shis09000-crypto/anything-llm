import { useEffect, useState } from "react";
import {
  DeviceMobile,
  Eye,
  EyeSlash,
  Fingerprint,
  Key,
  LockKey,
  ShieldCheck,
  Trash,
  Timer,
  WarningCircle,
} from "@phosphor-icons/react";
import AppButton from "@/components/lib/AppButton";
import { showAppConfirm } from "@/components/lib/AppConfirmDialog/confirm";
import usePfp from "@/hooks/usePfp";
import showToast from "@/utils/toast";
import AccountSettingRow from "./AccountSettingRow";
import AccountSettingsApi from "./accountSettingsApi";
import { CardHeader } from "./ContactMethodsCard";

export default function LoginSecurityCard({
  user,
  emailVerified,
  authCapability,
  passkeys = [],
  passkeysLoading = false,
  refreshPasskeys,
}) {
  const { pfp } = usePfp();
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: "",
    password: "",
    confirmPassword: "",
  });
  const [passwordVisibility, setPasswordVisibility] = useState({
    currentPassword: false,
    password: false,
    confirmPassword: false,
  });
  const [saving, setSaving] = useState(false);
  const [trustedDevices, setTrustedDevices] = useState([]);
  const [trustedDevicesLoading, setTrustedDevicesLoading] = useState(false);
  const [showTrustedDeviceSetup, setShowTrustedDeviceSetup] = useState(false);
  const [trustedDevicePassword, setTrustedDevicePassword] = useState("");
  const [trustedDeviceSaving, setTrustedDeviceSaving] = useState(false);
  const [passkeyReauthLoading, setPasskeyReauthLoading] = useState(false);
  const passkeyCapabilityAvailable =
    authCapability?.showPasskey ?? AccountSettingsApi.passkeysSupported();
  const zkLoginAvailable =
    authCapability?.secureContext ?? window.isSecureContext;
  const hasPasskeys = passkeys.length > 0;
  const passkeyReauthAvailable = passkeyCapabilityAvailable && hasPasskeys;

  useEffect(() => {
    refreshTrustedDevices();
  }, []);

  useEffect(() => {
    if (!pfp || trustedDevices.length === 0) return;
    AccountSettingsApi.rememberTrustedDeviceAvatar({
      devices: trustedDevices,
      avatarUrl: pfp,
    });
  }, [pfp, trustedDevices]);

  async function refreshTrustedDevices() {
    setTrustedDevicesLoading(true);
    const result = await AccountSettingsApi.fetchTrustedLoginDevices({
      user,
      avatarUrl: pfp,
    });
    setTrustedDevicesLoading(false);
    if (result?.success) setTrustedDevices(result.devices || []);
  }

  async function startTrustedDeviceSetup() {
    if (!zkLoginAvailable) {
      showToast(
        "零知识快速登录需要 HTTPS 或 localhost。手机局域网 HTTP 地址无法保存可信设备。",
        "info"
      );
      return;
    }

    const confirmed = await showAppConfirm({
      tone: "warning",
      title: "是否在此设备启用快速登录？",
      description:
        "该功能会把加密凭证保存在当前浏览器中。如果这是公共电脑，请不要启用。",
      confirmText: "继续启用",
      cancelText: "取消",
    });
    if (!confirmed) return;
    setShowTrustedDeviceSetup(true);
  }

  async function enableTrustedDeviceWithPassword(event) {
    event.preventDefault();
    if (!trustedDevicePassword) {
      showToast("请输入当前密码完成安全验证。", "error");
      return;
    }

    setTrustedDeviceSaving(true);
    const reauth = await AccountSettingsApi.reauthZkWithPassword({
      currentPassword: trustedDevicePassword,
    });
    if (!reauth?.success) {
      setTrustedDeviceSaving(false);
      showToast(reauth?.error || "当前密码验证失败。", "error");
      return;
    }
    await finishTrustedDeviceEnroll(reauth.reauthToken);
  }

  async function enableTrustedDeviceWithPasskey() {
    if (!passkeyCapabilityAvailable) {
      showToast("当前浏览器不支持通行密钥验证。", "info");
      return;
    }

    const latestPasskeys = await refreshPasskeys?.();
    const passkeyCount = Array.isArray(latestPasskeys)
      ? latestPasskeys.length
      : passkeys.length;
    if (passkeyCount === 0) {
      showToast("请先添加通行密钥后再使用此验证方式。", "info");
      return;
    }

    setPasskeyReauthLoading(true);
    const reauth = await AccountSettingsApi.reauthZkWithPasskey().catch(
      (error) => {
        if (isPasskeyCancel(error)) return { success: false, cancelled: true };
        return { success: false, error: error.message };
      }
    );
    setPasskeyReauthLoading(false);

    if (reauth.cancelled) {
      showToast("已取消通行密钥验证。", "info");
      return;
    }
    if (!reauth?.success) {
      showToast(reauth?.error || "通行密钥验证失败。", "error");
      return;
    }
    setTrustedDeviceSaving(true);
    await finishTrustedDeviceEnroll(reauth.reauthToken);
  }

  async function finishTrustedDeviceEnroll(reauthToken) {
    const result = await AccountSettingsApi.enableTrustedLoginDevice({
      user,
      reauthToken,
      avatarUrl: pfp,
    }).catch((error) => ({ success: false, error: error.message }));
    setTrustedDeviceSaving(false);

    if (!result?.success) {
      showToast(result?.error || "启用快速登录失败。", "error");
      return;
    }

    setTrustedDevicePassword("");
    setShowTrustedDeviceSetup(false);
    showToast("已在此浏览器启用快速登录。", "success");
    await refreshTrustedDevices();
  }

  async function revokeTrustedDevice(device) {
    const confirmed = await showAppConfirm({
      tone: "danger",
      title: "删除可信设备？",
      description: "删除后，此浏览器将无法使用零知识证明快速登录。",
      confirmText: "删除",
      cancelText: "取消",
    });
    if (!confirmed) return;

    const result = await AccountSettingsApi.revokeTrustedLoginDevice(
      device.id,
      { deviceId: device.deviceId }
    );
    if (!result?.success) {
      showToast(result?.error || "删除可信设备失败。", "error");
      return;
    }

    showToast("可信设备已删除。", "success");
    await refreshTrustedDevices();
  }

  function updatePasswordField(field, value) {
    setPasswordForm((current) => ({ ...current, [field]: value }));
  }

  function togglePasswordVisibility(field) {
    setPasswordVisibility((current) => ({
      ...current,
      [field]: !current[field],
    }));
  }

  function closePasswordModal() {
    if (saving) return;
    setShowPasswordModal(false);
    setPasswordForm({
      currentPassword: "",
      password: "",
      confirmPassword: "",
    });
    setPasswordVisibility({
      currentPassword: false,
      password: false,
      confirmPassword: false,
    });
  }

  async function changePassword(event) {
    event.preventDefault();
    if (
      !passwordForm.currentPassword ||
      !passwordForm.password ||
      !passwordForm.confirmPassword
    ) {
      showToast("请输入当前密码、新密码和确认密码。", "error");
      return;
    }
    if (passwordForm.password !== passwordForm.confirmPassword) {
      showToast("两次输入的新密码不一致。", "error");
      return;
    }

    setSaving(true);
    const result = await AccountSettingsApi.updatePassword({
      currentPassword: passwordForm.currentPassword,
      password: passwordForm.password,
    });
    setSaving(false);

    if (!result.success) {
      showToast(`修改密码失败：${result.error}`, "error");
      return;
    }

    closePasswordModal();
    showToast("密码已更新。", "success");
  }

  return (
    <section id="security" className="account-card">
      <CardHeader
        title="登录与安全"
        subtitle="管理密码、恢复方式和账号安全状态。"
      />
      <div className="divide-y divide-slate-100">
        <AccountSettingRow
          icon={<LockKey className="h-5 w-5" />}
          title="修改密码"
          subtitle="修改密码需要输入当前密码。"
          action={
            <AppButton
              type="button"
              size="md"
              variant="primary"
              onClick={() => setShowPasswordModal(true)}
            >
              修改密码
            </AppButton>
          }
        />
        <AccountSettingRow
          icon={<Key className="h-5 w-5" />}
          title="恢复码管理"
          subtitle="恢复码在首次登录后展示，请妥善保存。"
          status={<span className="font-semibold text-slate-500">已启用</span>}
        />
        <AccountSettingRow
          icon={<ShieldCheck className="h-5 w-5" />}
          title="邮箱验证码找回"
          subtitle="使用已验证邮箱接收 6 位验证码找回密码。"
          status={
            <span
              className={
                emailVerified
                  ? "font-semibold text-emerald-600"
                  : "font-semibold text-amber-600"
              }
            >
              {emailVerified ? "可用" : "需要验证邮箱"}
            </span>
          }
        />
        <AccountSettingRow
          icon={<DeviceMobile className="h-5 w-5" />}
          title="可信设备"
          subtitle="启用后可在当前设备使用零知识证明快速登录。"
          status={
            <span className="font-semibold text-slate-500">
              {trustedDevicesLoading
                ? "正在读取"
                : trustedDevices.length > 0
                  ? `${trustedDevices.length} 台设备`
                  : "未启用"}
            </span>
          }
          action={
            <AppButton
              type="button"
              size="sm"
              variant="secondary"
              disabled={!zkLoginAvailable}
              title={
                zkLoginAvailable
                  ? "在此设备启用快速登录"
                  : "零知识快速登录需要 HTTPS 或 localhost"
              }
              onClick={startTrustedDeviceSetup}
            >
              {zkLoginAvailable ? "启用" : "需要 HTTPS"}
            </AppButton>
          }
        >
          {!zkLoginAvailable && (
            <div className="mt-4 rounded-3xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-sm font-medium leading-6 text-amber-700">
              手机网页需要通过 HTTPS 打开，才能保存零知识快速登录凭证。
            </div>
          )}

          {showTrustedDeviceSetup && (
            <form
              onSubmit={enableTrustedDeviceWithPassword}
              className="mt-4 rounded-3xl border border-slate-200 bg-slate-50/80 p-4"
            >
              <p className="text-sm font-medium leading-6 text-slate-600">
                启用快速登录前需要再次验证身份。你可以输入当前密码，或使用已添加的通行密钥。
              </p>
              <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto]">
                <input
                  type="password"
                  value={trustedDevicePassword}
                  onChange={(event) =>
                    setTrustedDevicePassword(event.target.value)
                  }
                  placeholder="当前密码"
                  autoComplete="current-password"
                  className="h-11 rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-950 outline-none focus:border-sky-400"
                />
                <AppButton
                  type="submit"
                  size="md"
                  variant="primary"
                  disabled={trustedDeviceSaving}
                  loading={trustedDeviceSaving}
                >
                  验证并启用
                </AppButton>
              </div>
              {passkeyCapabilityAvailable && (
                <div className="mt-3">
                  <AppButton
                    type="button"
                    size="sm"
                    variant="secondary"
                    leftIcon={<Fingerprint className="h-4 w-4" />}
                    disabled={
                      passkeysLoading ||
                      passkeyReauthLoading ||
                      trustedDeviceSaving ||
                      !passkeyReauthAvailable
                    }
                    loading={passkeyReauthLoading}
                    onClick={enableTrustedDeviceWithPasskey}
                  >
                    {passkeysLoading
                      ? "正在读取通行密钥"
                      : passkeyReauthAvailable
                        ? "使用通行密钥验证"
                        : "请先添加通行密钥"}
                  </AppButton>
                </div>
              )}
            </form>
          )}

          {trustedDevices.length > 0 && (
            <div className="mt-4 space-y-2">
              {trustedDevices.map((device) => (
                <div
                  key={device.id}
                  className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-900">
                      {device.deviceName || "This Device"}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      创建：{formatDate(device.createdAt)}
                      {device.lastUsedAt
                        ? ` · 最近使用：${formatDate(device.lastUsedAt)}`
                        : ""}
                    </p>
                  </div>
                  <AppButton
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="account-button-danger"
                    leftIcon={<Trash className="h-4 w-4" />}
                    onClick={() => revokeTrustedDevice(device)}
                  >
                    删除
                  </AppButton>
                </div>
              ))}
            </div>
          )}
        </AccountSettingRow>
        <AccountSettingRow
          icon={<Timer className="h-5 w-5" />}
          title="最近一次登录"
          subtitle="Chrome on macOS · 127.0.0.1"
          status={<span className="font-semibold text-slate-500">刚刚</span>}
        />
        <AccountSettingRow
          icon={<WarningCircle className="h-5 w-5" />}
          title="安全评分"
          subtitle="验证邮箱、设置恢复方式并添加通行密钥可提高评分。"
          status={
            <span className="text-lg font-semibold text-slate-950">72/100</span>
          }
        />
      </div>
      {showPasswordModal && (
        <PasswordChangeModal
          form={passwordForm}
          visibility={passwordVisibility}
          saving={saving}
          onChange={updatePasswordField}
          onToggleVisibility={togglePasswordVisibility}
          onCancel={closePasswordModal}
          onSubmit={changePassword}
        />
      )}
    </section>
  );
}

function PasswordChangeModal({
  form,
  visibility,
  saving,
  onChange,
  onToggleVisibility,
  onCancel,
  onSubmit,
}) {
  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950/30 px-4 py-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="change-password-title"
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-[460px] rounded-[28px] border border-white/80 bg-white p-6 shadow-[0_24px_80px_rgba(15,23,42,0.18)]"
      >
        <h3
          id="change-password-title"
          className="text-xl font-semibold tracking-normal text-slate-950"
        >
          修改密码
        </h3>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          请输入当前密码，并设置一个新的账号密码。
        </p>
        <div className="mt-5 space-y-4">
          <PasswordModalInput
            label="当前密码"
            value={form.currentPassword}
            visible={visibility.currentPassword}
            autoComplete="current-password"
            onChange={(value) => onChange("currentPassword", value)}
            onToggle={() => onToggleVisibility("currentPassword")}
          />
          <PasswordModalInput
            label="新密码"
            value={form.password}
            visible={visibility.password}
            autoComplete="new-password"
            onChange={(value) => onChange("password", value)}
            onToggle={() => onToggleVisibility("password")}
          />
          <PasswordModalInput
            label="再次确认"
            value={form.confirmPassword}
            visible={visibility.confirmPassword}
            autoComplete="new-password"
            onChange={(value) => onChange("confirmPassword", value)}
            onToggle={() => onToggleVisibility("confirmPassword")}
          />
        </div>
        <div className="mt-6 flex items-center justify-between gap-3">
          <AppButton
            type="button"
            size="md"
            variant="secondary"
            onClick={onCancel}
            disabled={saving}
          >
            取消
          </AppButton>
          <AppButton
            type="submit"
            size="md"
            variant="primary"
            loading={saving}
            disabled={saving}
          >
            确认修改
          </AppButton>
        </div>
      </form>
    </div>
  );
}

function PasswordModalInput({
  label,
  value,
  visible,
  autoComplete,
  onChange,
  onToggle,
}) {
  return (
    <label className="block text-sm font-semibold text-slate-700">
      {label}
      <div className="relative mt-2">
        <input
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          className="h-12 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 pr-12 text-sm text-slate-950 outline-none transition focus:border-sky-400 focus:bg-white"
        />
        <button
          type="button"
          className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          aria-label={visible ? "隐藏密码" : "显示密码"}
          onClick={onToggle}
        >
          {visible ? (
            <EyeSlash className="h-5 w-5" />
          ) : (
            <Eye className="h-5 w-5" />
          )}
        </button>
      </div>
    </label>
  );
}

function formatDate(value) {
  if (!value) return "未使用";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  return date.toLocaleString();
}

function isPasskeyCancel(error) {
  return ["AbortError", "NotAllowedError"].includes(error?.name);
}
