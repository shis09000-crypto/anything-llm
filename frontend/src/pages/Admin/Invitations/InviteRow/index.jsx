import { useRef, useState } from "react";
import { titleCase } from "text-case";
import Admin from "@/models/admin";
import { Trash } from "@phosphor-icons/react";
import { showAppConfirm } from "@/components/lib/AppConfirmDialog/confirm";
import { useTranslation } from "react-i18next";
import AppButton from "@/components/lib/AppButton";

export default function InviteRow({ invite }) {
  const rowRef = useRef(null);
  const { t } = useTranslation();
  const [status, setStatus] = useState(invite.status);
  const handleDelete = async () => {
    if (
      !(await showAppConfirm({
        tone: "danger",
        title: t("admin.invites.confirm.disable.title"),
        description: t("admin.invites.confirm.disable.description"),
        confirmText: t("admin.invites.confirm.disable.confirm"),
      }))
    )
      return false;
    setStatus("revoked");
    await Admin.disableInvite(invite.id);
  };

  const statusLabel = t(`admin.invites.status.${status}`, {
    defaultValue: titleCase(status),
  });
  const roleLabel = t(`admin.invites.role.${invite.role}`, {
    defaultValue: titleCase(invite.role),
  });
  const deletedUserText = t("admin.invites.deletedUser");

  return (
    <>
      <tr
        ref={rowRef}
        className="bg-transparent text-white text-opacity-80 text-xs font-medium border-b border-white/10 h-10"
      >
        <td scope="row" className="px-6 whitespace-nowrap">
          {statusLabel}
        </td>
        <td className="px-6">{roleLabel}</td>
        <td className="px-6">
          {invite.claimedBy ? invite.claimedBy?.username || deletedUserText : "--"}
        </td>
        <td className="px-6">{invite.createdBy?.username || deletedUserText}</td>
        <td className="px-6">{formatDate(invite.expiresAt)}</td>
        <td className="px-6">{formatDate(invite.createdAt)}</td>
        <td className="px-6 flex items-center gap-x-6 h-full mt-1">
          {status === "pending" && (
            <AppButton
              variant="secondary"
              size="sm"
              iconOnly
              leftIcon={<Trash className="h-5 w-5" />}
              onClick={handleDelete}
              aria-label={t("admin.invites.confirm.disable.confirm")}
            />
          )}
        </td>
      </tr>
    </>
  );
}

function formatDate(value) {
  if (!value) return "--";
  return new Date(value).toLocaleString();
}
