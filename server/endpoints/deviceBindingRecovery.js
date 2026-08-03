const {
  issueDeviceBindingChallenge,
} = require("../utils/authz/deviceBindingRecovery");
const { apiErrorStatus } = require("../utils/http/apiError");

function deviceBindingRecoveryEndpoints(app) {
  if (!app) return;

  app.post("/auth/device-binding/preflight", async (request, response) => {
    try {
      const challenge = await issueDeviceBindingChallenge(request);
      return response.status(200).json({ success: true, ...challenge });
    } catch (error) {
      return response.status(apiErrorStatus(error)).json({
        success: false,
        error: error.code || "device_binding_preflight_failed",
      });
    }
  });
}

module.exports = { deviceBindingRecoveryEndpoints };
