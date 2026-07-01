import { useEffect, useState } from "react";
import Admin from "@/models/admin";
import { Trash } from "@phosphor-icons/react";
import { userFromStorage } from "@/utils/request";
import System from "@/models/system";
import { useTranslation } from "react-i18next";
import { showAppConfirm } from "@/components/lib/AppConfirmDialog/confirm";

export default function ApiKeyRow({ apiKey, removeApiKey }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const handleDelete = async () => {
    if (
      !(await showAppConfirm({
        tone: "danger",
        title: "删除 API Key？",
        description: t("api.row.deleteConfirm"),
        confirmText: "删除",
      }))
    )
      return false;

    const user = userFromStorage();
    const Model = !!user ? Admin : System;
    await Model.deleteApiKey(apiKey.id);
    removeApiKey(apiKey.id);
  };

  const copyApiKey = () => {
    if (!apiKey || apiKey.secretMasked) return false;
    window.navigator.clipboard.writeText(apiKey.secret);
    setCopied(true);
  };

  useEffect(() => {
    function resetStatus() {
      if (!copied) return false;
      setTimeout(() => {
        setCopied(false);
      }, 3000);
    }
    resetStatus();
  }, [copied]);

  return (
    <>
      <tr className="bg-transparent text-xs font-semibold text-[var(--soft-text-secondary)]">
        <td scope="row" className="px-6 py-3 whitespace-nowrap align-middle">
          {apiKey.name || t("api.row.unnamed")}
        </td>
        <td scope="row" className="px-6 py-3 align-middle">
          <code className="font-mono text-[11px] break-all text-theme-text-primary">
            {apiKey.secret}
          </code>
        </td>
        <td className="px-6 py-3 text-left align-middle">
          {apiKey.createdBy?.username || "--"}
        </td>
        <td className="px-6 py-3 whitespace-nowrap align-middle">
          {new Date(apiKey.createdAt).toLocaleString()}
        </td>
        <td className="px-6 py-3 align-middle">
          <div className="flex items-center gap-x-6">
            <button
              onClick={copyApiKey}
              disabled={copied || apiKey.secretMasked}
              className="text-xs font-bold text-[#2152ff] rounded-lg hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            >
              {apiKey.secretMasked
                ? "Masked"
                : copied
                  ? t("api.row.copied")
                  : t("api.row.copy")}
            </button>
            <button
              onClick={handleDelete}
              className="text-xs font-medium text-[var(--soft-text-secondary)] hover:text-red-500 rounded-lg px-2 py-1 hover:bg-red-50"
            >
              <Trash className="h-5 w-5" />
            </button>
          </div>
        </td>
      </tr>
    </>
  );
}
