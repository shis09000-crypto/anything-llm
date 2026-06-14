import React, { useEffect, useState } from "react";
import Invite from "@/models/invite";
import paths from "@/utils/paths";
import { AUTH_TOKEN, AUTH_USER } from "@/utils/constants";
import { useTranslation } from "react-i18next";
import {
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_PATTERN,
} from "@/utils/username";
import { setLoginUserActionNow } from "@/utils/userAction";
import {
  ACCOUNT_ROLES,
  normalizeRole,
  roleLabel as accountRoleLabel,
} from "@/utils/authz";
import EmailVerificationCodeInput from "@/components/EmailVerificationCodeInput";
import { normalizeEmailInput } from "@/utils/emailInput";
import showToast from "@/utils/toast";

export default function NewUserModal({ invite, inviteToken }) {
  const [error, setError] = useState(null);
  const [email, setEmail] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [codeResetSignal, setCodeResetSignal] = useState(0);
  const [resendRemaining, setResendRemaining] = useState(0);
  const [loading, setLoading] = useState(false);
  const { t } = useTranslation();

  useEffect(() => {
    if (resendRemaining <= 0) return;
    const timer = setTimeout(() => {
      setResendRemaining((current) => Math.max(0, current - 1));
    }, 1_000);
    return () => clearTimeout(timer);
  }, [resendRemaining]);

  const requestEmailCode = async () => {
    if (loading || resendRemaining > 0) return;
    setError(null);
    setLoading(true);
    const result = await Invite.requestEmailCode(inviteToken, email);
    setLoading(false);
    if (!result.success) {
      showToast(result.error || "无法发送邮箱验证码。", "error", {
        clear: true,
      });
      return;
    }
    showToast(result.message || "验证码已发送，请检查邮箱。", "success", {
      clear: true,
    });
    setResendRemaining(Number(result.resendCooldownSeconds) || 60);
  };

  const handleCreate = async (e) => {
    setError(null);
    e.preventDefault();
    if (!/^\d{6}$/.test(emailCode)) {
      setCodeResetSignal((current) => current + 1);
      setError("请输入 6 位邮箱验证码。");
      return;
    }
    const data = {};
    const form = new FormData(e.target);
    for (var [key, value] of form.entries()) data[key] = value;
    data.email = email;
    data.emailCode = emailCode;
    setLoading(true);
    const { success, valid, user, token, error } = await Invite.acceptInvite(
      inviteToken,
      data
    );
    setLoading(false);
    if (success && valid && !!token && !!user) {
      window.localStorage.setItem(AUTH_USER, JSON.stringify(user));
      window.localStorage.setItem(AUTH_TOKEN, token);
      setLoginUserActionNow();
      window.location = paths.home();
      return;
    }
    setCodeResetSignal((current) => current + 1);
    setError(error || "无法完成邀请注册，请检查信息后重试。");
  };

  return (
    <div className="relative w-full max-w-2xl max-h-full">
      <div className="relative w-full max-w-2xl bg-theme-bg-secondary rounded-lg shadow border-2 border-theme-modal-border">
        <div className="flex items-start justify-between p-4 border-b rounded-t border-theme-modal-border">
          <h3 className="text-xl font-semibold text-theme-text-primary">
            {normalizeRole(invite?.role) !== ACCOUNT_ROLES.user
              ? "管理员邀请注册"
              : "Create a new account"}
          </h3>
          {invite?.role && (
            <p className="text-sm text-theme-text-secondary mt-2">
              邀请角色：{roleLabel(invite.role)}
            </p>
          )}
        </div>
        <form onSubmit={handleCreate}>
          <div className="p-6 space-y-6 flex h-full w-full">
            <div className="w-full flex flex-col gap-y-4">
              <div>
                <label
                  htmlFor="email"
                  className="block mb-2 text-sm font-medium text-theme-text-primary"
                >
                  邮箱
                </label>
                <div className="flex gap-2">
                  <input
                    name="email"
                    type="email"
                    value={email}
                    onChange={(event) =>
                      setEmail(normalizeEmailInput(event.target.value))
                    }
                    className="border-none bg-theme-settings-input-bg text-theme-text-primary placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
                    placeholder="name@example.com"
                    required={true}
                    autoComplete="email"
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    disabled={loading || resendRemaining > 0}
                    onClick={requestEmailCode}
                    className="shrink-0 motion-hover border border-theme-text-primary px-4 py-2 rounded-lg text-theme-text-primary text-sm hover:bg-theme-text-primary hover:text-theme-bg-primary disabled:opacity-60"
                  >
                    {resendRemaining > 0 ? `${resendRemaining}s` : "发送验证码"}
                  </button>
                </div>
              </div>
              <div>
                <label className="block mb-2 text-sm font-medium text-theme-text-primary">
                  邮箱验证码
                </label>
                <EmailVerificationCodeInput
                  disabled={loading}
                  onComplete={setEmailCode}
                  resetSignal={codeResetSignal}
                />
              </div>
              <div>
                <label
                  htmlFor="username"
                  className="block mb-2 text-sm font-medium text-theme-text-primary"
                >
                  Username
                </label>
                <input
                  name="username"
                  type="text"
                  className="border-none bg-theme-settings-input-bg text-theme-text-primary placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
                  placeholder="My username"
                  minLength={USERNAME_MIN_LENGTH}
                  maxLength={USERNAME_MAX_LENGTH}
                  pattern={USERNAME_PATTERN}
                  required={true}
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
                  Password
                </label>
                <input
                  name="password"
                  type="password"
                  className="border-none bg-theme-settings-input-bg text-theme-text-primary placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
                  placeholder="Your password"
                  required={true}
                  minLength={8}
                  autoComplete="off"
                />
              </div>
              <div>
                <label
                  htmlFor="confirmPassword"
                  className="block mb-2 text-sm font-medium text-theme-text-primary"
                >
                  Confirm Password
                </label>
                <input
                  name="confirmPassword"
                  type="password"
                  className="border-none bg-theme-settings-input-bg text-theme-text-primary placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
                  placeholder="Confirm your password"
                  required={true}
                  minLength={8}
                  autoComplete="off"
                />
              </div>
              {error && <p className="text-red-400 text-sm">Error: {error}</p>}
              <p className="text-theme-text-secondary text-xs md:text-sm">
                After creating your account you will be able to login with these
                credentials and start using workspaces.
              </p>
            </div>
          </div>
          <div className="flex w-full justify-between items-center p-6 space-x-2 border-t rounded-b border-theme-modal-border">
            <button
              type="submit"
              disabled={loading}
              className="w-full motion-hover border border-theme-text-primary px-4 py-2 rounded-lg text-theme-text-primary text-sm items-center flex gap-x-2 hover:bg-theme-text-primary hover:text-theme-bg-primary focus:ring-gray-800 text-center justify-center"
            >
              {loading ? "Submitting..." : "Accept Invitation"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function roleLabel(role) {
  return accountRoleLabel(role);
}
