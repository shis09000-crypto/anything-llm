import { useEffect, useState } from "react";
import * as Skeleton from "react-loading-skeleton";
import "react-loading-skeleton/dist/skeleton.css";
import { PlusCircle } from "@phosphor-icons/react";
import Admin from "@/models/admin";
import ApiKeyRow from "./ApiKeyRow";
import NewApiKeyModal from "./NewApiKeyModal";
import paths from "@/utils/paths";
import { userFromStorage } from "@/utils/request";
import System from "@/models/system";
import ModalWrapper from "@/components/ModalWrapper";
import { useModal } from "@/hooks/useModal";
import { useTranslation } from "react-i18next";
import {
  SoftButton,
  SoftCard,
  SoftSettingsLayout,
} from "@/components/SoftSettings";

export default function AdminApiKeys() {
  const { isOpen, openModal, closeModal } = useModal();
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [apiKeys, setApiKeys] = useState([]);

  const fetchExistingKeys = async (isActive = () => true) => {
    const user = userFromStorage();
    const Model = !!user ? Admin : System;
    const { apiKeys: foundKeys } = await Model.getApiKeys();
    if (!isActive()) return;
    setApiKeys(foundKeys);
    setLoading(false);
  };

  useEffect(() => {
    let active = true;
    fetchExistingKeys(() => active);
    return () => {
      active = false;
    };
  }, []);

  const removeApiKey = (id) => {
    setApiKeys((prevKeys) => prevKeys.filter((apiKey) => apiKey.id !== id));
  };

  return (
    <SoftSettingsLayout
      title={t("api.title")}
      description={t("api.description")}
      actions={
        <SoftButton onClick={openModal}>
          <PlusCircle className="h-4 w-4" weight="bold" />
          {t("api.generate")}
        </SoftButton>
      }
    >
      <a
        href={paths.apiDocs()}
        target="_blank"
        rel="noreferrer"
        className="w-fit text-xs font-semibold leading-[18px] text-[#2152ff] hover:underline"
      >
        {t("api.link")} &rarr;
      </a>
      <SoftCard className="p-0">
        <div className="settings-soft-table-card">
          {loading ? (
            <Skeleton.default
              height="80vh"
              width="100%"
              highlightColor="var(--soft-control-hover)"
              baseColor="var(--soft-card)"
              count={1}
              className="w-full p-4 rounded-2xl"
              containerClassName="flex w-full"
            />
          ) : (
            <table className="settings-soft-table min-w-[720px] text-left text-xs">
              <thead>
                <tr>
                  <th scope="col" className="px-6 py-3 rounded-tl-lg">
                    {t("api.table.name")}
                  </th>
                  <th scope="col" className="px-6 py-3">
                    {t("api.table.key")}
                  </th>
                  <th scope="col" className="px-6 py-3">
                    {t("api.table.by")}
                  </th>
                  <th scope="col" className="px-6 py-3">
                    {t("api.table.created")}
                  </th>
                  <th scope="col" className="px-6 py-3 rounded-tr-lg">
                    {t("api.actions")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {apiKeys.length === 0 ? (
                  <tr className="bg-transparent text-theme-text-secondary text-sm font-medium">
                    <td colSpan="5" className="px-6 py-4 text-center">
                      {t("api.empty")}
                    </td>
                  </tr>
                ) : (
                  apiKeys.map((apiKey) => (
                    <ApiKeyRow
                      key={apiKey.id}
                      apiKey={apiKey}
                      removeApiKey={removeApiKey}
                    />
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      </SoftCard>
      <ModalWrapper isOpen={isOpen}>
        <NewApiKeyModal closeModal={closeModal} onSuccess={fetchExistingKeys} />
      </ModalWrapper>
    </SoftSettingsLayout>
  );
}
