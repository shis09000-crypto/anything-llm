const { DataAccessCenter } = require("../utils/dataAccess");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const AuthIdentityDb = DataAccessCenter.authIdentity.localDb;
const SystemSettings = DataAccessCenter.adminSystem;

const TRUSTED_DEVICE_UNAVAILABLE = "可信设备快速登录将在后续版本开放。";

function authTrustedDeviceEndpoints(app) {
  app.get(
    "/auth/trusted-devices",
    [validatedRequest],
    async (_request, response) => {
      try {
        if (!response.locals.multiUserMode) {
          return response.status(404).json({ success: false });
        }

        const user = response.locals.user;
        const devices = await AuthIdentityDb.trustedLoginDevice.findMany({
          where: {
            userId: user.id,
            revokedAt: null,
          },
          select: {
            id: true,
            deviceId: true,
            deviceName: true,
            createdAt: true,
            lastUsedAt: true,
            revokedAt: true,
          },
          orderBy: {
            createdAt: "desc",
          },
        });

        return response.status(200).json({
          success: true,
          devices,
          enabled: devices.length > 0,
        });
      } catch (error) {
        console.error("[Trusted devices list failed]", error.message);
        return response.status(500).json({
          success: false,
          devices: [],
          error: "可信设备列表暂不可用。",
        });
      }
    }
  );

  app.post(
    "/auth/trusted-devices/enable",
    [validatedRequest],
    async (_request, response) => {
      if (!response.locals.multiUserMode) {
        return response.status(404).json({ success: false });
      }

      return response.status(501).json({
        success: false,
        enabled: false,
        message: TRUSTED_DEVICE_UNAVAILABLE,
        error: TRUSTED_DEVICE_UNAVAILABLE,
      });
    }
  );

  app.delete(
    "/auth/trusted-devices/:id",
    [validatedRequest],
    async (_request, response) => {
      if (!response.locals.multiUserMode) {
        return response.status(404).json({ success: false });
      }

      return response.status(501).json({
        success: false,
        revoked: false,
        message: "可信设备撤销将在后续版本开放。",
        error: "可信设备撤销将在后续版本开放。",
      });
    }
  );

  app.get("/auth/trusted-devices/quick-login", async (_request, response) => {
    if (!(await SystemSettings.isMultiUserMode())) {
      return response.status(404).json({ success: false });
    }

    return response.status(200).json({
      success: true,
      enabled: false,
      device: null,
      message: TRUSTED_DEVICE_UNAVAILABLE,
    });
  });
}

module.exports = { authTrustedDeviceEndpoints };
