import React, {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  EnvelopeSimple,
  Eye,
  EyeSlash,
  Fingerprint,
  LockKey,
  UserCircle,
} from "@phosphor-icons/react";
import System from "../../../models/system";
import paths from "../../../utils/paths";
import showToast from "@/utils/toast";
import ModalWrapper from "@/components/ModalWrapper";
import { useModal } from "@/hooks/useModal";
import RecoveryCodeModal from "@/components/Modals/DisplayRecoveryCodeModal";
import { t } from "i18next";
import EmailVerificationCodeInput from "@/components/EmailVerificationCodeInput";
import { normalizeEmailInput } from "@/utils/emailInput";
import { emailVerificationErrorMessage } from "@/utils/emailVerificationErrors";
import AccountSettingsApi from "@/pages/UserSettings/AccountSettings/accountSettingsApi";
import AppButton from "@/components/lib/AppButton";
import { detectAuthCapability } from "@/utils/authCapability";
import { getPreferredLocalZkDevice } from "@/utils/zkLoginStorage";
import { setLoginUserActionNow } from "@/utils/userAction";
import { setAuthToken } from "@/utils/authTokenStorage";
import { setStoredAuthUser } from "@/utils/authUserStorage";
import { AuthContext } from "@/AuthContext";
import { useNavigate } from "react-router-dom";
import { markLoginBoot } from "@/utils/loginBootPerf";
import LoginBackground from "./LoginPage/LoginBackground";
import LoginCard from "./LoginPage/LoginCard";
import LoginWelcomeHeader from "./LoginPage/LoginWelcomeHeader";
import "./styles.css";

const REMEMBERED_ACCOUNT_KEY = "athena:login:remembered-account";
const RESET_TOKEN_STORAGE_KEY = "resetToken";

function storePasswordResetToken(resetToken) {
  try {
    window.sessionStorage.setItem(RESET_TOKEN_STORAGE_KEY, resetToken);
    window.localStorage.removeItem(RESET_TOKEN_STORAGE_KEY);
  } catch {}
}

function readPasswordResetToken() {
  try {
    const sessionToken = window.sessionStorage.getItem(RESET_TOKEN_STORAGE_KEY);
    if (sessionToken) return sessionToken;

    const legacyToken = window.localStorage.getItem(RESET_TOKEN_STORAGE_KEY);
    if (legacyToken) {
      window.sessionStorage.setItem(RESET_TOKEN_STORAGE_KEY, legacyToken);
      window.localStorage.removeItem(RESET_TOKEN_STORAGE_KEY);
    }
    return legacyToken;
  } catch {
    return null;
  }
}

function clearPasswordResetToken() {
  try {
    window.sessionStorage.removeItem(RESET_TOKEN_STORAGE_KEY);
    window.localStorage.removeItem(RESET_TOKEN_STORAGE_KEY);
  } catch {}
}

const appleButtonStyle = {
  "--app-button-lg-height": "56px",
  "--app-button-lg-px": "24px",
  "--app-button-lg-font-size": "15px",
  "--app-button-radius": "16px",
  "--app-button-gradient-start": "#2b2b2f",
  "--app-button-gradient-middle": "#17171a",
  "--app-button-gradient-end": "#050506",
  "--app-button-shadow-strength": "0.14",
  "--app-button-glow-blur": "0px",
  "--app-button-hover-lift": "1px",
};

const secondaryAppleButtonStyle = {
  ...appleButtonStyle,
  "--app-button-secondary-text": "#111827",
  "--app-button-secondary-start": "#ffffff",
  "--app-button-secondary-mid": "#ffffff",
  "--app-button-secondary-end": "#f4f5f7",
  "--app-button-secondary-border-alpha": "0.42",
  "--app-button-secondary-shadow-alpha": "0.06",
};

const appleInputClass =
  "h-14 w-full rounded-2xl border border-slate-200 bg-white/90 px-12 text-[15px] text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-[#007AFF]/70 focus:bg-white focus:ring-4 focus:ring-[#007AFF]/10 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500";

const codeInputClass =
  "h-12 w-10 rounded-xl border border-slate-200 bg-white text-center text-lg font-semibold text-slate-950 outline-none transition focus:border-[#007AFF]/70 focus:ring-4 focus:ring-[#007AFF]/10 disabled:cursor-not-allowed disabled:bg-slate-100";

const registrationEmailFormatMessage = "请输入有效邮箱地址，需包含 @ 和域名。";

function normalizeLoginIdentifier(value = "") {
  const normalized = String(value || "")
    .normalize("NFKC")
    .trim();
  if (normalized.includes("@") || normalized.includes("。")) {
    return normalizeEmailInput(normalized);
  }
  return normalized;
}

