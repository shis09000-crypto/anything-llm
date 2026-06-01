import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FolderPlus } from "@phosphor-icons/react";
import Document from "@/models/document";
import AppButton from "@/components/lib/AppButton";
import AppIcon from "@/components/lib/AppIcon";
import { useTranslation } from "react-i18next";

export default function NewFolderModal({ closeModal, files, setFiles }) {
  const [error, setError] = useState(null);
  const [folderName, setFolderName] = useState("");
  const [creating, setCreating] = useState(false);
  const { t } = useTranslation();

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape") closeModal();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeModal]);

  const handleCreate = async (e) => {
    e.preventDefault();
    setError(null);
    if (folderName.trim() !== "") {
      const newFolder = {
        name: folderName,
        type: "folder",
        items: [],
      };
      setCreating(true);
      const { success } = await Document.createFolder(folderName);
      setCreating(false);
      if (success) {
        setFiles({
          ...files,
          items: [...files.items, newFolder],
        });
        closeModal();
      } else {
        setError(t("connectors.directory.create-folder-error"));
      }
    }
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="motion-modal-open fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950/55 px-4 py-6 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-folder-modal-title"
      onMouseDown={closeModal}
    >
      <div
        className="motion-modal-content w-full max-w-[620px] overflow-hidden rounded-[24px] border border-white/10 bg-theme-bg-secondary shadow-[0_28px_90px_rgba(0,0,0,0.45)] light:border-slate-200 light:bg-white light:shadow-[0_28px_90px_rgba(15,23,42,0.20)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/10 bg-white/[0.03] px-6 py-5 light:border-slate-200 light:bg-slate-50">
          <div>
            <h2
              id="new-folder-modal-title"
              className="text-lg font-bold text-theme-text-primary"
            >
              {t("connectors.directory.create-folder-title")}
            </h2>
          </div>
          <button
            onClick={closeModal}
            type="button"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70"
            aria-label={t("connectors.directory.close-create-folder")}
          >
            <AppIcon name="close" size="md" tone="muted" weight="bold" />
          </button>
        </div>
        <form onSubmit={handleCreate}>
          <div className="space-y-5 px-6 py-5">
            <label className="block" htmlFor="folderName">
              <span className="mb-2 block text-sm font-semibold text-theme-text-primary">
                {t("connectors.directory.folder-name")}
              </span>
              <input
                name="folderName"
                id="folderName"
                type="text"
                className="w-full rounded-2xl border border-white/10 bg-theme-settings-input-bg p-4 text-sm leading-6 text-theme-settings-input-text outline-none placeholder:text-theme-settings-input-placeholder focus:border-primary-button focus:outline-none light:border-slate-200 light:bg-slate-50"
                placeholder={t("connectors.directory.folder-name-placeholder")}
                required={true}
                autoComplete="off"
                autoFocus={true}
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
              />
            </label>
            {error && (
              <p className="rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-300 light:text-red-600">
                {error}
              </p>
            )}
          </div>
          <div className="flex flex-wrap justify-between gap-3 border-t border-white/10 bg-white/[0.02] px-6 py-4 light:border-slate-200 light:bg-slate-50">
            <AppButton
              onClick={closeModal}
              type="button"
              variant="secondary"
              size="md"
            >
              {t("connectors.directory.cancel-create-folder")}
            </AppButton>
            <AppButton
              type="submit"
              size="md"
              loading={creating}
              leftIcon={<FolderPlus size={16} weight="fill" />}
            >
              {creating
                ? t("connectors.directory.creating-folder")
                : t("connectors.directory.create-folder")}
            </AppButton>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
