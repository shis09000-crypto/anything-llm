const { SystemSettings } = require("../../models/systemSettings");
const { User } = require("../../models/user");
const { EncryptionManager } = require("../EncryptionManager");
const { decodeJWT } = require("../http");
const { applyCodexDevAuthBypass } = require("../codexDevAuthBypass");
const { jwtIdleState } = require("../sessionIdle");
const { AuthIdentity } = require("../../models/authIdentity");
const { attachAuthenticatedClientContext } = require("../clientIdentity");
const { requireSignedHighRiskRequest } = require("../requestSigning");
const EncryptionMgr = new EncryptionManager();

async function validatedRequest(request, response, next) {
  if (applyCodexDevAuthBypass(request, response)) {
    await attachAuthenticatedClientContext({
      request,
      user: response.locals.user,
    });
    return requireSignedHighRiskRequest(request, response, next);
  }

  const multiUserMode = await SystemSettings.isMultiUserMode();
  response.locals.multiUserMode = multiUserMode;
  if (multiUserMode)
    return await validateMultiUserRequest(request, response, next);

  // When in development passthrough auth token for ease of development.
  // Or if the user simply did not set an Auth token or JWT Secret
  if (
    process.env.NODE_ENV === "development" ||
    !process.env.AUTH_TOKEN ||
    !process.env.JWT_SECRET
  ) {
    return requireSignedHighRiskRequest(request, response, next);
  }

  if (!process.env.AUTH_TOKEN) {
    response.status(401).json({
      error: "You need to set an AUTH_TOKEN environment variable.",
    });
    return;
  }

  const auth = request.header("Authorization");
  const token = auth ? auth.split(" ")[1] : null;

  if (!token) {
    response.status(401).json({
      error: "No auth token found.",
    });
    return;
  }

  const bcrypt = require("bcryptjs");
  const { p } = decodeJWT(token);

  if (p === null || !/\w{32}:\w{32}/.test(p)) {
    response.status(401).json({
      error: "Token expired or failed validation.",
    });
    return;
  }

  // Since the blame of this comment we have been encrypting the `p` property of JWTs with the persistent
  // encryptionManager PEM's. This prevents us from storing the `p` unencrypted in the JWT itself, which could
  // be unsafe. As a consequence, existing JWTs with invalid `p` values that do not match the regex
  // in ln:44 will be marked invalid so they can be logged out and forced to log back in and obtain an encrypted token.
  // This kind of methodology only applies to single-user password mode.
  if (
    !bcrypt.compareSync(
      EncryptionMgr.decrypt(p),
      bcrypt.hashSync(process.env.AUTH_TOKEN, 10)
    )
  ) {
    response.status(401).json({
      error: "Invalid auth credentials.",
    });
    return;
  }

  return requireSignedHighRiskRequest(request, response, next);
}

async function validateMultiUserRequest(request, response, next) {
  const auth = request.header("Authorization");
  const token = auth ? auth.split(" ")[1] : null;

  if (!token) {
    response.status(401).json({
      error: "No auth token found.",
    });
    return;
  }

  const valid = decodeJWT(token);
  if (!valid || !valid.id) {
    response.status(401).json({
      error: "Invalid auth token.",
    });
    return;
  }

  const idleState = jwtIdleState(valid);
  if (idleState.idleExpired) {
    response.status(401).json({
      error: "Session expired due to inactivity.",
      idleExpiresAt: idleState.idleExpiresAt,
      idleRemainingMs: 0,
    });
    return;
  }

  const shadow = await User._get({ id: valid.id });
  if (!shadow) {
    response.status(401).json({
      error: "Invalid auth for user.",
    });
    return;
  }

  let authUser = valid.authUserId
    ? await AuthIdentity.findById(valid.authUserId)
    : null;
  if (!authUser && shadow.authUserId) {
    authUser = await AuthIdentity.findById(shadow.authUserId);
  }
  if (!authUser) {
    authUser = await AuthIdentity.bootstrapAuthUserFromShadow(shadow);
  }

  if (!authUser || !(await AuthIdentity.canLoginInCurrentEnvAsync(authUser))) {
    response.status(401).json({
      error: "Invalid auth for user.",
    });
    return;
  }

  const syncedUser = await AuthIdentity.ensureShadowUser(authUser);
  response.locals.user = User.filterFields(syncedUser);
  await attachAuthenticatedClientContext({
    request,
    user: response.locals.user,
  });
  return requireSignedHighRiskRequest(request, response, next);
}

module.exports = {
  validatedRequest,
};