function isValidRegistrationEmail(email = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

const RecoveryForm = ({ setShowRecoveryForm, onEmailResetToken }) => {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [step, setStep] = useState("request");
  const [loading, setLoading] = useState(false);
  const [codeResetSignal, setCodeResetSignal] = useState(0);
  const [resendRemaining, setResendRemaining] = useState(0);
  const [challengeId, setChallengeId] = useState("");

  useEffect(() => {
    if (resendRemaining <= 0) return;
    const timer = setTimeout(() => {
      setResendRemaining((current) => Math.max(0, current - 1));
    }, 1_000);
    return () => clearTimeout(timer);
  }, [resendRemaining]);

  const handleRequest = async (event) => {
    event.preventDefault();
    if (loading || resendRemaining > 0) return;
    setLoading(true);
    const result = await System.requestEmailPasswordReset(username, email);
    setLoading(false);
    if (!result.success) {
      if (result.resendCooldownSeconds) {
        setResendRemaining(Number(result.resendCooldownSeconds));
      }
      showToast(emailVerificationErrorMessage(t, result), "error", {
        clear: true,
      });
      return;
    }

    showToast(
      result.message || t("login.password-reset.generic-email-sent"),
      "success",
      { clear: true }
    );
    setChallengeId(result.challengeId || "");
    setStep("verify");
    setResendRemaining(Number(result.resendCooldownSeconds) || 60);
  };

  const handleVerify = async (code) => {
    if (loading) return;
    setLoading(true);
    const { success, resetToken, error, errorCode } =
      await System.confirmEmailPasswordReset(
        username,
        email,
        code,
        challengeId
      );
    setLoading(false);

    if (success && resetToken) {
      onEmailResetToken(resetToken);
    } else {
      setCodeResetSignal((current) => current + 1);
      showToast(
        emailVerificationErrorMessage(t, { error, errorCode }),
        "error",
        { clear: true }
      );
    }
  };

  return (
    <form onSubmit={handleRequest} className="w-full space-y-6">
      <AuthSectionHeader
        title={t("login.password-reset.email-title")}
        description={t("login.password-reset.email-description")}
      />
      <div className="space-y-4">
        <AppleInput
          label="账号名"
          name="username"
          type="text"
          icon={<UserCircle className="h-5 w-5" />}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
          disabled={step === "verify"}
          autoComplete="username"
        />
        <AppleInput
          label={t("login.password-reset.verified-email")}
          name="email"
          type="text"
          icon={<EnvelopeSimple className="h-5 w-5" />}
          value={email}
          onChange={(event) =>
            setEmail(normalizeEmailInput(event.target.value))
          }
          required
          inputMode="email"
          disabled={step === "verify"}
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          lang="en"
        />
        {step === "verify" && (
          <div className="space-y-3">
            <label className="block text-sm font-semibold text-slate-700">
              {t("login.password-reset.verification-code")}
            </label>
            <div className="flex justify-center">
              <EmailVerificationCodeInput
                disabled={loading}
                onComplete={handleVerify}
                resetSignal={codeResetSignal}
                inputClassName={codeInputClass}
              />
            </div>
          </div>
        )}
      </div>
      <div className="space-y-4">
        <AppButton
          disabled={loading || resendRemaining > 0}
          loading={loading}
          type="submit"
          size="lg"
          fullWidth
          style={appleButtonStyle}
        >
          {resendRemaining > 0
            ? t("login.password-reset.resend-code-in", {
                seconds: resendRemaining,
              })
            : t("login.password-reset.send-code")}
        </AppButton>
        <AuthTextButton onClick={() => setShowRecoveryForm(false)}>
          {t("login.password-reset.back-to-login")}
        </AuthTextButton>
      </div>
    </form>
  );
};

const ResetPasswordForm = ({ onSubmit }) => {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(newPassword, confirmPassword);
  };

  return (
    <form onSubmit={handleSubmit} className="w-full space-y-6">
      <AuthSectionHeader title="重置密码" description="请输入新的账号密码。" />
      <div className="space-y-4">
        <AppleInput
          label="新密码"
          type="password"
          name="newPassword"
          icon={<LockKey className="h-5 w-5" />}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          autoComplete="new-password"
        />
        <AppleInput
          label="确认新密码"
          type="password"
          name="confirmPassword"
          icon={<LockKey className="h-5 w-5" />}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          autoComplete="new-password"
        />
      </div>
      <AppButton type="submit" size="lg" fullWidth style={appleButtonStyle}>
        重置密码
      </AppButton>
    </form>
  );
};

