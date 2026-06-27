import { useLanguageOptions } from "@/hooks/useLanguageOptions";
import usePfp from "@/hooks/usePfp";
import System from "@/models/system";
import Appearance from "@/models/appearance";
import {
  AUTH_TIMESTAMP,
  AUTH_USER,
  LAST_USER_ACTION_AT,
  LAST_VISITED_WORKSPACE,
  LAST_VISITED_WORKSPACE_THREADS,
  USER_PROMPT_INPUT_MAP,
} from "@/utils/constants";
import showToast from "@/utils/toast";
import { Info, Plus } from "@phosphor-icons/react";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "react-i18next";
import { useState, useEffect, useRef } from "react";
import { Tooltip } from "react-tooltip";
import { safeJsonParse } from "@/utils/request";
import Toggle from "@/components/lib/Toggle";
import AppButton from "@/components/lib/AppButton";
import { removeAuthToken } from "@/utils/authTokenStorage";
import AppIcon from "@/components/lib/AppIcon";
import EmailVerificationCodeInput from "@/components/EmailVerificationCodeInput";
import { normalizeEmailInput } from "@/utils/emailInput";
import { emailVerificationErrorMessage } from "@/utils/emailVerificationErrors";
import paths from "@/utils/paths";
import { createPortal } from "react-dom";
import {
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_PATTERN,
} from "@/utils/username";

