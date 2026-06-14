const { Prisma } = require("@prisma/client");
const prisma = require("../utils/prisma");
const { EventLogs } = require("./eventLogs");
const { AuthIdentity } = require("./authIdentity");
const { appEnvironment } = require("../utils/environment");
const {
  ROLES,
  assertValidRole,
  capabilitiesFor,
  deriveRoleDefaults,
  normalizeAllowedEnvs,
  normalizeOwnerType,
  normalizeRole,
  normalizeStatus,
} = require("../utils/authz/accountRoles");

/**
 * @typedef {Object} User
 * @property {number} id
 * @property {string} username
 * @property {string} password
 * @property {string} pfpFilename
 * @property {string} role
 * @property {boolean} suspended
 * @property {number|null} dailyMessageLimit
 */

const User = {
  usernameRegex: new RegExp(/^[A-Za-z0-9_-]+$/),
  writable: [
    // Used for generic updates so we can validate keys in request body
    "username",
    "displayName",
    "password",
    "pfpFilename",
    "role",
    "status",
    "allowedEnvs",
    "ownerType",
    "suspended",
    "dailyMessageLimit",
    "bio",
    "email",
    "email_verified_at",
    "phone",
    "phone_verified_at",
  ],
  validations: {
    /**
     * Account name used for login:
     * - Letters, digits, underscores, and hyphens only
     * - 3-32 characters long
     */
    username: (newValue = "") => {
      try {
        const username = String(newValue || "").trim();
        if (username.length > 32)
          throw new Error("Username cannot be longer than 32 characters");
        if (username.length < 3)
          throw new Error("Username must be at least 3 characters");
        if (!User.usernameRegex.test(username))
          throw new Error(
            "Username can only contain letters, numbers, underscores, and hyphens"
          );
        return username;
      } catch (e) {
        throw new Error(e.message);
      }
    },
    role: (role = ROLES.user) => {
      const raw = String(role || ROLES.user)
        .trim()
        .toLowerCase();
      if (
        !["default", "manager"].includes(raw) &&
        !["disabled", "user", "developer", "admin", "owner"].includes(raw)
      ) {
        assertValidRole(raw);
      }
      const normalized = normalizeRole(raw);
      assertValidRole(normalized);
      return normalized;
    },
    status: (status = "active") => {
      return normalizeStatus(status);
    },
    allowedEnvs: (allowedEnvs = null, role = ROLES.user) => {
      return JSON.stringify(normalizeAllowedEnvs(allowedEnvs, role));
    },
    ownerType: (ownerType = null) => normalizeOwnerType(ownerType),
    dailyMessageLimit: (dailyMessageLimit = null) => {
      if (dailyMessageLimit === null) return null;
      const limit = Number(dailyMessageLimit);
      if (isNaN(limit) || limit < 1) {
        throw new Error(
          "Daily message limit must be null or a number greater than or equal to 1"
        );
      }
      return limit;
    },
    bio: (bio = "") => {
      if (!bio || typeof bio !== "string") return "";
      if (bio.length > 1000)
        throw new Error("Bio cannot be longer than 1,000 characters");
      return String(bio);
    },
    displayName: (displayName = "") => {
      const value = String(displayName || "")
        .replace(/[<>]/g, "")
        .trim();
      if (value.length > 80)
        throw new Error("Display name cannot be longer than 80 characters");
      return value;
    },
  },
  // validations for the above writable fields.
  castColumnValue: function (key, value) {
    switch (key) {
      case "suspended":
        return Number(Boolean(value));
      case "dailyMessageLimit":
        return value === null ? null : Number(value);
      default:
        return String(value);
    }
  },

  filterFields: function (user = {}) {
    const {
      password: _password,
      web_push_subscription_config: _web_push_subscription_config,
      ...rest
    } = user;
    return {
      ...rest,
      role: normalizeRole(rest.role),
      status: normalizeStatus(rest.status, rest.role, rest.suspended),
      allowedEnvs: normalizeAllowedEnvs(rest.allowedEnvs, rest.role),
      ownerType: normalizeOwnerType(rest.ownerType, rest.role, rest),
      capabilities: capabilitiesFor(rest),
    };
  },
  _identifyErrorAndFormatMessage: function (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      // P2002 is the unique constraint violation error code
      if (error.code === "P2002") {
        const target = error.meta?.target;
        return `A user with that ${target?.join(", ")} already exists`;
      }
    }
    return error.message;
  },

  create: async function ({
    username,
    password,
    role = ROLES.user,
    status = null,
    allowedEnvs = null,
    dailyMessageLimit = null,
    bio = "",
    email = null,
    emailVerifiedAt = null,
    phone = null,
    phoneVerifiedAt = null,
    originEnv = appEnvironment(),
    ownerType = null,
  }) {
    const passwordCheck = this.checkPasswordComplexity(password);
    if (!passwordCheck.checkedOK) {
      return { user: null, error: passwordCheck.error };
    }

    try {
      // Validate username format (validation function handles all checks)
      const validatedUsername = this.validations.username(username);

      const bcrypt = require("bcryptjs");
      const hashedPassword = bcrypt.hashSync(password, 10);
      const displayName = this.validations.displayName(username);
      const normalizedEmail = email ? AuthIdentity.normalizeEmail(email) : null;
      const normalizedPhone = phone ? AuthIdentity.normalizePhone(phone) : null;
      const roleDefaults = deriveRoleDefaults({
        role,
        status,
        allowedEnvs,
        originEnv,
        ownerType,
        username: validatedUsername,
        email: normalizedEmail,
      });
      const validatedRole = this.validations.role(roleDefaults.role);
      const validatedBio = this.validations.bio(bio);
      const validatedDailyMessageLimit =
        this.validations.dailyMessageLimit(dailyMessageLimit);
      const authUser = await AuthIdentity.createAuthUser({
        username: validatedUsername,
        displayName,
        passwordHash: hashedPassword,
        role: validatedRole,
        status: roleDefaults.status,
        allowedEnvs: roleDefaults.allowedEnvs,
        ownerType: roleDefaults.ownerType,
        bio: validatedBio,
        email: normalizedEmail,
        emailVerifiedAt,
        phone: normalizedPhone,
        phoneVerifiedAt,
        dailyMessageLimit: validatedDailyMessageLimit,
        originEnv: roleDefaults.originEnv,
      });

      const user = await prisma.users.create({
        data: {
          authUserId: authUser.id,
          originEnv: AuthIdentity.normalizeOriginEnv(roleDefaults.originEnv),
          username: validatedUsername,
          displayName,
          password: hashedPassword,
          role: validatedRole,
          status: roleDefaults.status,
          allowedEnvs: roleDefaults.allowedEnvs,
          ownerType: roleDefaults.ownerType,
          suspended: roleDefaults.suspended,
          bio: validatedBio,
          ...(normalizedEmail ? { email: normalizedEmail } : {}),
          ...(emailVerifiedAt ? { email_verified_at: emailVerifiedAt } : {}),
          ...(normalizedPhone ? { phone: normalizedPhone } : {}),
          ...(phoneVerifiedAt ? { phone_verified_at: phoneVerifiedAt } : {}),
          dailyMessageLimit: validatedDailyMessageLimit,
        },
      });
      return { user: this.filterFields(user), error: null };
    } catch (error) {
      console.error("FAILED TO CREATE USER.", error.message);
      return { user: null, error: this._identifyErrorAndFormatMessage(error) };
    }
  },
  // Log the changes to a user object, but omit sensitive fields
  // that are not meant to be logged.
  loggedChanges: function (updates, prev = {}) {
    const changes = {};
    const sensitiveFields = ["password"];

    Object.keys(updates).forEach((key) => {
      if (!sensitiveFields.includes(key) && updates[key] !== prev[key]) {
        changes[key] = `${prev[key]} => ${updates[key]}`;
      }
    });

    return changes;
  },

  update: async function (userId, updates = {}) {
    try {
      if (!userId) throw new Error("No user id provided for update");
      const currentUser = await prisma.users.findUnique({
        where: { id: parseInt(userId) },
      });
      if (!currentUser) return { success: false, error: "User not found" };

      // We previously had more lenient username validation, but now with more strict validation
      // we dont want to break existing users by changing non-username fields.
      // If they are not explictly changing the username, do not attempt to validate it.
      if (updates.hasOwnProperty("username")) {
        if (updates.username === currentUser.username) delete updates.username;
      }

      // Removes non-writable fields for generic updates
      // and force-casts to the proper type;
      Object.entries(updates).forEach(([key, value]) => {
        if (this.writable.includes(key)) {
          if (this.validations.hasOwnProperty(key)) {
            updates[key] = this.validations[key](
              this.castColumnValue(key, value)
            );
          } else {
            updates[key] = this.castColumnValue(key, value);
          }
          return;
        }
        delete updates[key];
      });

      if (Object.keys(updates).length === 0)
        return { success: false, error: "No valid updates applied." };

      if (
        Object.prototype.hasOwnProperty.call(updates, "role") ||
        Object.prototype.hasOwnProperty.call(updates, "status") ||
        Object.prototype.hasOwnProperty.call(updates, "allowedEnvs") ||
        Object.prototype.hasOwnProperty.call(updates, "ownerType") ||
        Object.prototype.hasOwnProperty.call(updates, "suspended")
      ) {
        const roleDefaults = deriveRoleDefaults({
          role: updates.role ?? currentUser.role,
          status: updates.status ?? currentUser.status,
          originEnv: updates.originEnv ?? currentUser.originEnv,
          allowedEnvs: updates.allowedEnvs ?? currentUser.allowedEnvs,
          suspended: updates.suspended ?? currentUser.suspended,
          ownerType: updates.ownerType ?? currentUser.ownerType,
          username: updates.username ?? currentUser.username,
          email: updates.email ?? currentUser.email,
        });
        updates.role = roleDefaults.role;
        updates.status = roleDefaults.status;
        updates.allowedEnvs = roleDefaults.allowedEnvs;
        updates.ownerType = roleDefaults.ownerType;
        updates.suspended = roleDefaults.suspended;
        updates.originEnv = roleDefaults.originEnv;
      }

      // Handle password specific updates
      if (updates.hasOwnProperty("password")) {
        const passwordCheck = this.checkPasswordComplexity(updates.password);
        if (!passwordCheck.checkedOK) {
          return { success: false, error: passwordCheck.error };
        }
        const bcrypt = require("bcryptjs");
        updates.password = bcrypt.hashSync(updates.password, 10);
      }

      const user = await prisma.users.update({
        where: { id: parseInt(userId) },
        data: updates,
      });
      if (user.authUserId)
        await AuthIdentity.updateAuthUser(user.authUserId, updates);

      await EventLogs.logEvent(
        "user_updated",
        {
          username: user.username,
          changes: this.loggedChanges(updates, currentUser),
        },
        userId
      );
      return { success: true, error: null };
    } catch (error) {
      console.error("FAILED TO UPDATE USER.", error.message);
      return {
        success: false,
        error: this._identifyErrorAndFormatMessage(error),
      };
    }
  },

  /**
   * Explicit direct update of user object.
   * Only use this method when directly setting a key value
   * that takes no user input for the keys being modified.
   * @param {number} id - The id of the user to update.
   * @param {Object} data - The data to update the user with.
   * @returns {Promise<Object>} The updated user object.
   */
  _update: async function (id = null, data = {}) {
    if (!id) throw new Error("No user id provided for update");

    try {
      const user = await prisma.users.update({
        where: { id },
        data,
      });
      if (user.authUserId)
        await AuthIdentity.updateAuthUser(user.authUserId, data);
      return { user, message: null };
    } catch (error) {
      console.error(error.message);
      return { user: null, message: error.message };
    }
  },

  /**
   * Get all users that match the given clause without filtering the fields.
   * Internal use only - do not use this method for user-input flows
   * @param {Object} clause - The clause to filter the users by.
   * @param {number|null} limit - The maximum number of users to return.
   * @returns {Promise<Array<User>>} The users that match the given clause.
   */
  _where: async function (clause = {}, limit = null) {
    try {
      const users = await prisma.users.findMany({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
      });
      return users;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  /**
   * Returns a user object based on the clause provided.
   * @param {Object} clause - The clause to use to find the user.
   * @returns {Promise<import("@prisma/client").users|null>} The user object or null if not found.
   */
  get: async function (clause = {}) {
    try {
      const user = await prisma.users.findFirst({ where: clause });
      return user ? this.filterFields({ ...user }) : null;
    } catch (error) {
      console.error(error.message);
      return null;
    }
  },
  // Returns user object with all fields
  _get: async function (clause = {}) {
    try {
      const user = await prisma.users.findFirst({ where: clause });
      return user ? { ...user } : null;
    } catch (error) {
      console.error(error.message);
      return null;
    }
  },

  count: async function (clause = {}) {
    try {
      const count = await prisma.users.count({ where: clause });
      return count;
    } catch (error) {
      console.error(error.message);
      return 0;
    }
  },

  delete: async function (clause = {}) {
    try {
      await prisma.users.deleteMany({ where: clause });
      return true;
    } catch (error) {
      console.error(error.message);
      return false;
    }
  },

  where: async function (clause = {}, limit = null) {
    try {
      const users = await prisma.users.findMany({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
      });
      return users.map((usr) => this.filterFields(usr));
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  checkPasswordComplexity: function (passwordInput = "") {
    const passwordComplexity = require("joi-password-complexity");
    // Can be set via ENV variable on boot. No frontend config at this time.
    // Docs: https://www.npmjs.com/package/joi-password-complexity
    const complexityOptions = {
      min: process.env.PASSWORDMINCHAR || 8,
      max: process.env.PASSWORDMAXCHAR || 250,
      lowerCase: process.env.PASSWORDLOWERCASE || 0,
      upperCase: process.env.PASSWORDUPPERCASE || 0,
      numeric: process.env.PASSWORDNUMERIC || 0,
      symbol: process.env.PASSWORDSYMBOL || 0,
      // reqCount should be equal to how many conditions you are testing for (1-4)
      requirementCount: process.env.PASSWORDREQUIREMENTS || 0,
    };

    const complexityCheck = passwordComplexity(
      complexityOptions,
      "password"
    ).validate(passwordInput);
    if (complexityCheck.hasOwnProperty("error")) {
      let myError = "";
      let prepend = "";
      for (let i = 0; i < complexityCheck.error.details.length; i++) {
        myError += prepend + complexityCheck.error.details[i].message;
        prepend = ", ";
      }
      return { checkedOK: false, error: myError };
    }

    return { checkedOK: true, error: "No error." };
  },

  /**
   * Check if a user can send a chat based on their daily message limit.
   * This limit is system wide and not per workspace and only applies to
   * multi-user mode AND non-admin users.
   * @param {User} user The user object record.
   * @returns {Promise<boolean>} True if the user can send a chat, false otherwise.
   */
  canSendChat: async function (user) {
    if (
      !user ||
      user.dailyMessageLimit === null ||
      [ROLES.admin, ROLES.owner].includes(normalizeRole(user.role))
    )
      return true;

    const { WorkspaceChats } = require("./workspaceChats");
    const currentChatCount = await WorkspaceChats.count({
      user_id: user.id,
      createdAt: {
        gte: new Date(new Date() - 24 * 60 * 60 * 1000), // 24 hours
      },
    });

    return currentChatCount < user.dailyMessageLimit;
  },
};

module.exports = { User };