const RegistrationForm = ({ onBack, onSuccess }) => {
  const [email, setEmail] = useState("");
  const [step, setStep] = useState("email");
  const [loading, setLoading] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [resendRemaining, setResendRemaining] = useState(0);
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [codeResetSignal, setCodeResetSignal] = useState(0);
  const [autoSendAttemptedEmail, setAutoSendAttemptedEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showRegistrationPassword, setShowRegistrationPassword] =
    useState(false);
  const [showRegistrationConfirmPassword, setShowRegistrationConfirmPassword] =
    useState(false);

  useEffect(() => {
    if (resendRemaining <= 0) return;
    const timer = setTimeout(() => {
      setResendRemaining((current) => Math.max(0, current - 1));
    }, 1_000);
    return () => clearTimeout(timer);
  }, [resendRemaining]);

  useEffect(() => {
    if (step !== "email") return;
    const normalizedEmail = normalizeEmailInput(email);
    if (!normalizedEmail) return;

    const timer = setTimeout(() => {
      if (!isValidRegistrationEmail(normalizedEmail)) {
        showToast(registrationEmailFormatMessage, "warning", {
          toastId: "registration-email-format",
        });
      }
    }, 800);

    return () => clearTimeout(timer);
  }, [email, step]);

  useEffect(() => {
    if (step !== "code") return;
    if (!email || autoSendAttemptedEmail === email) return;
    setAutoSendAttemptedEmail(email);
    sendRegistrationCode({ clearToast: true });
  }, [autoSendAttemptedEmail, email, step]);

  async function sendRegistrationCode({ clearToast = false } = {}) {
    if (sendingCode || resendRemaining > 0) return;
    setSendingCode(true);
    const result = await System.requestRegistrationCode({ email });
    setSendingCode(false);
    if (!result.success) {
      showToast(result.error || "无法发送注册验证码。", "error", {
        clear: clearToast,
      });
      return;
    }

    setEmail(result.email || email);
    setChallengeId(result.challengeId || "");
    setCode("");
    setCodeResetSignal((current) => current + 1);
    setResendRemaining(Number(result.resendCooldownSeconds) || 60);
    showToast(result.message || "验证码已发送，请检查邮箱。", "success", {
      clear: clearToast,
    });
  }

  const requestCode = async (event) => {
    event.preventDefault();
    if (loading) return;
    const normalizedEmail = normalizeEmailInput(email);
    if (!isValidRegistrationEmail(normalizedEmail)) {
      showToast(registrationEmailFormatMessage, "warning", { clear: true });
      return;
    }

    setLoading(true);
    const check = await System.checkRegistrationEmail({
      email: normalizedEmail,
    });
    if (!check.success) {
      setLoading(false);
      showToast(check.error || "该邮箱暂时无法注册。", "error", {
        clear: true,
      });
      return;
    }

    setEmail(check.email || normalizedEmail);
    setLoading(false);
    setCode("");
    setChallengeId("");
    setCodeResetSignal((current) => current + 1);
    setResendRemaining(0);
    setAutoSendAttemptedEmail("");
    setStep("code");
  };

  const verifyCode = async (event) => {
    event.preventDefault();
    if (loading) return;
    if (!/^\d{6}$/.test(code)) {
      setCodeResetSignal((current) => current + 1);
      showToast("请输入 6 位邮箱验证码。", "error", { clear: true });
      return;
    }

    setLoading(true);
    const result = await System.verifyRegistrationCode({
      email,
      code,
      challengeId,
    });
    setLoading(false);
    if (!result.success) {
      setCodeResetSignal((current) => current + 1);
      showToast(result.error || "验证码不正确或已过期。", "error", {
        clear: true,
      });
      return;
    }

    setEmail(result.email || email);
    setChallengeId(result.challengeId || challengeId);
    setStep("password");
  };

  const completeRegistration = async (event) => {
    event.preventDefault();
    if (loading) return;
    if (password !== confirmPassword) {
      showToast("两次输入的密码不一致。", "error", { clear: true });
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      setCodeResetSignal((current) => current + 1);
      showToast("请输入 6 位邮箱验证码。", "error", { clear: true });
      return;
    }

    setLoading(true);
    const result = await System.registerAccount({
      email,
      code,
      challengeId,
      password,
      confirmPassword,
    });
    setLoading(false);

    if (result.success && result.token && result.user) {
      showToast("账号已创建。", "success", { clear: true });
      onSuccess(result);
      return;
    }

    setCodeResetSignal((current) => current + 1);
    showToast(result.error || "无法完成注册，请检查信息后重试。", "error", {
      clear: true,
    });
  };

  if (step === "email") {
    return (
      <form onSubmit={requestCode} className="w-full space-y-6">
        <AuthStepBackButton onClick={onBack} />
        <AuthSectionHeader
          title="创建账号"
          description="先确认邮箱并发送验证码。"
        />
        <AppleInput
          label="邮箱"
          name="email"
          type="text"
          icon={<EnvelopeSimple className="h-5 w-5" />}
          placeholder="name@example.com"
          value={email}
          onChange={(event) =>
            setEmail(normalizeEmailInput(event.target.value))
          }
          required
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          lang="en"
        />
        <div className="space-y-4">
          <AppButton
            disabled={loading || resendRemaining > 0}
            loading={loading}
            type="submit"
            size="lg"
            fullWidth
            style={appleButtonStyle}
          >
            {resendRemaining > 0 ? `${resendRemaining} 秒后可重新发送` : "继续"}
          </AppButton>
        </div>
      </form>
    );
  }

  if (step === "code") {
    return (
      <form onSubmit={verifyCode} className="w-full space-y-6">
        <AuthStepBackButton
          onClick={() => {
            setStep("email");
            setCode("");
            setCodeResetSignal((current) => current + 1);
          }}
        />
        <AuthSectionHeader
          title="验证邮箱"
          description="输入发送到该邮箱的 6 位验证码。"
        />
        <div className="space-y-4">
          <AppleInput
            label="邮箱"
            name="email"
            type="text"
            icon={<EnvelopeSimple className="h-5 w-5" />}
            value={email}
            inputMode="email"
            disabled
            readOnly
          />
          <div className="space-y-3">
            <label className="block text-sm font-semibold text-slate-700">
              邮箱验证码
            </label>
            <div className="flex justify-center">
              <EmailVerificationCodeInput
                disabled={loading}
                onComplete={setCode}
                resetSignal={codeResetSignal}
                inputClassName={codeInputClass}
              />
            </div>
          </div>
        </div>
        <AppButton
          disabled={sendingCode || resendRemaining > 0}
          loading={sendingCode}
          type="button"
          variant="secondary"
          size="lg"
          fullWidth
          onClick={() => sendRegistrationCode({ clearToast: true })}
          style={secondaryAppleButtonStyle}
        >
          {resendRemaining > 0
            ? `${resendRemaining} 秒后可重新发送`
            : "发送验证码"}
        </AppButton>
        <AppButton
          disabled={loading || sendingCode}
          loading={loading}
          type="submit"
          size="lg"
          fullWidth
          style={appleButtonStyle}
        >
          验证并继续
        </AppButton>
      </form>
    );
  }

  return (
    <form onSubmit={completeRegistration} className="w-full space-y-6">
      <AuthStepBackButton onClick={() => setStep("code")} />
      <AuthSectionHeader
        title="创建账号"
        description="邮箱已验证，请设置账号密码。"
      />
      <div className="space-y-4">
        <AppleInput
          label="邮箱"
          name="email"
          type="text"
          icon={<EnvelopeSimple className="h-5 w-5" />}
          value={email}
          inputMode="email"
          disabled
          readOnly
        />
        <AppleInput
          label="密码"
          name="password"
          type={showRegistrationPassword ? "text" : "password"}
          icon={<LockKey className="h-5 w-5" />}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
          rightAdornment={
            <PasswordVisibilityButton
              visible={showRegistrationPassword}
              onClick={() => setShowRegistrationPassword((current) => !current)}
            />
          }
        />
        <AppleInput
          label="确认密码"
          name="confirmPassword"
          type={showRegistrationConfirmPassword ? "text" : "password"}
          icon={<LockKey className="h-5 w-5" />}
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
          rightAdornment={
            <PasswordVisibilityButton
              visible={showRegistrationConfirmPassword}
              onClick={() =>
                setShowRegistrationConfirmPassword((current) => !current)
              }
            />
          }
        />
      </div>
      <div className="space-y-4">
        <AppButton
          disabled={loading}
          loading={loading}
          type="submit"
          size="lg"
          fullWidth
          style={appleButtonStyle}
        >
          注册
        </AppButton>
      </div>
    </form>
  );
};

