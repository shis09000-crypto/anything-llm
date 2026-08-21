import { useEffect, useMemo, useState } from "react";
import { FullScreenLoader } from "@/components/Preloader";
import System from "@/models/system";
import AccountSettingsApi from "@/pages/UserSettings/AccountSettings/accountSettingsApi";
import {
  buildMobileLoginAccountHint,
  MobileLoginScreen,
  useMobileViewportFrame,
} from "@/components/MobileWeb";
import { getPreferredLocalZkDevice } from "@/utils/zkLoginStorage";
import {
  passkeyCapabilityDescription,
  recordWebAuthnCapabilityFailure,
} from "@/utils/authCapability";
import useAuthCapability from "@/hooks/useAuthCapability";

export default function MobileLoginRoute({
  user,
  onAuthenticated,
  authBootstrap = null,
}) {
  const viewportFrameStyle = useMobileViewportFrame(true);
  const [quickLoginDevice, setQuickLoginDevice] = useState(null);
  const [quickLoginLoading, setQuickLoginLoading] = useState(true);
  const [quickLoginLoadError, setQuickLoginLoadError] = useState(null);
  const [allowPublicRegistration, setAllowPublicRegistration] = useState(false);
  const authCapability = useAuthCapability(authBootstrap?.methods?.passkey);
  const loginAccountHint = useMemo(
    () => buildMobileLoginAccountHint(quickLoginDevice, user),
    [quickLoginDevice, user]
  );

  useEffect(() => {
    let cancelled = false;

    async function loadPreferredDevice() {
      setQuickLoginLoading(true);
      setQuickLoginLoadError(null);
      try {
        const device = await getPreferredLocalZkDevice();
        if (cancelled) return;
        setQuickLoginDevice(device || null);
      } catch (error) {
        if (cancelled) return;
        setQuickLoginDevice(null);
        setQuickLoginLoadError(
          error?.message || "快速登录凭证读取失败，请使用账号密码登录。"
        );
      } finally {
        if (!cancelled) setQuickLoginLoading(false);
      }
    }

    loadPreferredDevice();
    System.registrationConfig().then((config) => {
      setAllowPublicRegistration(Boolean(config?.allowPublicRegistration));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function completeLogin(result, fallbackMessage) {
    if (result?.valid && result?.token && result?.user) {
      onAuthenticated?.(result.user, result.token);
      return { success: true };
    }

    return {
      success: false,
      error: result?.message || result?.error || fallbackMessage,
    };
  }

  async function handleQuickLogin() {
    try {
      const device = quickLoginDevice || (await getPreferredLocalZkDevice());
      if (!device) {
        return {
          success: false,
          error: "当前浏览器没有可用的快速登录凭证。",
        };
      }

      setQuickLoginDevice(device);
      const result = await AccountSettingsApi.loginWithZkDevice(device);
      return completeLogin(result, "快速登录失败，请使用账号密码登录。");
    } catch (error) {
      recordWebAuthnCapabilityFailure(error);
      return {
        success: false,
        error: error?.message || "快速登录凭证读取失败，请使用账号密码登录。",
      };
    }
  }

  async function handlePasswordLogin({ identifier, password }) {
    const result = await System.requestToken({ identifier, password });
    return completeLogin(result, "账号或密码不正确。");
  }

  async function handlePasskeyLogin() {
    if (!authCapability.showPasskey) {
      return {
        success: false,
        error: passkeyCapabilityDescription(authCapability),
      };
    }

    try {
      const result = await AccountSettingsApi.loginWithPasskey();
      return completeLogin(result, "通行密钥登录失败，请重试。");
    } catch (error) {
      return {
        success: false,
        error: error?.message || "通行密钥登录失败，请重试。",
      };
    }
  }

  if (quickLoginLoading) return <FullScreenLoader />;

  return (
    <div
      className="relative w-screen overflow-hidden bg-[#f6f9ff]"
      style={viewportFrameStyle}
    >
      <MobileLoginScreen
        user={user}
        loginAccountHint={loginAccountHint}
        subtitle="手机端登录"
        initialMode={quickLoginDevice ? "quick" : "password"}
        onQuickLogin={handleQuickLogin}
        onPasswordLogin={handlePasswordLogin}
        onPasskeyLogin={handlePasskeyLogin}
        authBootstrap={authBootstrap}
        allowPublicRegistration={allowPublicRegistration}
        onRegistrationSuccess={(result) =>
          completeLogin(result, "注册成功，但自动登录失败，请手动登录。")
        }
      />
      {quickLoginLoadError && !quickLoginDevice ? (
        <div className="pointer-events-none absolute inset-x-6 bottom-6 text-center text-xs font-semibold text-slate-400">
          {quickLoginLoadError}
        </div>
      ) : null}
    </div>
  );
}
