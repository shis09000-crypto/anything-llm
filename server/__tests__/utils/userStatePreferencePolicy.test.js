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
  namespacePolicy,
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

  it("marks reader.library as bootstrap cache instead of business authority", () => {
    expect(namespacePolicy("reader.library")).toMatchObject({
      authority: "bootstrap-cache",
      businessAuthority: false,
    });
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

  it("limits iOS drawer pins to iOS and iPad client identities", async () => {
    await expect(
      validateUserStateInput({
        request: { clientContext: { platform: "ios" } },
        state: {
          namespace: "ios.drawer.pins",
          scope: "global",
          value: { pins: [] },
        },
      })
    ).resolves.toMatchObject({ ok: true });

    await expect(
      validateUserStateInput({
        request: { clientContext: { platform: "web" } },
        state: {
          namespace: "ios.drawer.pins",
          scope: "global",
          value: { pins: [] },
        },
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: "state_namespace_unavailable",
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