export default function MultiUserAuth({ loginLogo, isCustomLogo = false }) {
  const auth = useContext(AuthContext);
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [downloadComplete, setDownloadComplete] = useState(false);
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [showRecoveryForm, setShowRecoveryForm] = useState(false);
  const [showResetPasswordForm, setShowResetPasswordForm] = useState(false);
  const [authCapability, setAuthCapability] = useState(() =>
    detectAuthCapability()
  );
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [loginIdentifier, setLoginIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [rememberAccount, setRememberAccount] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [trustedDevice, setTrustedDevice] = useState(null);
  const [trustedDeviceLoading, setTrustedDeviceLoading] = useState(false);
  const [loginMode, setLoginMode] = useState("password");
  const [allowPublicRegistration, setAllowPublicRegistration] = useState(false);
  const [showRegisterForm, setShowRegisterForm] = useState(false);

  const {
    isOpen: isRecoveryCodeModalOpen,
    openModal: openRecoveryCodeModal,
    closeModal: closeRecoveryCodeModal,
  } = useModal();

  const completeAuthenticatedLogin = useCallback(
    (user, token) => {
      if (!user || !token) return;
      markLoginBoot("token_received", { userId: user?.id || null });
      if (auth?.actions?.updateUser) {
        auth.actions.updateUser(user, token);
      } else {
        setStoredAuthUser(user);
        setAuthToken(token);
        setLoginUserActionNow();
      }
      navigate(paths.home(), { replace: true });
    },
    [auth?.actions, navigate]
  );

  const handleLogin = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    markLoginBoot("login_submit", { mode: "password" });

    const normalizedIdentifier = normalizeLoginIdentifier(loginIdentifier);
    setLoginIdentifier(normalizedIdentifier);
    persistRememberedAccount(normalizedIdentifier, rememberAccount);

    try {
      const { valid, user, token, recoveryCodes, message } =
        await System.requestToken({
          identifier: normalizedIdentifier,
          password,
        });

      if (valid && !!token && !!user) {
        setUser(user);
        setToken(token);

        if (recoveryCodes) {
          setRecoveryCodes(recoveryCodes);
          openRecoveryCodeModal();
        } else {
          completeAuthenticatedLogin(user, token);
        }
      } else {
        const errorMessage =
          message === "账号已被禁用" ? message : "账号或密码不正确";
        setError(errorMessage);
        showToast(errorMessage, "error", { clear: true });
      }
    } catch {
      setError("账号或密码不正确");
      showToast("账号或密码不正确", "error", { clear: true });
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadComplete = () => setDownloadComplete(true);
  const handleResetPassword = () => {
    setError(null);
    setShowRegisterForm(false);
    setShowRecoveryForm(true);
  };
  const handleRememberChange = (event) => {
    const checked = event.target.checked;
    setRememberAccount(checked);
    if (!checked) window.localStorage.removeItem(REMEMBERED_ACCOUNT_KEY);
  };

  const handlePasskeyLogin = async () => {
    if (!authCapability.showPasskey) {
      return;
    }

    markLoginBoot("login_submit", { mode: "passkey" });
    setError(null);
    setPasskeyLoading(true);
    const result = await AccountSettingsApi.loginWithPasskey().catch(
      (error) => {
        if (isPasskeyCancel(error)) {
          return { valid: false, cancelled: true };
        }
        return { valid: false, message: error.message };
      }
    );
    setPasskeyLoading(false);

    if (result.cancelled) {
      showToast("已取消通行密钥验证。", "info", { clear: true });
      return;
    }

    if (result.valid && result.token && result.user) {
      completeAuthenticatedLogin(result.user, result.token);
      return;
    }

    const message = result.message || "无法验证通行密钥。";
    setError(message);
    showToast(message, "error", { clear: true });
  };

  const handleEmailResetToken = (resetToken) => {
    storePasswordResetToken(resetToken);
    setShowRecoveryForm(false);
    setShowResetPasswordForm(true);
  };

  const handleTrustedDeviceLogin = async () => {
    if (!trustedDevice) return;
    markLoginBoot("login_submit", { mode: "trusted-device" });
    setError(null);
    setTrustedDeviceLoading(true);
    const result = await AccountSettingsApi.loginWithZkDevice(trustedDevice);
    setTrustedDeviceLoading(false);

    if (result.valid && result.token && result.user) {
      completeAuthenticatedLogin(result.user, result.token);
      return;
    }

    const message = result.message || "快速登录失败，请使用密码登录。";
    if (result.resetLocalDevice) {
      setTrustedDevice(null);
      setLoginMode("password");
    }
    setError(message);
    showToast(message, "error", { clear: true });
  };

  const handleResetSubmit = async (newPassword, confirmPassword) => {
    const resetToken = readPasswordResetToken();

    if (resetToken) {
      const { success, error } = await System.resetPassword(
        resetToken,
        newPassword,
        confirmPassword
      );

      if (success) {
        clearPasswordResetToken();
        setShowResetPasswordForm(false);
        showToast("密码已重置。", "success", { clear: true });
      } else {
        showToast(error || "密码重置失败。", "error", { clear: true });
      }
    } else {
      showToast("重置令牌无效，请重新发起找回。", "error", { clear: true });
    }
  };

  const handleRegistrationSuccess = ({ user, token, recoveryCodes }) => {
    if (!user || !token) return;
    setUser(user);
    setToken(token);
    setShowRegisterForm(false);
    if (recoveryCodes) {
      setRecoveryCodes(recoveryCodes);
      openRecoveryCodeModal();
      return;
    }
    completeAuthenticatedLogin(user, token);
  };

  useEffect(() => {
    if (downloadComplete && user && token) {
      completeAuthenticatedLogin(user, token);
    }
  }, [completeAuthenticatedLogin, downloadComplete, user, token]);

  useEffect(() => {
    setAuthCapability(detectAuthCapability());
    const rememberedAccount = window.localStorage.getItem(
      REMEMBERED_ACCOUNT_KEY
    );
    if (rememberedAccount) {
      setLoginIdentifier(rememberedAccount);
      setRememberAccount(true);
    }
    System.registrationConfig().then((config) => {
      setAllowPublicRegistration(Boolean(config?.allowPublicRegistration));
    });
    getPreferredLocalZkDevice()
      .then((device) => {
        if (!device) return;
        setTrustedDevice(device);
        setLoginMode("quick");
        if (device.username) {
          setLoginIdentifier((current) => current || device.username);
        }
      })
      .catch(() => setTrustedDevice(null));
  }, []);

  let contentKey = "login";
  let content = (
    <LoginForm
      loginIdentifier={loginIdentifier}
      setLoginIdentifier={setLoginIdentifier}
      password={password}
      setPassword={setPassword}
      showPassword={showPassword}
      setShowPassword={setShowPassword}
      rememberAccount={rememberAccount}
      handleRememberChange={handleRememberChange}
      loading={loading}
      passkeyLoading={passkeyLoading}
      trustedDevice={trustedDevice}
      trustedDeviceLoading={trustedDeviceLoading}
      loginMode={loginMode}
      setLoginMode={setLoginMode}
      authCapability={authCapability}
      error={error}
      onSubmit={handleLogin}
      onPasskeyLogin={handlePasskeyLogin}
      onTrustedDeviceLogin={handleTrustedDeviceLogin}
      onResetPassword={handleResetPassword}
      allowPublicRegistration={allowPublicRegistration}
      onCreateAccount={() => {
        setError(null);
        setShowRegisterForm(true);
      }}
    />
  );

  if (showRegisterForm && allowPublicRegistration) {
    contentKey = "register";
    content = (
      <RegistrationForm
        onBack={() => setShowRegisterForm(false)}
        onSuccess={handleRegistrationSuccess}
      />
    );
  }

  if (showRecoveryForm) {
    contentKey = "recovery";
    content = (
      <RecoveryForm
        setShowRecoveryForm={setShowRecoveryForm}
        onEmailResetToken={handleEmailResetToken}
      />
    );
  }

  if (showResetPasswordForm) {
    contentKey = "reset-password";
    content = <ResetPasswordForm onSubmit={handleResetSubmit} />;
  }

  return (
    <>
      <SoftLoginShell loginLogo={loginLogo} isCustomLogo={isCustomLogo}>
        <AuthContentTransition transitionKey={contentKey}>
          {content}
        </AuthContentTransition>
      </SoftLoginShell>
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

function AuthContentTransition({ transitionKey, children }) {
  const previousKeyRef = useRef(transitionKey);
  const lastChildrenRef = useRef(children);
  const timersRef = useRef([]);
  const [transitionState, setTransitionState] = useState({
    visible: true,
    entering: true,
    exitingContent: null,
  });

  useEffect(() => {
    if (previousKeyRef.current === transitionKey) return;

    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];

    const exitingContent = {
      key: previousKeyRef.current,
      node: lastChildrenRef.current,
    };
    previousKeyRef.current = transitionKey;

    setTransitionState({
      visible: false,
      entering: false,
      exitingContent,
    });

    timersRef.current.push(
      window.setTimeout(() => {
        setTransitionState({
          visible: false,
          entering: false,
          exitingContent: null,
        });
      }, 155)
    );

    timersRef.current.push(
      window.setTimeout(() => {
        setTransitionState({
          visible: true,
          entering: true,
          exitingContent: null,
        });
      }, 215)
    );

    return () => {
      timersRef.current.forEach((timer) => window.clearTimeout(timer));
      timersRef.current = [];
    };
  }, [transitionKey]);

  useEffect(() => {
    if (!transitionState.exitingContent && transitionState.visible) {
      lastChildrenRef.current = children;
    }
  }, [children, transitionState.exitingContent, transitionState.visible]);

  return (
    <div className="soft-login-content-stage">
      {transitionState.exitingContent && (
        <div
          key={`exit-${transitionState.exitingContent.key}`}
          className="soft-login-content-panel soft-login-content-panel-exit"
          aria-hidden="true"
        >
          {transitionState.exitingContent.node}
        </div>
      )}
      {transitionState.visible && (
        <div
          key={`enter-${transitionKey}`}
          className={`soft-login-content-panel ${
            transitionState.entering ? "soft-login-content-panel-enter" : ""
          }`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function LoginForm({
  loginIdentifier,
  setLoginIdentifier,
  password,
  setPassword,
  showPassword,
  setShowPassword,
  rememberAccount,
  handleRememberChange,
  loading,
  passkeyLoading,
  trustedDevice,
  trustedDeviceLoading,
  loginMode,
  setLoginMode,
  authCapability,
  error,
  onSubmit,
  onPasskeyLogin,
  onTrustedDeviceLogin,
  onResetPassword,
  allowPublicRegistration,
  onCreateAccount,
}) {
  const isTrustedQuickMode = Boolean(trustedDevice && loginMode === "quick");
  const showPasswordForm = !isTrustedQuickMode;

  return (
    <form onSubmit={onSubmit} className="w-full space-y-5">
      <LoginWelcomeHeader />
      {isTrustedQuickMode ? (
        <TrustedDeviceQuickLoginSlot
          device={trustedDevice}
          loading={trustedDeviceLoading}
          onQuickLogin={onTrustedDeviceLogin}
          onUsePassword={() => {
            setLoginMode("password");
            window.requestAnimationFrame(() => {
              document.querySelector('input[name="password"]')?.focus();
            });
          }}
          onUseOtherAccount={() => {
            setLoginMode("password");
            setLoginIdentifier("");
            window.requestAnimationFrame(() => {
              document.querySelector('input[name="identifier"]')?.focus();
            });
          }}
        />
      ) : null}

      {showPasswordForm ? (
        <>
          <div className="space-y-4">
            <AppleInput
              label="账号名 / 邮箱 / 手机号"
              name="identifier"
              type="text"
              icon={<UserCircle className="h-5 w-5" />}
              placeholder="账号名 / 邮箱 / 手机号"
              value={loginIdentifier}
              onChange={(event) =>
                setLoginIdentifier(normalizeLoginIdentifier(event.target.value))
              }
              required
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
            />
            <AppleInput
              label="密码"
              name="password"
              type={showPassword ? "text" : "password"}
              icon={<LockKey className="h-5 w-5" />}
              placeholder="密码"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoComplete="current-password"
              rightAdornment={
                <button
                  type="button"
                  className="flex h-10 w-10 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus:ring-4 focus:ring-[#007AFF]/10"
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  onClick={() => setShowPassword((current) => !current)}
                >
                  {showPassword ? (
                    <EyeSlash className="h-5 w-5" />
                  ) : (
                    <Eye className="h-5 w-5" />
                  )}
                </button>
              }
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-600">
              <input
                type="checkbox"
                checked={rememberAccount}
                onChange={handleRememberChange}
                className="h-4 w-4 rounded border-slate-300 text-[#007AFF] focus:ring-[#007AFF]/30"
              />
              记住账号
            </label>
            <button
              type="button"
              className="text-sm font-medium text-[#007AFF] transition hover:text-[#0056cc]"
              onClick={onResetPassword}
            >
              忘记密码？
            </button>
          </div>

          {error && (
            <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-600">
              {error}
            </div>
          )}

          <AppButton
            disabled={loading}
            loading={loading}
            type="submit"
            size="lg"
            fullWidth
            style={appleButtonStyle}
          >
            登录
          </AppButton>

          {authCapability.showPasskey ? (
            <>
              <div className="flex items-center gap-3 py-1 text-xs font-medium text-slate-400">
                <span className="h-px flex-1 bg-slate-200" />
                或
                <span className="h-px flex-1 bg-slate-200" />
              </div>

              <AppButton
                disabled={passkeyLoading || loading}
                loading={passkeyLoading}
                type="button"
                variant="secondary"
                size="lg"
                fullWidth
                leftIcon={<Fingerprint className="h-5 w-5" />}
                onClick={onPasskeyLogin}
                style={secondaryAppleButtonStyle}
              >
                使用通行密钥登录
              </AppButton>
            </>
          ) : null}

          {allowPublicRegistration ? (
            <div className="pt-1 text-center text-sm font-medium text-slate-500">
              还没有账号？
              <button
                type="button"
                className="ml-1 text-[#007AFF] transition hover:text-[#0056cc]"
                onClick={onCreateAccount}
              >
                创建账号
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <>
          {error && (
            <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-600">
              {error}
            </div>
          )}
        </>
      )}
    </form>
  );
}

function TrustedDeviceQuickLoginSlot({
  device,
  loading = false,
  onQuickLogin,
  onUsePassword,
  onUseOtherAccount,
}) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const accountUsername =
    device.accountUsername ||
    device.username ||
    device.user?.username ||
    "Account";

  useEffect(() => {
    setAvatarFailed(false);
  }, [device?.avatarUrl]);

  if (!device) return null;

  return (
    <div className="min-h-[228px] rounded-[32px] border border-slate-200 bg-slate-50/80 p-6 text-center">
      <div className="mx-auto flex h-20 w-20 items-center justify-center overflow-hidden rounded-full border border-white bg-white text-slate-500 shadow-[0_12px_34px_rgba(15,23,42,0.14)]">
        {device.avatarUrl && !avatarFailed ? (
          <img
            src={device.avatarUrl}
            alt={accountUsername}
            className="h-full w-full object-cover"
            onError={() => setAvatarFailed(true)}
          />
        ) : (
          <UserCircle className="h-12 w-12" />
        )}
      </div>
      <p className="mt-4 text-xl font-semibold text-slate-950">
        {accountUsername}
      </p>
      <p className="mt-2 text-sm font-medium text-slate-500">
        {device.deviceName || "此浏览器"} 已启用快速登录
      </p>
      <div className="mt-4 grid gap-2">
        <AppButton
          type="button"
          size="md"
          fullWidth
          loading={loading}
          disabled={loading}
          onClick={onQuickLogin}
          style={appleButtonStyle}
        >
          快速登录
        </AppButton>
        <div className="mt-0 flex items-center justify-between">
          <button
            type="button"
            className="text-sm font-medium text-[#007AFF] transition hover:text-[#0056cc]"
            onClick={onUsePassword}
          >
            使用密码登录
          </button>
          <button
            type="button"
            className="text-sm font-medium text-slate-500 transition hover:text-slate-800"
            onClick={onUseOtherAccount}
          >
            使用其他账号
          </button>
        </div>
      </div>
    </div>
  );
}

export function SoftLoginShell({ children }) {
  return (
    <div className="soft-login-page text-slate-950">
      <LoginBackground />
      <main className="soft-login-panel">
        <LoginCard>{children}</LoginCard>
        <footer className="soft-login-footer">
          <span>Athena</span>
          <span>Privacy</span>
          <span>Terms</span>
          <span>Version</span>
        </footer>
      </main>
    </div>
  );
}

function AuthSectionHeader({ title, description }) {
  return (
    <div className="text-center">
      <h2 className="text-2xl font-semibold tracking-normal text-slate-950">
        {title}
      </h2>
      <p className="mt-2 text-sm leading-6 text-slate-500">{description}</p>
    </div>
  );
}

function AuthStepBackButton({ onClick }) {
  return (
    <button
      type="button"
      aria-label="返回上一步"
      className="absolute left-6 top-6 flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:bg-slate-50 hover:text-slate-900 focus:outline-none focus:ring-4 focus:ring-[#007AFF]/10 sm:left-8 sm:top-8"
      onClick={onClick}
    >
      <ArrowLeft className="h-5 w-5" />
    </button>
  );
}

function PasswordVisibilityButton({ visible, onClick }) {
  return (
    <button
      type="button"
      className="flex h-10 w-10 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus:ring-4 focus:ring-[#007AFF]/10"
      aria-label={visible ? "隐藏密码" : "显示密码"}
      onClick={onClick}
    >
      {visible ? <EyeSlash className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
    </button>
  );
}

function AppleInput({
  label,
  hideLabel = false,
  icon,
  rightAdornment,
  className = "",
  ...props
}) {
  return (
    <div className="space-y-2">
      <label
        className={
          hideLabel ? "sr-only" : "block text-sm font-semibold text-slate-700"
        }
      >
        {label}
      </label>
      <div className="relative">
        <span className="pointer-events-none absolute left-4 top-1/2 flex -translate-y-1/2 text-slate-400">
          {icon}
        </span>
        <input
          {...props}
          className={`${appleInputClass} ${
            rightAdornment ? "pr-14" : "pr-4"
          } ${className}`}
        />
        {rightAdornment && (
          <span className="absolute right-2 top-1/2 flex -translate-y-1/2">
            {rightAdornment}
          </span>
        )}
      </div>
    </div>
  );
}

function AuthTextButton({ children, onClick }) {
  return (
    <button
      type="button"
      className="mx-auto flex text-sm font-medium text-[#007AFF] transition hover:text-[#0056cc]"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function persistRememberedAccount(username, rememberAccount) {
  if (!rememberAccount) {
    window.localStorage.removeItem(REMEMBERED_ACCOUNT_KEY);
    return;
  }

  const account = String(username || "").trim();
  if (!account) return;
  window.localStorage.setItem(REMEMBERED_ACCOUNT_KEY, account);
}

function isPasskeyCancel(error) {
  return ["AbortError", "NotAllowedError"].includes(error?.name);
}
