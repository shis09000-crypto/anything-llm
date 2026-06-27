import { useEffect, useState } from "react";
import {
  Archive,
  ChatCircleText,
  Eye,
  EyeSlash,
  FileArrowDown,
  Fingerprint,
  LockKey,
  PencilSimpleLine,
  Plus,
  ShieldCheck,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import AppButton from "@/components/lib/AppButton";
import { showAppConfirm } from "@/components/lib/AppConfirmDialog/confirm";
import showToast from "@/utils/toast";
import { AUTH_USER } from "@/utils/constants";
import { removeAuthToken } from "@/utils/authTokenStorage";
import AccountSettingRow from "./AccountSettingRow";
import AccountSettingsApi from "./accountSettingsApi";
import { CardHeader } from "./ContactMethodsCard";

const SENSITIVE_MEMORY_SESSION_TTL_MS = 5 * 60 * 1000;
const MEMORY_CATEGORY_OPTIONS = [
  { category: "preferences", title: "用户偏好" },
  { category: "projects", title: "长期项目" },
  { category: "facts", title: "长期事实" },
  { category: "decisions", title: "重要决策" },
  { category: "open_topics", title: "待解决问题" },
  { category: "interests", title: "兴趣与研究方向" },
];

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
  const [sensitiveMemories, setSensitiveMemories] = useState([]);
  const [sensitiveLoading, setSensitiveLoading] = useState(true);
  const [sensitiveDrawerOpen, setSensitiveDrawerOpen] = useState(false);
  const [creatingTempMemory, setCreatingTempMemory] = useState(false);
  const [revealTarget, setRevealTarget] = useState(null);
  const [revealPassword, setRevealPassword] = useState("");
  const [showRevealPassword, setShowRevealPassword] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [revealedMemories, setRevealedMemories] = useState({});
  const [editingSensitiveMemory, setEditingSensitiveMemory] = useState(null);
  const [savingSensitiveMemory, setSavingSensitiveMemory] = useState(false);
  const [deletingSensitiveMemoryId, setDeletingSensitiveMemoryId] =
    useState(null);
  const [passkeys, setPasskeys] = useState([]);
  const [passkeysLoading, setPasskeysLoading] = useState(false);
  const [revealMethod, setRevealMethod] = useState("password");

  useEffect(() => {
    if (!deleteModalOpen || cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1_000);
    return () => clearTimeout(timer);
  }, [deleteModalOpen, cooldown]);

  useEffect(() => {
    refreshSensitiveMemories();
  }, []);

  useEffect(() => {
    if (!sensitiveDrawerOpen) return;
    refreshSensitiveMemories();
    refreshPasskeys();
  }, [sensitiveDrawerOpen]);

  useEffect(() => {
    if (!sensitiveDrawerOpen) return;
    const timer = window.setTimeout(() => {
      setSensitiveDrawerOpen(false);
      clearSensitiveSession();
      showToast("敏感记忆查看已超时，请重新验证。", "info");
    }, SENSITIVE_MEMORY_SESSION_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [sensitiveDrawerOpen]);

  useEffect(() => {
    if (!revealTarget) return;
    setRevealMethod(canUsePasskey() ? "passkey" : "password");
  }, [revealTarget, passkeys.length]);

  useEffect(() => {
    if (!sensitiveDrawerOpen) return;
    const handleKeyDown = (event) => {
      if (event.key !== "Escape") return;
      if (revealing || creatingTempMemory) return;
      if (revealTarget) {
        closeRevealPanel();
        return;
      }
      closeSensitiveDrawer();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [sensitiveDrawerOpen, revealing, creatingTempMemory, revealTarget]);

  async function refreshSensitiveMemories() {
    setSensitiveLoading(true);
    const result = await AccountSettingsApi.fetchSensitiveMemories({
      limit: 50,
      offset: 0,
      detail: "light",
    });
    setSensitiveLoading(false);
    if (!result?.success) {
      showToast(result?.error || "无法读取敏感记忆。", "error");
      return;
    }
    setSensitiveMemories(result.memories || []);
  }

  async function refreshPasskeys() {
    if (!AccountSettingsApi.passkeysSupported()) {
      setPasskeys([]);
      return;
    }
    setPasskeysLoading(true);
    const result = await AccountSettingsApi.fetchPasskeys();
    setPasskeysLoading(false);
    if (!result?.success) {
      setPasskeys([]);
      return;
    }
    setPasskeys(result.passkeys || []);
  }

  function canUsePasskey() {
    return AccountSettingsApi.passkeysSupported() && passkeys.length > 0;
  }

  function openSensitiveDrawer() {
    clearSensitiveSession();
    setSensitiveDrawerOpen(true);
  }

  function closeSensitiveDrawer() {
    if (revealing || creatingTempMemory || savingSensitiveMemory) return;
    setSensitiveDrawerOpen(false);
    clearSensitiveSession();
    setEditingSensitiveMemory(null);
  }

  function closeRevealPanel() {
    resetRevealPrompt();
  }

  function resetRevealPrompt() {
    setRevealTarget(null);
    setRevealPassword("");
    setShowRevealPassword(false);
    setRevealMethod(canUsePasskey() ? "passkey" : "password");
  }

  function clearSensitiveSession() {
    setRevealTarget(null);
    setRevealPassword("");
    setShowRevealPassword(false);
    setRevealMethod(canUsePasskey() ? "passkey" : "password");
    setRevealedMemories({});
    setEditingSensitiveMemory(null);
  }

  async function createTemporarySensitiveMemory() {
    setCreatingTempMemory(true);
    const result = await AccountSettingsApi.createMemoryCandidate({
      category: "facts",
      title: "临时敏感测试",
      detail: "这是一条用于验证敏感记忆密码和通行密钥解锁流程的临时内容。",
      source: "临时测试",
      confidence: "测试",
      isSensitive: true,
    });
    setCreatingTempMemory(false);
    if (!result?.success) {
      showToast(result?.error || "无法添加临时敏感记忆。", "error");
      return;
    }
    showToast("已添加临时敏感记忆。", "success");
    await refreshSensitiveMemories();
  }

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
    removeAuthToken();
    showToast("账户已删除，已退出登录。", "success");
    navigate("/login?nt=1", { replace: true });
  }

  async function revealSensitiveMemoryWithPassword() {
    if (!revealTarget) return;
    if (!revealPassword.trim()) {
      showToast("请输入当前密码。", "error");
      return;
    }

    setRevealing(true);
    const result = await AccountSettingsApi.revealSensitiveMemory({
      id: revealTarget.id,
      currentPassword: revealPassword,
    });
    setRevealing(false);
    if (!result?.success) {
      showToast(result?.error || "无法查看敏感记忆。", "error");
      return;
    }

    setRevealedMemories((current) => ({
      ...current,
      [revealTarget.id]: result.memory,
    }));
    closeRevealPanel();
  }

  async function revealSensitiveMemoryWithPasskey() {
    if (!revealTarget) return;
    setRevealing(true);
    const reauth = await AccountSettingsApi.reauthSensitiveMemoryWithPasskey();
    if (!reauth?.success || !reauth?.reauthToken) {
      setRevealing(false);
      showToast(reauth?.error || "通行密钥验证失败。", "error");
      return;
    }

    const result = await AccountSettingsApi.revealSensitiveMemory({
      id: revealTarget.id,
      reauthToken: reauth.reauthToken,
    });
    setRevealing(false);
    if (!result?.success) {
      showToast(result?.error || "无法查看敏感记忆。", "error");
      return;
    }

    setRevealedMemories((current) => ({
      ...current,
      [revealTarget.id]: result.memory,
    }));
    closeRevealPanel();
  }

  async function saveSensitiveMemoryEdit(form) {
    if (!editingSensitiveMemory) return;
    setSavingSensitiveMemory(true);
    const result = await AccountSettingsApi.updateMemory({
      id: editingSensitiveMemory.id,
      ...form,
    });
    setSavingSensitiveMemory(false);
    if (!result?.success) {
      showToast(result?.error || "无法更新敏感记忆。", "error");
      return;
    }

    const id = editingSensitiveMemory.id;
    setEditingSensitiveMemory(null);
    setRevealedMemories((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    showToast("敏感记忆已更新。", "success");
    await refreshSensitiveMemories();
  }

  async function deleteSensitiveMemory(memory) {
    const confirmed = await showAppConfirm({
      title: "删除敏感记忆",
      description:
        "确定删除这条敏感记忆吗？删除后会进入记忆归档，但不会归档明文。",
      confirmText: "删除",
      cancelText: "取消",
      tone: "danger",
    });
    if (!confirmed) return;

    setDeletingSensitiveMemoryId(memory.id);
    const result = await AccountSettingsApi.deleteMemory({ id: memory.id });
    setDeletingSensitiveMemoryId(null);
    if (!result?.success) {
      showToast(result?.error || "无法删除敏感记忆。", "error");
      return;
    }

    setRevealedMemories((current) => {
      const next = { ...current };
      delete next[memory.id];
      return next;
    });
    showToast("敏感记忆已删除并归档。", "success");
    await refreshSensitiveMemories();
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
          icon={<LockKey className="h-5 w-5" />}
          title="敏感记忆"
          subtitle="单独存放需要二次验证才能查看的长期记忆。"
          onClick={openSensitiveDrawer}
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
      <SensitiveMemoryDrawer
        open={sensitiveDrawerOpen}
        loading={sensitiveLoading}
        memories={sensitiveMemories}
        revealedMemories={revealedMemories}
        revealTarget={revealTarget}
        password={revealPassword}
        setPassword={setRevealPassword}
        showPassword={showRevealPassword}
        setShowPassword={setShowRevealPassword}
        revealing={revealing}
        passkeyAvailable={canUsePasskey()}
        passkeysLoading={passkeysLoading}
        revealMethod={revealMethod}
        setRevealMethod={setRevealMethod}
        creatingTempMemory={creatingTempMemory}
        deletingMemoryId={deletingSensitiveMemoryId}
        onClose={closeSensitiveDrawer}
        onCreateTemp={createTemporarySensitiveMemory}
        onStartReveal={(memory) => {
          setRevealTarget(memory);
          setRevealPassword("");
          setShowRevealPassword(false);
          setRevealMethod(canUsePasskey() ? "passkey" : "password");
        }}
        onCancelReveal={closeRevealPanel}
        onRevealWithPassword={revealSensitiveMemoryWithPassword}
        onRevealWithPasskey={revealSensitiveMemoryWithPasskey}
        onEdit={(memory) => setEditingSensitiveMemory(memory)}
        onDelete={deleteSensitiveMemory}
      />
      {editingSensitiveMemory && (
        <SensitiveMemoryEditDialog
          memory={editingSensitiveMemory}
          saving={savingSensitiveMemory}
          onCancel={() => setEditingSensitiveMemory(null)}
          onSave={saveSensitiveMemoryEdit}
        />
      )}
    </section>
  );
}

function SensitiveMemoryDrawer({
  open,
  loading,
  memories,
  revealedMemories,
  revealTarget,
  password,
  setPassword,
  showPassword,
  setShowPassword,
  revealing,
  passkeyAvailable,
  passkeysLoading,
  revealMethod,
  setRevealMethod,
  creatingTempMemory,
  deletingMemoryId,
  onClose,
  onCreateTemp,
  onStartReveal,
  onCancelReveal,
  onRevealWithPassword,
  onRevealWithPasskey,
  onEdit,
  onDelete,
}) {
  return (
    <div
      className={[
        "fixed inset-0 z-[10000] hidden transition-opacity duration-[280ms] md:block",
        open
          ? "pointer-events-auto bg-slate-950/[0.08] opacity-100 backdrop-blur-[2px]"
          : "pointer-events-none bg-slate-950/0 opacity-0",
      ].join(" ")}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="sensitive-memory-drawer-title"
    >
      <aside
        className={[
          "absolute bottom-6 right-6 top-6 flex w-[400px] max-w-[calc(100vw-48px)] flex-col rounded-[20px] border border-slate-200/80 bg-white shadow-[0_22px_60px_rgba(15,23,42,0.14)] transition-transform duration-[280ms] ease-out",
          open ? "translate-x-0" : "translate-x-[calc(100%+32px)]",
        ].join(" ")}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="border-b border-slate-100 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-300">
                Sensitive Memory
              </p>
              <h3
                id="sensitive-memory-drawer-title"
                className="mt-2 text-lg font-semibold text-slate-950"
              >
                敏感记忆
              </h3>
              <p className="mt-1 text-sm leading-6 text-slate-500">
                需要二次验证才能查看的长期记忆。
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 transition hover:bg-slate-50 hover:text-slate-700"
              aria-label="关闭敏感记忆"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="rounded-2xl border border-slate-100 bg-slate-50/80 px-4 py-5 text-sm text-slate-500">
              正在读取敏感记忆...
            </div>
          ) : memories.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-4 py-5">
              <p className="text-sm font-semibold text-slate-800">
                还没有敏感记忆
              </p>
              <p className="mt-1 text-sm leading-6 text-slate-500">
                可以先添加一条临时测试记忆，用来验证密码和通行密钥解锁流程。
              </p>
              <AppButton
                size="sm"
                variant="secondary"
                className="mt-4"
                loading={creatingTempMemory}
                onClick={onCreateTemp}
              >
                <Plus className="h-4 w-4" />
                添加临时测试记忆
              </AppButton>
            </div>
          ) : (
            <div className="space-y-2">
              {memories.map((memory) => {
                const revealed = revealedMemories[memory.id];
                return (
                  <div
                    key={memory.id}
                    className="rounded-2xl border border-slate-100 bg-white px-3.5 py-3 shadow-[0_1px_8px_rgba(15,23,42,0.03)]"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center justify-between gap-3">
                        <p className="truncate text-sm font-semibold text-slate-900">
                          {revealed?.title || memory.title}
                        </p>
                        <div className="flex shrink-0 items-center gap-1">
                          {revealed ? (
                            <button
                              type="button"
                              className="flex h-7 w-7 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-50 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-100"
                              onClick={() =>
                                onEdit({
                                  ...memory,
                                  title: revealed.title,
                                  detail: revealed.detail,
                                })
                              }
                              aria-label="编辑敏感记忆"
                            >
                              <PencilSimpleLine className="h-3.5 w-3.5" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="shrink-0 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-500 transition hover:bg-slate-50 hover:text-slate-700"
                              onClick={() => onStartReveal(memory)}
                            >
                              查看
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={deletingMemoryId === memory.id}
                            className="flex h-7 w-7 items-center justify-center rounded-full text-slate-400 transition hover:bg-rose-50 hover:text-rose-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
                            onClick={() => onDelete(memory)}
                            aria-label="删除敏感记忆"
                          >
                            <Trash className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                      <div className="min-w-0">
                        <p className="mt-1 line-clamp-3 text-sm leading-6 text-slate-500">
                          {revealed?.detail || memory.detail}
                        </p>
                        <p className="mt-2 text-xs text-slate-400">
                          {memory.source} · {memory.confidence} ·{" "}
                          {formatPrivacyDate(memory.updatedAt)}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <footer className="border-t border-slate-100 px-5 py-3 text-xs leading-5 text-slate-400">
          这些记忆只用于个性化体验，不会用于训练模型。
        </footer>
      </aside>
      {revealTarget && (
        <SensitiveMemoryRevealDialog
          memory={revealTarget}
          password={password}
          setPassword={setPassword}
          showPassword={showPassword}
          setShowPassword={setShowPassword}
          loading={revealing}
          passkeyAvailable={passkeyAvailable}
          passkeysLoading={passkeysLoading}
          method={revealMethod}
          setMethod={setRevealMethod}
          onCancel={onCancelReveal}
          onRevealWithPassword={onRevealWithPassword}
          onRevealWithPasskey={onRevealWithPasskey}
        />
      )}
    </div>
  );
}

function SensitiveMemoryEditDialog({ memory, saving, onCancel, onSave }) {
  const [form, setForm] = useState(() => ({
    category: memory.category,
    title: memory.title,
    detail: memory.detail,
    source: memory.source,
    confidence: memory.confidence,
  }));

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function submit(event) {
    event.preventDefault();
    onSave(form);
  }

  return (
    <div
      className="fixed inset-0 z-[10020] flex items-center justify-center bg-slate-950/[0.12] px-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sensitive-memory-edit-title"
      onClick={() => {
        if (!saving) onCancel();
      }}
    >
      <form
        className="w-full max-w-[480px] rounded-[24px] border border-white/80 bg-white p-5 shadow-[0_24px_70px_rgba(15,23,42,0.18)]"
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-300">
              Edit Sensitive Memory
            </p>
            <h4
              id="sensitive-memory-edit-title"
              className="mt-2 text-lg font-semibold text-slate-950"
            >
              编辑敏感记忆
            </h4>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 transition hover:bg-slate-50 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="关闭编辑"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <SensitiveMemoryFormField label="分类">
            <select
              className="w-full rounded-2xl border border-slate-200 bg-slate-50/70 px-3 py-2.5 text-sm font-medium text-slate-800 outline-none transition focus:border-violet-200 focus:bg-white focus:ring-2 focus:ring-violet-100"
              value={form.category}
              onChange={(event) => updateField("category", event.target.value)}
            >
              {MEMORY_CATEGORY_OPTIONS.map((option) => (
                <option key={option.category} value={option.category}>
                  {option.title}
                </option>
              ))}
            </select>
          </SensitiveMemoryFormField>
          <SensitiveMemoryFormField label="标题">
            <input
              className="w-full rounded-2xl border border-slate-200 bg-slate-50/70 px-3 py-2.5 text-sm font-medium text-slate-800 outline-none transition focus:border-violet-200 focus:bg-white focus:ring-2 focus:ring-violet-100"
              value={form.title}
              maxLength={160}
              onChange={(event) => updateField("title", event.target.value)}
            />
          </SensitiveMemoryFormField>
          <SensitiveMemoryFormField label="详情">
            <textarea
              className="min-h-[120px] w-full resize-y rounded-2xl border border-slate-200 bg-slate-50/70 px-3 py-2.5 text-sm leading-6 text-slate-800 outline-none transition focus:border-violet-200 focus:bg-white focus:ring-2 focus:ring-violet-100"
              value={form.detail}
              maxLength={2000}
              onChange={(event) => updateField("detail", event.target.value)}
            />
          </SensitiveMemoryFormField>
          <div className="grid gap-3 md:grid-cols-2">
            <SensitiveMemoryFormField label="来源">
              <input
                className="w-full rounded-2xl border border-slate-200 bg-slate-50/70 px-3 py-2.5 text-sm font-medium text-slate-800 outline-none transition focus:border-violet-200 focus:bg-white focus:ring-2 focus:ring-violet-100"
                value={form.source}
                maxLength={120}
                onChange={(event) => updateField("source", event.target.value)}
              />
            </SensitiveMemoryFormField>
            <SensitiveMemoryFormField label="置信度">
              <input
                className="w-full rounded-2xl border border-slate-200 bg-slate-50/70 px-3 py-2.5 text-sm font-medium text-slate-800 outline-none transition focus:border-violet-200 focus:bg-white focus:ring-2 focus:ring-violet-100"
                value={form.confidence}
                maxLength={24}
                onChange={(event) =>
                  updateField("confidence", event.target.value)
                }
              />
            </SensitiveMemoryFormField>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <AppButton
            type="button"
            variant="secondary"
            size="sm"
            disabled={saving}
            onClick={onCancel}
          >
            取消
          </AppButton>
          <AppButton type="submit" size="sm" loading={saving}>
            保存
          </AppButton>
        </div>
      </form>
    </div>
  );
}

function SensitiveMemoryFormField({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}

function SensitiveMemoryRevealDialog({
  memory,
  password,
  setPassword,
  showPassword,
  setShowPassword,
  loading,
  passkeyAvailable,
  passkeysLoading,
  method,
  setMethod,
  onCancel,
  onRevealWithPassword,
  onRevealWithPasskey,
}) {
  return (
    <div
      className="fixed inset-0 z-[10010] flex items-center justify-center bg-slate-950/[0.12] px-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sensitive-memory-reveal-title"
      onClick={(event) => {
        event.stopPropagation();
        if (!loading) onCancel();
      }}
    >
      <div
        className="w-full max-w-[380px] rounded-[24px] border border-white/80 bg-white p-5 shadow-[0_24px_70px_rgba(15,23,42,0.18)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-300">
              Verify Identity
            </p>
            <h4
              id="sensitive-memory-reveal-title"
              className="mt-2 text-lg font-semibold text-slate-950"
            >
              查看敏感记忆
            </h4>
            <p className="mt-1 truncate text-sm text-slate-500">
              {memory?.title || "敏感记忆"}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 transition hover:bg-slate-50 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="关闭验证"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <SensitiveMemoryVerificationPanel
          password={password}
          setPassword={setPassword}
          showPassword={showPassword}
          setShowPassword={setShowPassword}
          loading={loading}
          passkeyAvailable={passkeyAvailable}
          passkeysLoading={passkeysLoading}
          method={method}
          setMethod={setMethod}
          onCancel={onCancel}
          onRevealWithPassword={onRevealWithPassword}
          onRevealWithPasskey={onRevealWithPasskey}
        />
      </div>
    </div>
  );
}

function SensitiveMemoryVerificationPanel({
  password,
  setPassword,
  showPassword,
  setShowPassword,
  loading,
  passkeyAvailable,
  passkeysLoading,
  method,
  setMethod,
  onCancel,
  onRevealWithPassword,
  onRevealWithPasskey,
}) {
  const usePasskey = passkeyAvailable && method === "passkey";
  return (
    <div className="mt-3 rounded-3xl border border-slate-200 bg-slate-50/80 p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-500">
          {usePasskey ? (
            <Fingerprint className="h-5 w-5" />
          ) : (
            <LockKey className="h-5 w-5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900">验证身份</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            {passkeyAvailable
              ? "已检测到通行密钥，默认使用通行密钥查看敏感记忆。"
              : "当前账号没有可用通行密钥，请输入当前密码查看。"}
          </p>
        </div>
      </div>

      {usePasskey ? (
        <div className="mt-4 flex flex-col gap-2">
          <AppButton
            size="sm"
            loading={loading || passkeysLoading}
            onClick={onRevealWithPasskey}
          >
            <Fingerprint className="h-4 w-4" />
            使用通行密钥查看
          </AppButton>
          <button
            type="button"
            className="text-xs font-semibold text-slate-400 transition hover:text-slate-700"
            onClick={() => setMethod("password")}
            disabled={loading}
          >
            改用当前密码
          </button>
        </div>
      ) : (
        <>
          <label className="mt-4 block text-xs font-semibold text-slate-500">
            当前密码
          </label>
          <div className="mt-2 flex h-11 items-center rounded-2xl border border-slate-200 bg-white px-3 focus-within:border-blue-400 focus-within:ring-4 focus-within:ring-blue-100">
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={loading}
              className="min-w-0 flex-1 bg-transparent text-sm font-medium text-slate-900 outline-none placeholder:text-slate-400"
              placeholder="请输入当前密码"
              autoComplete="current-password"
              autoFocus
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              className="ml-2 rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              aria-label={showPassword ? "隐藏密码" : "显示密码"}
              disabled={loading}
            >
              {showPassword ? (
                <EyeSlash className="h-5 w-5" />
              ) : (
                <Eye className="h-5 w-5" />
              )}
            </button>
          </div>
          {passkeyAvailable && (
            <button
              type="button"
              className="mt-2 text-xs font-semibold text-slate-400 transition hover:text-slate-700"
              onClick={() => setMethod("passkey")}
              disabled={loading}
            >
              使用通行密钥
            </button>
          )}
        </>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <AppButton
          variant="secondary"
          size="sm"
          onClick={onCancel}
          disabled={loading}
        >
          取消
        </AppButton>
        {!usePasskey && (
          <AppButton size="sm" loading={loading} onClick={onRevealWithPassword}>
            查看
          </AppButton>
        )}
      </div>
    </div>
  );
}

function formatPrivacyDate(value) {
  if (!value) return "未知时间";
  try {
    return new Date(value).toLocaleDateString("zh-CN");
  } catch {
    return String(value);
  }
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
              此操作会删除当前环境中的账号数据和相关业务数据。请确认下方删除范围，完成二次验证后，等待
              5 秒冷却再手动确认删除。
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-red-100 bg-red-50/70 p-4 text-sm text-red-700">
          <p className="font-semibold text-red-800">
            将删除账号：{preview?.username || "当前账号"}
          </p>
          <p className="mt-1">
            环境：{preview?.currentEnv || "当前环境"} · 共享认证账号：
            {preview?.willDeleteSharedAuthUser
              ? "同步删除"
              : "保留并写入当前环境删除记录"}
          </p>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <PreviewMetric label="工作区" value={totals.workspaceCount || 0} />
          <PreviewMetric label="线程" value={totals.threadCount || 0} />
          <PreviewMetric label="聊天记录" value={totals.chatCount || 0} />
          <PreviewMetric
            label="文档与向量空间"
            value={totals.documentCount || 0}
          />
          <PreviewMetric
            label="记忆/学习数据"
            value={totals.memoryCount || 0}
          />
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
