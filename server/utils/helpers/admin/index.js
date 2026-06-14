const authPrisma = require("../../authPrisma");
const { ROLES } = require("../../middleware/multiUserProtected");
const {
  OWNER_TYPES,
  assertOwnerCap,
  assertOwnerHierarchyMutationAllowed,
  assertOwnerWillRemain,
  canCreateRole,
  isPrimaryOwner,
  normalizeRole,
} = require("../../authz/accountRoles");

// When a user is updating or creating a user in multi-user, we need to check if they
// are allowed to do this and that the new or existing user will be at or below their permission level.
// the user executing this function should be an admin or manager.
function validRoleSelection(
  currentUser = {},
  newUserParams = {},
  { allowOwner = false } = {}
) {
  if (!newUserParams.hasOwnProperty("role"))
    return { valid: true, error: null }; // not updating role, so skip.
  if (normalizeRole(newUserParams.role) === ROLES.owner && !allowOwner)
    return { valid: false, error: "Owner can only be granted from user edit." };
  if (canCreateRole(currentUser, newUserParams.role))
    return { valid: true, error: null };
  return { valid: false, error: "Invalid role selection for user." };
}

// Check to make sure with this update that includes a role change to an existing admin to a non-admin
// that we still have at least one admin left or else they will lock themselves out.
async function canModifyAdmin(userToModify, updates, currentUser = {}) {
  const currentRole = normalizeRole(userToModify?.role);
  const nextRole = updates.hasOwnProperty("role")
    ? normalizeRole(updates.role)
    : currentRole;
  const nextStatus = updates.hasOwnProperty("status")
    ? updates.status
    : userToModify?.status;
  const disabling =
    updates.suspended === true ||
    updates.suspended === 1 ||
    nextRole === ROLES.disabled ||
    nextStatus === "disabled";

  if (currentRole !== ROLES.owner && nextRole !== ROLES.owner)
    return { valid: true, error: null };

  try {
    assertOwnerHierarchyMutationAllowed({
      actor: currentUser,
      target: userToModify,
      updates,
    });
    await assertOwnerWillRemain({
      authPrisma,
      targetAuthUserId: userToModify?.authUserId,
      nextRole,
      nextStatus: disabling ? "disabled" : nextStatus,
    });
    await assertOwnerCap({
      authPrisma,
      targetAuthUserId: userToModify?.authUserId,
      nextRole,
      nextStatus: disabling ? "disabled" : nextStatus,
    });
    return { valid: true, error: null };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

function validCanModify(currentUser, existingUser) {
  const actorRole = normalizeRole(currentUser?.role);
  const targetRole = normalizeRole(existingUser?.role);
  if (actorRole === ROLES.owner) {
    if (targetRole === ROLES.owner && !isPrimaryOwner(currentUser))
      return {
        valid: false,
        error: "Secondary owners cannot modify owner accounts.",
      };
    return { valid: true, error: null };
  }
  if (actorRole === ROLES.admin && targetRole !== ROLES.owner)
    return { valid: true, error: null };
  return { valid: false, error: "Cannot perform that action on user." };
}

function forceSecondaryOwnerOnPromotion(targetUser = {}, updates = {}) {
  if (
    normalizeRole(updates.role) === ROLES.owner &&
    normalizeRole(targetUser?.role) !== ROLES.owner
  ) {
    updates.ownerType = OWNER_TYPES.secondary;
  }
  return updates;
}

module.exports = {
  forceSecondaryOwnerOnPromotion,
  validCanModify,
  validRoleSelection,
  canModifyAdmin,
};
