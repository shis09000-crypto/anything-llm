import React, { useState } from "react";
import { X } from "@phosphor-icons/react";
import System from "@/models/system";
import showToast from "@/utils/toast";
import { useTranslation } from "react-i18next";

export default function EditVariableModal({ variable, closeModal, onRefresh }) {
  const [error, setError] = useState(null);
  const { t } = useTranslation();

  const handleUpdate = async (e) => {
    if (!variable.id) return;
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.target);
    const updatedVariable = {};
    for (const [key, value] of formData.entries())
      updatedVariable[key] = value.trim();

    if (!updatedVariable.key || !updatedVariable.value) {
      setError(t("system-prompt-variables.errors.required"));
      return;
    }

    try {
      await System.promptVariables.update(variable.id, updatedVariable);
      showToast(t("system-prompt-variables.toasts.updated"), "success", {
        clear: true,
      });
      if (onRefresh) onRefresh();
      closeModal();
    } catch (error) {
      console.error("Error updating variable:", error);
      setError(t("system-prompt-variables.errors.update"));
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-auto bg-black bg-opacity-50 flex items-center justify-center">
      <div className="relative w-full max-w-2xl bg-theme-bg-secondary rounded-lg shadow border-2 border-theme-modal-border">
        <div className="relative p-6 border-b rounded-t border-theme-modal-border">
          <div className="w-full flex gap-x-2 items-center">
            <h3 className="text-xl font-semibold text-white overflow-hidden overflow-ellipsis whitespace-nowrap">
              {t("system-prompt-variables.form.editTitle", {
                key: variable.key,
              })}
            </h3>
          </div>
          <button
            onClick={closeModal}
            type="button"
            className="absolute top-4 right-4 motion-hover bg-transparent rounded-lg text-sm p-1 inline-flex items-center hover:bg-theme-modal-border hover:border-theme-modal-border hover:border-opacity-50 border-transparent border"
          >
            <X size={24} weight="bold" className="text-white" />
          </button>
        </div>
        <div className="p-6">
          <form onSubmit={handleUpdate}>
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="key"
                  className="block mb-2 text-sm font-medium text-white"
                >
                  {t("system-prompt-variables.columns.key")}
                </label>
                <input
                  name="key"
                  minLength={3}
                  maxLength={255}
                  type="text"
                  className="border-none bg-theme-settings-input-bg w-full text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
                  placeholder={t("system-prompt-variables.form.keyPlaceholder")}
                  defaultValue={variable.key}
                  required={true}
                  autoComplete="off"
                  pattern="^[a-zA-Z0-9_]+$"
                />
                <p className="mt-2 text-xs text-white/60">
                  {t("system-prompt-variables.form.keyHint")}
                </p>
              </div>
              <div>
                <label
                  htmlFor="value"
                  className="block mb-2 text-sm font-medium text-white"
                >
                  {t("system-prompt-variables.columns.value")}
                </label>
                <input
                  name="value"
                  type="text"
                  className="border-none bg-theme-settings-input-bg w-full text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
                  placeholder={t(
                    "system-prompt-variables.form.valuePlaceholder"
                  )}
                  defaultValue={variable.value}
                  required={true}
                  autoComplete="off"
                />
              </div>
              <div>
                <label
                  htmlFor="description"
                  className="block mb-2 text-sm font-medium text-white"
                >
                  {t("system-prompt-variables.columns.description")}
                </label>
                <input
                  name="description"
                  type="text"
                  className="border-none bg-theme-settings-input-bg w-full text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
                  placeholder={t(
                    "system-prompt-variables.form.descriptionPlaceholder"
                  )}
                  defaultValue={variable.description}
                  autoComplete="off"
                />
              </div>
              {error && (
                <p className="text-red-400 text-sm">
                  {t("system-prompt-variables.errors.prefix")}: {error}
                </p>
              )}
            </div>
            <div className="flex justify-between items-center mt-6 pt-6 border-t border-theme-modal-border">
              <button
                onClick={closeModal}
                type="button"
                className="motion-hover text-white hover:bg-zinc-700 px-4 py-2 rounded-lg text-sm"
              >
                {t("system-prompt-variables.form.cancel")}
              </button>
              <button
                type="submit"
                className="motion-hover bg-white text-black hover:opacity-60 px-4 py-2 rounded-lg text-sm"
              >
                {t("system-prompt-variables.form.update")}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
