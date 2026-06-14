import { useEffect, useState } from "react";
import Sidebar from "@/components/SettingsSidebar";
import { isMobile } from "react-device-detect";
import * as Skeleton from "react-loading-skeleton";
import "react-loading-skeleton/dist/skeleton.css";
import { EnvelopeSimple } from "@phosphor-icons/react";
import Admin from "@/models/admin";
import InviteRow from "./InviteRow";
import NewInviteModal from "./NewInviteModal";
import { useModal } from "@/hooks/useModal";
import ModalWrapper from "@/components/ModalWrapper";
import showToast from "@/utils/toast";
import AppButton from "@/components/lib/AppButton";
import { useTranslation } from "react-i18next";

export default function AdminInvites() {
  const { isOpen, openModal, closeModal } = useModal();
  const [loading, setLoading] = useState(true);
  const [invites, setInvites] = useState([]);
  const [allowPublicRegistration, setAllowPublicRegistration] = useState(false);
  const [savingRegistration, setSavingRegistration] = useState(false);
  const { t } = useTranslation();

  const fetchInvites = async () => {
    const _invites = await Admin.invites();
    setInvites(_invites);
    setLoading(false);
  };

  const fetchRegistrationSetting = async () => {
    const settings = await Admin.systemPreferences([
      "allow_public_registration",
    ]);
    const enabled = String(settings.allow_public_registration) === "true";
    setAllowPublicRegistration(enabled);
    return enabled;
  };

  const togglePublicRegistration = async () => {
    if (savingRegistration) return;
    const nextValue = !allowPublicRegistration;
    setSavingRegistration(true);
    const result = await Admin.updateSystemPreferences({
      allow_public_registration: String(nextValue),
    });
    if (!result.success) {
      setSavingRegistration(false);
      showToast(t("admin.invites.toasts.updateError"), "error", {
        clear: true,
      });
      return;
    }
    const savedValue = await fetchRegistrationSetting();
    setSavingRegistration(false);
    showToast(
      savedValue
        ? t("admin.invites.toasts.updateEnabled")
        : t("admin.invites.toasts.updateDisabled"),
      "success",
      {
        clear: true,
      }
    );
  };

  useEffect(() => {
    fetchInvites();
    fetchRegistrationSetting();
  }, []);

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll p-4 md:p-0"
      >
        <div className="flex flex-col w-full px-1 md:pl-6 md:pr-[50px] md:py-6 py-16">
          <div className="w-full flex flex-col gap-y-1 pb-6 border-white/10 border-b-2">
            <div className="items-center flex gap-x-4">
              <p className="text-lg leading-6 font-bold text-theme-text-primary">
                {t("admin.invites.title")}
              </p>
            </div>
            <p className="text-xs leading-[18px] font-base text-theme-text-secondary mt-2">
              {t("admin.invites.description")}
            </p>
          </div>
          <div className="mt-5 rounded-2xl border border-theme-sidebar-border bg-theme-bg-primary p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-theme-text-primary">
                {t("admin.invites.publicRegistration.title")}
              </p>
              <p className="mt-1 text-xs leading-5 text-theme-text-secondary">
                {t("admin.invites.publicRegistration.description")}
              </p>
            </div>
            <AppButton
              type="button"
              variant="secondary"
              disabled={savingRegistration}
              onClick={togglePublicRegistration}
            >
              {allowPublicRegistration
                ? t("admin.invites.publicRegistration.disableAction")
                : t("admin.invites.publicRegistration.enableAction")}
            </AppButton>
          </div>
          <div className="w-full justify-end flex">
            <AppButton
              variant="primary"
              leftIcon={<EnvelopeSimple className="h-4 w-4" weight="bold" />}
              onClick={openModal}
              className="mt-3 mr-0 mb-4 md:-mb-12 z-10"
            >
              {t("admin.invites.create")}
            </AppButton>
          </div>
          <div className="overflow-x-auto mt-6">
            {loading ? (
              <Skeleton.default
                height="80vh"
                width="100%"
                highlightColor="var(--theme-bg-primary)"
                baseColor="var(--theme-bg-secondary)"
                count={1}
                className="w-full p-4 rounded-b-2xl rounded-tr-2xl rounded-tl-sm"
                containerClassName="flex w-full"
              />
            ) : (
              <table className="w-full text-xs text-left rounded-lg min-w-[640px] border-spacing-0">
                <thead className="text-theme-text-secondary text-xs leading-[18px] font-bold uppercase border-white/10 border-b">
                  <tr>
                    <th scope="col" className="px-6 py-3 rounded-tl-lg">
                      {t("admin.invites.table.status")}
                    </th>
                    <th scope="col" className="px-6 py-3">
                      {t("admin.invites.table.role")}
                    </th>
                    <th scope="col" className="px-6 py-3">
                      {t("admin.invites.table.acceptedBy")}
                    </th>
                    <th scope="col" className="px-6 py-3">
                      {t("admin.invites.table.createdBy")}
                    </th>
                    <th scope="col" className="px-6 py-3">
                      {t("admin.invites.table.expires")}
                    </th>
                    <th scope="col" className="px-6 py-3">
                      {t("admin.invites.table.created")}
                    </th>
                    <th scope="col" className="px-6 py-3 rounded-tr-lg">
                      {" "}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invites.length === 0 ? (
                    <tr className="bg-transparent text-theme-text-secondary text-sm font-medium">
                      <td colSpan="7" className="px-6 py-4 text-center">
                        {t("admin.invites.noInvitations")}
                      </td>
                    </tr>
                  ) : (
                    invites.map((invite) => (
                      <InviteRow key={invite.id} invite={invite} />
                    ))
                  )}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <ModalWrapper isOpen={isOpen}>
          <NewInviteModal closeModal={closeModal} onSuccess={fetchInvites} />
        </ModalWrapper>
      </div>
    </div>
  );
}
