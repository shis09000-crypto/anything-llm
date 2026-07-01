describe("mobile stream chat mode", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.dontMock("../../models/workspace");
    jest.dontMock("../../utils/chats/apiChatHandler");
    jest.dontMock("../../utils/http");
    jest.dontMock("../../utils/prisma");
    jest.dontMock("../../endpoints/utils");
    jest.dontMock("../../models/mobileDevice");
    jest.dontMock("../../utils/security/transportSecurity");
    jest.dontMock("../../utils/security/chatHistoryEncryption");
  });

  function responseMock() {
    const response = {
      locals: { user: { id: 7 } },
      status: jest.fn(),
      json: jest.fn(),
      flushHeaders: jest.fn(),
      end: jest.fn(),
    };
    response.status.mockReturnValue(response);
    response.json.mockReturnValue(response);
    return response;
  }

  async function invokeStreamChat(workspaceOverrides = {}) {
    const streamChat = jest.fn();
    const workspace = {
      id: 12,
      slug: "workspace-a",
      chatMode: "automatic",
      ...workspaceOverrides,
    };

    jest.doMock("../../models/workspace", () => ({
      Workspace: {
        getWithUser: jest.fn(async () => workspace),
        get: jest.fn(async () => workspace),
      },
    }));
    jest.doMock("../../models/workspaceChats", () => ({
      WorkspaceChats: {
        markThreadHistoryInvalidV2: jest.fn(),
      },
    }));
    jest.doMock("../../models/workspaceThread", () => ({
      WorkspaceThread: {
        new: jest.fn(),
      },
    }));
    jest.doMock("../../utils/chats/apiChatHandler", () => ({
      ApiChatHandler: { streamChat },
    }));
    jest.doMock("../../utils/http", () => ({
      reqBody: (request) => request.body,
    }));
    jest.doMock("../../utils/prisma", () => ({
      workspace_threads: {
        findFirst: jest.fn(async () => ({ id: 44, slug: "thread-a" })),
      },
      workspace_chats: {
        count: jest.fn(),
        findMany: jest.fn(),
      },
    }));
    jest.doMock("../../endpoints/utils", () => ({
      getModelTag: jest.fn(() => "model"),
    }));
    jest.doMock("../../models/mobileDevice", () => ({
      MobileDevice: { platform: "mobile" },
    }));
    jest.doMock("../../utils/security/transportSecurity", () => ({
      setSseTransportHeaders: jest.fn(),
    }));
    jest.doMock("../../utils/security/chatHistoryEncryption", () => ({
      decryptWorkspaceChatRecordsAsync: jest.fn(async (records) => records),
    }));

    const { handleMobileCommand } = require("../../endpoints/mobile/utils");
    const response = responseMock();
    await handleMobileCommand(
      {
        params: { command: "stream-chat" },
        body: {
          workspaceSlug: "workspace-a",
          threadSlug: "thread-a",
          message: "Search the latest web news.",
        },
      },
      response
    );

    return { streamChat, response };
  }

  it("uses the workspace chat mode for mobile stream chat", async () => {
    const { streamChat, response } = await invokeStreamChat({
      chatMode: "automatic",
    });

    expect(response.flushHeaders).toHaveBeenCalled();
    expect(response.end).toHaveBeenCalled();
    expect(streamChat).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "automatic" })
    );
  });

  it("falls back to automatic when the workspace has no chat mode", async () => {
    const { streamChat } = await invokeStreamChat({ chatMode: null });

    expect(streamChat).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "automatic" })
    );
  });
});
