import React, { useEffect, useState } from "react";
import { X, Copy, Check } from "@phosphor-icons/react";
import Admin from "@/models/admin";
import showToast from "@/utils/toast";
import { useTranslation } from "react-i18next";
import AppButton from "@/components/lib/AppButton";
import { ACCOUNT_ROLES } from "@/utils/authz";

export default function NewInviteModal({ closeModal, onSuccess }) {
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [role, setRole] = useState(ACCOUNT_ROLES.user);
  const [expiresInHours, setExpiresInHours] = useState(24);
  const [creating, setCreating] = useState(false);
  const { t } = useTranslation();

  const handleCreate = async (e) => {
    setError(null);
    e.preventDefault();
    if (creating) return;

    setCreating(true);
    const { invite: newInvite, error } = await Admin.newInvite({
      role,
      expiresInHours,
      workspaceIds: [],
    });
    setCreating(false);
    if (!!newInvite) {
      setInvite(newInvite);
      onSuccess();
      setError(null);
      return;
    }
    setError(error || t("admin.invites.modal.createError"));
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

  const copyInviteLink = () => {
    if (!invite) return false;
    window.navigator.clipboard.writeText(inviteLink(invite));
    setCopied(true);
    showToast(t("admin.invites.modal.copyToast"), "success", {
      clear: true,
    });
  };

  return (
    <div className="relative w-full max-w-2xl bg-theme-bg-secondary rounded-lg shadow border-2 border-theme-modal-border">
      <div className="relative p-6 border-b rounded-t border-theme-modal-border">
        <div className="w-full flex gap-x-2 items-center">
          <h3 className="text-xl font-semibold text-white overflow-hidden overflow-ellipsis whitespace-nowrap">
            {t("admin.invites.modal.title")}
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
            {error && (
              <p className="text-red-400 text-sm">
                {t("admin.common.genericError", { error })}
              </p>
            )}
            {invite && (
              <div className="relative">
                <input
                  type="url"
                  defaultValue={inviteLink(invite)}
                  disabled={true}
                  className="border-none bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg outline-none block w-full p-2.5 pr-10"
                />
                <AppButton
                  type="button"
                  variant="secondary"
                  size="sm"
                  iconOnly
                  onClick={copyInviteLink}
                  disabled={copied}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md hover:bg-theme-modal-border motion-hover"
                  leftIcon={
                    copied ? (
                      <Check
                        size={20}
                        className="text-green-400"
                        weight="bold"
                      />
                    ) : (
                      <Copy size={20} className="text-white" weight="bold" />
                    )
                  }
                />
              </div>
            )}
            <p className="text-white text-opacity-60 text-xs md:text-sm">
              {t("admin.invites.modal.note")}
            </p>
          </div>

          {!invite && (
            <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="flex flex-col gap-2 text-sm font-medium text-white">
                {t("admin.invites.modal.roleLabel")}
                <select
                  value={role}
                  onChange={(event) => setRole(event.target.value)}
                  className="border-none bg-theme-settings-input-bg text-white text-sm rounded-lg outline-none p-2.5"
                >
                  <option value={ACCOUNT_ROLES.user}>
                    {t("admin.invites.modal.role.user", {
                      defaultValue: t("admin.invites.modal.role.default"),
                    })}
                  </option>
                  <option value={ACCOUNT_ROLES.developer}>
                    {t("admin.invites.modal.role.developer", {
                      defaultValue: "Developer",
                    })}
                  </option>
                  <option value={ACCOUNT_ROLES.admin}>
                    {t("admin.invites.modal.role.admin")}
                  </option>
                </select>
              </label>
              <label className="flex flex-col gap-2 text-sm font-medium text-white">
                {t("admin.invites.modal.expiresLabel")}
                <select
                  value={expiresInHours}
                  onChange={(event) =>
                    setExpiresInHours(Number(event.target.value))
                  }
                  className="border-none bg-theme-settings-input-bg text-white text-sm rounded-lg outline-none p-2.5"
                >
                  <option value={24}>
                    {t("admin.invites.modal.expires.24")}
                  </option>
                  <option value={72}>
                    {t("admin.invites.modal.expires.72")}
                  </option>
                  <option value={168}>
                    {t("admin.invites.modal.expires.168")}
                  </option>
                </select>
              </label>
            </div>
          )}

          <div className="flex justify-end items-center mt-6 pt-6 border-t border-theme-modal-border">
            {!invite ? (
              <>
                <AppButton
                  onClick={closeModal}
                  type="button"
                  variant="secondary"
                  className="motion-hover mr-2"
                >
                  {t("admin.invites.modal.cancel")}
                </AppButton>
                <AppButton
                  type="submit"
                  variant="primary"
                  loading={creating}
                  disabled={creating}
                  className="motion-hover"
                >
                  {t("admin.invites.modal.create")}
                </AppButton>
              </>
            ) : (
              <AppButton
                onClick={closeModal}
                type="button"
                variant="secondary"
                className="motion-hover"
              >
                {t("admin.invites.modal.close")}
              </AppButton>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

function inviteLink(invite) {
  const token = invite?.token || "";
  if (invite?.role && invite.role !== ACCOUNT_ROLES.user) {
    return `${window.location.origin}/auth/admin-invite?token=${encodeURIComponent(
      token
    )}`;
  }
  return `${window.location.origin}/accept-invite/${token}`;
}
