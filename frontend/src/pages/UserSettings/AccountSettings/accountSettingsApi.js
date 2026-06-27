import { deleteJson, getJson, postJson } from "@/lib/communication/apiClient";
import { BLOB_KINDS, requestBlob } from "@/lib/communication/blobClient";
import { apiErrorRaw } from "@/lib/communication/apiError";
import System from "@/models/system";
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
  syncLocalZkDevicesWithServer,
  updateLocalZkDevice,
  zkLoginStorageSupported,
} from "@/utils/zkLoginStorage";

const ZK_UNSUPPORTED_MESSAGE =
  "零知识快速登录需要 HTTPS 或 localhost。手机局域网 HTTP 地址无法保存可信设备。";

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
  fetchMemoryOverview: () => System.memoryOverview(),
  fetchMemoryBlocks: (options = {}) => System.memoryBlocks(options),
  fetchMemoryArchives: (options = {}) => System.memoryArchives(options),
  fetchSensitiveMemories: (options = {}) => System.sensitiveMemories(options),
  createMemoryCandidate: (data) => System.createMemoryCandidate(data),
  rebuildMemoryProfile: () => System.rebuildMemoryProfile(),
  updateMemory: ({ id, ...data }) => System.updateMemory({ id, ...data }),
  deleteMemory: ({ id }) => System.deleteMemory({ id }),
  revealSensitiveMemory: ({ id, currentPassword, reauthToken }) =>
    System.revealSensitiveMemory({ id, currentPassword, reauthToken }),
  reauthSensitiveMemoryWithPasskey: async () => {
    if (!detectAuthCapability().showPasskey) {
      return {
        success: false,
        error: "当前浏览器不支持通行密钥验证。",
      };
    }

    const optionsResponse = await System.sensitiveMemoryPasskeyReauthOptions();
    if (!optionsResponse?.success) return optionsResponse;

    try {
      const response = await startAuthentication({
        optionsJSON: optionsResponse.options,
      });
      return System.sensitiveMemoryPasskeyReauthVerify({ response });
    } catch (error) {
      return {
        success: false,
        error: error?.message || "通行密钥验证已取消。",
      };
    }
  },
  fetchProfilePicture: (userId) => System.fetchPfp(userId),
  uploadProfilePicture: (formData) => System.uploadPfp(formData),
  removeProfilePicture: () => System.removePfp(),
  passkeysSupported: () => detectAuthCapability().showPasskey,
  fetchPasskeys: async () => {
    return passkeyJson(getJson("/auth/passkeys"), "无法读取通行密钥。")
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

    const optionsResponse = await passkeyJson(
      postJson("/auth/passkeys/register/options"),
      "Could not start passkey setup."
    );
    if (!optionsResponse?.success) {
      return {
        success: false,
        error: optionsResponse?.error || "Could not start passkey setup.",
      };
    }

    const response = await startRegistration({
      optionsJSON: optionsResponse.options,
    });
    return passkeyJson(
      postJson("/auth/passkeys/register/verify", {
        response,
        ...deviceDescriptor(),
      }),
      "Could not verify passkey setup."
    );
  },
  deletePasskey: async (id, { confirmRisk = false } = {}) => {
    return passkeyJson(
      deleteJson(`/auth/passkeys/${id}`, { body: { confirmRisk } }),
      "Could not delete passkey."
    );
  },
  fetchTrustedLoginDevices: async ({ user, avatarUrl } = {}) => {
    return passkeyJson(
      getJson("/auth/zk-login/devices"),
      "Could not read trusted devices."
    )
      .then(async (res) => {
        if (res?.success) {
          const devices = res.devices || [];
          await syncLocalZkDevicesWithServer({
            user,
            devices,
            avatarUrl,
          }).catch(() => null);
          return { ...res, devices };
        }
        return res;
      })
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
    return passkeyJson(
      postJson("/auth/zk-login/reauth/password", { currentPassword }),
      "Could not verify password."
    );
  },
  reauthZkWithPasskey: async () => {
    if (!detectAuthCapability().showPasskey) {
      return {
        success: false,
        error: "当前浏览器不支持通行密钥验证。",
      };
    }

    const optionsResponse = await passkeyJson(
      postJson("/auth/zk-login/reauth/passkey/options"),
      "Could not start passkey verification."
    );
    if (!optionsResponse?.success) return optionsResponse;

    const response = await startAuthentication({
      optionsJSON: optionsResponse.options,
    });
    return passkeyJson(
      postJson("/auth/zk-login/reauth/passkey/verify", { response }),
      "Could not verify passkey."
    );
  },
  enableTrustedLoginDevice: async ({ user, reauthToken, avatarUrl } = {}) => {
    if (!zkLoginStorageSupported()) {
      return { success: false, error: ZK_UNSUPPORTED_MESSAGE };
    }

    if ((!user?.id && !user?.authUserId) || !reauthToken) {
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

    const startResponse = await passkeyJson(
      postJson("/auth/zk-login/enroll/start", {
        reauthToken,
        deviceId: localDevice.deviceId,
        deviceName: localDevice.metadata.deviceName,
        deviceSalt: localDevice.deviceSalt,
        registrationRequest,
      }),
      "Could not start trusted device setup."
    );
    if (!startResponse?.success) return startResponse;

    const { registrationRecord } = opaqueClient.finishRegistration({
      clientRegistrationState,
      registrationResponse: startResponse.registrationResponse,
      password: localDevice.deviceSecret,
      identifiers: opaqueIdentifiers(localDevice.deviceId),
    });

    const finishResponse = await passkeyJson(
      postJson("/auth/zk-login/enroll/finish", {
        reauthToken,
        deviceId: localDevice.deviceId,
        deviceName: localDevice.metadata.deviceName,
        deviceSalt: localDevice.deviceSalt,
        registrationRecord,
      }),
      "Could not finish trusted device setup."
    );
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
    const result = await passkeyJson(
      deleteJson(`/auth/zk-login/devices/${id}`),
      "Could not revoke trusted device."
    );
    if (result?.success && deviceId) await removeLocalZkDevice(deviceId);
    return result;
  },
  loginWithZkDevice: async (device) => {
    if (!zkLoginStorageSupported()) {
      return {
        valid: false,
        message: ZK_UNSUPPORTED_MESSAGE,
      };
    }

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
    const startResponse = await passkeyJson(
      postJson(
        "/auth/zk-login/login/start",
        {
          userId: device.userId,
          deviceId: device.deviceId,
          startLoginRequest,
        },
        { includeBaseHeaders: false }
      ),
      "快速登录暂不可用。"
    );
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
    const result = await loginJson(
      postJson(
        "/auth/zk-login/login/finish",
        {
          loginAttemptId: startResponse.loginAttemptId,
          finishLoginRequest,
        },
        { includeBaseHeaders: false }
      ),
      "快速登录暂不可用。"
    );

    if (result?.valid) {
      await updateLocalZkDevice(device.deviceId, {
        userId: result.user?.authUserId || result.user?.id || device.userId,
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
    const optionsResponse = await passkeyJson(
      postJson("/auth/passkeys/login/options", undefined, {
        includeBaseHeaders: false,
      }),
      "Could not start passkey login."
    );
    if (!optionsResponse?.success) {
      return {
        valid: false,
        message: optionsResponse?.error || "Could not start passkey login.",
      };
    }

    const response = await startAuthentication({
      optionsJSON: optionsResponse.options,
    });
    return loginJson(
      postJson(
        "/auth/passkeys/login/verify",
        { response },
        { includeBaseHeaders: false }
      ),
      "Could not verify passkey login."
    );
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

async function passkeyJson(request, fallbackMessage) {
  try {
    const { data } = await request;
    return data ?? { success: true };
  } catch (error) {
    const raw = apiErrorRaw(error);
    if (raw) return raw;
    return {
      success: false,
      error:
        error?.message === "Failed to fetch"
          ? fallbackMessage
          : error?.message || fallbackMessage,
    };
  }
}

async function loginJson(request, fallbackMessage) {
  const result = await passkeyJson(request, fallbackMessage);
  if (typeof result?.valid === "boolean") return result;
  return {
    ...result,
    valid: false,
    message: result?.message || result?.error || fallbackMessage,
  };
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
    const { blob } = await requestBlob(avatarUrl, {
      includeBaseHeaders: false,
      blobKind: BLOB_KINDS.avatar,
    });
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
