const mockFindAuthById = jest.fn();
const mockBootstrapAuthUser = jest.fn();
const mockCanLogin = jest.fn();
const mockEnsureShadowUser = jest.fn();
const mockIsMultiUserMode = jest.fn();
const mockUserGet = jest.fn();
const mockUserFilterFields = jest.fn();
const mockWorkspaceGet = jest.fn();
const mockWorkspaceGetWithUser = jest.fn();
const mockInvocationGet = jest.fn();
const mockParsedFileGet = jest.fn();
const mockChatGet = jest.fn();
const mockThreadGet = jest.fn();
const mockIsCodexBypassEnabled = jest.fn();
const mockCodexDevAuthUser = jest.fn();
const mockDecodeJwt = jest.fn();
const mockJwtIdleState = jest.fn();

jest.mock("../../models/authIdentity", () => ({
  AuthIdentity: {
    findById: (...args) => mockFindAuthById(...args),
    bootstrapAuthUserFromShadow: (...args) => mockBootstrapAuthUser(...args),
    canLoginInCurrentEnvAsync: (...args) => mockCanLogin(...args),
    ensureShadowUser: (...args) => mockEnsureShadowUser(...args),
  },
}));

jest.mock("../../models/systemSettings", () => ({
  SystemSettings: {
    isMultiUserMode: (...args) => mockIsMultiUserMode(...args),
  },
}));

jest.mock("../../models/user", () => ({
  User: {
    _get: (...args) => mockUserGet(...args),
    filterFields: (...args) => mockUserFilterFields(...args),
  },
}));

jest.mock("../../models/workspace", () => ({
  Workspace: {
    get: (...args) => mockWorkspaceGet(...args),
    getWithUser: (...args) => mockWorkspaceGetWithUser(...args),
  },
}));

jest.mock("../../models/workspaceAgentInvocation", () => ({
  WorkspaceAgentInvocation: {
    get: (...args) => mockInvocationGet(...args),
  },
}));

jest.mock("../../models/workspaceChats", () => ({
  WorkspaceChats: {
    get: (...args) => mockChatGet(...args),
  },
}));

jest.mock("../../models/workspaceParsedFiles", () => ({
  WorkspaceParsedFiles: {
    get: (...args) => mockParsedFileGet(...args),
  },
}));

jest.mock("../../models/workspaceThread", () => ({
  WorkspaceThread: {
    get: (...args) => mockThreadGet(...args),
  },
}));

jest.mock("../../utils/codexDevAuthBypass", () => ({
  codexDevAuthUser: (...args) => mockCodexDevAuthUser(...args),
  isCodexDevAuthBypassEnabled: (...args) =>
    mockIsCodexBypassEnabled(...args),
}));

jest.mock("../../utils/http", () => ({
  decodeJWT: (...args) => mockDecodeJwt(...args),
}));

jest.mock("../../utils/sessionIdle", () => ({
  jwtIdleState: (...args) => mockJwtIdleState(...args),
}));

const {
  fileBackedOwnerMetadata,
  getAuthorizedAgentInvocation,
  getAuthorizedFileBackedResource,
  getAuthorizedParsedFile,
  getAuthorizedWorkspace,
  getAuthorizedWorkspaceChat,
  getAuthorizedWorkspaceThread,
  getScopedWorkspaceChat,
  recordResourceAccessAudit,
  stripFileBackedOwnerMetadata,
} = require("../../utils/authz/resourceAccess");

function requestWithToken(token = "owner-token") {
  return {
    query: {},
    headers: { authorization: `Bearer ${token}` },
    header(name) {
      return name === "Authorization" ? this.headers.authorization : null;
    },
  };
}

