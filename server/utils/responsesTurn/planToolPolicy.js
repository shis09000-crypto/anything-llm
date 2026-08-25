const PLAN_READ_ONLY_TOOLS = new Set([
  "workspace_search",
  "web-browsing",
  "web-scraping",
  "chat-history",
  "document-index-status-tool",
  "get_workspace_supplement",
  "load_image",
  "search_image_assets",
  "request-user-input#request-user-input",
  "thread-goal#get_goal",
  "crypto-market-agent#crypto_price",
  "crypto-market-agent#crypto_market_snapshot",
  "crypto-account-agent#crypto_account_overview",
  "crypto-account-agent#crypto_account_holdings",
  "crypto-account-agent#crypto_account_positions",
  "crypto-account-agent#crypto_account_activity",
  "crypto-account-agent#crypto_portfolio_overview",
  "crypto-account-agent#crypto_portfolio_risk",
  "weather-agent#weather_current",
  "weather-agent#weather_forecast",
  "global-market-agent#global_forex_rate",
  "global-market-agent#global_index_quote",
  "global-market-agent#global_stock_quote",
  "global-market-agent#global_commodity_quote",
  "global-market-agent#global_fund_quote",
  "gold-market-agent#gold_market_analysis",
]);

function planReadOnlyFunctions(functions = []) {
  return [...new Set(functions)].filter((name) =>
    PLAN_READ_ONLY_TOOLS.has(String(name))
  );
}

module.exports = { PLAN_READ_ONLY_TOOLS, planReadOnlyFunctions };
