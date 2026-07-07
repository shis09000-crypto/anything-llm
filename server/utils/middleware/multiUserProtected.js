const { DataAccessCenter } = require("../dataAccess");
const { userFromSession } = require("../http");
const { ROLES, normalizeRole } = require("../authz/accountRoles");

const SystemSettings = DataAccessCenter.adminSystem;
const DEFAULT_ROLES = [ROLES.admin, ROLES.owner];

function rolePermitted(userRole, allowedRoles = DEFAULT_ROLES) {
  const role = normalizeRole(userRole);
  const allowed = allowedRoles.map((allowedRole) => normalizeRole(allowedRole));
  if (allowed.includes(role)) return true;
  if (role === ROLES.owner && allowed.includes(ROLES.admin)) return true;
  return false;
}

/**
 * Explicitly check that single user mode is enabled as well as that the
 * requesting user has the appropriate role to modify or call the URL.
 * @returns {function}
 */
async function isSingleUserMode(_request, response, next) {
  if (response.locals?.codexDevAuthBypass) {
    next();
    return;
  }

  const multiUserMode = await SystemSettings.isMultiUserMode();
  if (multiUserMode) return response.sendStatus(401).end();
  next();
  return;
}

/**
 * Explicitly check that multi user mode is enabled as well as that the
 * requesting user has the appropriate role to modify or call the URL.
 * @param {string[]} allowedRoles - The roles that are allowed to access the route
 * @returns {function}
 */
function strictMultiUserRoleValid(allowedRoles = DEFAULT_ROLES) {
  return async (request, response, next) => {
    if (response.locals?.codexDevAuthBypass) {
      next();
      return;
    }

    // If the access-control is allowable for all - skip validations and continue;
    if (allowedRoles.includes(ROLES.all)) {
      next();
      return;
    }

    const multiUserMode =
      response.locals?.multiUserMode ??
      (await SystemSettings.isMultiUserMode());
    if (!multiUserMode) return response.sendStatus(401).end();

    const user =
      response.locals?.user ?? (await userFromSession(request, response));
    if (rolePermitted(user?.role, allowedRoles)) {
      next();
      return;
    }
    return response.sendStatus(401).end();
  };
}

/**
 * Apply role permission checks IF the current system is in multi-user mode.
 * This is relevant for routes that are shared between MUM and single-user mode.
 * @param {string[]} allowedRoles - The roles that are allowed to access the route
 * @returns {function}
 */
function flexUserRoleValid(allowedRoles = DEFAULT_ROLES) {
  return async (request, response, next) => {
    if (response.locals?.codexDevAuthBypass) {
      next();
      return;
    }

    // If the access-control is allowable for all - skip validations and continue;
    // It does not matter if multi-user or not.
    if (allowedRoles.includes(ROLES.all)) {
      next();
      return;
    }

    // Bypass if not in multi-user mode
    const multiUserMode =
      response.locals?.multiUserMode ??
      (await SystemSettings.isMultiUserMode());
    if (!multiUserMode) {
      next();
      return;
    }

    const user =
      response.locals?.user ?? (await userFromSession(request, response));
    if (rolePermitted(user?.role, allowedRoles)) {
      next();
      return;
    }
    return response.sendStatus(401).end();
  };
}

// Middleware check on a public route if the instance is in a valid
// multi-user set up.
async function isMultiUserSetup(_request, response, next) {
  const multiUserMode = await SystemSettings.isMultiUserMode();
  if (!multiUserMode) {
    response.status(403).json({
      error: "Invalid request",
    });
    return;
  }

  next();
  return;
}

module.exports = {
  ROLES,
  rolePermitted,
  isSingleUserMode,
  strictMultiUserRoleValid,
  flexUserRoleValid,
  isMultiUserSetup,
};
