# Athena Crypto Forecast v4 Independent Audit

- Verdict: **FAIL**
- Classification: `historical_semi_blind`
- Generated: 2026-07-30T06:35:41.319597+00:00
- Replay records: 82662
- Trace verification: 60 traces, 0 failures

## Horizon results

| Horizon | Samples | Coverage | Selective accuracy | Brier skill | ECE | Net lower 95% | Gate |
|---|---:|---:|---:|---:|---:|---:|---|
| 4h | 41331 | 8.11% | 47.41% | -0.0129 | 0.0501 | -0.002012 | fail |
| 24h | 41331 | 11.60% | 47.84% | -0.0419 | 0.0762 | -0.004931 | fail |

## Independent risk-head replay

- Samples: 12108
- Gate: pass

| Horizon | Samples | Vol QLIKE | EWMA QLIKE | Tail Brier skill | Gate |
|---|---:|---:|---:|---:|---|
| 4h | 10356 | 0.07889295700108541 | 0.0975888198034979 | 0.22786239685085574 | pass |
| 24h | 1752 | 0.05370790039366261 | 0.06256455137989848 | 0.1870617496665904 | pass |

## Failed gates

- 4h: coverage, brierSkill, ece, costBootstrap, pbo, deflatedSharpe
- 24h: selectiveAccuracy, brierSkill, ece, costBootstrap, pbo, deflatedSharpe

## Highest-confidence selected errors

| Passport | Symbol | Horizon | Actual | Predicted | Confidence | Net return (2bps) |
|---|---|---|---|---|---:|---:|
| a76226d49a456871 | BTC | 24h | up | down | 0.8710 | 0.004841 |
| 8f1e06013b598d01 | BTC | 4h | down | up | 0.8439 | -0.003442 |
| b30cde92c9d7dce7 | SOL | 4h | up | down | 0.8427 | -0.008507 |
| 490bfc5a0060a4d1 | BTC | 4h | up | down | 0.8341 | -0.011506 |
| b995cbf3e275ab2c | BTC | 4h | down | up | 0.8339 | -0.012070 |
| bc00212292ffd567 | ETH | 4h | down | up | 0.8293 | -0.001538 |
| 5aaef0a9b76b3ac4 | SOL | 4h | up | down | 0.8249 | 0.014664 |
| 9e8716e5ea885405 | BTC | 4h | down | up | 0.8232 | -0.016751 |
| 8cb443545ce8df43 | SOL | 4h | up | down | 0.8209 | -0.003360 |
| e3036de765083b87 | BTC | 4h | down | up | 0.8140 | -0.002315 |
| 621fe02de0bb4960 | BTC | 4h | down | up | 0.8126 | 0.005132 |
| 8636823ed1989434 | ETH | 4h | down | up | 0.8119 | -0.008869 |
| 5d27cd08bc424592 | BTC | 4h | down | up | 0.8118 | -0.019496 |
| 969931e25b9866d9 | ETH | 24h | up | down | 0.8097 | 0.003738 |
| 7b83770016b2fa9c | BTC | 4h | down | up | 0.8091 | -0.005274 |
| 31050f778d487d22 | ETH | 24h | up | down | 0.8075 | 0.024974 |
| ead6e10c68fb20c9 | BTC | 4h | down | up | 0.8074 | 0.003272 |
| 1ccb13b9bd1257f0 | BTC | 4h | down | up | 0.8069 | 0.008110 |
| 04800e8ee383683c | BTC | 4h | down | up | 0.8067 | -0.000939 |
| 46b76cc509222d9f | BTC | 4h | down | up | 0.8067 | -0.009865 |

## Inspector conclusion

真实性链路可以复算，但至少一个准确度、校准、风险头、过拟合或成本后门槛未通过。v4未优于完整基线，必须保持Shadow且本轮审计判定失败。

Historical results are semi-blind and cannot activate v4. Only prospective Shadow evidence can satisfy the final promotion gate.
