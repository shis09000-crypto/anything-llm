import React, { useEffect, useState } from "react";
import System from "../../../models/system";
import paths from "../../../utils/paths";
import ModalWrapper from "@/components/ModalWrapper";
import { useModal } from "@/hooks/useModal";
import RecoveryCodeModal from "@/components/Modals/DisplayRecoveryCodeModal";
import { useTranslation } from "react-i18next";
import { setAuthToken } from "@/utils/authTokenStorage";

export default function SingleUserAuth() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [downloadComplete, setDownloadComplete] = useState(false);
  const [token, setToken] = useState(null);
  const [customAppName, setCustomAppName] = useState(null);

  const {
    isOpen: isRecoveryCodeModalOpen,
    openModal: openRecoveryCodeModal,
    closeModal: closeRecoveryCodeModal,
  } = useModal();

  const handleLogin = async (e) => {
    setError(null);
    setLoading(true);
    e.preventDefault();
    const data = {};
    const form = new FormData(e.target);
    for (var [key, value] of form.entries()) data[key] = value;
    const { valid, token, message, recoveryCodes } =
      await System.requestToken(data);
    if (valid && !!token) {
      setToken(token);
      if (recoveryCodes) {
        setRecoveryCodes(recoveryCodes);
        openRecoveryCodeModal();
      } else {
        setAuthToken(token);
        window.location = paths.home();
      }
    } else {
      setError(message);
      setLoading(false);
    }
    setLoading(false);
  };

  const handleDownloadComplete = () => {
    setDownloadComplete(true);
  };

  useEffect(() => {
    if (downloadComplete && token) {
      setAuthToken(token);
      window.location = paths.home();
    }
  }, [downloadComplete, token]);

  useEffect(() => {
    const fetchCustomAppName = async () => {
      const { appName } = await System.fetchCustomAppName();
      setCustomAppName(appName || "");
      setLoading(false);
    };
    fetchCustomAppName();
  }, []);

  return (
    <>
      <form
        onSubmit={handleLogin}
        className="flex w-full flex-col items-center justify-center"
      >
        <div className="flex items-start justify-between pb-9">
          <div className="flex items-center flex-col gap-y-[18px] max-w-[300px]">
            <div className="flex gap-x-1">
              <h3 className="block text-center text-3xl font-semibold leading-[28px] text-slate-950 whitespace-nowrap">
                {t("login.multi-user.welcome")}
              </h3>
            </div>
            <p className="text-center text-sm font-medium text-slate-500">
              {t("login.sign-in", {
                appName: customAppName || t("common.productName"),
              })}
            </p>
          </div>
        </div>
        <div className="w-full px-12">
          <div className="w-full flex flex-col gap-y-3">
            <div className="w-full flex flex-col gap-y-2">
              <label className="text-sm font-semibold text-slate-700">
                Password
              </label>
              <input
                name="password"
                type="password"
                className="h-12 w-[300px] rounded-2xl border border-slate-200/80 bg-slate-100/75 p-3 text-sm font-semibold text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-sky-300 focus:bg-white focus:ring-4 focus:ring-sky-400/15"
                required={true}
                autoComplete="off"
              />
            </div>
            {error && <p className="text-red-400 text-sm">Error: {error}</p>}
          </div>
        </div>
        <div className="flex items-center px-12 mt-9 space-x-2 w-full flex-col gap-y-6">
          <button
            disabled={loading}
            type="submit"
            className="h-12 w-full rounded-2xl bg-gradient-to-br from-[#5ab0ff] via-[#007aff] to-[#0066d6] text-sm font-semibold text-white shadow-[0_16px_34px_rgba(0,122,255,0.2)] transition hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading
              ? t("login.multi-user.validating")
              : t("login.multi-user.login")}
          </button>
        </div>
      </form>

      <ModalWrapper isOpen={isRecoveryCodeModalOpen} noPortal={true}>
        <RecoveryCodeModal
          recoveryCodes={recoveryCodes}
          onDownloadComplete={handleDownloadComplete}
          onClose={closeRecoveryCodeModal}
        />
      </ModalWrapper>
    </>
  );
}
