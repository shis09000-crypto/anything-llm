const path = require("node:path");
const { storagePath } = require("../environment");

const TOOL_NAME = "gold_market_analysis";
const FORMULA_VERSION = "gqss-gold-analysis-v1";
const RESULT_SCHEMA = "athena.gold.market-analysis";
const RESULT_SCHEMA_VERSION = "1.0";
const MAX_STORE_BYTES = 512 * 1024 * 1024;
const MIN_FREE_BYTES = 12 * 1024 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 100 * 1024;
const MODEL_RESULT_MAX_CHARS = 20_000;
const TWELVE_DATA_BASE = "https://api.twelvedata.com";
const GOLD_API_BASE = "https://api.gold-api.com/price";
const FRED_CSV_BASE = "https://fred.stlouisfed.org/graph/fredgraph.csv";
const CFTC_DISAGGREGATED_URL = "https://www.cftc.gov/dea/newcot/f_disagg.txt";
const GATE_SPOT_CANDLES_URL = "https://api.gateio.ws/api/v4/spot/candlesticks";
const SGE_BASE = "https://www.sge.com.cn/sjzx/shanghaiAuAuto";
const GLD_PAGE =
  "https://www.ssga.com/us/en/intermediary/etfs/spdr-gold-shares-gld";
const IAU_PAGE =
  "https://www.ishares.com/us/products/239561/ishares-gold-trust-etf";

const FRED_SERIES = Object.freeze({
  dxy: "DTWEXBGS",
  realYield10y: "DFII10",
  nominal10y: "DGS10",
  nominal2y: "DGS2",
  breakeven10y: "T10YIE",
  vix: "VIXCLS",
  gvz: "GVZCLS",
  oilWti: "DCOILWTICO",
});

const TIMEFRAMES = Object.freeze({
  "1h": { intervalMs: 60 * 60 * 1_000, barsPerYear: 24 * 252 },
  "4h": { intervalMs: 4 * 60 * 60 * 1_000, barsPerYear: 6 * 252 },
  "1d": { intervalMs: 24 * 60 * 60 * 1_000, barsPerYear: 252 },
  "1w": { intervalMs: 7 * 24 * 60 * 60 * 1_000, barsPerYear: 52 },
});

function goldAnalysisRoot(env = process.env) {
  const configured = String(env.ATHENA_GOLD_ANALYSIS_STORAGE_DIR || "").trim();
  return configured ? path.resolve(configured) : storagePath("gold-analysis");
}

module.exports = {
  CFTC_DISAGGREGATED_URL,
  FORMULA_VERSION,
  FRED_CSV_BASE,
  FRED_SERIES,
  GATE_SPOT_CANDLES_URL,
  GLD_PAGE,
  GOLD_API_BASE,
  IAU_PAGE,
  MAX_PAYLOAD_BYTES,
  MAX_STORE_BYTES,
  MIN_FREE_BYTES,
  MODEL_RESULT_MAX_CHARS,
  RESULT_SCHEMA,
  RESULT_SCHEMA_VERSION,
  SGE_BASE,
  TIMEFRAMES,
  TOOL_NAME,
  TWELVE_DATA_BASE,
  goldAnalysisRoot,
};
