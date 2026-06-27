import { useEffect, useMemo, useState } from "react";
import { saveAs } from "file-saver";
import {
  BookOpen,
  CaretLeft,
  CaretRight,
  ChatsCircle,
  EnvelopeSimple,
  TextT,
  Trash,
  UserCircleGear,
} from "@phosphor-icons/react";
import { titleCase } from "text-case";
import Admin from "@/models/admin";
import System from "@/models/system";
import paths from "@/utils/paths";
import showToast from "@/utils/toast";
import { showAppConfirm } from "@/components/lib/AppConfirmDialog/confirm";
import AppButton from "@/components/lib/AppButton";
import ModalWrapper from "@/components/ModalWrapper";
import { useModal } from "@/hooks/useModal";
import NewInviteModal from "@/pages/Admin/Invitations/NewInviteModal";
import {
  ACCOUNT_ROLES,
  accountRoleLabel,
  banActorRole,
  canRestoreBannedUser,
  isPrimaryOwner,
  nextAccountPromotion,
  normalizeRole,
} from "@/utils/authz";

const CHAT_PAGE_SIZE = 15;
const ADMIN_PANEL_SECTION_IDS = new Set([
  "admin",
  "admin-users",
  "admin-workspaces",
  "admin-chats",
  "admin-invites",
  "admin-default-prompt",
]);

function canModifyUser(actor, target) {
  const actorRole = normalizeRole(actor?.role);
  const targetRole = normalizeRole(target?.previousRole || target?.role);
  if (isPrimaryOwner(target)) return false;
  if (isPrimaryOwner(actor)) return true;
  if (actorRole === ACCOUNT_ROLES.owner && targetRole !== ACCOUNT_ROLES.owner)
    return true;
  return (
    actorRole === ACCOUNT_ROLES.admin && targetRole !== ACCOUNT_ROLES.owner
  );
}

function roleDisplay(user) {
  if (Number(user?.suspended) === 1) {
    return banActorRole(user) === ACCOUNT_ROLES.owner
      ? "已禁用（Owner）"
      : "已禁用";
  }
  if (normalizeRole(user?.role) === ACCOUNT_ROLES.owner)
    return accountRoleLabel(user);
  const labels = {
    disabled: "已禁用",
    user: "成员",
    developer: "开发者",
    admin: "管理员",
  };
  return labels[normalizeRole(user?.role)] || titleCase(user?.role || "user");
}

function inviteStatusLabel(status) {
  return (
    {
      pending: "待领取",
      claimed: "已使用",
      consumed: "已使用",
      revoked: "已撤销",
      expired: "已过期",
    }[status] || titleCase(status || "pending")
  );
}

function inviteRoleLabel(role) {
  return (
    {
      default: "普通用户",
      user: "普通用户",
      developer: "开发者",
      manager: "管理员助理",
      admin: "管理员",
      owner: "Owner",
    }[role] || titleCase(role || "user")
  );
}

function formatDate(value) {
  if (!value) return "--";
  return new Date(value).toLocaleString();
}

function displayText(value, fallback = "--") {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) {
    const text = value.map((item) => displayText(item, "")).filter(Boolean);
    return text.length ? text.join(", ") : fallback;
  }
  if (typeof value === "object") {
    return (
      value.displayName ||
      value.username ||
      value.email ||
      value.name ||
      value.title ||
      value.slug ||
      fallback
    );
  }
  return fallback;
}

function AdminCard({ id, icon, title, description, action, children }) {
  return (
    <section id={id} className="account-card">
      <div className="mb-4 flex flex-col gap-3 px-1 pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 text-slate-500">
            {icon}
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-950">{title}</h2>
            <p className="mt-1 text-sm leading-5 text-slate-500">
              {description}
            </p>
          </div>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function EmptyState({ children }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm font-medium text-slate-400">
      {children}
    </div>
  );
}

function AppleTable({ columns, children, minWidth = "min-w-[720px]" }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-100">
      <table
        className={`w-full border-spacing-0 text-left text-sm ${minWidth}`}
      >
        <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-normal text-slate-400">
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col" className="px-4 py-3">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">{children}</tbody>
      </table>
    </div>
  );
}

