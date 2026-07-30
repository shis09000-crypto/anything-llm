#!/usr/bin/env node

const { main } = require("./crypto-forecast-v4-replay");

main().catch((error) => {
  console.error(
    JSON.stringify({
      error: error?.code || error?.message || "forecast_v5_replay_failed",
    })
  );
  process.exitCode = 1;
});
