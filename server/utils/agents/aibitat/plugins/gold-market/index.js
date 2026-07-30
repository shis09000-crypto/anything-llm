const { goldAnalysisRuntime } = require("../../../../goldAnalysis");
const { jsonTool } = require("../market-data/lib");
const {
  prepareGoldResultForModel,
  validatedGoldMarketContinuation,
} = require("./interpretation");

async function executeGoldMarketAnalysis(_input = {}, dependencies = {}) {
  return goldAnalysisRuntime.analyze({
    force: Boolean(dependencies.force),
    dependencies,
  });
}

const goldMarketAnalysis = jsonTool({
  name: "gold_market_analysis",
  description:
    "Analyze the current global gold market with the GQSS V1 monitoring standard. It returns closed XAU/USD multi-timeframe indicators, macro conditions, COMEX COT positioning, issuer ETF observations, Shanghai Gold cross-market context, volatility risk, data quality, and auditable provenance. It has no mode and needs no parameters. It never exposes a future direction, directional probability, price target, return target, investment recommendation, or trade instruction.",
  examples: [
    {
      prompt: "按 GQSS 标准分析一下当前黄金市场",
      call: JSON.stringify({}),
    },
  ],
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  continuationInstruction:
    "Use the deterministic GQSS report. Describe only current, timestamped observations and data limitations. Never add a future direction, probability, price or return target, causal claim, investment recommendation, or trade instruction.",
  prepareResultForModel: prepareGoldResultForModel,
  modelResultMaxChars: 20_000,
  validatedContinuation: validatedGoldMarketContinuation,
  execute: executeGoldMarketAnalysis,
});

const goldMarketAgent = {
  name: "gold-market-agent",
  startupConfig: { params: {} },
  plugin: [goldMarketAnalysis],
};

module.exports = {
  executeGoldMarketAnalysis,
  goldMarketAgent,
  prepareGoldResultForModel,
};
