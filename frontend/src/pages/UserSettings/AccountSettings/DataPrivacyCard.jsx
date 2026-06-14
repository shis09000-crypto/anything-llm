import { useEffect, useState } from "react";
import {
  Archive,
  ChatCircleText,
  Eye,
  EyeSlash,
  FileArrowDown,
  ShieldCheck,
  Trash,
} from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import AppButton from "@/components/lib/AppButton";
import showToast from "@/utils/toast";
import { AUTH_TOKEN, AUTH_USER } from "@/utils/constants";
import AccountSettingRow from "./AccountSettingRow";
import AccountSettingsApi from "./accountSettingsApi";
import { CardHeader } from "./ContactMethodsCard";

export default function DataPrivacyCard() {
  const navigate = useNavigate();
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deletePreview, setDeletePreview] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [reauthToken, setReauthToken] = useState(null);
  const [reauthLoading, setReauthLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (!deleteModalOpen || cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1_000);
    return () => clearTimeout(timer);
  }, [deleteModalOpen, cooldown]);

  async function exportAccountData() {
    await AccountSettingsApi.exportAccountData();
    showToast("导出账户数据接口已预留。", "info");
  }

  async function exportChatRecords() {
    await AccountSettingsApi.exportChatRecords();
    showToast("导出聊天记录接口已预留。", "info");
  }

  async function requestDeletion() {
    setLoadingPreview(true);
    const result = await AccountSettingsApi.fetchAccountDeletePreview();
    setLoadingPreview(false);
    if (!result?.success) {
      showToast(result?.error || "无法生成删除预览。", "error");
      return;
    }
    setDeletePreview(result.preview);
    setDeleteModalOpen(true);
  }

  function closeDeleteModal() {
    if (deleteLoading) return;
    setDeleteModalOpen(false);
    setDeletePreview(null);
    setCurrentPassword("");
    setShowPassword(false);
    setReauthToken(null);
    setCooldown(0);
  }

  async function verifyDeletePassword() {
    if (!currentPassword.trim()) {
      showToast("请输入当前密码。", "error");
      return;
    }
    setReauthLoading(true);
    const result = await AccountSettingsApi.reauthAccountDeleteWithPassword({
      currentPassword,
    });
    setReauthLoading(false);
    if (!result?.success || !result?.reauthToken) {
      showToast(result?.error || "安全验证失败。", "error");
      return;
    }
    setReauthToken(result.reauthToken);
    setCooldown(5);
    showToast("安全验证已通过，请确认删除范围。", "success");
  }

  async function confirmDeleteAccount() {
    if (!reauthToken) {
      showToast("请先完成安全验证。", "error");
      return;
    }
    if (cooldown > 0) return;
    setDeleteLoading(true);
    const result = await AccountSettingsApi.deleteAccount({
      confirm: true,
      reauthToken,
    });
    setDeleteLoading(false);
    if (!result?.success) {
      showToast(result?.error || "删除账户失败。", "error");
      return;
    }

    await AccountSettingsApi.clearLocalZkDevices().catch(() => null);
    window.localStorage.removeItem(AUTH_USER);
    window.localStorage.removeItem(AUTH_TOKEN);
    showToast("账户已删除，已退出登录。", "success");
    navigate("/login?nt=1", { replace: true });
  }

  return (
    <section id="privacy" className="account-card">
      <CardHeader
        title="数据与隐私"
        subtitle="导出数据、查看安全记录或发起账户删除流程。"
      />
      <div className="divide-y divide-slate-100">
        <AccountSettingRow
          icon={<FileArrowDown className="h-5 w-5" />}
          title="导出账户数据"
          subtitle="导出个人资料、联系方式和账号配置。"
          onClick={exportAccountData}
        />
        <AccountSettingRow
          icon={<ChatCircleText className="h-5 w-5" />}
          title="导出聊天记录"
          subtitle="导出你有权限访问的聊天历史。"
          onClick={exportChatRecords}
        />
        <AccountSettingRow
          icon={<ShieldCheck className="h-5 w-5" />}
          title="安全审计记录"
          subtitle="查看登录、安全设置和账号变更记录。"
          status={
            <span className="font-semibold text-slate-400">入口预留</span>
          }
        />
        <AccountSettingRow
          icon={<Archive className="h-5 w-5" />}
          title="数据保留"
          subtitle="账户数据遵循本地部署的数据保留策略。"
          status={<span className="font-semibold text-slate-500">默认</span>}
        />
        <AccountSettingRow
          icon={<Trash className="h-5 w-5" />}
          title="删除账户"
          subtitle="删除账户需要独立确认和后端安全流程。"
          danger
          onClick={requestDeletion}
          status={
            loadingPreview ? (
              <span className="font-semibold text-slate-400">生成预览中</span>
            ) : null
          }
        />
      </div>
      {deleteModalOpen && (
        <AccountDeleteDialog
          preview={deletePreview}
          currentPassword={currentPassword}
          setCurrentPassword={setCurrentPassword}
          showPassword={showPassword}
          setShowPassword={setShowPassword}
          reauthToken={reauthToken}
          cooldown={cooldown}
          reauthLoading={reauthLoading}
          deleteLoading={deleteLoading}
          onVerify={verifyDeletePassword}
          onCancel={closeDeleteModal}
          onDelete={confirmDeleteAccount}
        />
      )}
    </section>
  );
}

