const {
  agentReasoningEffort,
  LocalToolVectorIndex,
  simpleAgentRequest,
} = require("../../../utils/agents/aibitat/utils/localToolVectorIndex");

describe("local Agent tool vector index", () => {
  beforeEach(() => {
    LocalToolVectorIndex.instance = null;
  });

  const tools = [
    {
      name: "browser_search",
      description: "Search public web pages and return current results.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "read_document",
      description: "Read a workspace file or document.",
      parameters: { type: "object", properties: {} },
    },
    ...Array.from({ length: 20 }, (_, index) => ({
      name: `unrelated_tool_${index}`,
      description: `Perform unrelated operation number ${index}.`,
      parameters: { type: "object", properties: {} },
    })),
  ];

  test("selects a bounded relevant set from a warm registry", () => {
    const selector = new LocalToolVectorIndex({
      env: {
        ATHENA_AGENT_TOOL_LIMIT: "15",
        ATHENA_AGENT_TOOL_MIN_SCORE: "0.3",
      },
    });
    selector.prewarm(tools);
    const result = selector.select("请搜索网页上的最新资料", tools);
    expect(result.degradedReason).toBeNull();
    expect(result.tools.map((tool) => tool.name)).toContain("browser_search");
    expect(result.tools.length).toBeLessThanOrEqual(15);
  });

  test("forces URL and attachment capabilities even below threshold", () => {
    const selector = new LocalToolVectorIndex({
      env: { ATHENA_AGENT_TOOL_MIN_SCORE: "0.99" },
    });
    const withUrl = selector.select("打开 https://example.com", tools);
    expect(withUrl.tools.map((tool) => tool.name)).toContain("browser_search");
    const withFile = selector.select("帮我处理", tools, {
      hasAttachments: true,
    });
    expect(withFile.tools.map((tool) => tool.name)).toContain("read_document");
  });

  test("identifies only simple no-tool conversation for the fast path", () => {
    expect(simpleAgentRequest("哈咯", { selectedTools: [] })).toBe(true);
    expect(simpleAgentRequest("@agent 哈咯", { selectedTools: [] })).toBe(
      false
    );
    expect(
      simpleAgentRequest("搜索并分析这个网页", { selectedTools: [] })
    ).toBe(false);
  });

  test("disables hidden reasoning only for the simple Agent fast path", () => {
    expect(agentReasoningEffort("哈咯", { selectedTools: [] })).toBe("none");
    expect(agentReasoningEffort("@agent 哈咯", { selectedTools: [] })).toBe(
      "high"
    );
    expect(
      agentReasoningEffort("帮我搜索并比较最新资料", { selectedTools: [] })
    ).toBe("high");
    expect(
      agentReasoningEffort("请概括附件", {
        selectedTools: [],
        context: { hasAttachments: true },
      })
    ).toBe("high");
  });
});