export default function AccountModal({ user, hideModal }) {
  const { pfp, setPfp } = usePfp();
  const { t } = useTranslation();
  const formRef = useRef(null);
  const initialHashRef = useRef(
    accountDataHash({
      username: user.username || "",
      password: "",
      bio: user.bio || "",
    })
  );
  const closingRef = useRef(false);
  const [emailStatus, setEmailStatus] = useState({
    email: user.email || "",
    verified: Boolean(user.email && user.email_verified_at),
    pendingEmail: "",
  });
  const [emailDraft, setEmailDraft] = useState(user.email || "");
  const [emailStep, setEmailStep] = useState("request");
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailCodeResetSignal, setEmailCodeResetSignal] = useState(0);
  const [emailResendRemaining, setEmailResendRemaining] = useState(0);
  const [emailEditMode, setEmailEditMode] = useState(
    !(user.email && user.email_verified_at)
  );

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape") closeWithAutoSave();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    initialHashRef.current = accountDataHash({
      username: user.username || "",
      password: "",
      bio: user.bio || "",
    });
  }, [user.bio, user.username]);

  useEffect(() => {
    async function fetchEmailStatus() {
      const result = await System.emailVerificationStatus();
      if (!result.success) return;
      setEmailStatus({
        email: result.email || "",
        verified: Boolean(result.verified),
        verifiedAt: result.verifiedAt || null,
        pendingEmail: result.pendingEmail || "",
      });
      setEmailDraft(result.pendingEmail || result.email || "");
      setEmailStep(result.pendingEmail ? "verify" : "request");
      setEmailEditMode(Boolean(result.pendingEmail || !result.verified));
    }
    fetchEmailStatus();
  }, []);

  useEffect(() => {
    if (emailResendRemaining <= 0) return;
    const timer = setTimeout(() => {
      setEmailResendRemaining((current) => Math.max(0, current - 1));
    }, 1_000);
    return () => clearTimeout(timer);
  }, [emailResendRemaining]);

  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return false;

    const formData = new FormData();
    formData.append("file", file);
    const { success, error } = await System.uploadPfp(formData);
    if (!success) {
      showToast(t("profile_settings.failed_upload", { error }), "error");
      return;
    }

    const pfpUrl = await System.fetchPfp(user.id);
    setPfp(pfpUrl);
    showToast(t("profile_settings.upload_success"), "success");
  };

  const handleRemovePfp = async () => {
    const { success, error } = await System.removePfp();
    if (!success) {
      showToast(t("profile_settings.failed_remove", { error }), "error");
      return;
    }

    setPfp(null);
  };

  async function saveIfChanged() {
    const form = formRef.current;
    if (!form) return true;

    const data = accountDataFromForm(form);
    const currentHash = accountDataHash(data);
    if (currentHash === initialHashRef.current) return true;
    if (!form.reportValidity()) return false;

    const { success, error } = await System.updateUser(data);
    if (success) {
      let storedUser = safeJsonParse(localStorage.getItem(AUTH_USER), null);
      if (storedUser) {
        storedUser.username = data.username;
        storedUser.bio = data.bio;
        localStorage.setItem(AUTH_USER, JSON.stringify(storedUser));
      }
      showToast(t("profile_settings.profile_updated"), "success", {
        clear: true,
      });
      initialHashRef.current = currentHash;
      return true;
    } else {
      showToast(t("profile_settings.failed_update_user", { error }), "error");
      return false;
    }
  }

  async function closeWithAutoSave() {
    if (closingRef.current) return;
    closingRef.current = true;
    const saved = await saveIfChanged();
    closingRef.current = false;
    if (saved) hideModal();
  }

  async function signOut() {
    if (closingRef.current) return;
    closingRef.current = true;
    const saved = await saveIfChanged();
    closingRef.current = false;
    if (!saved) return;
    window.localStorage.removeItem(AUTH_USER);
    removeAuthToken();
    window.localStorage.removeItem(AUTH_TIMESTAMP);
    window.localStorage.removeItem(LAST_USER_ACTION_AT);
    window.localStorage.removeItem(LAST_VISITED_WORKSPACE);
    window.localStorage.removeItem(LAST_VISITED_WORKSPACE_THREADS);
    window.localStorage.removeItem(USER_PROMPT_INPUT_MAP);
    window.location.replace(paths.home());
  }

  async function requestEmailCode() {
    if (emailLoading || emailResendRemaining > 0) return;
    if (!emailDraft) {
      showToast(t("profile_settings.email-required"), "error", {
        clear: true,
      });
      return;
    }

    setEmailLoading(true);
    const result = await System.requestEmailVerification({
      email: emailDraft,
    });
    setEmailLoading(false);

    if (!result.success) {
      if (result.resendCooldownSeconds) {
        setEmailResendRemaining(Number(result.resendCooldownSeconds));
      }
      showToast(emailVerificationErrorMessage(t, result), "error", {
        clear: true,
      });
      return;
    }

    setEmailStatus((current) => ({
      ...current,
      pendingEmail: result.pendingEmail || emailDraft,
    }));
    setEmailStep("verify");
    setEmailResendRemaining(Number(result.resendCooldownSeconds) || 60);
    showToast(t("profile_settings.email-code-sent"), "success", {
      clear: true,
    });
  }

  function startEmailEdit() {
    setEmailEditMode(true);
    setEmailDraft("");
    setEmailStep("request");
    setEmailResendRemaining(0);
    setEmailCodeResetSignal((current) => current + 1);
  }

  async function confirmEmailCode(code) {
    if (emailLoading) return;
    setEmailLoading(true);
    const result = await System.confirmEmailVerification({
      email: emailStatus.pendingEmail || emailDraft,
      code,
    });
    setEmailLoading(false);

    if (!result.success) {
      setEmailCodeResetSignal((current) => current + 1);
      showToast(emailVerificationErrorMessage(t, result), "error", {
        clear: true,
      });
      return;
    }

    const nextStatus = {
      email: result.email,
      verified: true,
      verifiedAt: result.verifiedAt,
      pendingEmail: "",
    };
    setEmailStatus(nextStatus);
    setEmailDraft(result.email);
    setEmailStep("request");
    setEmailEditMode(false);

    let storedUser = safeJsonParse(localStorage.getItem(AUTH_USER), null);
    if (storedUser) {
      storedUser.email = result.email;
      storedUser.email_verified_at = result.verifiedAt;
      localStorage.setItem(AUTH_USER, JSON.stringify(storedUser));
    }
    showToast(t("profile_settings.email-verified-success"), "success", {
      clear: true,
    });
  }

  if (typeof document === "undefined") return null;

  const showEmailEditor =
    !emailStatus.verified || Boolean(emailStatus.pendingEmail) || emailEditMode;

  return createPortal(
    <div
      className="motion-modal-open fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950/55 px-4 py-6 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-modal-title"
      onMouseDown={closeWithAutoSave}
    >
      <div
        className="motion-modal-content w-full max-w-[620px] overflow-hidden rounded-[24px] border border-white/10 bg-theme-bg-secondary shadow-[0_28px_90px_rgba(0,0,0,0.45)] light:border-slate-200 light:bg-white light:shadow-[0_28px_90px_rgba(15,23,42,0.20)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <form ref={formRef}>
          <div className="flex items-start justify-between gap-4 border-b border-white/10 bg-white/[0.03] px-6 py-5 light:border-slate-200 light:bg-slate-50">
            <div>
              <h2
                id="account-modal-title"
                className="text-lg font-bold text-theme-text-primary"
              >
                {t("profile_settings.edit_account")}
              </h2>
              <p className="mt-1 max-w-[420px] text-xs leading-5 text-theme-text-secondary">
                {t("profile_settings.account")}
              </p>
            </div>
            <button
              type="button"
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70"
              onClick={closeWithAutoSave}
              aria-label="关闭账户"
            >
              <AppIcon name="close" size="md" tone="muted" weight="bold" />
            </button>
          </div>
          <div
            className="h-full w-full overflow-y-auto px-6 py-5"
            style={{ maxHeight: "calc(100vh - 220px)" }}
          >
            <div className="space-y-6">
              <div className="flex flex-col md:flex-row items-center justify-center gap-8">
                <div className="flex flex-col items-center">
                  <label className="group w-44 h-44 flex flex-col items-center justify-center bg-theme-settings-input-bg hover:bg-theme-bg-primary motion-hover rounded-full border-2 border-dashed border-white/20 light:border-slate-300 light:bg-sky-50 light:hover:bg-slate-50 cursor-pointer hover:opacity-80">
                    <input
                      id="logo-upload"
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleFileUpload}
                    />
                    {pfp ? (
                      <img
                        src={pfp}
                        alt="User profile picture"
                        className="w-44 h-44 rounded-full object-cover bg-white"
                      />
                    ) : (
                      <div className="flex flex-col items-center justify-center p-3">
                        <Plus className="w-8 h-8 text-theme-text-secondary m-2" />
                        <span className="text-theme-text-secondary text-opacity-80 text-sm font-semibold">
                          {t("profile_settings.profile_picture")}
                        </span>
                        <span className="text-theme-text-secondary text-opacity-60 text-xs">
                          800 x 800
                        </span>
                      </div>
                    )}
                  </label>
                  {pfp && (
                    <button
                      type="button"
                      onClick={handleRemovePfp}
                      className="mt-3 text-theme-text-secondary text-opacity-60 text-sm font-medium hover:underline"
                    >
                      {t("profile_settings.remove_profile_picture")}
                    </button>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-y-4">
                <div>
                  <label
                    htmlFor="username"
                    className="block mb-2 text-sm font-medium text-theme-text-primary"
                  >
                    {t("profile_settings.username")}
                  </label>
                  <input
                    name="username"
                    type="text"
                    className="border border-white/10 bg-theme-settings-input-bg placeholder:text-theme-settings-input-placeholder text-theme-settings-input-text text-sm rounded-2xl focus:border-primary-button focus:outline-none outline-none block w-full p-3 light:border-slate-200 light:bg-slate-50"
                    placeholder="User's username"
                    minLength={USERNAME_MIN_LENGTH}
                    maxLength={USERNAME_MAX_LENGTH}
                    pattern={USERNAME_PATTERN}
                    defaultValue={user.username}
                    required
                    autoComplete="off"
                  />
                  <p className="mt-2 text-xs text-theme-text-secondary">
                    {t("common.username_requirements")}
                  </p>
                </div>
                <div>
                  <label
                    htmlFor="password"
                    className="block mb-2 text-sm font-medium text-theme-text-primary"
                  >
                    {t("profile_settings.new_password")}
                  </label>
                  <input
                    name="password"
                    type="text"
                    className="border border-white/10 bg-theme-settings-input-bg placeholder:text-theme-settings-input-placeholder text-theme-settings-input-text text-sm rounded-2xl focus:border-primary-button focus:outline-none outline-none block w-full p-3 light:border-slate-200 light:bg-slate-50"
                    placeholder={`${user.username}'s new password`}
                    minLength={8}
                  />
                  <p className="mt-2 text-xs text-theme-text-secondary">
                    {t("profile_settings.password_description")}
                  </p>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/[0.02] p-4 light:border-slate-200 light:bg-slate-50">
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <label className="block text-sm font-medium text-theme-text-primary">
                        {t("profile_settings.email")}
                      </label>
                      <p className="mt-1 text-sm text-theme-text-secondary">
                        {emailStatus.verified ? (
                          <>
                            <span className="font-semibold text-base text-theme-text-primary">
                              {emailStatus.email}
                            </span>{" "}
                            <span>
                              · {t("profile_settings.email-verified")}
                            </span>
                          </>
                        ) : emailStatus.pendingEmail ? (
                          <>
                            <span className="font-semibold text-base text-theme-text-primary">
                              {emailStatus.pendingEmail}
                            </span>{" "}
                            <span>· {t("profile_settings.email-pending")}</span>
                          </>
                        ) : (
                          t("profile_settings.email-unbound")
                        )}
                      </p>
                    </div>
                    {emailStatus.verified && (
                      <span className="w-fit rounded-md bg-emerald-500/15 px-2 py-1 text-xs font-semibold text-emerald-300 light:text-emerald-700">
                        {t("profile_settings.email-verified")}
                      </span>
                    )}
                    {!emailStatus.verified && emailStatus.pendingEmail && (
                      <span className="w-fit rounded-md bg-amber-500/15 px-2 py-1 text-xs font-semibold text-amber-300 light:text-amber-700">
                        {t("profile_settings.email-pending")}
                      </span>
                    )}
                  </div>
                  {showEmailEditor && (
                    <div className="mt-4">
                      <input
                        type="email"
                        value={emailDraft}
                        onChange={(event) => {
                          setEmailDraft(
                            normalizeEmailInput(event.target.value)
                          );
                          setEmailStep("request");
                        }}
                        className="border border-white/10 bg-theme-settings-input-bg placeholder:text-theme-settings-input-placeholder text-theme-settings-input-text text-sm rounded-2xl focus:border-primary-button focus:outline-none outline-none block w-full p-3 light:border-slate-200 light:bg-white"
                        placeholder="noreply@example.com"
                        autoComplete="email"
                        autoCapitalize="none"
                        spellCheck={false}
                        lang="en"
                      />
                    </div>
                  )}
                  <div
                    className={`mt-4 flex flex-col gap-3 sm:flex-row sm:items-center ${
                      showEmailEditor ? "sm:justify-between" : "sm:justify-end"
                    }`}
                  >
                    {showEmailEditor &&
                      (emailStep === "verify" ? (
                        <EmailVerificationCodeInput
                          disabled={emailLoading}
                          onComplete={confirmEmailCode}
                          resetSignal={emailCodeResetSignal}
                          inputClassName="h-10 w-9 rounded-lg border border-white/10 bg-theme-settings-input-bg text-center text-base font-semibold text-theme-settings-input-text outline-none focus:border-primary-button light:border-slate-200 light:bg-white"
                        />
                      ) : (
                        <span className="text-xs text-theme-text-secondary">
                          {emailStatus.verified
                            ? t("profile_settings.email-change-hint")
                            : t("profile_settings.email-bind-hint")}
                        </span>
                      ))}
                    <AppButton
                      variant="secondary"
                      type="button"
                      disabled={
                        showEmailEditor &&
                        (emailLoading || emailResendRemaining > 0)
                      }
                      onClick={
                        showEmailEditor ? requestEmailCode : startEmailEdit
                      }
                      className="h-10 min-w-36 rounded-lg"
                    >
                      {!showEmailEditor
                        ? t("profile_settings.change-email")
                        : emailLoading
                          ? t("profile_settings.processing")
                          : emailResendRemaining > 0
                            ? t(
                                "profile_settings.resend-verification-code-in",
                                {
                                  seconds: emailResendRemaining,
                                }
                              )
                            : t("profile_settings.send-verification-code")}
                    </AppButton>
                  </div>
                </div>
                <div>
                  <label
                    htmlFor="bio"
                    className="block mb-2 text-sm font-medium text-theme-text-primary"
                  >
                    Bio
                  </label>
                  <textarea
                    name="bio"
                    className="border border-white/10 bg-theme-settings-input-bg placeholder:text-theme-settings-input-placeholder text-theme-settings-input-text text-sm rounded-2xl focus:border-primary-button focus:outline-none outline-none block w-full p-3 min-h-[100px] resize-y light:border-slate-200 light:bg-slate-50"
                    placeholder="Tell us about yourself..."
                    defaultValue={user.bio}
                  />
                </div>
                <div className="flex flex-col gap-6 sm:flex-row sm:gap-x-16">
                  <div className="flex flex-col gap-y-6">
                    <ThemePreference />
                    <LanguagePreference />
                  </div>
                  <div className="flex flex-col gap-y-6">
                    <AutoSpeakPreference />
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="flex justify-end border-t border-white/10 bg-white/[0.02] px-6 py-4 light:border-slate-200 light:bg-slate-50">
            <AppButton size="md" onClick={signOut}>
              {t("profile_settings.signout")}
            </AppButton>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}

function accountDataFromForm(form) {
  const formData = new FormData(form);
  return {
    username: String(formData.get("username") || ""),
    password: String(formData.get("password") || ""),
    bio: String(formData.get("bio") || ""),
  };
}

function accountDataHash(data = {}) {
  const value = JSON.stringify({
    username: data.username || "",
    password: data.password || "",
    bio: data.bio || "",
  });
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return String(hash);
}

function LanguagePreference() {
  const {
    currentLanguage,
    supportedLanguages,
    getLanguageName,
    changeLanguage,
  } = useLanguageOptions();
  const { t } = useTranslation();
  return (
    <div>
      <label
        htmlFor="userLang"
        className="block mb-2 text-sm font-medium text-theme-text-primary"
      >
        {t("profile_settings.language")}
      </label>
      <select
        name="userLang"
        className="border border-white/10 bg-theme-settings-input-bg w-fit mt-2 px-4 focus:border-primary-button focus:outline-none outline-none text-theme-settings-input-text text-sm rounded-lg block py-2 light:border-slate-200 light:bg-slate-50"
        defaultValue={currentLanguage || "en"}
        onChange={(e) => changeLanguage(e.target.value)}
      >
        {supportedLanguages.map((lang) => {
          return (
            <option key={lang} value={lang}>
              {getLanguageName(lang)}
            </option>
          );
        })}
      </select>
    </div>
  );
}

function ThemePreference() {
  const { theme, setTheme, availableThemes } = useTheme();
  const { t } = useTranslation();
  return (
    <div>
      <label
        htmlFor="theme"
        className="block mb-2 text-sm font-medium text-theme-text-primary"
      >
        {t("profile_settings.theme")}
      </label>
      <select
        name="theme"
        value={theme}
        onChange={(e) => setTheme(e.target.value)}
        className="border border-white/10 bg-theme-settings-input-bg w-fit px-4 focus:border-primary-button focus:outline-none outline-none text-theme-settings-input-text text-sm rounded-lg block py-2 light:border-slate-200 light:bg-slate-50"
      >
        {Object.entries(availableThemes).map(([key, value]) => (
          <option key={key} value={key}>
            {value}
          </option>
        ))}
      </select>
    </div>
  );
}

function AutoSpeakPreference() {
  const [autoPlayAssistantTtsResponse, setAutoPlayAssistantTtsResponse] =
    useState(false);
  const { t } = useTranslation();

  useEffect(() => {
    const settings = Appearance.getSettings();
    setAutoPlayAssistantTtsResponse(
      settings.autoPlayAssistantTtsResponse ?? false
    );
  }, []);

  const handleChange = (checked) => {
    setAutoPlayAssistantTtsResponse(checked);
    Appearance.updateSettings({ autoPlayAssistantTtsResponse: checked });
  };

  return (
    <div>
      <div className="flex items-center gap-x-1 mb-2">
        <label
          htmlFor="autoSpeak"
          className="block text-sm font-medium text-theme-text-primary"
        >
          {t("customization.chat.auto_speak.title")}
        </label>
        <div
          data-tooltip-id="auto-speak-info"
          data-tooltip-content={t("customization.chat.auto_speak.description")}
          className="cursor-pointer h-fit"
        >
          <Info size={16} weight="bold" className="text-theme-text-primary" />
        </div>
      </div>
      <Toggle
        size="lg"
        enabled={autoPlayAssistantTtsResponse}
        onChange={handleChange}
      />
      <Tooltip
        id="auto-speak-info"
        place="bottom"
        delayShow={300}
        className="allm-tooltip !allm-text-xs"
      />
    </div>
  );
}
