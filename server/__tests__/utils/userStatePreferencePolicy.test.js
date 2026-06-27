const mockGetAuthorizedWorkspace = jest.fn();
const mockGetAuthorizedWorkspaceThread = jest.fn();
const mockGetAuthorizedFileBackedResource = jest.fn();

jest.mock("../../utils/authz/resourceAccess", () => ({
  getAuthorizedWorkspace: (...args) => mockGetAuthorizedWorkspace(...args),
  getAuthorizedWorkspaceThread: (...args) =>
    mockGetAuthorizedWorkspaceThread(...args),
  getAuthorizedFileBackedResource: (...args) =>
    mockGetAuthorizedFileBackedResource(...args),
}));

const {
  parseNamespaceFilter,
  validateUserStateInput,
  validateUserStateScope,
} = require("../../utils/userStatePreferencePolicy");

describe("user state preference policy", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthorizedWorkspace.mockResolvedValue({ id: 1, slug: "ws-a" });
    mockGetAuthorizedWorkspaceThread.mockResolvedValue({
      workspace: { id: 1, slug: "ws-a" },
      thread: { id: 2, slug: "thread-a" },
    });
    mockGetAuthorizedFileBackedResource.mockResolvedValue({
      user: { id: 10 },
    });
  });

  it("filters namespace query values to the allowlist", () => {
    expect(
      parseNamespaceFilter(
        "recent.navigation,unknown,chat.draft,preferences.appearance"
      )
    ).toEqual(["recent.navigation", "chat.draft", "preferences.appearance"]);
  });

  it("allows global low-risk preferences", async () => {
    const result = await validateUserStateInput({
      state: {
        namespace: "preferences.appearance",
        scope: "global",
        value: { theme: "dark" },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      state: {
        namespace: "preferences.appearance",
        scope: "global",
        value: { theme: "dark" },
      },
    });
  });

  it("rejects unknown namespaces and over-large drafts", async () => {
    await expect(
      validateUserStateInput({
        state: { namespace: "debug.anything", value: {} },
      })
    ).resolves.toMatchObject({ ok: false, status: 400 });

    await expect(
      validateUserStateInput({
        state: {
          namespace: "chat.draft",
          scope: "global",
          value: { text: "x".repeat(70 * 1024) },
        },
      })
    ).resolves.toMatchObject({ ok: false, status: 413 });
  });

  it("requires scoped resources to be authorized", async () => {
    await expect(
      validateUserStateScope({
        namespace: "chat.draft",
        scope: "thread:ws-a:thread-a",
      })
    ).resolves.toMatchObject({ ok: true });
    expect(mockGetAuthorizedWorkspaceThread).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceSlug: "ws-a",
        threadSlug: "thread-a",
      })
    );

    mockGetAuthorizedWorkspaceThread.mockResolvedValueOnce({
      workspace: null,
      thread: null,
    });
    await expect(
      validateUserStateScope({
        namespace: "chat.draft",
        scope: "thread:ws-b:thread-b",
      })
    ).resolves.toMatchObject({ ok: false, status: 404 });
  });
});
