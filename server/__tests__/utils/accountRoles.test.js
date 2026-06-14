const {
  ROLES,
  assertValidRole,
  assertOwnerCap,
  assertOwnerHierarchyMutationAllowed,
  canAccessAdmin,
  canAccessOwner,
  canCreateRole,
  canDeleteAccount,
  canSelfDeleteAccount,
  canBanAccount,
  canUnbanAccount,
  isPrimaryOwner,
  canLogin,
  deriveRoleDefaults,
  assertOwnerWillRemain,
  assertOwnerWillRemainAfterMutation,
  normalizeAllowedEnvs,
  normalizeRole,
} = require("../../utils/authz/accountRoles");

describe("account role and environment policy", () => {
  it("normalizes legacy roles but rejects unknown fixed roles", () => {
    expect(normalizeRole("default")).toBe(ROLES.user);
    expect(normalizeRole("manager")).toBe(ROLES.admin);
    expect(() => assertValidRole("superadmin")).toThrow(/Invalid role/);
  });

  it("derives fixed environment access for each account role", () => {
    expect(deriveRoleDefaults({ role: "user" })).toMatchObject({
      role: "user",
      originEnv: "production",
      allowedEnvs: JSON.stringify(["production"]),
    });
    expect(deriveRoleDefaults({ role: "developer" })).toMatchObject({
      role: "developer",
      originEnv: "development",
      allowedEnvs: JSON.stringify(["development"]),
    });
    expect(normalizeAllowedEnvs(deriveRoleDefaults({ role: "admin" }).allowedEnvs))
      .toEqual(["production", "development"]);
    expect(deriveRoleDefaults({ role: "disabled" })).toMatchObject({
      role: "disabled",
      status: "disabled",
      allowedEnvs: "[]",
    });
  });

  it("enforces login environments", () => {
    const user = deriveRoleDefaults({ role: "user" });
    const developer = deriveRoleDefaults({ role: "developer" });
    const admin = deriveRoleDefaults({ role: "admin" });
    const owner = deriveRoleDefaults({ role: "owner" });
    const disabled = deriveRoleDefaults({ role: "disabled" });

    expect(canLogin(user, "production")).toBe(true);
    expect(canLogin(user, "development")).toBe(false);
    expect(canLogin(developer, "production")).toBe(false);
    expect(canLogin(developer, "development")).toBe(true);
    expect(canLogin(admin, "production")).toBe(true);
    expect(canLogin(admin, "development")).toBe(true);
    expect(canLogin(owner, "production")).toBe(true);
    expect(canLogin(owner, "development")).toBe(true);
    expect(canLogin(disabled, "production")).toBe(false);
    expect(canLogin(disabled, "development")).toBe(false);
  });

  it("separates admin and owner privileges", () => {
    expect(canAccessAdmin(deriveRoleDefaults({ role: "admin" }))).toBe(true);
    expect(canAccessAdmin(deriveRoleDefaults({ role: "owner" }))).toBe(true);
    expect(canAccessAdmin(deriveRoleDefaults({ role: "developer" }))).toBe(false);
    expect(canAccessOwner(deriveRoleDefaults({ role: "admin" }))).toBe(false);
    expect(canAccessOwner(deriveRoleDefaults({ role: "owner" }))).toBe(true);
  });

  it("allows admin to create developer/admin but not owner", () => {
    expect(canCreateRole({ role: "admin" }, "developer")).toBe(true);
    expect(canCreateRole({ role: "admin" }, "admin")).toBe(true);
    expect(canCreateRole({ role: "admin" }, "owner")).toBe(false);
    expect(canCreateRole({ role: "owner", ownerType: "secondary" }, "owner")).toBe(false);
    expect(
      canCreateRole(
        {
          role: "owner",
          ownerType: "primary",
          username: "shis500225",
          email: "shis500225@gmail.com",
        },
        "owner"
      )
    ).toBe(true);
  });

  it("recognizes the fixed primary owner and blocks secondary owner hierarchy changes", () => {
    const primary = {
      role: "owner",
      ownerType: "primary",
      username: "shis500225",
      email: "shis500225@gmail.com",
    };
    expect(isPrimaryOwner(primary)).toBe(true);
    expect(() =>
      assertOwnerHierarchyMutationAllowed({
        actor: { role: "owner", ownerType: "secondary" },
        target: primary,
        updates: { role: "admin" },
      })
    ).toThrow(/Primary owner/);
    expect(() =>
      assertOwnerHierarchyMutationAllowed({
        actor: { role: "admin" },
        target: { role: "user" },
        updates: { role: "owner" },
      })
    ).toThrow(/primary owner/i);
  });

  it("prevents the last active owner from disappearing", async () => {
    const authPrisma = {
      users: {
        findMany: jest.fn().mockResolvedValue([{ id: 1, status: "active" }]),
      },
    };

    await expect(
      assertOwnerWillRemain({
        authPrisma,
        targetAuthUserId: 1,
        nextRole: "admin",
      })
    ).rejects.toThrow(/owner must remain/i);

    authPrisma.users.findMany.mockResolvedValue([
      { id: 1, status: "active" },
      { id: 2, status: "active" },
    ]);
    await expect(
      assertOwnerWillRemain({
        authPrisma,
        targetAuthUserId: 1,
        nextRole: "admin",
      })
    ).resolves.toBe(true);
  });

  it("enforces the active owner cap", async () => {
    const authPrisma = {
      users: {
        findMany: jest.fn().mockResolvedValue([
          { id: 1, role: "owner", status: "active" },
          { id: 2, role: "owner", status: "active" },
          { id: 3, role: "owner", status: "active" },
        ]),
      },
    };

    await expect(
      assertOwnerCap({
        authPrisma,
        targetAuthUserId: 4,
        nextRole: "owner",
        nextStatus: "active",
      })
    ).rejects.toThrow(/cannot exceed 3/i);
  });

  it("protects primary owner from account deletion and ban", () => {
    const primaryOwner = {
      id: 1,
      role: "owner",
      ownerType: "primary",
      username: "shis500225",
      email: "shis500225@gmail.com",
    };
    const secondaryOwner = {
      id: 2,
      role: "owner",
      ownerType: "secondary",
    };
    const admin = { id: 3, role: "admin" };
    const user = { id: 4, role: "user" };

    expect(canSelfDeleteAccount(primaryOwner)).toBe(false);
    expect(canDeleteAccount(primaryOwner, primaryOwner)).toBe(false);
    expect(canDeleteAccount(secondaryOwner, primaryOwner)).toBe(false);
    expect(canDeleteAccount(primaryOwner, secondaryOwner)).toBe(true);
    expect(canDeleteAccount(admin, user)).toBe(false);
    expect(canBanAccount(admin, user)).toBe(true);
    expect(canBanAccount(admin, primaryOwner)).toBe(false);
    expect(canBanAccount(primaryOwner, secondaryOwner)).toBe(true);
  });

  it("does not allow unban to restore owner unless primary owner restores a secondary owner", () => {
    const primaryOwner = {
      id: 1,
      role: "owner",
      ownerType: "primary",
      username: "shis500225",
      email: "shis500225@gmail.com",
    };
    const secondaryOwner = {
      id: 2,
      role: "owner",
      ownerType: "secondary",
      status: "disabled",
    };
    const nonPrimaryOwner = {
      id: 3,
      role: "owner",
      ownerType: "secondary",
      status: "active",
    };
    const admin = { id: 4, role: "admin" };
    const disabledUser = { id: 5, role: "user", status: "disabled" };

    expect(
      canUnbanAccount(primaryOwner, secondaryOwner, { restoreRole: "owner" })
    ).toBe(true);
    expect(
      canUnbanAccount(nonPrimaryOwner, secondaryOwner, { restoreRole: "owner" })
    ).toBe(false);
    expect(canUnbanAccount(admin, secondaryOwner, { restoreRole: "owner" })).toBe(
      false
    );
    expect(canUnbanAccount(admin, disabledUser, { restoreRole: "user" })).toBe(
      true
    );
    expect(canUnbanAccount(admin, disabledUser, { restoreRole: "admin" })).toBe(
      false
    );
  });

  it("prevents deleting or disabling the last active owner in an environment", async () => {
    const authPrisma = {
      users: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 1,
            role: "owner",
            status: "active",
            suspended: 0,
            allowedEnvs: JSON.stringify(["production", "development"]),
            ownerType: "secondary",
          },
        ]),
      },
    };

    await expect(
      assertOwnerWillRemainAfterMutation({
        authPrisma,
        targetAuthUserId: 1,
        env: "development",
        deleting: true,
      })
    ).rejects.toThrow(/active owner must remain/i);

    authPrisma.users.findMany.mockResolvedValue([
      {
        id: 1,
        role: "owner",
        status: "active",
        suspended: 0,
        allowedEnvs: JSON.stringify(["development"]),
        ownerType: "secondary",
      },
      {
        id: 2,
        role: "owner",
        status: "active",
        suspended: 0,
        allowedEnvs: JSON.stringify(["development"]),
        ownerType: "secondary",
      },
    ]);

    await expect(
      assertOwnerWillRemainAfterMutation({
        authPrisma,
        targetAuthUserId: 1,
        env: "development",
        deleting: true,
      })
    ).resolves.toBe(true);
  });
});
