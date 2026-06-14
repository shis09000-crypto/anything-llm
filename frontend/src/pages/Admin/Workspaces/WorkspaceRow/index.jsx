import { useRef } from "react";
import Admin from "@/models/admin";
import paths from "@/utils/paths";
import { LinkSimple, Trash } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import { showAppConfirm } from "@/components/lib/AppConfirmDialog/confirm";
import { useTranslation } from "react-i18next";
import AppButton from "@/components/lib/AppButton";

export default function WorkspaceRow({ workspace, users: _users }) {
  const rowRef = useRef(null);
  const { t } = useTranslation();
  const handleDelete = async () => {
    if (
      !(await showAppConfirm({
        tone: "danger",
        title: t("admin.workspaces.confirm.delete.title"),
        description: t("admin.workspaces.confirm.delete.description", {
          workspaceName: workspace.name,
        }),
        confirmText: t("admin.workspaces.confirm.delete.confirm"),
      }))
    )
      return false;
    rowRef?.current?.remove();
    await Admin.deleteWorkspace(workspace.id);
  };

  return (
    <>
      <tr
        ref={rowRef}
        className="bg-transparent text-white text-opacity-80 text-xs font-medium border-b border-white/10 h-10"
      >
        <th scope="row" className="px-6 whitespace-nowrap">
          {workspace.name}
        </th>
        <td className="px-6 flex items-center">
          <a
            href={paths.workspace.chat(workspace.slug)}
            target="_blank"
            rel="noreferrer"
            className="text-white flex items-center hover:underline"
          >
            <LinkSimple className="mr-2 w-4 h-4" /> {workspace.slug}
          </a>
        </td>
        <td className="px-6">
          <Link
            to={paths.workspace.settings.generalAppearance(workspace.slug)}
            className="text-white flex items-center underline"
          >
            {workspace.userIds?.length}
          </Link>
        </td>
        <td className="px-6">{workspace.createdAt}</td>
        <td className="px-6 flex items-center gap-x-2 h-full mt-1">
          <AppButton
            variant="secondary"
            size="sm"
            onClick={handleDelete}
            iconOnly
            leftIcon={<Trash className="h-5 w-5" />}
            aria-label={t("admin.workspaces.confirm.delete.confirm")}
          />
        </td>
      </tr>
    </>
  );
}
