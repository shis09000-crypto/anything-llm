const GATE_UNDERLYING_ASSET_ALIASES = Object.freeze({
  GTETH: "ETH",
  GTSOL: "SOL",
});

function normalizeCryptoAsset(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function underlyingAssetSymbol(value) {
  const symbol = normalizeCryptoAsset(value);
  return GATE_UNDERLYING_ASSET_ALIASES[symbol] || symbol;
}

module.exports = {
  GATE_UNDERLYING_ASSET_ALIASES,
  normalizeCryptoAsset,
  underlyingAssetSymbol,
};
