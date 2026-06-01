const mockSystemSettings = {
  findFirst: jest.fn(),
  upsert: jest.fn(),
};

const mockWorkspace = {
  _findMany: jest.fn(),
  trackChange: jest.fn(),
  update: jest.fn(),
};

jest.mock("../../utils/prisma", () => ({
  system_settings: mockSystemSettings,
}));

jest.mock("../../models/workspace", () => ({
  Workspace: mockWorkspace,
}));

describe("SystemSettings default system prompt syncing", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockWorkspace.trackChange.mockResolvedValue();
    mockWorkspace.update.mockImplementation(async (id, updates) => ({
      workspace: { id, ...updates },
      message: null,
    }));
  });

  it("builds unique default prompt sync candidates from previous, current, and legacy defaults", () => {
    const { SystemSettings } = require("../../models/systemSettings");

    expect(SystemSettings.defaultPromptSyncCandidates("old default")).toEqual([
      "old default",
      SystemSettings.saneDefaultSystemPrompt,
      ...SystemSettings.legacyDefaultSystemPrompts,
    ]);
  });

  it("normalizes stored legacy defaults to the current sane default prompt", () => {
    const { SystemSettings } = require("../../models/systemSettings");

    expect(
      SystemSettings.effectiveDefaultSystemPrompt(
        SystemSettings.legacyDefaultSystemPrompts[0]
      )
    ).toBe(SystemSettings.saneDefaultSystemPrompt);
    expect(SystemSettings.effectiveDefaultSystemPrompt("custom prompt")).toBe(
      "custom prompt"
    );
  });

  it("syncs only workspaces that still use a default prompt", async () => {
    const { SystemSettings } = require("../../models/systemSettings");
    const previousDefaultPrompt = "old default prompt";
    const nextDefaultPrompt = "next default prompt";
    const user = { id: 10 };

    mockWorkspace._findMany.mockResolvedValue([
      { id: 1, openAiPrompt: previousDefaultPrompt },
      { id: 2, openAiPrompt: SystemSettings.legacyDefaultSystemPrompts[0] },
      { id: 3, openAiPrompt: null },
      { id: 4, openAiPrompt: nextDefaultPrompt },
      { id: 5, openAiPrompt: "custom workspace prompt" },
    ]);

    const result = await SystemSettings.syncDefaultSystemPromptToWorkspaces({
      previousDefaultPrompt,
      nextDefaultPrompt,
      user,
    });

    expect(result).toEqual({
      enabled: true,
      synced: 3,
      skipped: 1,
      unchanged: 1,
      failed: 0,
    });
    expect(mockWorkspace.trackChange).toHaveBeenCalledTimes(3);
    expect(mockWorkspace.trackChange).toHaveBeenNthCalledWith(
      1,
      { id: 1, openAiPrompt: previousDefaultPrompt },
      { openAiPrompt: nextDefaultPrompt },
      user
    );
    expect(mockWorkspace.update).toHaveBeenCalledTimes(3);
    expect(mockWorkspace.update).toHaveBeenNthCalledWith(1, 1, {
      openAiPrompt: nextDefaultPrompt,
    });
    expect(mockWorkspace.update).toHaveBeenNthCalledWith(2, 2, {
      openAiPrompt: nextDefaultPrompt,
    });
    expect(mockWorkspace.update).toHaveBeenNthCalledWith(3, 3, {
      openAiPrompt: nextDefaultPrompt,
    });
  });
});
