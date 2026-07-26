#!/usr/bin/env node
const {
  CRYPTO_ASSETS,
  INVENTORY_VERSION,
  validateCryptoAssetInventory,
} = require("../utils/security/cryptoAssetInventory");

const result = validateCryptoAssetInventory();
console.log(
  JSON.stringify(
    {
      success: result.valid,
      inventoryVersion: INVENTORY_VERSION,
      assets: CRYPTO_ASSETS.length,
      legacyAssets: CRYPTO_ASSETS.filter(
        (asset) =>
          /legacy|migration/.test(asset.status) ||
          (asset.algorithms || []).some((algorithm) =>
            /legacy|CBC/i.test(algorithm)
          )
      ).map((asset) => asset.assetId),
      findings: result.findings,
    },
    null,
    2
  )
);
if (!result.valid) process.exitCode = 1;
