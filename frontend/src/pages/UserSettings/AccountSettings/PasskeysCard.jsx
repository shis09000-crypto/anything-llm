import { useEffect, useState } from "react";
import {
  AppleLogo,
  Fingerprint,
  GoogleLogo,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import { showAppConfirm } from "@/components/lib/AppConfirmDialog/confirm";
import AppButton from "@/components/lib/AppButton";
import showToast from "@/utils/toast";
import AccountSettingsApi from "./accountSettingsApi";
import { CardHeader } from "./ContactMethodsCard";
import {
  detectAuthCapability,
  passkeyCapabilityDescription,
} from "@/utils/authCapability";

export default function PasskeysCard() {
  const [passkeys, setPasskeys] = useState([]);
  const [authCapability, setAuthCapability] = useState(() =>
    detectAuthCapability()
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const capability = detectAuthCapability();
    setAuthCapability(capability);
    if (capability.showPasskey) refreshPasskeys();
  }, []);

  async function refreshPasskeys() {
    const result = await AccountSettingsApi.fetchPasskeys();
    if (result.success) setPasskeys(result.passkeys);
  }

  async function addPasskey() {
    if (!authCapability.showPasskey) {
      showToast("当前浏览器不支持通行密钥。", "info");
      return;
    }

    setLoading(true);
    const result = await AccountSettingsApi.addPasskey().catch((error) => {
      if (isPasskeyCancel(error)) {
        return { success: false, cancelled: true };
      }
      return { success: false, error: error.message };
    });
    setLoading(false);
    if (result.cancelled) {
      showToast("已取消通行密钥验证。", "info");
      return;
    }
    if (!result.success) {
      showToast(result.error || "添加通行密钥失败。", "error");
      return;
    }
    await refreshPasskeys();
    showToast("通行密钥已添加。", "success");
  }

  async function deletePasskey(passkey) {
    const confirmed = await showAppConfirm({
      tone: "danger",
      title: "删除通行密钥？",
      description: `删除 ${passkey.deviceName} 后，该设备将无法再使用此通行密钥登录。`,
      confirmText: "删除",
      cancelText: "取消",
    });
    if (!confirmed) return;
    const result = await AccountSettingsApi.deletePasskey(passkey.id);
    if (result?.requiresRiskConfirmation) {
      const riskConfirmed = await showAppConfirm({
        tone: "danger",
        title: "确认删除这个通行密钥？",
        description:
          result.risk?.message ||
          "删除后账户可用的登录/找回方式会减少，请确认你仍可登录。",
        confirmText: "仍然删除",
        cancelText: "取消",
      });
      if (!riskConfirmed) return;
      const retry = await AccountSettingsApi.deletePasskey(passkey.id, {
        confirmRisk: true,
      });
      if (!retry?.success) {
        showToast(retry?.error || "删除通行密钥失败。", "error");
        return;
      }
    } else if (!result?.success) {
      showToast(result?.error || "删除通行密钥失败。", "error");
      return;
    }
    setPasskeys((current) => current.filter((item) => item.id !== passkey.id));
    showToast("通行密钥已删除。", "success");
  }

  if (!authCapability.showPasskey) {
    return (
      <section id="passkeys" className="account-card">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <CardHeader
            title="通行密钥"
            subtitle="当前浏览器不支持通行密钥。你仍可使用账号密码登录。"
          />
          <span className="rounded-full bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-500">
            不可用
          </span>
        </div>
        <div className="mt-5 flex items-start gap-3 rounded-3xl border border-slate-200 bg-slate-50/80 px-4 py-5 text-sm text-slate-600">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-500">
            <Fingerprint className="h-5 w-5" />
          </div>
          <div>
            <div className="font-semibold text-slate-950">通行密钥不可用</div>
            <p className="mt-1 leading-6">
              通行密钥仅在 Apple 设备、Safari 或 Chrome 且浏览器支持 WebAuthn
              时显示。
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section id="passkeys" className="account-card">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <CardHeader
          title="通行密钥"
          subtitle={passkeyCapabilityDescription(authCapability)}
        />
        <AppButton
          type="button"
          size="md"
          variant="primary"
          onClick={addPasskey}
          disabled={loading}
          leftIcon={<Plus className="h-4 w-4" />}
        >
          {loading ? "正在添加" : "添加通行密钥"}
        </AppButton>
      </div>
      <div className="mt-2 divide-y divide-slate-100">
        {passkeys.length === 0 ? (
          <div className="flex items-center gap-3 px-1 py-6 text-sm text-slate-500">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 text-slate-600">
              <Fingerprint className="h-5 w-5" />
            </div>
            <span>还没有添加通行密钥</span>
          </div>
        ) : null}
        {passkeys.map((passkey) => (
          <div
            key={passkey.id}
            className="flex flex-col gap-3 px-1 py-4 sm:flex-row sm:items-center"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 text-slate-600">
              <Fingerprint className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <div className="font-semibold text-slate-950">
                  {passkey.deviceName}
                </div>
                <ProviderBadge passkey={passkey} />
              </div>
              <div className="mt-1 text-sm text-slate-500">
                创建：{formatDateTime(passkey.createdAt)} · 最近使用：
                {formatDateTime(passkey.lastUsedAt, "尚未使用")}
              </div>
              <div className="mt-1 text-xs text-slate-400">
                {passkey.browserName || "浏览器"} ·{" "}
                {passkey.platformName || "平台待确认"}
                {passkey.backedUp ? " · 已同步" : ""}
              </div>
            </div>
            <AppButton
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => deletePasskey(passkey)}
              className="account-button-danger"
              leftIcon={<Trash className="h-4 w-4" />}
            >
              删除
            </AppButton>
          </div>
        ))}
      </div>
    </section>
  );
}

function ProviderBadge({ passkey }) {
  const provider = passkey.provider || "unknown";
  const providerName = passkey.providerName || "来源待确认";
  const className =
    provider === "apple"
      ? "border-slate-200 bg-slate-100 text-slate-700"
      : provider === "google"
        ? "border-blue-100 bg-blue-50 text-blue-700"
        : "border-slate-200 bg-slate-50 text-slate-500";
  const Icon =
    provider === "apple"
      ? AppleLogo
      : provider === "google"
        ? GoogleLogo
        : null;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${className}`}
    >
      {Icon ? <Icon className="h-3.5 w-3.5" weight="fill" /> : null}
      {providerName}
    </span>
  );
}

function isPasskeyCancel(error) {
  return ["AbortError", "NotAllowedError"].includes(error?.name);
}

function formatDateTime(value, emptyText = "待确认") {
  if (!value) return emptyText;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return emptyText;
  return date.toLocaleString();
}
