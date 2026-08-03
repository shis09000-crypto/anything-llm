import React, { useEffect, useState } from "react";
import { Eye, EyeSlash, LockKey } from "@phosphor-icons/react";
import System from "../../../models/system";
import paths from "../../../utils/paths";
import ModalWrapper from "@/components/ModalWrapper";
import { useModal } from "@/hooks/useModal";
import RecoveryCodeModal from "@/components/Modals/DisplayRecoveryCodeModal";
import { useTranslation } from "react-i18next";
import { setAuthToken } from "@/utils/authTokenStorage";
import { consumeAuthReturnRef } from "@/utils/authLifecycleCoordinator";

export default function SingleUserAuth() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [downloadComplete, setDownloadComplete] = useState(false);
  const [token, setToken] = useState(null);
  const [customAppName, setCustomAppName] = useState(null);
  const [showPassword, setShowPassword] = useState(false);

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
        window.location.replace(consumeAuthReturnRef() || paths.home());
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
      window.location.replace(consumeAuthReturnRef() || paths.home());
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
        <div className="flex items-start justify-between pb-8">
          <div className="flex items-center flex-col gap-y-[18px] max-w-[300px]">
            <div className="flex gap-x-1">
              <h3 className="block whitespace-nowrap text-center text-2xl font-semibold leading-tight text-slate-950">
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
        <div className="w-full">
          <div className="w-full flex flex-col gap-y-3">
            <div className="w-full flex flex-col gap-y-2">
              <label className="text-sm font-semibold text-slate-700">
                Password
              </label>
              <div className="relative">
                <LockKey className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
                <input
                  name="password"
                  type={showPassword ? "text" : "password"}
                  className="h-14 w-full rounded-2xl border border-slate-200 bg-white/85 px-12 pr-14 text-[15px] text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-slate-400 focus:bg-white focus:ring-4 focus:ring-slate-900/5"
                  required={true}
                  autoComplete="current-password"
                  autoFocus
                />
                <button
                  type="button"
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  className="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus:ring-4 focus:ring-slate-900/5"
                  onClick={() => setShowPassword((current) => !current)}
                >
                  {showPassword ? (
                    <EyeSlash className="h-5 w-5" />
                  ) : (
                    <Eye className="h-5 w-5" />
                  )}
                </button>
              </div>
            </div>
            {error && (
              <div
                role="alert"
                className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-600"
              >
                {error}
              </div>
            )}
          </div>
        </div>
        <div className="mt-7 flex w-full flex-col items-center gap-y-6">
          <button
            disabled={loading}
            type="submit"
            className="soft-login-primary-button h-14 w-full rounded-2xl border border-white/20 bg-slate-950 text-[15px] font-semibold text-white shadow-[0_14px_30px_rgba(15,23,42,0.16)] transition hover:-translate-y-px hover:bg-black focus:outline-none focus:ring-4 focus:ring-slate-900/10 disabled:cursor-not-allowed disabled:opacity-55"
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
