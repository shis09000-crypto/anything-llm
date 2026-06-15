import System from "@/models/system";
import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";
import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import {
  client as opaqueClient,
  ready as opaqueReady,
} from "@serenity-kit/opaque";
import { detectAuthCapability } from "@/utils/authCapability";
import {
  clearLocalZkDevices,
  createLocalZkDevice,
  readLocalZkDeviceSecret,
  removeLocalZkDevice,
  saveLocalZkDevice,
  updateLocalZkDevice,
} from "@/utils/zkLoginStorage";

const now = new Date();

export const mockPasskeys = [
  {
    id: "passkey-macbook-pro",
    deviceName: "MacBook Pro",
    createdAt: "2026-05-18T09:20:00.000Z",
    lastUsedAt: "2026-06-12T08:40:00.000Z",
  },
  {
    id: "passkey-iphone",
    deviceName: "iPhone",
    createdAt: "2026-04-22T13:12:00.000Z",
    lastUsedAt: "2026-06-10T21:05:00.000Z",
  },
  {
    id: "passkey-ipad",
    deviceName: "iPad",
    createdAt: "2026-03-04T16:30:00.000Z",
    lastUsedAt: "2026-05-29T10:18:00.000Z",
  },
];

export const mockSessions = [
  {
    id: "current-device",
    deviceName: "当前设备",
    browser: "Chrome on macOS",
    ip: "127.0.0.1",
    lastActiveAt: now.toISOString(),
    current: true,
  },
];

