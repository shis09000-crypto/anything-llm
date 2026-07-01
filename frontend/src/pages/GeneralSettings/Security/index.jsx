import { useEffect, useState } from "react";
import showToast from "@/utils/toast";
import System from "@/models/system";
import paths from "@/utils/paths";
import { AUTH_TIMESTAMP, LAST_USER_ACTION_AT } from "@/utils/constants";
import { clearSensitiveClientSession } from "@/utils/security/clearSensitiveClientState";
import PreLoader from "@/components/Preloader";
import { useTranslation } from "react-i18next";
import Toggle from "@/components/lib/Toggle";
import {
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_PATTERN,
} from "@/utils/username";
import {
  SoftButton,
  SoftCard,
  SoftSettingsLayout,
} from "@/components/SoftSettings";

export default function GeneralSecurity() {
  const { t } = useTranslation();
  return (
    <SoftSettingsLayout title={t("security.title")}>
      <MultiUserMode />
      <PasswordProtection />
    </SoftSettingsLayout>
  );
}

function MultiUserMode() {
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [useMultiUserMode, setUseMultiUserMode] = useState(false);
  const [multiUserModeEnabled, setMultiUserModeEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const { t } = useTranslation();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setHasChanges(false);
    if (useMultiUserMode) {
      const form = new FormData(e.target);
      const data = {
        username: form.get("username"),
        password: form.get("password"),
      };

      const { success, error } = await System.setupMultiUser(data);
      if (success) {
        showToast("Multi-User mode enabled successfully.", "success");
        setSaving(false);
        setTimeout(() => {
          clearSensitiveClientSession();
          window.localStorage.removeItem(AUTH_TIMESTAMP);
          window.localStorage.removeItem(LAST_USER_ACTION_AT);
          window.location = paths.settings.users();
        }, 2_000);
        return;
      }

      showToast(`Failed to enable Multi-User mode: ${error}`, "error");
      setSaving(false);
      return;
    }
  };

  useEffect(() => {
    async function fetchIsMultiUserMode() {
      setLoading(true);
      const multiUserModeEnabled = await System.isMultiUserMode();
      setMultiUserModeEnabled(multiUserModeEnabled);
      setLoading(false);
    }
    fetchIsMultiUserMode();
  }, []);

  if (loading) {
    return (
      <SoftCard>
        <div className="w-full h-full flex justify-center items-center">
          <PreLoader />
        </div>
      </SoftCard>
    );
  }

  return (
    <form
      id="multi-user-mode-form"
      onSubmit={handleSubmit}
      onChange={() => setHasChanges(true)}
      className="settings-soft-form"
    >
      <SoftCard
        title={t("security.multiuser.title")}
        description={t("security.multiuser.description")}
        actions={
          hasChanges && (
            <SoftButton type="submit" form="multi-user-mode-form">
              {saving ? t("common.saving") : t("common.save")}
            </SoftButton>
          )
        }
      >
        <div className="relative w-full max-h-full">
          <div className="relative rounded-lg">
            <div className="flex items-start justify-between px-6 py-4"></div>
            <div className="space-y-6 flex h-full w-full">
              <div className="w-full flex flex-col gap-y-4">
                {multiUserModeEnabled ? (
                  <p className="text-white text-sm font-semibold">
                    {t("security.multiuser.enable.is-enable")}
                  </p>
                ) : (
                  <Toggle
                    size="lg"
                    className="mb-4"
                    label={t("security.multiuser.enable.enable")}
                    enabled={useMultiUserMode}
                    onChange={(checked) => setUseMultiUserMode(checked)}
                  />
                )}
                {useMultiUserMode && (
                  <div className="w-full flex flex-col gap-y-2 my-5">
                    <div className="w-80">
                      <label
                        htmlFor="username"
                        className="text-sm font-semibold block mb-3 text-[var(--soft-text-primary)]"
                      >
                        {t("security.multiuser.enable.username")}
                      </label>
                      <input
                        name="username"
                        type="text"
                        className="border bg-theme-settings-input-bg text-sm outline-none block w-full p-2.5 placeholder:text-theme-settings-input-placeholder"
                        placeholder="Your admin username"
                        minLength={USERNAME_MIN_LENGTH}
                        maxLength={USERNAME_MAX_LENGTH}
                        pattern={USERNAME_PATTERN}
                        required={true}
                        autoComplete="off"
                        disabled={multiUserModeEnabled}
                        defaultValue={multiUserModeEnabled ? "********" : ""}
                      />
                      <p className="text-[var(--soft-text-secondary)] text-xs mt-2">
                        {t("common.username_requirements")}
                      </p>
                    </div>
                    <div className="mt-4 w-80">
                      <label
                        htmlFor="password"
                        className="text-sm font-semibold block mb-3 text-[var(--soft-text-primary)]"
                      >
                        {t("security.multiuser.enable.password")}
                      </label>
                      <input
                        name="password"
                        type="text"
                        className="border bg-theme-settings-input-bg text-sm outline-none block w-full p-2.5 placeholder:text-theme-settings-input-placeholder"
                        placeholder="Your admin password"
                        minLength={8}
                        required={true}
                        autoComplete="off"
                        defaultValue={multiUserModeEnabled ? "********" : ""}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between space-x-14">
              <p className="text-white text-opacity-80 text-xs rounded-lg w-96">
                {t("security.multiuser.enable.description")}
              </p>
            </div>
          </div>
        </div>
      </SoftCard>
    </form>
  );
}

export const PW_REGEX = new RegExp(/^[a-zA-Z0-9_\-!@$%^&*();]+$/);
function PasswordProtection() {
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [multiUserModeEnabled, setMultiUserModeEnabled] = useState(false);
  const [usePassword, setUsePassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const { t } = useTranslation();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (multiUserModeEnabled) return false;
    const form = new FormData(e.target);

    if (!PW_REGEX.test(form.get("password"))) {
      showToast(
        `Your password has restricted characters in it. Allowed symbols are _,-,!,@,$,%,^,&,*,(,),;`,
        "error"
      );
      setSaving(false);
      return;
    }

    setSaving(true);
    setHasChanges(false);
    const data = {
      usePassword,
      newPassword: form.get("password"),
    };

    const { success, error } = await System.updateSystemPassword(data);
    if (success) {
      showToast("Your page will refresh in a few seconds.", "success");
      setSaving(false);
      setTimeout(() => {
        clearSensitiveClientSession();
        window.localStorage.removeItem(AUTH_TIMESTAMP);
        window.localStorage.removeItem(LAST_USER_ACTION_AT);
        window.location.reload();
      }, 3_000);
      return;
    } else {
      showToast(`Failed to update password: ${error}`, "error");
      setSaving(false);
    }
  };

  useEffect(() => {
    async function fetchIsMultiUserMode() {
      setLoading(true);
      const multiUserModeEnabled = await System.isMultiUserMode();
      const settings = await System.keys();
      setMultiUserModeEnabled(multiUserModeEnabled);
      setUsePassword(settings?.RequiresAuth);
      setLoading(false);
    }
    fetchIsMultiUserMode();
  }, []);

  if (loading) {
    return (
      <SoftCard>
        <div className="w-full h-full flex justify-center items-center">
          <PreLoader />
        </div>
      </SoftCard>
    );
  }

  if (multiUserModeEnabled) return null;
  return (
    <form
      id="password-protection-form"
      onSubmit={handleSubmit}
      onChange={() => setHasChanges(true)}
      className="settings-soft-form"
    >
      <SoftCard
        title={t("security.password.title")}
        description={t("security.password.description")}
        actions={
          hasChanges && (
            <SoftButton type="submit" form="password-protection-form">
              {saving ? t("common.saving") : t("common.save")}
            </SoftButton>
          )
        }
      >
        <div className="relative w-full max-h-full">
          <div className="relative rounded-lg">
            <div className="flex items-start justify-between px-6 py-4"></div>
            <div className="space-y-6 flex h-full w-full">
              <div className="w-full flex flex-col gap-y-4">
                <Toggle
                  size="lg"
                  className="mb-4"
                  label={t("security.password.title")}
                  enabled={usePassword}
                  onChange={(checked) => setUsePassword(checked)}
                />
                {usePassword && (
                  <div className="w-full flex flex-col gap-y-2 my-5">
                    <div className="mt-4 w-80">
                      <label
                        htmlFor="password"
                        className="text-sm font-semibold block mb-3 text-[var(--soft-text-primary)]"
                      >
                        {t("security.password.password-label")}
                      </label>
                      <input
                        name="password"
                        type="text"
                        className="border bg-theme-settings-input-bg text-sm outline-none block w-full p-2.5 placeholder:text-theme-settings-input-placeholder"
                        placeholder="Your Instance Password"
                        minLength={8}
                        required={true}
                        autoComplete="off"
                        defaultValue={usePassword ? "********" : ""}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between space-x-14">
              <p className="text-white text-opacity-80 light:text-theme-text text-xs rounded-lg w-96">
                {t("security.password.description")}
              </p>
            </div>
          </div>
        </div>
      </SoftCard>
    </form>
  );
}