describe("resource access authorization helpers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsCodexBypassEnabled.mockReturnValue(false);
    mockIsMultiUserMode.mockResolvedValue(true);
    mockDecodeJwt.mockImplementation((token) => {
      if (token === "owner-token") return { id: 10, authUserId: "auth-10" };
      if (token === "other-token") return { id: 11, authUserId: "auth-11" };
      return null;
    });
    mockJwtIdleState.mockReturnValue({ idleExpired: false });
    mockUserGet.mockImplementation(({ id }) =>
      Promise.resolve({ id, authUserId: `auth-${id}` })
    );
    mockFindAuthById.mockImplementation((id) => Promise.resolve({ id }));
    mockBootstrapAuthUser.mockImplementation((shadow) =>
      Promise.resolve({ id: shadow.authUserId })
    );
    mockCanLogin.mockResolvedValue(true);
    mockEnsureShadowUser.mockImplementation((authUser) => {
      const id = authUser.id === "auth-10" ? 10 : 11;
      return Promise.resolve({ id, authUserId: authUser.id });
    });
    mockUserFilterFields.mockImplementation((user) => user);
    mockWorkspaceGet.mockResolvedValue({ id: 22, slug: "workspace-a" });
    mockWorkspaceGetWithUser.mockResolvedValue({
      id: 22,
      slug: "workspace-a",
    });
    mockParsedFileGet.mockResolvedValue({ id: 7, workspaceId: 22, userId: 10 });
    mockChatGet.mockResolvedValue({
      id: 44,
      workspaceId: 22,
      thread_id: 9,
      user_id: 10,
      include: true,
    });
    mockThreadGet.mockResolvedValue({
      id: 9,
      slug: "thread-a",
      workspace_id: 22,
      user_id: 10,
    });
    mockInvocationGet.mockResolvedValue({
      uuid: "agent-uuid",
      workspace_id: 22,
      user_id: 10,
      closed: false,
    });
  });

  it("uses workspace ownership in multi-user mode", async () => {
    const workspace = await getAuthorizedWorkspace({
      request: requestWithToken(),
      workspaceSlug: "workspace-a",
    });

    expect(workspace).toEqual({ id: 22, slug: "workspace-a" });
    expect(mockWorkspaceGetWithUser).toHaveBeenCalledWith(
      { id: 10, authUserId: "auth-10" },
      { slug: "workspace-a" }
    );
    expect(mockWorkspaceGet).not.toHaveBeenCalled();
  });

  it("returns null when a workspace is not owned by the current user", async () => {
    mockWorkspaceGetWithUser.mockResolvedValue(null);

    await expect(
      getAuthorizedWorkspace({
        request: requestWithToken("other-token"),
        workspaceId: 22,
      })
    ).resolves.toBeNull();
  });

  it("scopes workspace threads by workspace and user", async () => {
    const result = await getAuthorizedWorkspaceThread({
      request: requestWithToken(),
      workspaceSlug: "workspace-a",
      threadSlug: "thread-a",
    });

    expect(result.thread).toEqual(
      expect.objectContaining({ id: 9, slug: "thread-a" })
    );
    expect(mockThreadGet).toHaveBeenCalledWith({
      slug: "thread-a",
      workspace_id: 22,
      user_id: 10,
    });
  });

  it("scopes parsed files by id, workspace, and user", async () => {
    const parsedFile = await getAuthorizedParsedFile({
      request: requestWithToken(),
      workspace: { id: 22 },
      fileId: "7",
    });

    expect(parsedFile).toEqual({ id: 7, workspaceId: 22, userId: 10 });
    expect(mockParsedFileGet).toHaveBeenCalledWith({
      id: 7,
      workspaceId: 22,
      userId: 10,
    });
  });

  it("scopes workspace chats by chat, workspace, thread, user, and include", async () => {
    const chat = await getScopedWorkspaceChat({
      chatId: 44,
      workspaceId: 22,
      threadId: 9,
      userId: 10,
      include: true,
    });

    expect(chat).toEqual(
      expect.objectContaining({ id: 44, workspaceId: 22, thread_id: 9 })
    );
    expect(mockChatGet).toHaveBeenCalledWith({
      id: 44,
      workspaceId: 22,
      thread_id: 9,
      user_id: 10,
      include: true,
    });
  });

  it("authorizes workspace chats through workspace ownership in multi-user mode", async () => {
    const result = await getAuthorizedWorkspaceChat({
      request: requestWithToken(),
      workspaceSlug: "workspace-a",
      chatId: 44,
      threadId: 9,
      include: true,
    });

    expect(result.chat).toEqual(expect.objectContaining({ id: 44 }));
    expect(mockChatGet).toHaveBeenCalledWith({
      id: 44,
      workspaceId: 22,
      thread_id: 9,
      user_id: 10,
      include: true,
    });
  });

  it("falls back to unscoped single-user workspace chats for legacy rows", async () => {
    mockIsMultiUserMode.mockResolvedValue(false);
    mockChatGet
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 44, workspaceId: 22, user_id: null });

    const result = await getAuthorizedWorkspaceChat({
      request: requestWithToken(),
      workspaceId: 22,
      chatId: 44,
    });

    expect(result.chat).toEqual({ id: 44, workspaceId: 22, user_id: null });
    expect(mockChatGet).toHaveBeenNthCalledWith(1, {
      id: 44,
      workspaceId: 22,
      user_id: 10,
    });
    expect(mockChatGet).toHaveBeenNthCalledWith(2, {
      id: 44,
      workspaceId: 22,
    });
  });

  it("authorizes only the invocation owner in multi-user mode", async () => {
    await expect(
      getAuthorizedAgentInvocation({
        request: requestWithToken(),
        uuid: "agent-uuid",
      })
    ).resolves.toEqual(
      expect.objectContaining({
        invocation: expect.objectContaining({ uuid: "agent-uuid" }),
        workspace: expect.objectContaining({ id: 22 }),
        user: expect.objectContaining({ id: 10 }),
      })
    );

    await expect(
      getAuthorizedAgentInvocation({
        request: requestWithToken("other-token"),
        uuid: "agent-uuid",
      })
    ).resolves.toBeNull();
  });

  it("keeps single-user mode behavior without a bearer token", async () => {
    mockIsMultiUserMode.mockResolvedValue(false);

    const workspace = await getAuthorizedWorkspace({
      request: { query: {}, headers: {} },
      workspaceId: 22,
    });

    expect(workspace).toEqual({ id: 22, slug: "workspace-a" });
    expect(mockWorkspaceGet).toHaveBeenCalledWith({ id: 22 });
  });

  it("uses token user scope for single-user thread rows when available", async () => {
    mockIsMultiUserMode.mockResolvedValue(false);

    const result = await getAuthorizedWorkspaceThread({
      request: requestWithToken(),
      workspaceId: 22,
      threadSlug: "thread-a",
    });

    expect(result.thread).toEqual(
      expect.objectContaining({ id: 9, slug: "thread-a" })
    );
    expect(mockThreadGet).toHaveBeenCalledWith({
      slug: "thread-a",
      workspace_id: 22,
      user_id: 10,
    });
  });

  it("falls back to unscoped single-user parsed files for legacy rows", async () => {
    mockIsMultiUserMode.mockResolvedValue(false);
    mockParsedFileGet
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 7, workspaceId: 22, userId: null });

    const parsedFile = await getAuthorizedParsedFile({
      request: requestWithToken(),
      workspace: { id: 22 },
      fileId: "7",
    });

    expect(parsedFile).toEqual({ id: 7, workspaceId: 22, userId: null });
    expect(mockParsedFileGet).toHaveBeenNthCalledWith(1, {
      id: 7,
      workspaceId: 22,
      userId: 10,
    });
    expect(mockParsedFileGet).toHaveBeenNthCalledWith(2, {
      id: 7,
      workspaceId: 22,
    });
  });

  it("builds and strips file-backed owner metadata", () => {
    expect(fileBackedOwnerMetadata({ id: 10, authUserId: "auth-10" })).toEqual(
      {
        ownerScopeVersion: 1,
        ownerUserId: 10,
        ownerAuthUserId: "auth-10",
      }
    );

    expect(
      stripFileBackedOwnerMetadata({
        title: "Reader",
        ownerScopeVersion: 1,
        ownerUserId: 10,
        ownerAuthUserId: "auth-10",
      })
    ).toEqual({ title: "Reader" });
  });

  it("authorizes file-backed resources by owner in multi-user mode", async () => {
    await expect(
      getAuthorizedFileBackedResource({
        request: requestWithToken(),
        metadata: { ownerScopeVersion: 1, ownerUserId: 10 },
        resourceType: "standalone_reader_document",
        resourceId: "reader-1",
      })
    ).resolves.toEqual(
      expect.objectContaining({ user: expect.objectContaining({ id: 10 }) })
    );

    await expect(
      getAuthorizedFileBackedResource({
        request: requestWithToken("other-token"),
        metadata: { ownerScopeVersion: 1, ownerUserId: 10 },
        resourceType: "standalone_reader_document",
        resourceId: "reader-1",
      })
    ).resolves.toBeNull();
  });

  it("fails closed for legacy ownerless file-backed resources in multi-user mode", async () => {
    await expect(
      getAuthorizedFileBackedResource({
        request: requestWithToken(),
        metadata: { title: "legacy" },
        resourceType: "standalone_reader_document",
        resourceId: "reader-legacy",
      })
    ).resolves.toBeNull();
  });

  it("allows legacy ownerless file-backed resources in single-user mode", async () => {
    mockIsMultiUserMode.mockResolvedValue(false);

    await expect(
      getAuthorizedFileBackedResource({
        request: { query: {}, headers: {} },
        metadata: { title: "legacy" },
        resourceType: "standalone_reader_document",
        resourceId: "reader-legacy",
      })
    ).resolves.toEqual(expect.objectContaining({ user: null }));
  });

  it("resource access debug audit hashes resource identifiers", () => {
    const originalDebug = process.env.ATHENA_RESOURCE_ACCESS_DEBUG;
    process.env.ATHENA_RESOURCE_ACCESS_DEBUG = "1";
    const debugSpy = jest.spyOn(console, "debug").mockImplementation(() => {});

    recordResourceAccessAudit({
      resourceType: "workspace_chat",
      resourceId: "chat-secret-id",
      userId: 10,
      result: "denied",
      reason: "not_found_or_not_owned",
    });

    expect(debugSpy).toHaveBeenCalledWith(
      "[resource-access]",
      expect.objectContaining({
        resourceType: "workspace_chat",
        resourceIdHash: expect.any(String),
        userId: 10,
        result: "denied",
        reason: "not_found_or_not_owned",
      })
    );
    expect(debugSpy.mock.calls[0][1].resourceId).toBeUndefined();
    expect(JSON.stringify(debugSpy.mock.calls[0][1])).not.toContain(
      "chat-secret-id"
    );

    debugSpy.mockRestore();
    if (originalDebug === undefined)
      delete process.env.ATHENA_RESOURCE_ACCESS_DEBUG;
    else process.env.ATHENA_RESOURCE_ACCESS_DEBUG = originalDebug;
  });
});