const AccountSettingsApi = {
  emailStatus: () => System.emailVerificationStatus(),
  requestEmailVerification: ({ email }) =>
    System.requestEmailVerification({ email }),
  confirmEmailVerification: ({ email, code }) =>
    System.confirmEmailVerification({ email, code }),
  updateProfile: ({ displayName, bio }) =>
    System.updateUser({ displayName, bio }),
  updatePassword: ({ currentPassword, password }) =>
    System.updateUser({ currentPassword, password }),
  fetchProfilePicture: (userId) => System.fetchPfp(userId),
  uploadProfilePicture: (formData) => System.uploadPfp(formData),
  removeProfilePicture: () => System.removePfp(),
  passkeysSupported: () => detectAuthCapability().showPasskey,
  fetchPasskeys: async () => {
    return fetch(`${API_BASE}/auth/passkeys`, {
      headers: baseHeaders(),
    })
      .then(safePasskeyJson)
      .then((res) => ({
        success: res?.success,
        passkeys: res?.passkeys || [],
        risk: res?.risk || null,
        error: res?.error || null,
      }))
      .catch((error) => ({
        success: false,
        passkeys: [],
        error:
          error?.message === "Failed to fetch"
            ? "无法读取通行密钥。"
            : error?.message || "无法读取通行密钥。",
      }));
  },
  addPasskey: async () => {
    if (!detectAuthCapability().showPasskey) {
      return {
        success: false,
        error: "当前浏览器不支持通行密钥。",
      };
    }

    const optionsResponse = await fetch(
      `${API_BASE}/auth/passkeys/register/options`,
      {
        method: "POST",
        headers: baseHeaders(),
      }
    ).then(safePasskeyJson);
    if (!optionsResponse?.success) {
      return {
        success: false,
        error: optionsResponse?.error || "Could not start passkey setup.",
      };
    }

    const response = await startRegistration({
      optionsJSON: optionsResponse.options,
    });
    return fetch(`${API_BASE}/auth/passkeys/register/verify`, {
      method: "POST",
      headers: {
        ...baseHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        response,
        ...deviceDescriptor(),
      }),
    })
      .then(safePasskeyJson)
      .catch((error) => ({ success: false, error: error.message }));
  },
  deletePasskey: async (id, { confirmRisk = false } = {}) => {
    return fetch(`${API_BASE}/auth/passkeys/${id}`, {
      method: "DELETE",
      headers: {
        ...baseHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirmRisk }),
    })
      .then(safePasskeyJson)
      .catch((error) => ({ success: false, error: error.message }));
  },
  fetchTrustedLoginDevices: async () => {
    return fetch(`${API_BASE}/auth/zk-login/devices`, {
      headers: baseHeaders(),
    })
      .then(safePasskeyJson)
      .catch((error) => ({
        success: false,
        devices: [],
        error: error.message,
      }));
  },
  rememberTrustedDeviceAvatar: async ({ devices = [], avatarUrl } = {}) => {
    const durableAvatarUrl = await durableAvatarDataUrl(avatarUrl);
    if (!durableAvatarUrl) return;
    await Promise.all(
      devices
        .filter((device) => device?.deviceId)
        .map((device) =>
          updateLocalZkDevice(device.deviceId, { avatarUrl: durableAvatarUrl })
        )
    );
  },
  reauthZkWithPassword: async ({ currentPassword }) => {
    return fetch(`${API_BASE}/auth/zk-login/reauth/password`, {
      method: "POST",
      headers: {
        ...baseHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ currentPassword }),
    })
      .then(safePasskeyJson)
      .catch((error) => ({ success: false, error: error.message }));
  },
  reauthZkWithPasskey: async () => {
    if (!detectAuthCapability().showPasskey) {
      return {
        success: false,
        error: "当前浏览器不支持通行密钥验证。",
      };
    }

    const optionsResponse = await fetch(
      `${API_BASE}/auth/zk-login/reauth/passkey/options`,
      {
        method: "POST",
        headers: baseHeaders(),
      }
    ).then(safePasskeyJson);
    if (!optionsResponse?.success) return optionsResponse;

    const response = await startAuthentication({
      optionsJSON: optionsResponse.options,
    });
    return fetch(`${API_BASE}/auth/zk-login/reauth/passkey/verify`, {
      method: "POST",
      headers: {
        ...baseHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ response }),
    })
      .then(safePasskeyJson)
      .catch((error) => ({ success: false, error: error.message }));
  },
  enableTrustedLoginDevice: async ({ user, reauthToken, avatarUrl } = {}) => {
    if (!user?.id || !reauthToken) {
      return { success: false, error: "请先完成安全验证。" };
    }

    const durableAvatarUrl = await durableAvatarDataUrl(avatarUrl);
    const localDevice = await createLocalZkDevice({
      user,
      avatarUrl: durableAvatarUrl,
    });
    await opaqueReady;
    const { clientRegistrationState, registrationRequest } =
      opaqueClient.startRegistration({
        password: localDevice.deviceSecret,
      });

    const startResponse = await fetch(
      `${API_BASE}/auth/zk-login/enroll/start`,
      {
        method: "POST",
        headers: {
          ...baseHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reauthToken,
          deviceId: localDevice.deviceId,
          deviceName: localDevice.metadata.deviceName,
          deviceSalt: localDevice.deviceSalt,
          registrationRequest,
        }),
      }
    ).then(safePasskeyJson);
    if (!startResponse?.success) return startResponse;

    const { registrationRecord } = opaqueClient.finishRegistration({
      clientRegistrationState,
      registrationResponse: startResponse.registrationResponse,
      password: localDevice.deviceSecret,
      identifiers: opaqueIdentifiers(localDevice.deviceId),
    });

    const finishResponse = await fetch(
      `${API_BASE}/auth/zk-login/enroll/finish`,
      {
        method: "POST",
        headers: {
          ...baseHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reauthToken,
          deviceId: localDevice.deviceId,
          deviceName: localDevice.metadata.deviceName,
          deviceSalt: localDevice.deviceSalt,
          registrationRecord,
        }),
      }
    ).then(safePasskeyJson);
    if (!finishResponse?.success) return finishResponse;

    await saveLocalZkDevice({
      metadata: {
        ...localDevice.metadata,
        ...finishResponse.device,
        username: user.username || localDevice.metadata.username,
        displayName:
          user.displayName || localDevice.metadata.displayName || null,
        avatarUrl: durableAvatarUrl || localDevice.metadata.avatarUrl,
      },
      deviceSecret: localDevice.deviceSecret,
    });
    return finishResponse;
  },
  revokeTrustedLoginDevice: async (id, { deviceId } = {}) => {
    const result = await fetch(`${API_BASE}/auth/zk-login/devices/${id}`, {
      method: "DELETE",
      headers: baseHeaders(),
    })
      .then(safePasskeyJson)
      .catch((error) => ({ success: false, error: error.message }));
    if (result?.success && deviceId) await removeLocalZkDevice(deviceId);
    return result;
  },
  loginWithZkDevice: async (device) => {
    const deviceSecret = await readLocalZkDeviceSecret(device?.deviceId);
    if (!device?.userId || !device?.deviceId || !deviceSecret) {
      return {
        valid: false,
        message: "当前浏览器没有可用的快速登录凭证。",
      };
    }

    await opaqueReady;
    const { clientLoginState, startLoginRequest } = opaqueClient.startLogin({
      password: deviceSecret,
    });
    const startResponse = await fetch(`${API_BASE}/auth/zk-login/login/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: device.userId,
        deviceId: device.deviceId,
        startLoginRequest,
      }),
    }).then(safePasskeyJson);
    if (!startResponse?.success) {
      return {
        valid: false,
        message: startResponse?.error || "快速登录暂不可用。",
      };
    }

    const { finishLoginRequest } = opaqueClient.finishLogin({
      clientLoginState,
      loginResponse: startResponse.loginResponse,
      password: deviceSecret,
      identifiers: opaqueIdentifiers(device.deviceId),
    });
    const result = await fetch(`${API_BASE}/auth/zk-login/login/finish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        loginAttemptId: startResponse.loginAttemptId,
        finishLoginRequest,
      }),
    })
      .then(safePasskeyJson)
      .catch((error) => ({ valid: false, message: error.message }));

    if (result?.valid) {
      await updateLocalZkDevice(device.deviceId, {
        lastUsedAt: new Date().toISOString(),
        username: result.user?.username || device.username,
        displayName: result.user?.displayName || device.displayName || null,
      });
    } else if (result?.resetLocalDevice) {
      await removeLocalZkDevice(device.deviceId);
    }
    return result;
  },
  loginWithPasskey: async () => {
    const optionsResponse = await fetch(
      `${API_BASE}/auth/passkeys/login/options`,
      {
        method: "POST",
      }
    ).then(safePasskeyJson);
    if (!optionsResponse?.success) {
      return {
        valid: false,
        message: optionsResponse?.error || "Could not start passkey login.",
      };
    }

    const response = await startAuthentication({
      optionsJSON: optionsResponse.options,
    });
    return fetch(`${API_BASE}/auth/passkeys/login/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ response }),
    })
      .then(safePasskeyJson)
      .catch((error) => ({ valid: false, message: error.message }));
  },
  fetchSessions: async () => mockSessions,
  signOutOtherSessions: async () => ({ success: true }),
  signOutAllSessions: async () => ({ success: true }),
  exportAccountData: async () => ({ success: true }),
  exportChatRecords: async () => ({ success: true }),
  fetchAccountDeletePreview: () => System.accountDeletePreview(),
  reauthAccountDeleteWithPassword: ({ currentPassword }) =>
    System.reauthAccountDeleteWithPassword({ currentPassword }),
  deleteAccount: ({ confirm, reauthToken }) =>
    System.deleteAccount({ confirm, reauthToken }),
  clearLocalZkDevices: () => clearLocalZkDevices(),
};

export default AccountSettingsApi;

async function safePasskeyJson(response) {
  const text = await response.text();
  if (!text) {
    return response.ok
      ? { success: true }
      : {
          success: false,
          error: "通行密钥服务暂不可用，请确认后端已重启。",
        };
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      success: false,
      error: "通行密钥服务暂不可用，请确认后端已重启。",
    };
  }
}

function deviceDescriptor() {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  const maxTouchPoints = navigator.maxTouchPoints || 0;
  const isIPad =
    /iPad/.test(ua) ||
    (platform === "MacIntel" && maxTouchPoints > 1 && /Safari|Chrome/.test(ua));
  const isIPhone = /iPhone/.test(ua);
  const isMac = /Mac/.test(platform) && !isIPad;
  const browserName = browserLabel(ua);
  const platformName = isIPad
    ? "iPadOS"
    : isIPhone
      ? "iOS"
      : isMac
        ? "macOS"
        : platformLabel(ua, platform);
  const base = {
    browserName,
    platformName,
    deviceName:
      browserName && platformName
        ? `${browserName} on ${platformName}`
        : "This Device",
  };

  if (isIPad) return { ...base, deviceType: "ipad" };
  if (isIPhone) return { ...base, deviceType: "iphone" };
  if (isMac) return { ...base, deviceType: "mac" };
  return { ...base, deviceType: "browser" };
}

function browserLabel(ua) {
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\//.test(ua)) return "Opera";
  if (/Chrome\//.test(ua) && !/Chromium\//.test(ua)) return "Chrome";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Safari\//.test(ua)) return "Safari";
  return "Browser";
}

function platformLabel(ua, platform) {
  if (/Windows/.test(ua) || /Win/.test(platform)) return "Windows";
  if (/Android/.test(ua)) return "Android";
  if (/Linux/.test(ua) || /Linux/.test(platform)) return "Linux";
  return platform || "this device";
}

function opaqueIdentifiers(deviceId) {
  return { client: deviceId, server: "Athena" };
}

async function durableAvatarDataUrl(avatarUrl) {
  if (!avatarUrl) return null;
  if (String(avatarUrl).startsWith("data:")) return avatarUrl;

  try {
    const response = await fetch(avatarUrl);
    if (!response.ok && !String(avatarUrl).startsWith("blob:")) return null;
    const blob = await response.blob();
    if (!blob?.size || !blob.type?.startsWith("image/")) return null;
    return await blobToDataUrl(blob);
  } catch {
    return null;
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}
