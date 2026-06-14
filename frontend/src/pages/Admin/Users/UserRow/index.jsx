import { useRef, useState } from "react";
import { titleCase } from "text-case";
import Admin from "@/models/admin";
import System from "@/models/system";
import EditUserModal from "./EditUserModal";
import showToast from "@/utils/toast";
import { useModal } from "@/hooks/useModal";
import ModalWrapper from "@/components/ModalWrapper";
import { showAppConfirm } from "@/components/lib/AppConfirmDialog/confirm";
import AppButton from "@/components/lib/AppButton";
import { useTranslation } from "react-i18next";
import {
  ACCOUNT_ROLES,
  accountRoleLabel,
  isPrimaryOwner,
  normalizeRole,
} from "@/utils/authz";

function canModifyUser(actor, target) {
  const actorRole = normalizeRole(actor?.role);
  const targetRole = normalizeRole(target?.role);
  if (isPrimaryOwner(target)) return false;
  if (isPrimaryOwner(actor)) return true;
  if (actorRole === ACCOUNT_ROLES.owner && targetRole !== ACCOUNT_ROLES.owner)
    return true;
  return (
    actorRole === ACCOUNT_ROLES.admin && targetRole !== ACCOUNT_ROLES.owner
  );
}

export default function UserRow({ currUser, user }) {
  const rowRef = useRef(null);
  const { t } = useTranslation();
  const canModify = canModifyUser(currUser, user);
  const [suspended, setSuspended] = useState(user.suspended === 1);
  const { isOpen, openModal, closeModal } = useModal();
  const handleSuspend = async () => {
    const confirm = suspended
      ? {
          title: t("admin.users.confirm.unsuspend.title"),
          description: t("admin.users.confirm.unsuspend.description", {
            username: user.username,
          }),
          confirmText: t("admin.users.confirm.unsuspend.confirm"),
        }
      : {
          title: t("admin.users.confirm.suspend.title"),
          description: t("admin.users.confirm.suspend.description", {
            username: user.username,
          }),
          confirmText: t("admin.users.confirm.suspend.confirm"),
        };

    if (!(await showAppConfirm(confirm))) return false;

    const { success, error } = suspended
      ? await Admin.unbanUser(user.id, { restoreRole: user.role })
      : await Admin.banUser(user.id, "admin_action");
    if (!success) showToast(error, "error", { clear: true });
    if (success) {
      showToast(
        suspended
          ? t("admin.users.toast.unsuspended")
          : t("admin.users.toast.suspended"),
        "success",
        { clear: true }
      );
      setSuspended(!suspended);
    }
  };

  const handleDelete = async () => {
    const previewResult = await Admin.userDeletePreview(user.id);
    if (!previewResult?.success) {
      showToast(previewResult?.error || "无法生成删除预览。", "error", {
        clear: true,
      });
      return false;
    }
    const preview = previewResult.preview;
    if (
      !(await showAppConfirm({
        tone: "danger",
        title: t("admin.users.confirm.delete.title"),
        description: [
          t("admin.users.confirm.delete.description", {
            username: user.username,
          }),
          `将影响 ${preview?.totals?.workspaceCount || 0} 个工作区、${preview?.totals?.threadCount || 0} 个线程、${preview?.totals?.chatCount || 0} 条聊天记录。`,
          preview?.willDeleteSharedAuthUser
            ? "该账号没有其它环境数据，将同步删除共享认证账号。"
            : "该账号仍有其它环境数据，本次仅删除当前环境数据。",
        ].join("\n"),
        confirmText: "继续安全验证",
      }))
    )
      return false;

    const currentPassword = window.prompt("请输入当前密码以确认删除该账号。");
    if (!currentPassword) return false;
    const reauth = await System.reauthAccountDeleteWithPassword({
      currentPassword,
    });
    if (!reauth?.success || !reauth?.reauthToken) {
      showToast(reauth?.error || "安全验证失败。", "error", { clear: true });
      return false;
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
        confirmText: t("admin.users.confirm.delete.confirm"),
      }))
    )
      return false;

    const { success, error } = await Admin.deleteUserWithReauth(user.id, {
      confirm: true,
      reauthToken: reauth.reauthToken,
    });
    if (!success) showToast(error, "error", { clear: true });
    if (success) {
      rowRef?.current?.remove();
      showToast(t("admin.users.toast.deleted"), "success", { clear: true });
    }
  };

  return (
    <>
      <tr
        ref={rowRef}
        className="bg-transparent text-white text-opacity-80 text-xs font-medium border-b border-white/10 h-10"
      >
        <th scope="row" className="px-6 whitespace-nowrap">
          {user.username}
        </th>
        <td className="px-6">
          {normalizeRole(user.role) === ACCOUNT_ROLES.owner
            ? accountRoleLabel(user)
            : t(`admin.users.roles.${normalizeRole(user.role)}`, {
                defaultValue: titleCase(normalizeRole(user.role)),
              })}
        </td>
        <td className="px-6">{user.createdAt}</td>
        <td className="px-6 flex items-center gap-x-2 h-full mt-2">
          {canModify && (
            <AppButton
              size="sm"
              variant="secondary"
              onClick={openModal}
              className="motion-hover"
            >
              {t("admin.users.actions.edit")}
            </AppButton>
          )}
          {currUser?.id !== user.id && canModify && (
            <>
              <AppButton
                size="sm"
                variant="secondary"
                onClick={handleSuspend}
                className="motion-hover"
              >
                {suspended
                  ? t("admin.users.actions.unsuspend")
                  : t("admin.users.actions.suspend")}
              </AppButton>
              <AppButton
                size="sm"
                variant="secondary"
                onClick={handleDelete}
                className="motion-hover"
              >
                {t("admin.users.actions.delete")}
              </AppButton>
            </>
          )}
        </td>
      </tr>
      <ModalWrapper isOpen={isOpen}>
        <EditUserModal
          currentUser={currUser}
          user={user}
          closeModal={closeModal}
        />
      </ModalWrapper>
    </>
  );
}
