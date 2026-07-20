const {
  _internals: { hydrateWorkspaceChatRelations },
} = require("../../models/workspaceChats");

describe("WorkspaceChats relation hydration", () => {
  test("loads workspace and user relations in two bounded queries", async () => {
    const client = {
      workspaces: {
        findMany: jest.fn().mockResolvedValue([
          { id: 10, name: "Workspace A", slug: "workspace-a" },
          { id: 11, name: "Workspace B", slug: "workspace-b" },
        ]),
      },
      users: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 20, username: "athena" }]),
      },
    };
    const rows = await hydrateWorkspaceChatRelations(client, [
      { id: 1, workspaceId: 10, user_id: 20, api_session_id: null },
      { id: 2, workspaceId: 10, user_id: 20, api_session_id: null },
      { id: 3, workspaceId: 11, user_id: null, api_session_id: "api-1" },
      { id: 4, workspaceId: 99, user_id: 99, api_session_id: null },
    ]);

    expect(client.workspaces.findMany).toHaveBeenCalledTimes(1);
    expect(client.users.findMany).toHaveBeenCalledTimes(1);
    expect(client.workspaces.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [10, 11, 99] } } })
    );
    expect(client.users.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [20, 99] } } })
    );
    expect(rows[0]).toMatchObject({
      workspace: { name: "Workspace A", slug: "workspace-a" },
      user: { username: "athena" },
    });
    expect(rows[2].user).toEqual({ username: "API" });
    expect(rows[3]).toMatchObject({
      workspace: { name: "deleted workspace", slug: null },
      user: { username: "unknown user" },
    });
  });

  test("does not query empty relation sets", async () => {
    const client = {
      workspaces: { findMany: jest.fn() },
      users: { findMany: jest.fn() },
    };
    await expect(hydrateWorkspaceChatRelations(client, [])).resolves.toEqual(
      []
    );
    expect(client.workspaces.findMany).not.toHaveBeenCalled();
    expect(client.users.findMany).not.toHaveBeenCalled();
  });
});
