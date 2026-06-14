import React, { useState } from "react";
import { X } from "@phosphor-icons/react";
import Admin from "@/models/admin";
import { MessageLimitInput, RoleHintDisplay } from "../..";
import { AUTH_USER } from "@/utils/constants";
import { useTranslation } from "react-i18next";
import AppButton from "@/components/lib/AppButton";
import {
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_PATTERN,
} from "@/utils/username";
import {
  ACCOUNT_ROLES,
  canPromoteOwner,
  isPrimaryOwner,
  normalizeRole,
} from "@/utils/authz";

export default function EditUserModal({ currentUser, user, closeModal }) {
  const [role, setRole] = useState(normalizeRole(user.role));
  const [error, setError] = useState(null);
  const [messageLimit, setMessageLimit] = useState({
    enabled: user.dailyMessageLimit !== null,
    limit: user.dailyMessageLimit || 10,
  });
  const { t } = useTranslation();

  const handleUpdate = async (e) => {
    setError(null);
    e.preventDefault();
    const data = {};
    const form = new FormData(e.target);
    for (var [key, value] of form.entries()) {
      if (!value || value === null) continue;
      data[key] = value;
    }
    if (messageLimit.enabled) {
      data.dailyMessageLimit = messageLimit.limit;
    } else {
      data.dailyMessageLimit = null;
    }

    const { success, error } = await Admin.updateUser(user.id, data);
    if (success) {
      // Update local storage if we're editing our own user
      if (currentUser && currentUser.id === user.id) {
        currentUser.username = data.username;
        currentUser.bio = data.bio;
        currentUser.role = data.role;
        localStorage.setItem(AUTH_USER, JSON.stringify(currentUser));
      }

      window.location.reload();
    }
    setError(error);
  };

  return (
    <div className="fixed inset-0 z-50 overflow-auto bg-black bg-opacity-50 flex items-center justify-center">
      <div className="relative w-full max-w-2xl bg-theme-bg-secondary rounded-lg shadow border-2 border-theme-modal-border">
        <div className="relative p-6 border-b rounded-t border-theme-modal-border">
          <div className="w-full flex gap-x-2 items-center">
            <h3 className="text-xl font-semibold text-white overflow-hidden overflow-ellipsis whitespace-nowrap">
              {t("admin.users.modal.editTitle", { username: user.username })}
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
          <form onSubmit={handleUpdate}>
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="username"
                  className="block mb-2 text-sm font-medium text-white"
                >
                  {t("admin.users.modal.usernameLabel")}
                </label>
                <input
                  name="username"
                  type="text"
                  className="border-none bg-theme-settings-input-bg w-full text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
                  placeholder={t("admin.users.modal.usernamePlaceholder")}
                  defaultValue={user.username}
                  minLength={USERNAME_MIN_LENGTH}
                  maxLength={USERNAME_MAX_LENGTH}
                  pattern={USERNAME_PATTERN}
                  required={true}
                  autoComplete="off"
                />
                <p className="mt-2 text-xs text-white/60">
                  {t("common.username_requirements")}
                </p>
              </div>
              <div>
                <label
                  htmlFor="password"
                  className="block mb-2 text-sm font-medium text-white"
                >
                  {t("admin.users.modal.passwordNewLabel")}
                </label>
                <input
                  name="password"
                  type="text"
                  className="border-none bg-theme-settings-input-bg w-full text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
                  placeholder={t("admin.users.modal.passwordNewPlaceholder", {
                    username: user.username,
                  })}
                  autoComplete="off"
                  minLength={8}
                />
                <p className="mt-2 text-xs text-white/60">
                  {t("admin.users.modal.passwordHint")}
                </p>
              </div>
              <div>
                <label
                  htmlFor="bio"
                  className="block mb-2 text-sm font-medium text-white"
                >
                  {t("admin.users.modal.bioLabel")}
                </label>
                <textarea
                  name="bio"
                  className="border-none bg-theme-settings-input-bg w-full text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
                  placeholder={t("admin.users.modal.bioPlaceholder")}
                  defaultValue={user.bio}
                  autoComplete="off"
                  rows={3}
                />
              </div>
              <div>
                <label
                  htmlFor="role"
                  className="block mb-2 text-sm font-medium text-white"
                >
                  {t("admin.users.modal.roleLabel")}
                </label>
                <select
                  name="role"
                  required={true}
                  defaultValue={normalizeRole(user.role)}
                  onChange={(e) => setRole(e.target.value)}
                  className="border-none bg-theme-settings-input-bg w-full text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
                >
                  <option value={ACCOUNT_ROLES.user}>
                    {t("admin.users.roles.user", {
                      defaultValue: t("admin.users.roles.default"),
                    })}
                  </option>
                  <option value={ACCOUNT_ROLES.developer}>
                    {t("admin.users.roles.developer", {
                      defaultValue: "Developer",
                    })}
                  </option>
                  <option value={ACCOUNT_ROLES.admin}>
                    {t("admin.users.roles.admin")}
                  </option>
                  {canPromoteOwner(currentUser) && !isPrimaryOwner(user) && (
                    <option value={ACCOUNT_ROLES.owner}>
                      {t("admin.users.roles.owner", {
                        defaultValue: "Owner",
                      })}
                    </option>
                  )}
                </select>
                <RoleHintDisplay role={role} />
              </div>
              <MessageLimitInput
                role={role}
                enabled={messageLimit.enabled}
                limit={messageLimit.limit}
                updateState={setMessageLimit}
              />
              {error && (
                <p className="text-red-400 text-sm">
                  {t("admin.common.genericError", { error })}
                </p>
              )}
            </div>
            <div className="flex justify-between items-center mt-6 pt-6 border-t border-theme-modal-border">
              <AppButton
                type="button"
                variant="secondary"
                onClick={closeModal}
                className="motion-hover"
              >
                {t("admin.users.actions.cancel")}
              </AppButton>
              <AppButton
                type="submit"
                variant="primary"
                className="motion-hover"
              >
                {t("admin.users.actions.update")}
              </AppButton>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