export default function AdminPanel({ currentUser, activeSection = null }) {
  const [users, setUsers] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [invites, setInvites] = useState([]);
  const [chats, setChats] = useState([]);
  const [chatOffset, setChatOffset] = useState(0);
  const [canNextChatPage, setCanNextChatPage] = useState(false);
  const [totalChats, setTotalChats] = useState(0);
  const [hasExactChatTotal, setHasExactChatTotal] = useState(false);
  const [allowPublicRegistration, setAllowPublicRegistration] = useState(false);
  const [defaultPrompt, setDefaultPrompt] = useState({
    value: "",
    saved: "",
    saneDefault: "",
    loading: true,
    saving: false,
  });
  const [loading, setLoading] = useState(true);
  const [savingRegistration, setSavingRegistration] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const inviteModal = useModal();

  const refreshUsers = async () => setUsers(await Admin.users());
  const refreshWorkspaces = async () => setWorkspaces(await Admin.workspaces());
  const refreshInvites = async () => setInvites(await Admin.invites());
  const refreshChats = async (offset = chatOffset) => {
    const result = await System.chats(offset, CHAT_PAGE_SIZE);
    const nextChats = result?.chats || [];
    const exactTotal =
      result?.totalChats !== undefined &&
      Number.isFinite(Number(result.totalChats));
    setChats(nextChats);
    setCanNextChatPage(Boolean(result?.hasPages));
    setHasExactChatTotal(exactTotal);
    setTotalChats(
      exactTotal
        ? Number(result.totalChats)
        : offset * CHAT_PAGE_SIZE + nextChats.length
    );
  };
  const refreshRegistrationSetting = async () => {
    const settings = await Admin.systemPreferences([
      "allow_public_registration",
    ]);
    const enabled = String(settings.allow_public_registration) === "true";
    setAllowPublicRegistration(enabled);
    return enabled;
  };
  const refreshDefaultPrompt = async () => {
    setDefaultPrompt((prev) => ({ ...prev, loading: true }));
    const { defaultSystemPrompt, saneDefaultSystemPrompt } =
      await System.fetchDefaultSystemPrompt();
    const value = defaultSystemPrompt || saneDefaultSystemPrompt || "";
    setDefaultPrompt({
      value,
      saved: value,
      saneDefault: saneDefaultSystemPrompt || "",
      loading: false,
      saving: false,
    });
  };

  useEffect(() => {
    async function loadAdminData() {
      setLoading(true);
      await Promise.all([
        refreshUsers(),
        refreshWorkspaces(),
        refreshInvites(),
        refreshChats(0),
        refreshRegistrationSetting(),
        refreshDefaultPrompt(),
      ]);
      setLoading(false);
    }
    loadAdminData();
  }, []);

  useEffect(() => {
    refreshChats(chatOffset);
  }, [chatOffset]);

  const workspaceCount = workspaces.length;
  const userCount = users.length;
  const normalizedActiveSection = ADMIN_PANEL_SECTION_IDS.has(activeSection)
    ? activeSection
    : null;
  const shouldRenderSection = (sectionId) =>
    !normalizedActiveSection || normalizedActiveSection === sectionId;
  const pendingInvites = useMemo(
    () => invites.filter((invite) => invite.status === "pending").length,
    [invites]
  );

  if (loading) {
    return (
      <section id={normalizedActiveSection || "admin"} className="account-card">
        <div className="h-32 animate-pulse rounded-2xl bg-slate-100" />
      </section>
    );
  }

  return (
    <>
      {shouldRenderSection("admin") && (
        <section id="admin" className="account-card">
          <div className="mb-2 px-1 pb-3">
            <h2 className="text-lg font-semibold text-slate-950">概览</h2>
            <p className="mt-1 text-sm leading-5 text-slate-500">
              查看当前实例的关键账户与工作区指标。
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs font-semibold text-slate-400">用户</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {userCount}
              </p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs font-semibold text-slate-400">工作区</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {workspaceCount}
              </p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs font-semibold text-slate-400">待领取邀请</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {pendingInvites}
              </p>
            </div>
          </div>
        </section>
      )}

      {shouldRenderSection("admin-users") && (
        <AdminUsersCard
          currentUser={currentUser}
          users={users}
          refreshUsers={refreshUsers}
        />
      )}
      {shouldRenderSection("admin-workspaces") && (
        <AdminWorkspacesCard
          workspaces={workspaces}
          workspaceName={workspaceName}
          setWorkspaceName={setWorkspaceName}
          creatingWorkspace={creatingWorkspace}
          setCreatingWorkspace={setCreatingWorkspace}
          refreshWorkspaces={refreshWorkspaces}
        />
      )}
      {shouldRenderSection("admin-chats") && (
        <AdminChatsCard
          chats={chats}
          setChats={setChats}
          chatOffset={chatOffset}
          setChatOffset={setChatOffset}
          canNextChatPage={canNextChatPage}
          totalChats={totalChats}
          setTotalChats={setTotalChats}
          hasExactChatTotal={hasExactChatTotal}
          refreshChats={refreshChats}
        />
      )}
      {shouldRenderSection("admin-invites") && (
        <AdminInvitesCard
          invites={invites}
          allowPublicRegistration={allowPublicRegistration}
          savingRegistration={savingRegistration}
          setSavingRegistration={setSavingRegistration}
          refreshInvites={refreshInvites}
          refreshRegistrationSetting={refreshRegistrationSetting}
          openInviteModal={inviteModal.openModal}
        />
      )}
      {shouldRenderSection("admin-default-prompt") && (
        <AdminDefaultPromptCard
          defaultPrompt={defaultPrompt}
          setDefaultPrompt={setDefaultPrompt}
        />
      )}

      <ModalWrapper isOpen={inviteModal.isOpen}>
        <NewInviteModal
          closeModal={inviteModal.closeModal}
          onSuccess={refreshInvites}
        />
      </ModalWrapper>
    </>
  );
}

