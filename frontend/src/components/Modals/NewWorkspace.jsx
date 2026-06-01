import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FloppyDisk } from "@phosphor-icons/react";
import Workspace from "@/models/workspace";
import paths from "@/utils/paths";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import AppButton from "@/components/lib/AppButton";
import AppIcon from "@/components/lib/AppIcon";
import { dispatchWorkspacesRefresh } from "@/utils/workspaceEvents";

const noop = () => false;
export default function NewWorkspaceModal({ hideModal = noop }) {
  const formEl = useRef(null);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const { t } = useTranslation();
  const navigate = useNavigate();

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape") hideModal();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hideModal]);

  const handleCreate = async (e) => {
    setError(null);
    e.preventDefault();
    setCreating(true);
    const data = {};
    const form = new FormData(formEl.current);
    for (var [key, value] of form.entries()) data[key] = value;
    const { workspace, message } = await Workspace.new(data);
    setCreating(false);
    if (!!workspace) {
      dispatchWorkspacesRefresh(workspace);
      navigate(paths.workspace.chat(workspace.slug));
      hideModal();
      return;
    }
    setError(message);
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="motion-modal-open fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950/55 px-4 py-6 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-workspace-modal-title"
      onMouseDown={hideModal}
    >
      <div
        className="motion-modal-content w-full max-w-[620px] overflow-hidden rounded-[24px] border border-white/10 bg-theme-bg-secondary shadow-[0_28px_90px_rgba(0,0,0,0.45)] light:border-slate-200 light:bg-white light:shadow-[0_28px_90px_rgba(15,23,42,0.20)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/10 bg-white/[0.03] px-6 py-5 light:border-slate-200 light:bg-slate-50">
          <div>
            <h2
              id="new-workspace-modal-title"
              className="text-lg font-bold text-theme-text-primary"
            >
              {t("new-workspace.title")}
            </h2>
          </div>
          <button
            onClick={hideModal}
            type="button"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70"
            aria-label="关闭新工作区"
          >
            <AppIcon name="close" size="md" tone="muted" weight="bold" />
          </button>
        </div>
        <form ref={formEl} onSubmit={handleCreate}>
          <div className="space-y-5 px-6 py-5">
            <label className="block" htmlFor="name">
              <span className="mb-2 block text-sm font-semibold text-theme-text-primary">
                {t("common.workspaces-name")}
              </span>
              <input
                name="name"
                type="text"
                id="name"
                className="w-full rounded-2xl border border-white/10 bg-theme-settings-input-bg p-4 text-sm leading-6 text-theme-settings-input-text outline-none placeholder:text-theme-settings-input-placeholder focus:border-primary-button focus:outline-none light:border-slate-200 light:bg-slate-50"
                placeholder={t("new-workspace.placeholder")}
                required={true}
                autoComplete="off"
                autoFocus={true}
              />
            </label>
            {error && (
              <p className="rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-300 light:text-red-600">
                Error: {error}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-3 border-t border-white/10 bg-white/[0.02] px-6 py-4 light:border-slate-200 light:bg-slate-50">
            <AppButton
              type="submit"
              size="md"
              loading={creating}
              leftIcon={<FloppyDisk size={16} weight="fill" />}
            >
              {creating ? t("common.saving") : "Save"}
            </AppButton>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}

export function useNewWorkspaceModal() {
  const [showing, setShowing] = useState(false);
  const showModal = () => {
    setShowing(true);
  };
  const hideModal = () => {
    setShowing(false);
  };

  return { showing, showModal, hideModal };
}
