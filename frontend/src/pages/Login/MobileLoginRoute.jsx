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
  AUTH_CAPABILITY_STATUS,
  passkeyCapabilityDescription,
  recordWebAuthnCapabilityFailure,
} from "@/utils/authCapability";
import useAuthCapability from "@/hooks/useAuthCapability";
import { Fingerprint } from "@phosphor-icons/react";

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
  const [deviceRecovery, setDeviceRecovery] = useState(null);
  const [deviceRecoveryError, setDeviceRecoveryError] = useState(null);
  const [deviceRecoveryLoading, setDeviceRecoveryLoading] = useState(false);
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
    if (
      result?.nextAction === "device_identity_reauth" &&
      result?.recoveryTicket
    ) {
      setDeviceRecovery({
        recoveryTicket: result.recoveryTicket,
      });
      return { success: false, error: null };
    }
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
      const result = await AccountSettingsApi.loginWithPasskey({
        deviceRecovery,
      });
      if (result?.valid) setDeviceRecovery(null);
      if (
        result?.nextAction === "device_identity_reauth" &&
        result?.recoveryTicket
      ) {
        setDeviceRecovery({
          recoveryTicket: result.recoveryTicket,
        });
        return { success: false, error: null };
      }
      return completeLogin(result, "通行密钥登录失败，请重试。");
    } catch (error) {
      return {
        success: false,
        error: error?.message || "通行密钥登录失败，请重试。",
      };
    }
  }

  async function handleDeviceRecoveryPasskey() {
    setDeviceRecoveryLoading(true);
    setDeviceRecoveryError(null);
    try {
      const result = await handlePasskeyLogin();
      if (!result?.success) {
        setDeviceRecoveryError(
          result?.error || "通行密钥确认失败，请重新验证。"
        );
      }
    } finally {
      setDeviceRecoveryLoading(false);
    }
  }

  if (quickLoginLoading) return <FullScreenLoader />;

  if (deviceRecovery) {
    return (
      <div
        className="flex w-screen items-center justify-center overflow-hidden bg-[#f6f9ff] px-6"
        style={viewportFrameStyle}
      >
        <div className="w-full max-w-md rounded-[28px] border border-white/70 bg-white/85 p-6 shadow-xl backdrop-blur-xl">
          <h1 className="text-2xl font-bold text-slate-950">确认此设备身份</h1>
          <p className="mt-3 text-sm leading-6 text-slate-500">
            密码已经验证。请使用通行密钥确认，成功后系统才会载入工作区。
          </p>
          {deviceRecoveryError ? (
            <div className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-600">
              {deviceRecoveryError}
            </div>
          ) : null}
          {authCapability.status === AUTH_CAPABILITY_STATUS.CHECKING ? (
            <p className="mt-6 text-center text-sm text-slate-500">
              正在检查当前设备的通行密钥能力…
            </p>
          ) : authCapability.showPasskey ? (
            <button
              type="button"
              disabled={deviceRecoveryLoading}
              onClick={handleDeviceRecoveryPasskey}
              className="mt-6 flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-slate-950 font-semibold text-white disabled:opacity-50"
            >
              <Fingerprint size={21} />
              {authCapability.status === AUTH_CAPABILITY_STATUS.LOCAL_READY
                ? "使用通行密钥确认"
                : "使用其他设备或安全密钥"}
            </button>
          ) : (
            <p className="mt-6 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-700">
              {passkeyCapabilityDescription(authCapability)}{" "}
              请改用支持通行密钥的安全设备。
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              setDeviceRecovery(null);
              setDeviceRecoveryError(null);
            }}
            className="mt-4 w-full text-sm font-semibold text-slate-500"
          >
            返回登录
          </button>
        </div>
      </div>
    );
  }

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
