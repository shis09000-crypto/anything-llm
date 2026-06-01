import SettingsSidebar from "@/components/SettingsSidebar";
import { useEffect, useState, Fragment } from "react";
import { isMobile } from "react-device-detect";
import System from "@/models/system";
import showToast from "@/utils/toast";
import * as Skeleton from "react-loading-skeleton";
import "react-loading-skeleton/dist/skeleton.css";
import Highlighter from "react-highlight-words";
import SystemPromptVariable from "@/models/systemPromptVariable";
import { Link } from "react-router-dom";
import paths from "@/utils/paths";
import { useTranslation } from "react-i18next";

export default function DefaultSystemPrompt() {
  const [systemPromptForm, setSystemPromptForm] = useState({
    value: "",
    default: "",
    isDirty: false,
    isSubmitting: false,
    isLoading: true,
    isEditing: false,
    syncExistingWorkspaces: false,
  });
  const [saneDefaultSystemPrompt, setSaneDefaultSystemPrompt] = useState("");
  const [availableVariables, setAvailableVariables] = useState([]);
  const { t } = useTranslation();
  useEffect(() => {
    async function setupVariableHighlighting() {
      const { variables } = await SystemPromptVariable.getAll();
      setAvailableVariables(variables);
    }
    setupVariableHighlighting();
  }, []);

  useEffect(() => {
    async function fetchDefaultSystemPrompt() {
      setSystemPromptForm((prev) => ({
        ...prev,
        isLoading: true,
      }));
      const { defaultSystemPrompt, saneDefaultSystemPrompt } =
        await System.fetchDefaultSystemPrompt();
      setSaneDefaultSystemPrompt(saneDefaultSystemPrompt);
      if (!defaultSystemPrompt)
        return setSystemPromptForm((prev) => ({
          ...prev,
          isLoading: false,
        }));

      setSystemPromptForm((prev) => ({
        ...prev,
        default: defaultSystemPrompt,
        value: defaultSystemPrompt,
        isLoading: false,
      }));
    }
    fetchDefaultSystemPrompt();
  }, []);

  const handleChange = (e) => {
    const value = e.target.value;
    const isDirty = value !== systemPromptForm.default;

    setSystemPromptForm((prev) => ({
      ...prev,
      value,
      isDirty,
      isSubmitting: false,
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSystemPromptForm((prev) => ({
      ...prev,
      isSubmitting: true,
    }));
    const newSystemPrompt = systemPromptForm.value.trim();
    await System.updateDefaultSystemPrompt(
      newSystemPrompt,
      systemPromptForm.syncExistingWorkspaces ? "defaultOnly" : null
    )
      .then(({ success, message, defaultSystemPrompt, sync }) => {
        if (!success) throw new Error(message);

        const savedSystemPrompt =
          defaultSystemPrompt ||
          (!newSystemPrompt || newSystemPrompt === saneDefaultSystemPrompt
            ? saneDefaultSystemPrompt
            : newSystemPrompt);

        showToast(
          sync?.enabled
            ? t("default-system-prompt.toasts.updatedWithSync", {
                synced: sync.synced,
                skipped: sync.skipped,
                failed: sync.failed,
              })
            : t("default-system-prompt.toasts.updated"),
          "success"
        );
        setSystemPromptForm((prev) => ({
          ...prev,
          default: savedSystemPrompt,
          value: savedSystemPrompt,
          isDirty: false,
          isSubmitting: false,
          syncExistingWorkspaces: false,
        }));
      })
      .catch((error) => {
        showToast(
          t("default-system-prompt.toasts.updateFailed", {
            error: error.message,
          }),
          "error"
        );
        setSystemPromptForm((prev) => ({
          ...prev,
          isSubmitting: false,
        }));
      });
  };

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <SettingsSidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll p-4 md:p-0"
      >
        <div className="flex flex-col w-full px-1 md:pl-6 md:pr-[50px] md:py-6 py-16">
          <div className="w-full flex flex-col gap-y-1 pb-6 border-white/10 border-b-2">
            <div className="items-center flex gap-x-4">
              <p className="text-lg leading-6 font-bold text-theme-text-primary">
                {t("default-system-prompt.title")}
              </p>
            </div>
            <p className="text-xs leading-[18px] font-base text-theme-text-secondary">
              {t("default-system-prompt.description")}
            </p>
          </div>
          <div>
            {systemPromptForm.isLoading ? (
              <div className="mt-8 flex flex-col gap-y-4">
                <Skeleton.default
                  height={20}
                  width={160}
                  highlightColor="var(--theme-bg-primary)"
                  baseColor="var(--theme-bg-secondary)"
                />
                <Skeleton.default
                  height={120}
                  width="100%"
                  highlightColor="var(--theme-bg-primary)"
                  baseColor="var(--theme-bg-secondary)"
                  className="rounded-lg"
                />
                <Skeleton.default
                  height={36}
                  width={140}
                  highlightColor="var(--theme-bg-primary)"
                  baseColor="var(--theme-bg-secondary)"
                />
              </div>
            ) : (
              <div className="mt-6">
                <form onSubmit={handleSubmit} className="space-y-3">
                  <label
                    htmlFor="default-system-prompt"
                    className=" text-base font-bold text-white"
                  >
                    {t("default-system-prompt.form.label")}
                  </label>
                  <div className="space-y-1">
                    <p className="text-white text-opacity-60 text-xs font-medium">
                      {t("default-system-prompt.form.helpStart")}
                      {t("default-system-prompt.form.helpStartSeparator")}
                      <span className="font-bold">
                        {t("default-system-prompt.form.specificWorkspace")}
                      </span>
                      {t("default-system-prompt.form.helpMiddle")}
                      {t("default-system-prompt.form.helpMiddleSeparator")}
                      <span className="font-bold">
                        {t("default-system-prompt.form.workspaceSettings")}
                      </span>
                      {t("default-system-prompt.form.helpEnd")}
                    </p>
                    <p className="text-white text-opacity-60 text-xs font-medium mb-2">
                      {t("default-system-prompt.form.variablesPrefix")}{" "}
                      <Link
                        to={paths.settings.systemPromptVariables()}
                        className="text-primary-button"
                      >
                        {t("default-system-prompt.form.variablesLink")}
                      </Link>{" "}
                      {t("default-system-prompt.form.variablesLike")}{" "}
                      {availableVariables.slice(0, 3).map((v, i) => (
                        <Fragment key={v.key}>
                          <span className="bg-theme-settings-input-bg px-1 py-0.5 rounded">
                            {`{${v.key}}`}
                          </span>
                          {i < availableVariables.length - 1 && ", "}
                        </Fragment>
                      ))}
                      {availableVariables.length > 3 && (
                        <Link
                          to={paths.settings.systemPromptVariables()}
                          className="text-primary-button"
                        >
                          {t("default-system-prompt.form.moreVariables", {
                            count: availableVariables.length - 3,
                          })}
                        </Link>
                      )}
                    </p>
                  </div>

                  {systemPromptForm.isEditing ? (
                    <textarea
                      autoFocus={true}
                      value={systemPromptForm.value}
                      onChange={handleChange}
                      onBlur={() =>
                        setSystemPromptForm((prev) => ({
                          ...prev,
                          isEditing: false,
                        }))
                      }
                      placeholder={
                        systemPromptForm.isLoading
                          ? t("common.loading")
                          : t("default-system-prompt.form.placeholder")
                      }
                      rows={5}
                      style={{
                        resize: "vertical",
                        overflowY: "scroll",
                        minHeight: "150px",
                      }}
                      className="w-full border-none bg-theme-settings-input-bg placeholder:text-theme-settings-input-placeholder text-white text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block p-2.5"
                    />
                  ) : (
                    <div
                      onClick={() =>
                        setSystemPromptForm((prev) => ({
                          ...prev,
                          isEditing: true,
                        }))
                      }
                      style={{
                        resize: "vertical",
                        overflowY: "scroll",
                        minHeight: "150px",
                      }}
                      className="w-full border-none bg-theme-settings-input-bg text-white text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block p-2.5 cursor-text"
                    >
                      <Highlighter
                        className="whitespace-pre-wrap"
                        highlightClassName="bg-cta-button p-0.5 rounded-md"
                        searchWords={availableVariables.map(
                          (v) => `{${v.key}}`
                        )}
                        autoEscape={true}
                        caseSensitive={true}
                        textToHighlight={systemPromptForm.value || ""}
                      />
                    </div>
                  )}
                  <label className="flex w-fit items-start gap-x-2 rounded-lg border border-white/10 bg-theme-settings-input-bg/60 p-3 text-xs font-medium text-theme-text-secondary light:border-slate-200 light:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={systemPromptForm.syncExistingWorkspaces}
                      onChange={(e) =>
                        setSystemPromptForm((prev) => ({
                          ...prev,
                          syncExistingWorkspaces: e.target.checked,
                        }))
                      }
                      className="mt-0.5 h-4 w-4 rounded border-white/20 bg-theme-settings-input-bg accent-primary-button"
                    />
                    <span className="flex max-w-[640px] flex-col gap-y-1">
                      <span className="font-semibold text-theme-text-primary">
                        {t("default-system-prompt.form.syncExisting")}
                      </span>
                      <span>
                        {t("default-system-prompt.form.syncExistingHint")}
                      </span>
                    </span>
                  </label>
                  <button
                    disabled={
                      (!systemPromptForm.isDirty &&
                        !systemPromptForm.syncExistingWorkspaces) ||
                      systemPromptForm.isSubmitting
                    }
                    className="motion-hover flex h-[36px] w-fit items-center justify-center rounded-lg border-none bg-primary-button px-4 py-2 text-sm font-bold text-black shadow-[0_4px_14px_rgba(0,0,0,0.25)] hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:opacity-40 light:text-white"
                    type="submit"
                  >
                    {t("common.save")}
                  </button>
                </form>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
