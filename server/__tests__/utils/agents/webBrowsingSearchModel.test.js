const os = require("os");

describe("web-browsing Search Model integration", () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  function loadWebBrowsingFunction() {
    jest.resetModules();
    const { webBrowsing } = require("../../../utils/agents/aibitat/plugins/web-browsing");
    let fn;
    const fakeAibitat = {
      function: (definition) => {
        fn = definition;
      },
      introspect: jest.fn(),
      addCitation: jest.fn(),
      handlerProps: { log: jest.fn() },
    };
    webBrowsing.plugin().setup(fakeAibitat);
    return { fn, fakeAibitat };
  }

  async function loadAgentSkillsFromSystemSettings(
    defaultSkills = [],
    disabledDefaultSkills = []
  ) {
    jest.resetModules();
    jest.doMock("../../../utils/AiProviders/modelMap", () => ({
      MODEL_MAP: {
        get: jest.fn(() => 4096),
      },
    }));
    jest.doMock("../../../models/systemSettings", () => ({
      SystemSettings: {
        getValueOrFallback: jest.fn(async ({ label }, fallback) => {
          if (label === "default_agent_skills")
            return JSON.stringify(defaultSkills);
          if (label === "disabled_agent_skills")
            return JSON.stringify(disabledDefaultSkills);
          return fallback;
        }),
      },
    }));
    const { agentSkillsFromSystemSettings } = require("../../../utils/agents/defaults");
    return agentSkillsFromSystemSettings();
  }

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      STORAGE_DIR: originalEnv.STORAGE_DIR || os.tmpdir(),
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
    jest.dontMock("../../../models/systemSettings");
    jest.resetModules();
  });

  it("does not expose web-browsing when Search Model is disabled", async () => {
    process.env.SEARCH_MODEL_PROVIDER = "none";
    await expect(
      loadAgentSkillsFromSystemSettings(["web-browsing"])
    ).resolves.not.toContain("web-browsing");
  });

  it("exposes web-browsing when Search Model is configured", async () => {
    process.env.SEARCH_MODEL_PROVIDER = "alibaba";
    process.env.SEARCH_MODEL_API_KEY = "sk-search";
    process.env.SEARCH_MODEL_BASE_URL =
      "https://dashscope.aliyuncs.com/compatible-mode/v1";
    process.env.SEARCH_MODEL_PREF = "qwen3.7-plus";

    await expect(
      loadAgentSkillsFromSystemSettings(["web-browsing"])
    ).resolves.toContain("web-browsing");
  });

  it("exposes web-browsing by default when Search Model is configured", async () => {
    process.env.SEARCH_MODEL_PROVIDER = "alibaba";
    process.env.SEARCH_MODEL_API_KEY = "sk-search";
    process.env.SEARCH_MODEL_BASE_URL =
      "https://dashscope.aliyuncs.com/compatible-mode/v1";
    process.env.SEARCH_MODEL_PREF = "qwen3.7-plus";

    await expect(loadAgentSkillsFromSystemSettings()).resolves.toContain(
      "web-browsing"
    );
  });

  it("does not expose default web-browsing when admin disables it", async () => {
    process.env.SEARCH_MODEL_PROVIDER = "alibaba";
    process.env.SEARCH_MODEL_API_KEY = "sk-search";
    process.env.SEARCH_MODEL_BASE_URL =
      "https://dashscope.aliyuncs.com/compatible-mode/v1";
    process.env.SEARCH_MODEL_PREF = "qwen3.7-plus";

    await expect(
      loadAgentSkillsFromSystemSettings(["web-browsing"], ["web-browsing"])
    ).resolves.not.toContain("web-browsing");
  });

  it("returns a disabled message when handler runs without Search Model config", async () => {
    process.env.SEARCH_MODEL_PROVIDER = "none";
    global.fetch = jest.fn();
    const { fn } = loadWebBrowsingFunction();

    const result = await fn.handler.call(fn, { query: "latest AI news" });
    expect(result).toContain("Search Model is not configured");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("uses Search Model and reports citations when configured", async () => {
    process.env.SEARCH_MODEL_PROVIDER = "alibaba";
    process.env.SEARCH_MODEL_API_KEY = "sk-search";
    process.env.SEARCH_MODEL_BASE_URL =
      "https://dashscope.aliyuncs.com/compatible-mode/v1";
    process.env.SEARCH_MODEL_PREF = "qwen3.7-plus";

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Search answer" } }],
        search_info: {
          search_results: [
            {
              title: "Result title",
              url: "https://example.com/result",
              snippet: "Result snippet",
            },
          ],
        },
      }),
    });
    const { fn, fakeAibitat } = loadWebBrowsingFunction();

    const result = await fn.handler.call(fn, { query: "latest AI news" });
    expect(result).toContain("Search answer");
    expect(result).toContain("https://example.com/result");
    expect(global.fetch).toHaveBeenCalled();
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toMatchObject({
      model: "qwen3.7-plus",
      enable_search: true,
      search_options: { search_strategy: "turbo" },
    });
    expect(fakeAibitat.addCitation).toHaveBeenCalledWith([
      expect.objectContaining({
        title: "Result title",
        chunkSource: "link://https://example.com/result",
      }),
    ]);
  });

  it("decrypts an encrypted Search Model API key before provider requests", async () => {
    process.env.ENCRYPTION_MASTER_KEY = "0".repeat(64);
    const { saveSecret } = require("../../../utils/security/secretStore");
    process.env.SEARCH_MODEL_PROVIDER = "alibaba";
    process.env.SEARCH_MODEL_API_KEY = saveSecret("sk-search");
    process.env.SEARCH_MODEL_BASE_URL =
      "https://dashscope.aliyuncs.com/compatible-mode/v1";
    process.env.SEARCH_MODEL_PREF = "qwen3.7-plus";

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Search answer" } }],
        search_info: { search_results: [] },
      }),
    });
    const { fn } = loadWebBrowsingFunction();

    await fn.handler.call(fn, { query: "latest AI news" });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer sk-search",
        }),
      })
    );
  });
});
