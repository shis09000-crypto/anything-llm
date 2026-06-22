const {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  searchModelConfigStatus,
  searchWithAlibabaModel,
} = require("../../../utils/SearchModels/alibaba");

describe("Alibaba Search Model", () => {
  it("reports disabled status when provider is none", () => {
    expect(searchModelConfigStatus({ SEARCH_MODEL_PROVIDER: "none" })).toEqual(
      expect.objectContaining({
        configured: false,
        provider: "none",
        reason: "disabled",
      })
    );
  });

  it("calls DashScope chat completions with enable_search", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
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

    const result = await searchWithAlibabaModel({
      query: "latest AI news",
      fetchImpl,
      env: {
        SEARCH_MODEL_PROVIDER: "alibaba",
        SEARCH_MODEL_API_KEY: "sk-search",
        SEARCH_MODEL_BASE_URL: DEFAULT_BASE_URL,
        SEARCH_MODEL_PREF: DEFAULT_MODEL,
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      `${DEFAULT_BASE_URL}/chat/completions`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-search",
          "Content-Type": "application/json",
        }),
      })
    );

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toMatchObject({
      model: DEFAULT_MODEL,
      enable_search: true,
      search_options: { search_strategy: "turbo" },
    });
    expect(body.messages).toEqual([
      { role: "user", content: "latest AI news" },
    ]);
    expect(result).toMatchObject({
      text: "Search answer",
      results: [
        {
          title: "Result title",
          link: "https://example.com/result",
          snippet: "Result snippet",
        },
      ],
    });
  });
});