function AccountDeleteDialog({
  preview,
  currentPassword,
  setCurrentPassword,
  showPassword,
  setShowPassword,
  reauthToken,
  cooldown,
  reauthLoading,
  deleteLoading,
  onVerify,
  onCancel,
  onDelete,
}) {
  const totals = preview?.totals || {};
  const workspaces = preview?.workspaces || [];
  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/35 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-delete-title"
    >
      <div className="w-full max-w-2xl rounded-[28px] border border-white/80 bg-white p-6 shadow-2xl shadow-slate-900/20">
        <div className="mb-5 flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-red-50 text-red-600">
            <Trash className="h-5 w-5" />
          </div>
          <div>
            <h3
              id="account-delete-title"
              className="text-xl font-semibold text-slate-950"
            >
              删除账户？
            </h3>
            <p className="mt-1 text-sm leading-6 text-slate-500">
              此操作会删除当前环境中的账号数据和相关业务数据。请确认下方删除范围，完成二次验证后，等待 5 秒冷却再手动确认删除。
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-red-100 bg-red-50/70 p-4 text-sm text-red-700">
          <p className="font-semibold text-red-800">
            将删除账号：{preview?.username || "当前账号"}
          </p>
          <p className="mt-1">
            环境：{preview?.currentEnv || "当前环境"} · 共享认证账号：
            {preview?.willDeleteSharedAuthUser ? "同步删除" : "保留并写入当前环境删除记录"}
          </p>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <PreviewMetric label="工作区" value={totals.workspaceCount || 0} />
          <PreviewMetric label="线程" value={totals.threadCount || 0} />
          <PreviewMetric label="聊天记录" value={totals.chatCount || 0} />
          <PreviewMetric label="文档与向量空间" value={totals.documentCount || 0} />
          <PreviewMetric label="记忆/学习数据" value={totals.memoryCount || 0} />
          <PreviewMetric
            label="向量命名空间"
            value={totals.vectorNamespaceCount || 0}
          />
        </div>

        {workspaces.length > 0 && (
          <div className="mt-4 max-h-36 overflow-y-auto rounded-2xl border border-slate-100">
            {workspaces.map((workspace) => (
              <div
                key={workspace.id}
                className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-800">
                    {workspace.name}
                  </p>
                  <p className="text-xs text-slate-500">
                    {workspace.deleteMode === "delete_workspace"
                      ? "唯一成员工作区，将完整删除并清理向量数据"
                      : "多人工作区，仅移除你的成员关系和个人数据"}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-500">
                  {workspace.deleteMode === "delete_workspace"
                    ? "删除工作区"
                    : "移除成员"}
                </span>
              </div>
            ))}
          </div>
        )}

        {preview?.warnings?.length > 0 && (
          <div className="mt-4 space-y-1 text-xs text-slate-500">
            {preview.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        )}

        <div className="mt-5">
          <label className="text-sm font-semibold text-slate-700">
            当前密码
          </label>
          <div className="mt-2 flex h-12 items-center rounded-2xl border border-slate-200 bg-white px-3 focus-within:border-blue-400 focus-within:ring-4 focus-within:ring-blue-100">
            <input
              type={showPassword ? "text" : "password"}
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              disabled={Boolean(reauthToken) || reauthLoading || deleteLoading}
              className="min-w-0 flex-1 bg-transparent text-sm font-medium text-slate-900 outline-none placeholder:text-slate-400"
              placeholder="请输入当前密码"
              autoComplete="current-password"
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              className="ml-2 rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              aria-label={showPassword ? "隐藏密码" : "显示密码"}
            >
              {showPassword ? (
                <EyeSlash className="h-5 w-5" />
              ) : (
                <Eye className="h-5 w-5" />
              )}
            </button>
          </div>
        </div>

        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <AppButton
            variant="secondary"
            onClick={onCancel}
            disabled={deleteLoading}
          >
            取消
          </AppButton>
          <div className="flex flex-col gap-3 sm:flex-row">
            {!reauthToken && (
              <AppButton
                variant="secondary"
                onClick={onVerify}
                loading={reauthLoading}
                disabled={deleteLoading}
              >
                验证身份
              </AppButton>
            )}
            <AppButton
              variant="primary"
              onClick={onDelete}
              loading={deleteLoading}
              disabled={!reauthToken || cooldown > 0}
              className="!bg-red-600 hover:!bg-red-700"
            >
              {cooldown > 0 ? `删除账户 (${cooldown}s)` : "删除账户"}
            </AppButton>
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewMetric({ label, value }) {
  return (
    <div className="rounded-2xl bg-slate-50 px-4 py-3">
      <p className="text-xs font-semibold text-slate-400">{label}</p>
      <p className="mt-1 text-lg font-semibold text-slate-900">{value}</p>
    </div>
  );
}
