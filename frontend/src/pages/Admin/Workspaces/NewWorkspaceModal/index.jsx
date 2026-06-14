import React, { useState } from "react";
import { X } from "@phosphor-icons/react";
import Admin from "@/models/admin";
import { useTranslation } from "react-i18next";
import AppButton from "@/components/lib/AppButton";

export default function NewWorkspaceModal({ closeModal }) {
  const [error, setError] = useState(null);
  const { t } = useTranslation();
  const handleCreate = async (e) => {
    setError(null);
    e.preventDefault();
    const form = new FormData(e.target);
    const { workspace, error } = await Admin.newWorkspace(form.get("name"));
    if (!!workspace) window.location.reload();
    setError(error);
  };

  return (
    <div className="fixed inset-0 z-50 overflow-auto bg-black bg-opacity-50 flex items-center justify-center">
      <div className="relative w-full max-w-2xl bg-theme-bg-secondary rounded-lg shadow border-2 border-theme-modal-border">
        <div className="relative p-6 border-b rounded-t border-theme-modal-border">
          <div className="w-full flex gap-x-2 items-center">
            <h3 className="text-xl font-semibold text-white overflow-hidden overflow-ellipsis whitespace-nowrap">
              {t("admin.workspaces.modal.createTitle")}
            </h3>
          </div>
          <AppButton
            onClick={closeModal}
            type="button"
            variant="secondary"
            size="sm"
            iconOnly
            aria-label={t("admin.common.close")}
            className="absolute top-4 right-4 motion-hover bg-transparent rounded-lg text-sm p-1 inline-flex items-center hover:bg-theme-modal-border hover:border-theme-modal-border hover:border-opacity-50 border-transparent border"
            leftIcon={<X size={24} weight="bold" className="text-white" />}
          />
        </div>
        <div className="p-6">
          <form onSubmit={handleCreate}>
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="name"
                  className="block mb-2 text-sm font-medium text-white"
                >
                  {t("common.workspaces-name")}
                </label>
                <input
                  name="name"
                  type="text"
                  className="border-none bg-theme-settings-input-bg w-full text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
                  placeholder={t("admin.workspaces.modal.namePlaceholder")}
                  minLength={4}
                  required={true}
                  autoComplete="off"
                />
              </div>
              {error && (
                <p className="text-red-400 text-sm">
                  {t("admin.common.genericError", { error })}
                </p>
              )}
              <p className="text-white text-opacity-60 text-xs md:text-sm">
                {t("admin.workspaces.modal.noteAfterCreate")}
              </p>
            </div>
            <div className="flex justify-between items-center mt-6 pt-6 border-t border-theme-modal-border">
              <AppButton
                type="button"
                variant="secondary"
                onClick={closeModal}
                className="motion-hover"
              >
                {t("admin.workspaces.actions.cancel")}
              </AppButton>
              <AppButton
                type="submit"
                variant="primary"
                className="motion-hover"
              >
                {t("admin.workspaces.modal.create")}
              </AppButton>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