function AdminUsersCard({ currentUser, users, refreshUsers }) {
  return (
    <AdminCard
      id="admin-users"
      icon={<UserCircleGear className="h-5 w-5" />}
      title="用户"
      description="查看当前实例内的账号，并按权限封禁、恢复或删除。"
    >
      {users.length === 0 ? (
        <EmptyState>未找到用户</EmptyState>
      ) : (
        <AppleTable columns={["用户名", "角色", "创建时间", ""]}>
          {users.map((user) => (
            <AdminUserRow
              key={user.id}
              currentUser={currentUser}
              user={user}
              refreshUsers={refreshUsers}
            />
          ))}
        </AppleTable>
      )}
    </AdminCard>
  );
}

function AdminUserRow({ currentUser, user, refreshUsers }) {
  const [suspended, setSuspended] = useState(user.suspended === 1);
  const canModify = canModifyUser(currentUser, user);
  const canRestore = canRestoreBannedUser(currentUser, user);
  const promotion = nextAccountPromotion(currentUser, user);

  const handleSuspend = async () => {
    const actionText = suspended ? "恢复" : "封禁";
    if (
      !(await showAppConfirm({
        tone: suspended ? "default" : "danger",
        title: `${actionText}用户？`,
        description: suspended
          ? `恢复 ${user.username} 后，该账号可以重新登录。`
          : `${user.username} 将被登出，并在恢复前无法再次登录。`,
        confirmText: actionText,
      }))
    )
      return;

    const result = suspended
      ? await Admin.unbanUser(user.id)
      : await Admin.banUser(user.id, "admin_action");
    if (!result?.success) {
      showToast(result?.error || `${actionText}失败。`, "error", {
        clear: true,
      });
      return;
    }
    setSuspended(!suspended);
    await refreshUsers();
    showToast(`${actionText}成功。`, "success", { clear: true });
  };

  const handleDelete = async () => {
    const previewResult = await Admin.userDeletePreview(user.id);
    if (!previewResult?.success) {
      showToast(previewResult?.error || "无法生成删除预览。", "error", {
        clear: true,
      });
      return;
    }
    const preview = previewResult.preview;
    if (
      !(await showAppConfirm({
        tone: "danger",
        title: "删除用户？",
        description: [
          `将删除 ${user.username} 在当前环境中的账号数据。`,
          `影响 ${preview?.totals?.workspaceCount || 0} 个工作区、${preview?.totals?.threadCount || 0} 个线程、${preview?.totals?.chatCount || 0} 条聊天。`,
          preview?.willDeleteSharedAuthUser
            ? "该账号没有其它环境数据，将同步删除共享认证账号。"
            : "该账号仍有其它环境数据，本次仅删除当前环境数据。",
        ].join("\n"),
        confirmText: "继续安全验证",
      }))
    )
      return;

    const currentPassword = window.prompt("请输入当前密码以确认删除该账号。");
    if (!currentPassword) return;
    const reauth = await System.reauthAccountDeleteWithPassword({
      currentPassword,
    });
    if (!reauth?.success || !reauth?.reauthToken) {
      showToast(reauth?.error || "安全验证失败。", "error", { clear: true });
      return;
    }

    showToast("安全验证已通过，删除按钮冷却 5 秒。", "info", {
      clear: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    if (
      !(await showAppConfirm({
        tone: "danger",
        title: "最终确认删除？",
        description: "冷却时间已结束。确认后将立即执行删除，无法撤销。",
        confirmText: "删除用户",
      }))
    )
      return;

    const result = await Admin.deleteUserWithReauth(user.id, {
      confirm: true,
      reauthToken: reauth.reauthToken,
    });
    if (!result?.success) {
      showToast(result?.error || "删除失败。", "error", { clear: true });
      return;
    }
    await refreshUsers();
    showToast("用户已删除。", "success", { clear: true });
  };

  const handlePromote = async () => {
    if (!promotion) return;
    if (
      !(await showAppConfirm({
        title: promotion.confirmTitle,
        description: promotion.confirmDescription,
        confirmText: promotion.label,
      }))
    )
      return;

    const result = await Admin.updateUser(user.id, {
      role: promotion.role,
      ...(promotion.ownerType ? { ownerType: promotion.ownerType } : {}),
    });
    if (!result?.success) {
      showToast(result?.error || "提权失败。", "error", { clear: true });
      return;
    }
    await refreshUsers();
    showToast(promotion.successMessage, "success", { clear: true });
  };

  return (
    <tr className="text-slate-700">
      <th scope="row" className="px-4 py-3 font-semibold text-slate-950">
        {user.username}
      </th>
      <td className="px-4 py-3">{roleDisplay(user)}</td>
      <td className="px-4 py-3 text-slate-500">{user.createdAt}</td>
      <td className="px-4 py-3">
        <div className="flex justify-end gap-2">
          {currentUser?.id !== user.id && canModify && !suspended && (
            <>
              {promotion && (
                <AppButton
                  size="sm"
                  variant="secondary"
                  onClick={handlePromote}
                >
                  {promotion.label}
                </AppButton>
              )}
              <AppButton size="sm" variant="secondary" onClick={handleSuspend}>
                {suspended ? "恢复" : "封禁"}
              </AppButton>
              <AppButton
                size="sm"
                variant="secondary"
                className="account-button-danger"
                onClick={handleDelete}
              >
                删除
              </AppButton>
            </>
          )}
          {currentUser?.id !== user.id && suspended && canRestore && (
            <AppButton size="sm" variant="secondary" onClick={handleSuspend}>
              恢复
            </AppButton>
          )}
        </div>
      </td>
    </tr>
  );
}

function AdminWorkspacesCard({
  workspaces,
  workspaceName,
  setWorkspaceName,
  creatingWorkspace,
  setCreatingWorkspace,
  refreshWorkspaces,
}) {
  const createWorkspace = async (event) => {
    event.preventDefault();
    const name = workspaceName.trim();
    if (name.length < 4) {
      showToast("工作区名称至少需要 4 个字符。", "error", { clear: true });
      return;
    }
    setCreatingWorkspace(true);
    const result = await Admin.newWorkspace(name);
    setCreatingWorkspace(false);
    if (!result?.workspace) {
      showToast(result?.error || "创建工作区失败。", "error", { clear: true });
      return;
    }
    setWorkspaceName("");
    await refreshWorkspaces();
    showToast("工作区已创建。", "success", { clear: true });
  };

  const deleteWorkspace = async (workspace) => {
    if (
      !(await showAppConfirm({
        tone: "danger",
        title: "删除工作区？",
        description: `将删除 ${workspace.name}，此操作无法撤销。`,
        confirmText: "删除工作区",
      }))
    )
      return;
    const result = await Admin.deleteWorkspace(workspace.id);
    if (!result?.success) {
      showToast(result?.error || "删除工作区失败。", "error", { clear: true });
      return;
    }
    await refreshWorkspaces();
    showToast("工作区已删除。", "success", { clear: true });
  };

  return (
    <AdminCard
      id="admin-workspaces"
      icon={<BookOpen className="h-5 w-5" />}
      title="工作区"
      description="查看和管理当前实例内的全局工作区。"
      action={
        <form
          onSubmit={createWorkspace}
          className="flex w-full gap-2 sm:w-auto"
        >
          <input
            value={workspaceName}
            onChange={(event) => setWorkspaceName(event.target.value)}
            placeholder="新工作区名称"
            className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-400 sm:w-48"
          />
          <AppButton type="submit" size="sm" loading={creatingWorkspace}>
            创建
          </AppButton>
        </form>
      }
    >
      {workspaces.length === 0 ? (
        <EmptyState>未找到工作区</EmptyState>
      ) : (
        <AppleTable columns={["名称", "Slug", "成员", "创建时间", ""]}>
          {workspaces.map((workspace) => (
            <tr key={workspace.id} className="text-slate-700">
              <th
                scope="row"
                className="px-4 py-3 font-semibold text-slate-950"
              >
                {workspace.name}
              </th>
              <td className="px-4 py-3">
                <a
                  href={paths.workspace.chat(workspace.slug)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-blue-600 hover:underline"
                >
                  {workspace.slug}
                </a>
              </td>
              <td className="px-4 py-3 text-slate-500">
                {workspace.userIds?.length || 0}
              </td>
              <td className="px-4 py-3 text-slate-500">
                {workspace.createdAt}
              </td>
              <td className="px-4 py-3">
                <div className="flex justify-end">
                  <AppButton
                    variant="secondary"
                    size="sm"
                    iconOnly
                    className="account-button-danger"
                    leftIcon={<Trash className="h-4 w-4" />}
                    aria-label="删除工作区"
                    onClick={() => deleteWorkspace(workspace)}
                  />
                </div>
              </td>
            </tr>
          ))}
        </AppleTable>
      )}
    </AdminCard>
  );
}

function AdminChatsCard({
  chats,
  setChats,
  chatOffset,
  setChatOffset,
  canNextChatPage,
  totalChats,
  setTotalChats,
  hasExactChatTotal,
  refreshChats,
}) {
  const [jumpPage, setJumpPage] = useState("");
  const currentPage = chatOffset + 1;
  const totalPages = hasExactChatTotal
    ? Math.max(Math.ceil(totalChats / CHAT_PAGE_SIZE), chats.length ? 1 : 0)
    : currentPage + (canNextChatPage ? 1 : 0);
  const pageItems = hasExactChatTotal
    ? paginationItems(currentPage, totalPages)
    : [];

  const goToPage = (page) => {
    const nextPage = Number(page);
    if (!Number.isInteger(nextPage) || nextPage < 1) return;
    if (hasExactChatTotal && nextPage > totalPages) return;
    setChatOffset(nextPage - 1);
  };

  const handleJump = (event) => {
    event.preventDefault();
    goToPage(Number(jumpPage));
    setJumpPage("");
  };

  const deleteChat = async (chatId) => {
    if (
      !(await showAppConfirm({
        tone: "danger",
        title: "删除这条对话？",
        description: "此操作无法撤销。",
        confirmText: "删除",
      }))
    )
      return;
    await System.deleteChat(chatId);
    const nextTotalChats = Math.max(Number(totalChats || 0) - 1, 0);
    setTotalChats(nextTotalChats);
    if (chats.length === 1 && chatOffset > 0) {
      setChatOffset(chatOffset - 1);
      return;
    }
    await refreshChats(chatOffset);
  };

  const clearAllChats = async () => {
    if (
      !(await showAppConfirm({
        tone: "danger",
        title: "清空所有聊天？",
        description: "此操作无法撤销。",
        confirmText: "清空",
      }))
    )
      return;
    await System.deleteChat(-1);
    setChats([]);
    setTotalChats(0);
    setChatOffset(0);
    showToast("聊天记录已清空。", "success", { clear: true });
  };

  const exportChats = async (type) => {
    const data = await System.exportChats(type, "workspace");
    if (!data) {
      showToast("导出聊天记录失败。", "error", { clear: true });
      return;
    }
    const blob = new Blob([data], {
      type: type === "csv" ? "text/csv" : "application/json",
    });
    saveAs(blob, `athena-chats-${new Date().toLocaleDateString()}.${type}`);
  };

  return (
    <AdminCard
      id="admin-chats"
      icon={<ChatsCircle className="h-5 w-5" />}
      title="对话历史记录"
      description="查看、导出或删除当前实例内的工作区聊天记录。"
      action={
        <div className="flex flex-wrap gap-2">
          <AppButton
            size="sm"
            variant="secondary"
            onClick={() => exportChats("csv")}
          >
            导出 CSV
          </AppButton>
          <AppButton
            size="sm"
            variant="secondary"
            onClick={() => exportChats("json")}
          >
            导出 JSON
          </AppButton>
          {chats.length > 0 && (
            <AppButton
              size="sm"
              variant="secondary"
              className="account-button-danger"
              onClick={clearAllChats}
            >
              清空
            </AppButton>
          )}
        </div>
      }
    >
      {chats.length === 0 ? (
        <EmptyState>未找到对话历史</EmptyState>
      ) : (
        <>
          <AppleTable
            minWidth="min-w-[860px]"
            columns={["ID", "用户", "工作区", "Prompt", "Response", "时间", ""]}
          >
            {chats.map((chat) => (
              <tr key={chat.id} className="text-slate-700">
                <td className="px-4 py-3 font-medium text-slate-950">
                  {chat.id}
                </td>
                <td className="px-4 py-3">{displayText(chat.username)}</td>
                <td className="px-4 py-3">{displayText(chat.workspace)}</td>
                <td className="max-w-[220px] truncate px-4 py-3">
                  {displayText(chat.prompt)}
                </td>
                <td className="max-w-[220px] truncate px-4 py-3">
                  {displayText(chat.response)}
                </td>
                <td className="px-4 py-3 text-slate-500">
                  {formatDate(chat.createdAt)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex justify-end">
                    <AppButton
                      variant="secondary"
                      size="sm"
                      iconOnly
                      className="account-button-danger"
                      leftIcon={<Trash className="h-4 w-4" />}
                      aria-label="删除对话"
                      onClick={() => deleteChat(chat.id)}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </AppleTable>
          <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <p className="text-sm font-medium text-slate-500">
              共 {Number(totalChats || 0)} 条
            </p>

            <div className="flex flex-wrap items-center justify-center gap-2">
              <AppButton
                size="sm"
                variant="secondary"
                iconOnly
                leftIcon={<CaretLeft className="h-4 w-4" />}
                aria-label="上一页"
                disabled={chatOffset === 0}
                onClick={() => setChatOffset(Math.max(chatOffset - 1, 0))}
              />

              {hasExactChatTotal ? (
                pageItems.map((item, index) =>
                  item === "ellipsis" ? (
                    <span
                      key={`ellipsis-${index}`}
                      className="px-1 text-sm font-semibold text-slate-400"
                    >
                      ...
                    </span>
                  ) : (
                    <button
                      key={item}
                      type="button"
                      onClick={() => goToPage(item)}
                      className={[
                        "h-9 min-w-[36px] rounded-full px-3 text-sm font-semibold transition",
                        item === currentPage
                          ? "border border-sky-200 bg-white text-sky-600 shadow-sm ring-2 ring-sky-100"
                          : "border border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50",
                      ].join(" ")}
                    >
                      {item}
                    </button>
                  )
                )
              ) : (
                <span className="rounded-full border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600">
                  {currentPage}
                </span>
              )}

              <AppButton
                size="sm"
                variant="secondary"
                iconOnly
                leftIcon={<CaretRight className="h-4 w-4" />}
                aria-label="下一页"
                disabled={
                  hasExactChatTotal
                    ? currentPage >= totalPages
                    : !canNextChatPage
                }
                onClick={() => setChatOffset(chatOffset + 1)}
              />
            </div>

            <form
              className="flex items-center gap-2 lg:justify-end"
              onSubmit={handleJump}
            >
              <span className="text-sm font-medium text-slate-500">跳转</span>
              <input
                value={jumpPage}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  if (/^\d*$/.test(nextValue)) setJumpPage(nextValue);
                }}
                inputMode="numeric"
                pattern="[0-9]*"
                aria-label="跳转页码"
                className="h-9 w-16 rounded-full border border-slate-200 bg-white px-3 text-center text-sm font-semibold text-slate-700 outline-none transition placeholder:text-slate-300 focus:border-sky-400"
                placeholder="页"
              />
              <AppButton
                type="submit"
                size="sm"
                variant="secondary"
                disabled={!hasExactChatTotal || !jumpPage}
              >
                跳转
              </AppButton>
            </form>
          </div>
        </>
      )}
    </AdminCard>
  );
}

function paginationItems(currentPage, totalPages) {
  if (totalPages <= 0) return [];
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const pages = new Set([1, totalPages, currentPage]);
  if (currentPage <= 4) {
    [2, 3, 4, 5].forEach((page) => pages.add(page));
  } else if (currentPage >= totalPages - 3) {
    [totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1].forEach(
      (page) => pages.add(page)
    );
  } else {
    [currentPage - 1, currentPage + 1].forEach((page) => pages.add(page));
  }

  const sortedPages = Array.from(pages)
    .filter((page) => page >= 1 && page <= totalPages)
    .sort((a, b) => a - b);

  return sortedPages.reduce((items, page, index) => {
    if (index > 0 && page - sortedPages[index - 1] > 1) {
      items.push("ellipsis");
    }
    items.push(page);
    return items;
  }, []);
}

function AdminInvitesCard({
  invites,
  allowPublicRegistration,
  savingRegistration,
  setSavingRegistration,
  refreshInvites,
  refreshRegistrationSetting,
  openInviteModal,
}) {
  const togglePublicRegistration = async () => {
    if (savingRegistration) return;
    setSavingRegistration(true);
    const result = await Admin.updateSystemPreferences({
      allow_public_registration: String(!allowPublicRegistration),
    });
    if (!result?.success) {
      setSavingRegistration(false);
      showToast(result?.error || "更新公开注册开关失败。", "error", {
        clear: true,
      });
      return;
    }
    const savedValue = await refreshRegistrationSetting();
    setSavingRegistration(false);
    showToast(savedValue ? "公开注册已开启。" : "公开注册已关闭。", "success", {
      clear: true,
    });
  };

  const revokeInvite = async (invite) => {
    if (
      !(await showAppConfirm({
        tone: "danger",
        title: "撤销邀请？",
        description: "撤销后该邀请链接将无法继续使用。",
        confirmText: "撤销邀请",
      }))
    )
      return;
    const result = await Admin.disableInvite(invite.id);
    if (!result?.success) {
      showToast(result?.error || "撤销邀请失败。", "error", { clear: true });
      return;
    }
    await refreshInvites();
    showToast("邀请已撤销。", "success", { clear: true });
  };

  return (
    <AdminCard
      id="admin-invites"
      icon={<EnvelopeSimple className="h-5 w-5" />}
      title="邀请"
      description="控制公开注册，并创建或撤销一次性邀请链接。"
      action={
        <AppButton
          size="sm"
          leftIcon={<EnvelopeSimple className="h-4 w-4" />}
          onClick={openInviteModal}
        >
          创建邀请链接
        </AppButton>
      }
    >
      <div className="mb-4 flex flex-col gap-3 rounded-2xl bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-950">允许公开注册</p>
          <p className="mt-1 text-sm text-slate-500">
            开启后登录页显示“创建账号”。公开注册仅允许创建普通用户。
          </p>
        </div>
        <AppButton
          size="sm"
          variant="secondary"
          loading={savingRegistration}
          onClick={togglePublicRegistration}
        >
          {allowPublicRegistration ? "关闭" : "开启"}
        </AppButton>
      </div>
      {invites.length === 0 ? (
        <EmptyState>未找到邀请</EmptyState>
      ) : (
        <AppleTable
          columns={["状态", "角色", "接受人", "创建人", "到期", "创建时间", ""]}
        >
          {invites.map((invite) => (
            <tr key={invite.id} className="text-slate-700">
              <td className="px-4 py-3 font-medium text-slate-950">
                {inviteStatusLabel(invite.status)}
              </td>
              <td className="px-4 py-3">{inviteRoleLabel(invite.role)}</td>
              <td className="px-4 py-3">
                {invite.claimedBy?.username || "--"}
              </td>
              <td className="px-4 py-3">
                {invite.createdBy?.username || "--"}
              </td>
              <td className="px-4 py-3 text-slate-500">
                {formatDate(invite.expiresAt)}
              </td>
              <td className="px-4 py-3 text-slate-500">
                {formatDate(invite.createdAt)}
              </td>
              <td className="px-4 py-3">
                <div className="flex justify-end">
                  {invite.status === "pending" && (
                    <AppButton
                      variant="secondary"
                      size="sm"
                      iconOnly
                      className="account-button-danger"
                      leftIcon={<Trash className="h-4 w-4" />}
                      aria-label="撤销邀请"
                      onClick={() => revokeInvite(invite)}
                    />
                  )}
                </div>
              </td>
            </tr>
          ))}
        </AppleTable>
      )}
    </AdminCard>
  );
}

function AdminDefaultPromptCard({ defaultPrompt, setDefaultPrompt }) {
  const isDirty = defaultPrompt.value !== defaultPrompt.saved;

  const savePrompt = async () => {
    setDefaultPrompt((prev) => ({ ...prev, saving: true }));
    const result = await System.updateDefaultSystemPrompt(
      defaultPrompt.value.trim(),
      null
    );
    if (!result?.success) {
      showToast(result?.message || "更新默认系统提示词失败。", "error", {
        clear: true,
      });
      setDefaultPrompt((prev) => ({ ...prev, saving: false }));
      return;
    }
    const saved =
      result.defaultSystemPrompt ||
      defaultPrompt.value.trim() ||
      defaultPrompt.saneDefault;
    setDefaultPrompt((prev) => ({
      ...prev,
      value: saved,
      saved,
      saving: false,
    }));
    showToast("默认系统提示词已更新。", "success", { clear: true });
  };

  return (
    <AdminCard
      id="admin-default-prompt"
      icon={<TextT className="h-5 w-5" />}
      title="默认系统提示词"
      description="设置新工作区默认使用的系统提示词。"
      action={
        <AppButton
          size="sm"
          disabled={!isDirty || defaultPrompt.loading}
          loading={defaultPrompt.saving}
          onClick={savePrompt}
        >
          保存
        </AppButton>
      }
    >
      {defaultPrompt.loading ? (
        <div className="h-36 animate-pulse rounded-2xl bg-slate-100" />
      ) : (
        <textarea
          value={defaultPrompt.value}
          onChange={(event) =>
            setDefaultPrompt((prev) => ({
              ...prev,
              value: event.target.value,
            }))
          }
          className="min-h-[180px] w-full resize-y rounded-2xl border border-slate-200 bg-white p-4 text-sm leading-6 text-slate-900 outline-none focus:border-blue-400"
        />
      )}
    </AdminCard>
  );
}
