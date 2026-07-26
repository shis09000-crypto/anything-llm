import { useEffect, useState } from "react";
import showToast from "@/utils/toast";
import System from "@/models/system";
import paths from "@/utils/paths";
import { AUTH_TIMESTAMP, LAST_USER_ACTION_AT } from "@/utils/constants";
import { clearSensitiveClientSession } from "@/utils/security/clearSensitiveClientState";
import PreLoader from "@/components/Preloader";
import { useTranslation } from "react-i18next";
import Toggle from "@/components/lib/Toggle";
import SecurityKeys from "@/models/securityKeys";
import { vaultCryptoSupported } from "@/utils/security/vaultCrypto";
import { localCacheCryptoSupported } from "@/utils/security/localCacheCrypto";
import { zkLoginStorageSupported } from "@/utils/zkLoginStorage";
import {
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_PATTERN,
} from "@/utils/username";
import {
  SoftButton,
  SoftCard,
  SoftSettingsLayout,
} from "@/components/SoftSettings";

export default function GeneralSecurity() {
  const { t } = useTranslation();
  return (
    <SoftSettingsLayout title={t("security.title")}>
      <MultiUserMode />
      <PasswordProtection />
      <KeyGovernance />
    </SoftSettingsLayout>
  );
}

function KeyGovernance() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [unlocked, setUnlocked] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const result = await SecurityKeys.status();
      setStatus(result);
    } catch (error) {
      setStatus({ success: false, error: error?.message || "状态不可用" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    return () => {
      void SecurityKeys.close();
    };
  }, []);

  const unlock = async () => {
    setBusy(true);
    try {
      const result = await SecurityKeys.unlock(password);
      if (!result?.success) throw new Error(result?.error || "重新认证失败");
      setUnlocked(true);
      setPassword("");
      showToast("密钥控制会话已解锁 5 分钟。", "success");
    } catch (error) {
      showToast(error?.message || "重新认证失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const runPreflight = async () => {
    setBusy(true);
    try {
      const result = await SecurityKeys.preflight();
      if (!result?.success)
        throw new Error(result?.runtime?.reason || result?.error);
      showToast("密钥预检通过。", "success");
      await refresh();
    } catch (error) {
      showToast(error?.message || "密钥预检失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const prepareRotation = async () => {
    if (
      !window.confirm(
        "将创建一把 pending 密钥和持久轮换任务，但不会立即激活。继续吗？"
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const result = await SecurityKeys.prepareRotation();
      if (!result?.success) throw new Error(result?.reason || result?.error);
      showToast("轮换任务已安全准备，旧密钥仍保持 active。", "success");
      await refresh();
    } catch (error) {
      showToast(error?.message || "无法准备轮换任务", "error");
    } finally {
      setBusy(false);
    }
  };

  const approveRotation = async (jobId) => {
    if (!window.confirm("确认以当前管理员身份审批此密钥轮换任务？")) return;
    setBusy(true);
    try {
      const result = await SecurityKeys.approveRotation(jobId);
      if (!result?.success) throw new Error(result?.error || "审批失败");
      showToast("轮换审批已记录，审批人与发起人必须不同。", "success");
      await refresh();
    } catch (error) {
      showToast(error?.message || "无法审批轮换任务", "error");
    } finally {
      setBusy(false);
    }
  };

  const executeRotation = async (jobId) => {
    if (
      !window.confirm(
        "执行将进入写屏障、重加密和校验流程。确认审批窗口有效并继续？"
      )
    )
      return;
    setBusy(true);
    try {
      const result = await SecurityKeys.executeRotation(jobId);
      if (!result?.success) throw new Error(result?.reason || result?.error);
      showToast("密钥轮换已完成并通过校验。", "success");
      await refresh();
    } catch (error) {
      showToast(error?.message || "密钥轮换执行失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const runtime = status?.runtime;
  const provider = status?.provider;
  const active = status?.registry?.find((item) => item.status === "active");
  const clientHealth = [
    ["Vault", vaultCryptoSupported()],
    ["设备签名", Boolean(globalThis.crypto?.subtle && globalThis.indexedDB)],
    ["ZK 登录", zkLoginStorageSupported()],
    ["本地缓存", localCacheCryptoSupported()],
  ];

  return (
    <SoftCard
      title="安全与密钥中心"
      description="统一展示密钥托管、Canary、数据域预检和客户端密钥能力；原始密钥不会进入浏览器。"
      actions={
        <SoftButton type="button" onClick={refresh} disabled={loading || busy}>
          刷新
        </SoftButton>
      }
    >
      {loading ? (
        <PreLoader />
      ) : (
        <div className="space-y-4 text-sm text-[var(--soft-text-primary)]">
          <div className="grid gap-3 md:grid-cols-3">
            <KeyState
              label="运行状态"
              value={runtime?.status || status?.error || "unknown"}
              bad={runtime?.quarantined}
            />
            <KeyState
              label="Provider"
              value={provider?.providerType || "unavailable"}
              bad={!provider?.ok}
            />
            <KeyState
              label="Active Key"
              value={active?.keyId || provider?.keyId || "unregistered"}
            />
          </div>

          {runtime?.reason && (
            <div className="rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-red-100">
              隔离原因：{runtime.reason}
            </div>
          )}

          <div>
            <p className="mb-2 font-semibold">数据域验证</p>
            <div className="grid gap-2 md:grid-cols-2">
              {(status?.bindings || []).map((binding) => (
                <div
                  key={binding.domain}
                  className="flex justify-between rounded-lg bg-white/5 px-3 py-2"
                >
                  <span>{binding.domain}</span>
                  <span
                    className={
                      binding.coverageState === "failed"
                        ? "text-red-300"
                        : "text-emerald-300"
                    }
                  >
                    {binding.coverageState}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 font-semibold">浏览器密钥能力</p>
            <div className="flex flex-wrap gap-2">
              {clientHealth.map(([label, ready]) => (
                <span
                  key={label}
                  className={`rounded-full px-3 py-1 ${ready ? "bg-emerald-400/10 text-emerald-200" : "bg-amber-400/10 text-amber-200"}`}
                >
                  {label}: {ready ? "ready" : "unavailable"}
                </span>
              ))}
            </div>
          </div>

          {!!status?.rotations?.length && (
            <div>
              <p className="mb-2 font-semibold">轮换任务</p>
              <div className="space-y-2">
                {status.rotations.slice(0, 8).map((job) => {
                  const awaitingApproval =
                    Number(job.requiredApprovals || 0) > 0 && !job.approvedAt;
                  const executable =
                    !awaitingApproval &&
                    !["running", "completed"].includes(job.status);
                  return (
                    <div
                      key={job.jobId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white/5 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="break-all font-mono text-xs">
                          {job.jobId}
                        </p>
                        <p className="text-xs text-[var(--soft-text-secondary)]">
                          {job.status} / {job.stage}
                          {job.approvalExpiresAt
                            ? ` · 审批截止 ${new Date(job.approvalExpiresAt).toLocaleString()}`
                            : ""}
                        </p>
                      </div>
                      {unlocked && job.status !== "completed" && (
                        <div className="flex gap-2">
                          {awaitingApproval && (
                            <SoftButton
                              type="button"
                              disabled={busy}
                              onClick={() => approveRotation(job.jobId)}
                            >
                              独立审批
                            </SoftButton>
                          )}
                          {executable && (
                            <SoftButton
                              type="button"
                              disabled={busy || runtime?.quarantined}
                              onClick={() => executeRotation(job.jobId)}
                            >
                              执行轮换
                            </SoftButton>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!unlocked ? (
            <div className="flex max-w-xl items-end gap-2">
              <label className="flex-1">
                <span className="mb-2 block text-xs text-[var(--soft-text-secondary)]">
                  当前管理员密码
                </span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  className="w-full rounded-lg border border-white/10 bg-theme-settings-input-bg p-2.5 outline-none"
                />
              </label>
              <SoftButton
                type="button"
                disabled={busy || !password}
                onClick={unlock}
              >
                解锁控制
              </SoftButton>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <SoftButton type="button" disabled={busy} onClick={runPreflight}>
                执行预检
              </SoftButton>
              <SoftButton
                type="button"
                disabled={busy || runtime?.quarantined}
                onClick={prepareRotation}
              >
                准备轮换
              </SoftButton>
            </div>
          )}
        </div>
      )}
    </SoftCard>
  );
}

function KeyState({ label, value, bad = false }) {
  return (
    <div
      className={`rounded-lg border p-3 ${bad ? "border-red-400/30 bg-red-400/10" : "border-white/10 bg-white/5"}`}
    >
      <p className="text-xs text-[var(--soft-text-secondary)]">{label}</p>
      <p className="mt-1 break-all font-mono text-xs">{value}</p>
    </div>
  );
}

function MultiUserMode() {
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [useMultiUserMode, setUseMultiUserMode] = useState(false);
  const [multiUserModeEnabled, setMultiUserModeEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const { t } = useTranslation();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setHasChanges(false);
    if (useMultiUserMode) {
      const form = new FormData(e.target);
      const data = {
        username: form.get("username"),
        password: form.get("password"),
      };

      const { success, error } = await System.setupMultiUser(data);
      if (success) {
        showToast("Multi-User mode enabled successfully.", "success");
        setSaving(false);
        setTimeout(() => {
          clearSensitiveClientSession();
          window.localStorage.removeItem(AUTH_TIMESTAMP);
          window.localStorage.removeItem(LAST_USER_ACTION_AT);
          window.location = paths.settings.users();
        }, 2_000);
        return;
      }

      showToast(`Failed to enable Multi-User mode: ${error}`, "error");
      setSaving(false);
      return;
    }
  };

  useEffect(() => {
    async function fetchIsMultiUserMode() {
      setLoading(true);
      const multiUserModeEnabled = await System.isMultiUserMode();
      setMultiUserModeEnabled(multiUserModeEnabled);
      setLoading(false);
    }
    fetchIsMultiUserMode();
  }, []);

  if (loading) {
    return (
      <SoftCard>
        <div className="w-full h-full flex justify-center items-center">
          <PreLoader />
        </div>
      </SoftCard>
    );
  }

  return (
    <form
      id="multi-user-mode-form"
      onSubmit={handleSubmit}
      onChange={() => setHasChanges(true)}
      className="settings-soft-form"
    >
      <SoftCard
        title={t("security.multiuser.title")}
        description={t("security.multiuser.description")}
        actions={
          hasChanges && (
            <SoftButton type="submit" form="multi-user-mode-form">
              {saving ? t("common.saving") : t("common.save")}
            </SoftButton>
          )
        }
      >
        <div className="relative w-full max-h-full">
          <div className="relative rounded-lg">
            <div className="flex items-start justify-between px-6 py-4"></div>
            <div className="space-y-6 flex h-full w-full">
              <div className="w-full flex flex-col gap-y-4">
                {multiUserModeEnabled ? (
                  <p className="text-white text-sm font-semibold">
                    {t("security.multiuser.enable.is-enable")}
                  </p>
                ) : (
                  <Toggle
                    size="lg"
                    className="mb-4"
                    label={t("security.multiuser.enable.enable")}
                    enabled={useMultiUserMode}
                    onChange={(checked) => setUseMultiUserMode(checked)}
                  />
                )}
                {useMultiUserMode && (
                  <div className="w-full flex flex-col gap-y-2 my-5">
                    <div className="w-80">
                      <label
                        htmlFor="username"
                        className="text-sm font-semibold block mb-3 text-[var(--soft-text-primary)]"
                      >
                        {t("security.multiuser.enable.username")}
                      </label>
                      <input
                        name="username"
                        type="text"
                        className="border bg-theme-settings-input-bg text-sm outline-none block w-full p-2.5 placeholder:text-theme-settings-input-placeholder"
                        placeholder="Your admin username"
                        minLength={USERNAME_MIN_LENGTH}
                        maxLength={USERNAME_MAX_LENGTH}
                        pattern={USERNAME_PATTERN}
                        required={true}
                        autoComplete="off"
                        disabled={multiUserModeEnabled}
                        defaultValue={multiUserModeEnabled ? "********" : ""}
                      />
                      <p className="text-[var(--soft-text-secondary)] text-xs mt-2">
                        {t("common.username_requirements")}
                      </p>
                    </div>
                    <div className="mt-4 w-80">
                      <label
                        htmlFor="password"
                        className="text-sm font-semibold block mb-3 text-[var(--soft-text-primary)]"
                      >
                        {t("security.multiuser.enable.password")}
                      </label>
                      <input
                        name="password"
                        type="text"
                        className="border bg-theme-settings-input-bg text-sm outline-none block w-full p-2.5 placeholder:text-theme-settings-input-placeholder"
                        placeholder="Your admin password"
                        minLength={8}
                        required={true}
                        autoComplete="off"
                        defaultValue={multiUserModeEnabled ? "********" : ""}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between space-x-14">
              <p className="text-white text-opacity-80 text-xs rounded-lg w-96">
                {t("security.multiuser.enable.description")}
              </p>
            </div>
          </div>
        </div>
      </SoftCard>
    </form>
  );
}

export const PW_REGEX = new RegExp(/^[a-zA-Z0-9_\-!@$%^&*();]+$/);
function PasswordProtection() {
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [multiUserModeEnabled, setMultiUserModeEnabled] = useState(false);
  const [usePassword, setUsePassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const { t } = useTranslation();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (multiUserModeEnabled) return false;
    const form = new FormData(e.target);

    if (!PW_REGEX.test(form.get("password"))) {
      showToast(
        `Your password has restricted characters in it. Allowed symbols are _,-,!,@,$,%,^,&,*,(,),;`,
        "error"
      );
      setSaving(false);
      return;
    }

    setSaving(true);
    setHasChanges(false);
    const data = {
      usePassword,
      newPassword: form.get("password"),
    };

    const { success, error } = await System.updateSystemPassword(data);
    if (success) {
      showToast("Your page will refresh in a few seconds.", "success");
      setSaving(false);
      setTimeout(() => {
        clearSensitiveClientSession();
        window.localStorage.removeItem(AUTH_TIMESTAMP);
        window.localStorage.removeItem(LAST_USER_ACTION_AT);
        window.location.reload();
      }, 3_000);
      return;
    } else {
      showToast(`Failed to update password: ${error}`, "error");
      setSaving(false);
    }
  };

  useEffect(() => {
    async function fetchIsMultiUserMode() {
      setLoading(true);
      const multiUserModeEnabled = await System.isMultiUserMode();
      const settings = await System.keys();
      setMultiUserModeEnabled(multiUserModeEnabled);
      setUsePassword(settings?.RequiresAuth);
      setLoading(false);
    }
    fetchIsMultiUserMode();
  }, []);

  if (loading) {
    return (
      <SoftCard>
        <div className="w-full h-full flex justify-center items-center">
          <PreLoader />
        </div>
      </SoftCard>
    );
  }

  if (multiUserModeEnabled) return null;
  return (
    <form
      id="password-protection-form"
      onSubmit={handleSubmit}
      onChange={() => setHasChanges(true)}
      className="settings-soft-form"
    >
      <SoftCard
        title={t("security.password.title")}
        description={t("security.password.description")}
        actions={
          hasChanges && (
            <SoftButton type="submit" form="password-protection-form">
              {saving ? t("common.saving") : t("common.save")}
            </SoftButton>
          )
        }
      >
        <div className="relative w-full max-h-full">
          <div className="relative rounded-lg">
            <div className="flex items-start justify-between px-6 py-4"></div>
            <div className="space-y-6 flex h-full w-full">
              <div className="w-full flex flex-col gap-y-4">
                <Toggle
                  size="lg"
                  className="mb-4"
                  label={t("security.password.title")}
                  enabled={usePassword}
                  onChange={(checked) => setUsePassword(checked)}
                />
                {usePassword && (
                  <div className="w-full flex flex-col gap-y-2 my-5">
                    <div className="mt-4 w-80">
                      <label
                        htmlFor="password"
                        className="text-sm font-semibold block mb-3 text-[var(--soft-text-primary)]"
                      >
                        {t("security.password.password-label")}
                      </label>
                      <input
                        name="password"
                        type="text"
                        className="border bg-theme-settings-input-bg text-sm outline-none block w-full p-2.5 placeholder:text-theme-settings-input-placeholder"
                        placeholder="Your Instance Password"
                        minLength={8}
                        required={true}
                        autoComplete="off"
                        defaultValue={usePassword ? "********" : ""}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between space-x-14">
              <p className="text-white text-opacity-80 light:text-theme-text text-xs rounded-lg w-96">
                {t("security.password.description")}
              </p>
            </div>
          </div>
        </div>
      </SoftCard>
    </form>
  );
}
