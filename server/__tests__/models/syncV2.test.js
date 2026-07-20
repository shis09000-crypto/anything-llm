const { SyncV2 } = require("../../models/syncV2");
const prisma = require("../../utils/prisma");
const { contentHash } = require("../../utils/syncV2/canonicalJson");
const {
  userProfileProjection,
  userSecurityPolicyProjection,
} = require("../../utils/syncV2/userProjection");

describe("SyncV2 transactional writer", () => {
  const originalHashSamplePercent =
    process.env.ATHENA_SYNC_V2_HASH_SAMPLE_PERCENT;

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalHashSamplePercent === undefined)
      delete process.env.ATHENA_SYNC_V2_HASH_SAMPLE_PERCENT;
    else
      process.env.ATHENA_SYNC_V2_HASH_SAMPLE_PERCENT =
        originalHashSamplePercent;
  });
  test("treats replace/delete root changes as conflicting with any field", () => {
    expect(SyncV2._pathsOverlap(["$"], ["profile.name"])).toBe(true);
    expect(SyncV2._pathsOverlap(["theme"], ["language"])).toBe(false);
  });

  test("keeps lazy projections out of manifest-time materialization", () => {
    expect(
      SyncV2._startupMaterializationKeys([
        "users/7/profile",
        "users/7/security/clients",
        "workspaces/4/metadata",
        "workspaces/4/members",
        "workspaces/4/permissions",
        "workspaces/4/documents",
        "threads/9/metadata",
        "threads/9/messages",
        "users/7/profile",
      ])
    ).toEqual(["users/7/profile", "workspaces/4/metadata"]);
  });

  test("deduplicates an Auth DB sidechain event with the same source revision", async () => {
    jest.spyOn(SyncV2, "enabled").mockReturnValue(true);
    jest.spyOn(SyncV2, "schemaReady").mockResolvedValue(true);
    jest.spyOn(prisma.users, "findUnique").mockResolvedValue({ id: 42 });
    const existing = {
      nodeKey: "users/42/security/sessions",
      ownerType: "user",
      ownerId: 42,
      visibility: "user",
      schemaVersion: 1,
      stateVersion: 7,
      updatedAt: new Date("2026-07-19T00:00:00.000Z"),
    };
    const tx = {
      sync_outbox: {
        findFirst: jest.fn().mockResolvedValue({
          payloadHintJson: JSON.stringify({ sourceRevision: "revision-a" }),
        }),
      },
      sync_nodes: {
        findUnique: jest.fn().mockResolvedValue(existing),
      },
    };
    jest
      .spyOn(prisma, "$transaction")
      .mockImplementation(async (callback) => callback(tx));
    const record = jest.spyOn(SyncV2, "recordNodeChange");

    const result = await SyncV2.recordAuthSessionChange({
      authUserId: 7001,
      sourceRevision: "revision-a",
      payloadHint: { sourceRevision: "revision-a" },
    });

    expect(record).not.toHaveBeenCalled();
    expect(result).toEqual({ node: SyncV2._descriptor(existing), event: null });
  });

  test("allows a stale mutation to rebase only with complete disjoint history", async () => {
    const tx = {
      sync_nodes: {
        findUnique: jest.fn().mockResolvedValue({
          nodeKey: "users/7/profile",
          ownerType: "user",
          ownerId: 7,
          visibility: "user",
          schemaVersion: 1,
          stateVersion: 3,
          updatedAt: new Date("2026-07-17T12:00:00.000Z"),
        }),
      },
      sync_outbox: {
        findMany: jest.fn().mockResolvedValue([
          { stateVersion: 2, changedPathsJson: '["bio"]' },
          { stateVersion: 3, changedPathsJson: '["displayName"]' },
        ]),
      },
    };

    await expect(
      SyncV2.assertMutationVersion(tx, {
        nodeKey: "users/7/profile",
        baseVersion: 1,
        changedPaths: ["username"],
      })
    ).resolves.toMatchObject({ stateVersion: 3 });
  });

  test("rejects stale mutations when retained outbox history has a gap", async () => {
    const tx = {
      sync_nodes: {
        findUnique: jest.fn().mockResolvedValue({
          nodeKey: "users/7/profile",
          ownerType: "user",
          ownerId: 7,
          visibility: "user",
          schemaVersion: 1,
          stateVersion: 4,
          updatedAt: new Date("2026-07-17T12:00:00.000Z"),
        }),
      },
      sync_outbox: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { stateVersion: 4, changedPathsJson: '["bio"]' },
          ]),
      },
    };

    await expect(
      SyncV2.assertMutationVersion(tx, {
        nodeKey: "users/7/profile",
        baseVersion: 1,
        changedPaths: ["username"],
      })
    ).rejects.toMatchObject({
      code: "state_version_conflict",
      requiresFullSync: true,
      conflictReason: "version_history_unavailable",
    });
  });

  test("increments a registered node and appends the matching outbox event", async () => {
    const tx = {
      sync_nodes: {
        upsert: jest.fn().mockResolvedValue({
          nodeKey: "users/7/profile",
          ownerType: "user",
          ownerId: 7,
          visibility: "user",
          schemaVersion: 1,
          stateVersion: 3,
          contentHash: "sha256:test",
          updatedAt: new Date("2026-07-17T12:00:00.000Z"),
        }),
      },
      sync_outbox: {
        create: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ ...data, seq: 14 })
          ),
      },
    };

    const result = await SyncV2.recordNodeChange(tx, {
      nodeKey: "users/7/profile",
      content: { id: 7, displayName: "Athena" },
      changedPaths: ["displayName"],
      mutationId: "mutation-1",
      audience: [7],
    });

    expect(tx.sync_nodes.upsert).toHaveBeenCalledTimes(1);
    expect(tx.sync_outbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nodeKey: "users/7/profile",
          stateVersion: 3,
          mutationId: "mutation-1",
        }),
      })
    );
    expect(result.node.stateVersion).toBe(3);
    expect(result.event.seq).toBe(14);
  });

  test("omits content hashes from event cursor descriptors", async () => {
    const tx = {
      sync_nodes: {
        upsert: jest.fn().mockResolvedValue({
          nodeKey: "threads/9/messages",
          ownerType: "thread",
          ownerId: 9,
          visibility: "thread",
          schemaVersion: 1,
          stateVersion: 4,
          contentHash: null,
          updatedAt: new Date("2026-07-17T12:00:00.000Z"),
        }),
      },
      sync_outbox: {
        create: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ ...data, seq: 15 })
          ),
      },
    };

    const result = await SyncV2.recordNodeChange(tx, {
      nodeKey: "threads/9/messages",
      content: { historyRevision: 4 },
      changedPaths: ["messages.12"],
    });

    expect(tx.sync_nodes.upsert.mock.calls[0][0].create.contentHash).toBeNull();
    expect(tx.sync_nodes.upsert.mock.calls[0][0].update.contentHash).toBeNull();
    expect(result.node).not.toHaveProperty("hash");
  });

  test("emits the first snapshot at state version one", async () => {
    const tx = {
      sync_nodes: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({
          nodeKey: "users/7/security/passkeys",
          ownerType: "user",
          ownerId: 7,
          visibility: "user",
          schemaVersion: 1,
          stateVersion: 1,
          contentHash: "sha256:first",
          updatedAt: new Date("2026-07-17T12:00:00.000Z"),
        }),
      },
      sync_outbox: {
        create: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ ...data, seq: 16 })
          ),
      },
    };
    const transaction = jest
      .spyOn(prisma, "$transaction")
      .mockImplementationOnce(async (callback) => await callback(tx));

    const result = await SyncV2.reconcileNode({
      nodeKey: "users/7/security/passkeys",
      content: [{ id: 1, deviceName: "Phone" }],
      emitOnCreate: true,
    });

    expect(tx.sync_nodes.upsert).toHaveBeenCalledTimes(1);
    expect(tx.sync_nodes.upsert.mock.calls[0][0].create.stateVersion).toBe(1);
    expect(result.node.stateVersion).toBe(1);
    expect(result.event.stateVersion).toBe(1);
    transaction.mockRestore();
  });

  test("advances an idle client to the global checkpoint across invisible events", async () => {
    jest
      .spyOn(prisma.users, "findUnique")
      .mockResolvedValue({ role: "default" });
    jest
      .spyOn(prisma.sync_outbox, "findFirst")
      .mockResolvedValueOnce({ seq: 7 })
      .mockResolvedValueOnce({ seq: 1 });
    jest.spyOn(prisma.workspace_users, "findMany").mockResolvedValue([]);
    jest.spyOn(prisma.workspace_threads, "findMany").mockResolvedValue([]);
    jest.spyOn(prisma.sync_outbox, "findMany").mockResolvedValue([]);

    const result = await SyncV2.eventsAfter({
      userId: 42,
      allowAllWorkspaces: false,
      after: 0,
      limit: 200,
    });

    expect(result).toMatchObject({
      events: [],
      checkpointSeq: 7,
      nextSeq: 7,
      hasMore: false,
      requiresFullSync: false,
    });
  });

  test("manifests every registered node owned by an authorized thread", async () => {
    jest
      .spyOn(prisma.users, "findUnique")
      .mockResolvedValue({ role: "default" });
    jest.spyOn(SyncV2, "materializeCoreForUser").mockResolvedValue([]);
    jest
      .spyOn(prisma.workspace_users, "findMany")
      .mockResolvedValue([{ workspace_id: 4 }]);
    jest
      .spyOn(prisma.workspace_threads, "findMany")
      .mockResolvedValue([{ id: 9 }]);
    const nodeQuery = jest
      .spyOn(prisma.sync_nodes, "findMany")
      .mockResolvedValue([]);
    jest.spyOn(prisma.sync_outbox, "findFirst").mockResolvedValue({ seq: 7 });

    await SyncV2.manifestForUser({ userId: 42 });

    expect(nodeQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: expect.arrayContaining([
            { ownerType: "thread", ownerId: { in: [9] } },
          ]),
        },
      })
    );
  });

  test("returns a compact manifest when the visible node tree is unchanged", async () => {
    jest
      .spyOn(prisma.users, "findUnique")
      .mockResolvedValue({ role: "default" });
    jest.spyOn(SyncV2, "materializeCoreForUser").mockResolvedValue([]);
    jest.spyOn(prisma.workspace_users, "findMany").mockResolvedValue([]);
    jest.spyOn(prisma.workspace_threads, "findMany").mockResolvedValue([]);
    jest.spyOn(prisma.sync_nodes, "findMany").mockResolvedValue([
      {
        nodeKey: "users/42/profile",
        parentKey: "users/42",
        ownerType: "user",
        ownerId: 42,
        visibility: "user",
        schemaVersion: 1,
        stateVersion: 3,
        contentHash: "sha256:profile",
        hashAlgorithm: "sha256",
        updatedAt: new Date("2026-07-17T12:00:00.000Z"),
        deletedAt: null,
      },
    ]);
    jest.spyOn(prisma.sync_outbox, "findFirst").mockResolvedValue({ seq: 7 });

    const full = await SyncV2.manifestForUser({ userId: 42 });
    const compact = await SyncV2.manifestForUser({
      userId: 42,
      knownManifestHash: full.manifestHash,
    });

    expect(full).toMatchObject({ unchanged: false, checkpointSeq: 7 });
    expect(full.nodes).toHaveLength(1);
    expect(compact).toEqual({
      checkpointSeq: 7,
      manifestHash: full.manifestHash,
      unchanged: true,
      nodes: [],
    });
  });

  test("batchGet shares visibility and node metadata reads across the page", async () => {
    const user = {
      id: 42,
      username: "athena",
      displayName: "Athena",
      role: "default",
      status: "active",
      allowedEnvs: "[]",
      ownerType: "user",
      suspended: false,
      password: "configured",
    };
    const profile = userProfileProjection(user);
    const policies = userSecurityPolicyProjection(user);
    const rows = [
      {
        nodeKey: "users/42/profile",
        parentKey: "users/42",
        ownerType: "user",
        ownerId: 42,
        visibility: "user",
        schemaVersion: 1,
        stateVersion: 3,
        contentHash: contentHash(profile),
        hashAlgorithm: "sha256",
        updatedAt: new Date("2026-07-18T00:00:00.000Z"),
        deletedAt: null,
      },
      {
        nodeKey: "users/42/security/policies",
        parentKey: "users/42/security",
        ownerType: "user",
        ownerId: 42,
        visibility: "user",
        schemaVersion: 1,
        stateVersion: 5,
        contentHash: contentHash(policies),
        hashAlgorithm: "sha256",
        updatedAt: new Date("2026-07-18T00:00:00.000Z"),
        deletedAt: null,
      },
    ];
    const membershipQuery = jest
      .spyOn(prisma.workspace_users, "findMany")
      .mockResolvedValue([]);
    const nodeQuery = jest
      .spyOn(prisma.sync_nodes, "findMany")
      .mockResolvedValue(rows);
    const perNodeQuery = jest.spyOn(prisma.sync_nodes, "findUnique");
    const payloadQuery = jest
      .spyOn(prisma.users, "findUnique")
      .mockResolvedValue(user);
    const reconcile = jest.spyOn(SyncV2, "reconcileNode");

    const result = await SyncV2.batchGet({
      userId: 42,
      nodes: [
        {
          nodeKey: rows[0].nodeKey,
          knownVersion: rows[0].stateVersion,
          knownHash: rows[0].contentHash,
        },
        {
          nodeKey: rows[1].nodeKey,
          knownVersion: rows[1].stateVersion,
          knownHash: rows[1].contentHash,
        },
        {
          nodeKey: rows[0].nodeKey,
          knownVersion: rows[0].stateVersion - 1,
          knownHash: "stale-hash",
        },
      ],
    });

    expect(result).toHaveLength(2);
    expect(result.every((entry) => entry.unchanged)).toBe(true);
    expect(membershipQuery).toHaveBeenCalledTimes(1);
    expect(nodeQuery).toHaveBeenCalledTimes(1);
    expect(perNodeQuery).not.toHaveBeenCalled();
    expect(payloadQuery).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  test("batchGet rejects revoked workspace scope before metadata or payload reads", async () => {
    jest.spyOn(prisma.workspace_users, "findMany").mockResolvedValue([]);
    const nodeQuery = jest.spyOn(prisma.sync_nodes, "findMany");
    const payloadQuery = jest.spyOn(prisma.workspaces, "findUnique");

    const result = await SyncV2.batchGet({
      userId: 42,
      nodes: [{ nodeKey: "workspaces/4/metadata", knownVersion: 1 }],
    });

    expect(result).toEqual([]);
    expect(nodeQuery).not.toHaveBeenCalled();
    expect(payloadQuery).not.toHaveBeenCalled();
  });

  test("batchGet reuses one user projection across changed user nodes", async () => {
    const user = {
      id: 42,
      username: "athena",
      role: "default",
      status: "active",
      allowedEnvs: "[]",
      ownerType: "user",
      suspended: false,
      password: "configured",
    };
    const rows = [
      {
        nodeKey: "users/42/profile",
        ownerType: "user",
        ownerId: 42,
        visibility: "user",
        schemaVersion: 1,
        stateVersion: 3,
        contentHash: contentHash(userProfileProjection(user)),
        updatedAt: new Date("2026-07-18T00:00:00.000Z"),
      },
      {
        nodeKey: "users/42/security/policies",
        ownerType: "user",
        ownerId: 42,
        visibility: "user",
        schemaVersion: 1,
        stateVersion: 5,
        contentHash: contentHash(userSecurityPolicyProjection(user)),
        updatedAt: new Date("2026-07-18T00:00:00.000Z"),
      },
    ];
    jest.spyOn(prisma.workspace_users, "findMany").mockResolvedValue([]);
    jest.spyOn(prisma.sync_nodes, "findMany").mockResolvedValue(rows);
    const userQuery = jest
      .spyOn(prisma.users, "findUnique")
      .mockResolvedValue(user);
    const reconcile = jest.spyOn(SyncV2, "reconcileNode");

    const result = await SyncV2.batchGet({
      userId: 42,
      nodes: rows.map((row) => ({
        nodeKey: row.nodeKey,
        knownVersion: 0,
      })),
    });

    expect(result).toHaveLength(2);
    expect(result.every((entry) => !entry.unchanged && entry.payload)).toBe(
      true
    );
    expect(userQuery).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
  });

  test("sampled Hash verification repairs same-version domain drift", async () => {
    process.env.ATHENA_SYNC_V2_HASH_SAMPLE_PERCENT = "100";
    const currentUser = { id: 42, username: "current" };
    const existing = {
      nodeKey: "users/42/profile",
      ownerType: "user",
      ownerId: 42,
      visibility: "user",
      schemaVersion: 1,
      stateVersion: 3,
      contentHash: contentHash({ id: 42, username: "stale" }),
      updatedAt: new Date("2026-07-18T00:00:00.000Z"),
    };
    jest.spyOn(prisma.workspace_users, "findMany").mockResolvedValue([]);
    jest.spyOn(prisma.sync_nodes, "findMany").mockResolvedValue([existing]);
    jest.spyOn(prisma.users, "findUnique").mockResolvedValue(currentUser);
    const repairedDescriptor = {
      ...SyncV2._descriptor(existing),
      stateVersion: 4,
      hash: contentHash(userProfileProjection(currentUser)),
    };
    const reconcile = jest.spyOn(SyncV2, "reconcileNode").mockResolvedValue({
      node: repairedDescriptor,
      event: { seq: 9 },
    });

    const [result] = await SyncV2.batchGet({
      userId: 42,
      nodes: [
        {
          nodeKey: existing.nodeKey,
          knownVersion: existing.stateVersion,
          knownHash: existing.contentHash,
        },
      ],
    });

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ unchanged: false, repaired: true });
  });
});
