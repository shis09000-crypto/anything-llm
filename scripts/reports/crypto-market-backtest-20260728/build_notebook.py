#!/usr/bin/env python3
"""Build and execute the reproducible crypto market walk-forward audit notebook."""

from pathlib import Path

import nbformat as nbf
from nbclient import NotebookClient


ARTIFACT_DIR = Path(__file__).resolve().parent
NOTEBOOK_PATH = ARTIFACT_DIR / "crypto-market-backtest.ipynb"


def markdown(source: str):
    return nbf.v4.new_markdown_cell(source.strip())


def code(source: str):
    return nbf.v4.new_code_cell(source.strip())


cells = [
    markdown(
        """
## tl;dr

This is a **walk-forward replay**, not a hindsight chart review. It reruns the
production `crypto-quant-v2` rules at each UTC daily close using only candles
available at that moment, then scores the next 4, 12, and 24 daily candles.

- Universe: BTC/USDT, ETH/USDT, SOL/USDT.
- Evaluation dates: 2025-07-01 through 2026-07-04.
- Raw decision dates: 1,107 asset-days; exported scenario/horizon rows: 9,963.
- Confirmed directional signals: 79 (42 bullish, 37 bearish). Pooled terminal
  direction accuracy is **44.3%, 46.8%, and 49.4%** at 4/12/24 days. With a
  horizon-length cooldown to reduce overlapping samples it is **36.5%, 48.7%,
  and 51.6%** (n=52/39/31). This does **not** establish a stable directional edge.
- The bearish branch is materially better than the bullish branch in this
  particular period; the bullish branch is below its unconditional up-market
  baseline at every horizon. That asymmetry must not be hidden by pooling.
- Confirmed range signals have 4-day endpoint accuracy **73.7%** and strict
  whole-path accuracy **64.3%**. By 24 days these fall to **48.2%** and **10.7%**.
  The tool is more credible as a short-range state classifier than as a
  medium-horizon direction predictor.
- “Target before invalidation” is around 80% while terminal direction is below
  50%. Reporting only target-touch metrics would therefore be misleading.

Conclusion: the current tool is useful for transparent conditional scenarios
and short-range monitoring, but its confirmed directional labels are not yet
accurate enough to present as a quantitatively validated forecast.
"""
    ),
    markdown(
        """
## Context & Methods

The replay imports the current production `buildQuantAnalysis` implementation
instead of rebuilding formulas in Python. At every decision timestamp it:

1. supplies up to the same 500 historical candles per 1h/4h/1d/1w timeframe;
2. lets the production module separate forming from closed candles;
3. records trigger, confirmation, K-line-only support verdict, target, and
   invalidation;
4. reveals later daily candles only after the decision is recorded.

Directional scenarios are scored by the sign of the horizon-end close return.
Range scenarios are scored three ways: horizon-end close in the predicted
range, every intervening close in the predicted range, and every intervening
close inside the wider invalidation band.

The 95% confidence intervals are Wilson intervals. Daily signals overlap, so a
second view enforces a horizon-length cooldown per asset and scenario. This is
not a portfolio backtest: no position sizing, slippage model, funding, or
execution engine is assumed.
"""
    ),
    code(
        """
from pathlib import Path
import gzip
import hashlib
import json
import math

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from IPython.display import display

ROOT = Path.cwd()
records_path = ROOT / "backtest-records.csv"
metadata_path = ROOT / "metadata.json"
raw_path = ROOT / "raw-candles.json.gz"

df = pd.read_csv(records_path)
metadata = json.loads(metadata_path.read_text())
for column in [
    "trigger_met", "confirmed", "direction_correct", "invalidated",
    "direction_correct_after_10bps", "target_hit",
    "target_before_invalidation",
    "range_final_inside", "range_strict_path_inside",
    "range_relaxed_path_inside",
]:
    if column in df:
        df[column] = df[column].map(
            {"true": True, "false": False, True: True, False: False}
        ).astype("boolean")

df["signal_date"] = pd.to_datetime(df["signal_date"], utc=True)
print({
    "rows": len(df),
    "assets": sorted(df.asset.unique()),
    "first_signal": str(df.signal_date.min().date()),
    "last_signal": str(df.signal_date.max().date()),
    "formula_version": metadata["formulaVersion"],
    "raw_sha256": metadata["rawDataSha256"],
    "records_sha256": metadata["recordsSha256"],
})
"""
    ),
    markdown(
        """
## Data

Gate public spot OHLCV is the sole market-data source. The saved gzip snapshot,
CSV, production-code hashes, formula version, and evaluation timestamps make
every score reproducible. Gate limits 1-hour history to roughly 10,000 candles,
which sets the honest evaluation start; no other exchange was spliced in.
"""
    ),
    code(
        """
raw_bytes = gzip.decompress(raw_path.read_bytes())
raw = json.loads(raw_bytes)
raw_sha = hashlib.sha256(raw_bytes).hexdigest()
csv_sha = hashlib.sha256(records_path.read_bytes()).hexdigest()

quality_rows = []
for asset, timeframes in raw.items():
    for timeframe, rows in timeframes.items():
        timestamps = [int(row["ts"]) for row in rows]
        numeric_ok = all(
            all(np.isfinite(float(row[field])) for field in ["open", "high", "low", "close", "volume"])
            for row in rows
        )
        ohlc_ok = all(
            float(row["high"]) >= max(float(row["open"]), float(row["close"]), float(row["low"]))
            and float(row["low"]) <= min(float(row["open"]), float(row["close"]), float(row["high"]))
            for row in rows
        )
        quality_rows.append({
            "asset": asset,
            "timeframe": timeframe,
            "rows": len(rows),
            "strictly_increasing": all(b > a for a, b in zip(timestamps, timestamps[1:])),
            "duplicate_timestamps": len(timestamps) - len(set(timestamps)),
            "numeric_ok": numeric_ok,
            "ohlc_consistent": ohlc_ok,
        })

quality = pd.DataFrame(quality_rows)
checks = {
    "raw_sha_matches_metadata": raw_sha == metadata["rawDataSha256"],
    "csv_sha_matches_metadata": csv_sha == metadata["recordsSha256"],
    "unique_asset_date_scenario_horizon": not df.duplicated(
        ["asset", "signal_date", "scenario_id", "horizon"]
    ).any(),
    "future_starts_after_decision": bool(
        (df.outcome_start_timestamp_ms >= df.decision_timestamp_ms).all()
    ),
    "future_ends_after_start": bool(
        (df.outcome_end_timestamp_ms >= df.outcome_start_timestamp_ms).all()
    ),
    "no_missing_future_close": not df.final_close.isna().any(),
    "all_raw_series_monotonic": bool(quality.strictly_increasing.all()),
    "no_raw_timestamp_duplicates": bool((quality.duplicate_timestamps == 0).all()),
    "raw_numeric_values_valid": bool(quality.numeric_ok.all()),
    "raw_ohlc_consistent": bool(quality.ohlc_consistent.all()),
}
display(quality)
display(pd.Series(checks, name="passed").to_frame())
assert all(checks.values()), checks
"""
    ),
    code(
        """
def wilson(values):
    values = pd.Series(values).dropna().astype(bool)
    n = len(values)
    if n == 0:
        return {"n": 0, "accuracy": np.nan, "ci_low": np.nan, "ci_high": np.nan}
    p = float(values.mean())
    z = 1.96
    denominator = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denominator
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator
    return {"n": n, "accuracy": p, "ci_low": center - half, "ci_high": center + half}


def summarize(group, outcome):
    stats = wilson(group[outcome])
    if "signed_return" in group:
        stats["mean_signed_return"] = group.signed_return.mean()
        stats["median_signed_return"] = group.signed_return.median()
    return pd.Series(stats)


def cooldown(group, bars):
    kept = []
    last_timestamp = {}
    for index, row in group.sort_values("signal_timestamp_ms").iterrows():
        key = (row.asset, row.scenario_id)
        earliest = last_timestamp.get(key, -np.inf) + bars * 86_400_000
        if row.signal_timestamp_ms >= earliest:
            kept.append(index)
            last_timestamp[key] = row.signal_timestamp_ms
    return group.loc[kept]


def percent_table(frame, columns=("accuracy", "ci_low", "ci_high")):
    result = frame.copy()
    for column in columns:
        if column in result:
            result[column] = (
                100 * pd.to_numeric(result[column], errors="coerce")
            ).round(1)
    return result
"""
    ),
    markdown(
        """
## Results

### Confirmed directional scenarios

Accuracy below means the horizon-end close moved in the scenario direction.
The asset-weighted unconditional benchmark is the same direction’s historical
base rate over all eligible dates, not a fitted model.
"""
    ),
    code(
        """
confirmed_directional = df[df.confirmed & df.direction.ne("range")].copy()
direction_table = (
    confirmed_directional
    .groupby(["scenario_id", "horizon"], observed=True)
    .apply(lambda group: summarize(group, "direction_correct"), include_groups=False)
    .reset_index()
)

base = df[df.scenario_id.eq("bullish_breakout")].copy()
base_rates = (
    base.assign(up=base.raw_return.gt(0), down=base.raw_return.lt(0))
    .groupby(["asset", "horizon"], observed=True)[["up", "down"]]
    .mean()
)

benchmarks = []
for _, row in direction_table.iterrows():
    sample = confirmed_directional[
        confirmed_directional.scenario_id.eq(row.scenario_id)
        & confirmed_directional.horizon.eq(row.horizon)
    ]
    side = "up" if row.scenario_id == "bullish_breakout" else "down"
    benchmark = np.mean([
        base_rates.loc[(asset, int(row.horizon)), side]
        for asset in sample.asset
    ])
    benchmarks.append(benchmark)
direction_table["unconditional_benchmark"] = benchmarks
direction_table["accuracy_minus_benchmark"] = (
    direction_table.accuracy - direction_table.unconditional_benchmark
)
display(percent_table(direction_table, (
    "accuracy", "ci_low", "ci_high", "unconditional_benchmark",
    "accuracy_minus_benchmark",
)))
"""
    ),
    code(
        """
pooled_direction = (
    confirmed_directional
    .groupby("horizon", observed=True)
    .apply(lambda group: summarize(group, "direction_correct"), include_groups=False)
    .reset_index()
)
pooled_direction["target_before_invalidation"] = (
    confirmed_directional.groupby("horizon").target_before_invalidation.mean().values
)
pooled_direction["invalidated"] = (
    confirmed_directional.groupby("horizon").invalidated.mean().values
)
display(percent_table(pooled_direction, (
    "accuracy", "ci_low", "ci_high", "target_before_invalidation", "invalidated",
)))
"""
    ),
    markdown(
        """
The bearish branch improved with horizon in this sample, while the bullish
branch failed increasingly often. This is not a symmetric trend predictor.
The high target-touch rate cannot substitute for terminal-direction accuracy:
a scenario may briefly touch a nearby target and later reverse.

### Confirmed range scenarios
"""
    ),
    code(
        """
confirmed_range = df[df.confirmed & df.direction.eq("range")].copy()
range_rows = []
for horizon, group in confirmed_range.groupby("horizon", observed=True):
    for metric in [
        "range_final_inside",
        "range_strict_path_inside",
        "range_relaxed_path_inside",
    ]:
        range_rows.append({
            "horizon": horizon,
            "metric": metric,
            **wilson(group[metric]),
        })
range_table = pd.DataFrame(range_rows)
display(percent_table(range_table))
"""
    ),
    code(
        """
fig, axes = plt.subplots(1, 2, figsize=(12, 4.2), constrained_layout=True)

for scenario, group in direction_table.groupby("scenario_id"):
    axes[0].plot(group.horizon, 100 * group.accuracy, marker="o", label=scenario)
axes[0].axhline(50, color="black", linewidth=1, linestyle="--", alpha=0.5)
axes[0].set(title="Confirmed directional accuracy", xlabel="Future daily bars", ylabel="Accuracy (%)")
axes[0].set_xticks([4, 12, 24])
axes[0].set_ylim(0, 100)
axes[0].legend()

for metric, group in range_table.groupby("metric"):
    axes[1].plot(group.horizon, 100 * group.accuracy, marker="o", label=metric)
axes[1].set(title="Confirmed range accuracy", xlabel="Future daily bars", ylabel="Accuracy (%)")
axes[1].set_xticks([4, 12, 24])
axes[1].set_ylim(0, 100)
axes[1].legend(fontsize=8)

figure_path = ROOT / "accuracy-by-horizon.png"
fig.savefig(figure_path, dpi=160)
plt.show()
"""
    ),
    markdown(
        """
### Overlap sensitivity and threshold sensitivity

Daily decisions inside a 24-day outcome window share most of their future
candles. The cooldown view retains only the first signal until its evaluation
horizon has elapsed. It is smaller but less deceptively precise.
"""
    ),
    code(
        """
cooldown_rows = []
for horizon, group in confirmed_directional.groupby("horizon", observed=True):
    sample = cooldown(group, int(horizon))
    cooldown_rows.append({
        "scenario_type": "directional",
        "horizon": horizon,
        **wilson(sample.direction_correct),
        "mean_signed_return": sample.signed_return.mean(),
    })
for horizon, group in confirmed_range.groupby("horizon", observed=True):
    sample = cooldown(group, int(horizon))
    cooldown_rows.append({
        "scenario_type": "range_final",
        "horizon": horizon,
        **wilson(sample.range_final_inside),
        "mean_signed_return": np.nan,
    })
cooldown_table = pd.DataFrame(cooldown_rows)
display(percent_table(cooldown_table))

threshold_rows = []
for horizon, group in confirmed_directional.groupby("horizon", observed=True):
    for threshold_bps in [0, 10, 30, 50]:
        threshold_rows.append({
            "horizon": horizon,
            "threshold_bps": threshold_bps,
            **wilson(group.signed_return.gt(threshold_bps / 10_000)),
        })
threshold_table = pd.DataFrame(threshold_rows)
display(percent_table(threshold_table))
"""
    ),
    markdown(
        """
### Does confirmation or K-line support improve accuracy?

The support verdict here includes historical price-trend, price-volume, and
relative-to-BTC families. Historical order book, taker-flow, open interest,
funding, and liquidation snapshots were unavailable and are deliberately not
simulated.
"""
    ),
    code(
        """
trigger_comparison = []
for label, sample in [
    ("triggered", df[df.trigger_met & df.direction.ne("range")]),
    ("confirmed", confirmed_directional),
]:
    for horizon, group in sample.groupby("horizon", observed=True):
        trigger_comparison.append({
            "sample": label,
            "horizon": horizon,
            **wilson(group.direction_correct),
        })
trigger_comparison = pd.DataFrame(trigger_comparison)
display(percent_table(trigger_comparison))

support_rows = []
for (direction, verdict, horizon), group in (
    df[df.confirmed]
    .groupby(["direction", "support_verdict", "horizon"], observed=True)
):
    metric = "range_final_inside" if direction == "range" else "direction_correct"
    support_rows.append({
        "direction": direction,
        "support_verdict": verdict,
        "horizon": horizon,
        "metric": metric,
        **wilson(group[metric]),
    })
support_table = pd.DataFrame(support_rows)
display(percent_table(support_table))
"""
    ),
    markdown(
        """
## Takeaways

1. **No validated broad directional edge yet.** Pooled confirmed-direction
   accuracy never exceeds 50% in the overlapping sample and reaches only 51.6%
   in the much smaller 24-day cooldown sample.
2. **The bearish and bullish paths must be calibrated separately.** The bearish
   branch was useful at longer horizons in this down-biased evaluation period;
   the bullish branch underperformed its base rate at every horizon.
3. **Short range classification is the strongest current use.** Four-day range
   accuracy survives the cooldown check, while medium-horizon containment
   degrades sharply.
4. **Target-touch is not forecast accuracy.** Its roughly 80% success coexists
   with sub-50% terminal direction and must be shown only as a path statistic.
5. **K-line confirmation is not a universal reliability upgrade.** It helps
   some range samples but does not improve pooled directional accuracy.
6. **Next accuracy work should be out-of-sample and versioned.** Freeze this
   rule version, add more market regimes/assets, retain historical derivatives
   and microstructure snapshots, and tune only on a training period before
   reporting a separate untouched test period.

This notebook measures descriptive historical performance, not investment
advice, a calibrated probability, or a promise of future returns.
"""
    ),
    code(
        """
def table_records(frame):
    clean = frame.replace({np.nan: None})
    return json.loads(clean.to_json(orient="records"))

summary = {
    "formulaVersion": metadata["formulaVersion"],
    "source": metadata["source"],
    "evaluationStart": metadata["evaluationStart"],
    "evaluationEnd": str(df.signal_date.max().date()),
    "assets": metadata["assets"],
    "signalAssetDays": metadata["signalDateCount"],
    "exportedRows": metadata["rowCount"],
    "rawDataSha256": metadata["rawDataSha256"],
    "recordsSha256": metadata["recordsSha256"],
    "qualityChecks": checks,
    "confirmedDirectional": table_records(direction_table),
    "pooledDirectional": table_records(pooled_direction),
    "confirmedRange": table_records(range_table),
    "cooldownSensitivity": table_records(cooldown_table),
    "thresholdSensitivity": table_records(threshold_table),
    "triggerComparison": table_records(trigger_comparison),
    "supportStratification": table_records(support_table),
    "limitations": metadata["limitations"],
}
(ROOT / "summary.json").write_text(json.dumps(summary, indent=2))
print("wrote", ROOT / "summary.json")
"""
    ),
]

notebook = nbf.v4.new_notebook(
    cells=cells,
    metadata={
        "kernelspec": {
            "display_name": "Python 3",
            "language": "python",
            "name": "python3",
        },
        "language_info": {"name": "python", "version": "3.10"},
    },
)
nbf.write(notebook, NOTEBOOK_PATH)

client = NotebookClient(
    notebook,
    timeout=180,
    kernel_name="python3",
    resources={"metadata": {"path": str(ARTIFACT_DIR)}},
)
executed = client.execute()
nbf.write(executed, NOTEBOOK_PATH)
print(NOTEBOOK_PATH)
