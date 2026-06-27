import { useEffect, useState } from "react";
import { EnvelopeSimple, Phone } from "@phosphor-icons/react";
import EmailVerificationCodeInput from "@/components/EmailVerificationCodeInput";
import { AUTH_USER } from "@/utils/constants";
import { safeJsonParse } from "@/utils/request";
import { normalizeEmailInput } from "@/utils/emailInput";
import { emailVerificationErrorMessage } from "@/utils/emailVerificationErrors";
import showToast from "@/utils/toast";
import { useTranslation } from "react-i18next";
import AppButton from "@/components/lib/AppButton";
import AccountSettingRow from "./AccountSettingRow";
import AccountSettingsApi from "./accountSettingsApi";
import { useAccountSettingsData } from "./AccountSettingsDataProvider";

export default function ContactMethodsCard({ user, onUserUpdated }) {
  const { t } = useTranslation();
  const accountSettingsData = useAccountSettingsData();
  const [emailStatus, setEmailStatus] = useState({
    email: user?.email || "",
    verified: Boolean(user?.email && user?.email_verified_at),
    verifiedAt: user?.email_verified_at || null,
    pendingEmail: "",
  });
  const [emailDraft, setEmailDraft] = useState(user?.email || "");
  const [emailStep, setEmailStep] = useState("request");
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailEditMode, setEmailEditMode] = useState(
    !(user?.email && user?.email_verified_at)
  );
  const [emailCodeResetSignal, setEmailCodeResetSignal] = useState(0);
  const [emailResendRemaining, setEmailResendRemaining] = useState(0);

  useEffect(() => {
    let mounted = true;
    const loadEmailStatus =
      accountSettingsData?.loadEmailStatus || AccountSettingsApi.emailStatus;
    loadEmailStatus().then((result) => {
      if (!mounted || !result.success) return;
      const nextStatus = {
        email: result.email || "",
        verified: Boolean(result.verified),
        verifiedAt: result.verifiedAt || null,
        pendingEmail: result.pendingEmail || "",
      };
      setEmailStatus(nextStatus);
      setEmailDraft(nextStatus.pendingEmail || nextStatus.email || "");
      setEmailStep(nextStatus.pendingEmail ? "verify" : "request");
      setEmailEditMode(
        Boolean(nextStatus.pendingEmail || !nextStatus.verified)
      );
    });
    return () => {
      mounted = false;
    };
  }, [accountSettingsData]);

  useEffect(() => {
    if (emailResendRemaining <= 0) return;
    const timer = setTimeout(() => {
      setEmailResendRemaining((current) => Math.max(0, current - 1));
    }, 1_000);
    return () => clearTimeout(timer);
  }, [emailResendRemaining]);

  function startEmailEdit() {
    setEmailEditMode(true);
    setEmailDraft("");
    setEmailStep("request");
    setEmailResendRemaining(0);
    setEmailCodeResetSignal((current) => current + 1);
  }

  async function requestEmailCode() {
    if (emailLoading || emailResendRemaining > 0) return;
    if (!emailDraft) {
      showToast("邮箱不能为空。", "error", { clear: true });
      return;
    }

    setEmailLoading(true);
    const result = await AccountSettingsApi.requestEmailVerification({
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
    showToast("验证码已发送。", "success", { clear: true });
  }

  async function confirmEmailCode(code) {
    if (emailLoading) return;
    setEmailLoading(true);
    const result = await AccountSettingsApi.confirmEmailVerification({
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

    const storedUser = safeJsonParse(localStorage.getItem(AUTH_USER), null);
    const nextUser = {
      ...(storedUser || user),
      email: result.email,
      email_verified_at: result.verifiedAt,
    };
    localStorage.setItem(AUTH_USER, JSON.stringify(nextUser));
    onUserUpdated?.(nextUser);
    showToast("邮箱已验证。", "success", { clear: true });
  }

  const showEmailEditor =
    !emailStatus.verified || Boolean(emailStatus.pendingEmail) || emailEditMode;

  return (
    <section id="contact" className="account-card">
      <CardHeader
        title="联系方式"
        subtitle="管理用于登录、找回密码和通知的联系方式。"
      />
      <div className="divide-y divide-slate-100">
        <AccountSettingRow
          icon={<EnvelopeSimple className="h-5 w-5" />}
          title="绑定邮箱"
          subtitle={emailLabel(emailStatus)}
          status={<EmailStatusBadge status={emailStatus} />}
          action={
            <AppButton
              size="sm"
              variant={showEmailEditor ? "primary" : "secondary"}
              type="button"
              onClick={showEmailEditor ? requestEmailCode : startEmailEdit}
              disabled={
                showEmailEditor && (emailLoading || emailResendRemaining > 0)
              }
            >
              {!showEmailEditor
                ? "更换"
                : emailLoading
                  ? "处理中..."
                  : emailResendRemaining > 0
                    ? `${emailResendRemaining}s`
                    : emailStep === "verify"
                      ? "重发"
                      : emailStatus.verified
                        ? "发送验证码"
                        : "绑定"}
            </AppButton>
          }
        >
          {showEmailEditor && (
            <div className="mt-4 grid gap-3">
              <input
                type="email"
                value={emailDraft}
                onChange={(event) => {
                  setEmailDraft(normalizeEmailInput(event.target.value));
                  setEmailStep("request");
                }}
                placeholder="noreply@example.com"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                className="h-11 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm text-slate-950 outline-none focus:border-sky-400"
              />
              {emailStep === "verify" ? (
                <EmailVerificationCodeInput
                  disabled={emailLoading}
                  onComplete={confirmEmailCode}
                  resetSignal={emailCodeResetSignal}
                  inputClassName="h-10 w-9 rounded-xl border border-slate-200 bg-white text-center text-base font-semibold text-slate-950 outline-none focus:border-sky-400"
                />
              ) : (
                <p className="text-xs leading-5 text-slate-500">
                  修改邮箱必须通过验证码确认，不会随普通个人资料自动保存。
                </p>
              )}
            </div>
          )}
        </AccountSettingRow>
        <AccountSettingRow
          icon={<Phone className="h-5 w-5" />}
          title="绑定电话"
          subtitle="未绑定电话号码"
          status={<span className="font-semibold text-slate-400">未绑定</span>}
          action={
            <AppButton size="sm" variant="secondary" type="button">
              添加电话号码
            </AppButton>
          }
        />
      </div>
    </section>
  );
}

export function CardHeader({ title, subtitle }) {
  return (
    <div className="mb-2 flex flex-col gap-1 px-1 pb-3">
      <h2 className="text-lg font-semibold text-slate-950">{title}</h2>
      {subtitle && (
        <p className="text-sm leading-5 text-slate-500">{subtitle}</p>
      )}
    </div>
  );
}

function EmailStatusBadge({ status }) {
  if (status.verified) {
    return <span className="font-semibold text-emerald-600">已验证</span>;
  }
  if (status.pendingEmail) {
    return <span className="font-semibold text-amber-600">待验证</span>;
  }
  return <span className="font-semibold text-slate-400">未绑定</span>;
}

function emailLabel(status) {
  if (status.verified) return status.email;
  if (status.pendingEmail) return status.pendingEmail;
  return "未绑定邮箱";
}
