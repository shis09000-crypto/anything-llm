#!/usr/bin/env python3
"""Independently recompute every exported outcome from the pinned daily candles."""

from pathlib import Path
import gzip
import hashlib
import json

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parent
RECORDS_PATH = ROOT / "backtest-records.csv"
RAW_PATH = ROOT / "raw-candles.json.gz"
REPORT_PATH = ROOT / "verification-report.json"


def equal(left, right, tolerance=1e-12):
    if pd.isna(left) and pd.isna(right):
        return True
    if isinstance(left, (bool, np.bool_)) or isinstance(right, (bool, np.bool_)):
        return bool(left) == bool(right)
    return bool(np.isclose(float(left), float(right), rtol=tolerance, atol=tolerance))


df = pd.read_csv(RECORDS_PATH)
for column in [
    "direction_correct",
    "direction_correct_after_10bps",
    "target_hit",
    "invalidated",
    "target_before_invalidation",
    "range_final_inside",
    "range_strict_path_inside",
    "range_relaxed_path_inside",
]:
    df[column] = df[column].map(
        {"true": True, "false": False, True: True, False: False}
    ).astype("boolean")

raw_bytes = gzip.decompress(RAW_PATH.read_bytes())
raw = json.loads(raw_bytes)
daily_by_asset = {
    asset: sorted(rows["1d"], key=lambda row: int(row["ts"]))
    for asset, rows in raw.items()
}
daily_index = {
    asset: {int(row["ts"]): index for index, row in enumerate(rows)}
    for asset, rows in daily_by_asset.items()
}

mismatches = []
for row in df.itertuples(index=False):
    candles = daily_by_asset[row.asset]
    index = daily_index[row.asset].get(int(row.signal_timestamp_ms))
    if index is None:
        mismatches.append({"field": "signal_timestamp_missing", "row": row.signal_date})
        continue
    signal = candles[index]
    future = candles[index + 1 : index + 1 + int(row.horizon)]
    if len(future) != int(row.horizon):
        mismatches.append({"field": "future_length", "row": row.signal_date})
        continue

    entry = float(signal["close"])
    final = float(future[-1]["close"])
    raw_return = final / entry - 1
    expected = {
        "entry_close": entry,
        "outcome_start_timestamp_ms": int(future[0]["ts"]),
        "outcome_end_timestamp_ms": int(future[-1]["ts"]),
        "final_close": final,
        "raw_return": raw_return,
    }

    if row.direction in ("bullish", "bearish"):
        signed = raw_return if row.direction == "bullish" else -raw_return
        target = float(row.target) if pd.notna(row.target) else None
        invalidation = (
            float(row.invalidation_value)
            if pd.notna(row.invalidation_value)
            else None
        )
        first_target = None
        first_invalidation = None
        for bar_index, bar in enumerate(future, start=1):
            high = float(bar["high"])
            low = float(bar["low"])
            close = float(bar["close"])
            target_touched = (
                target is not None
                and (
                    (row.direction == "bullish" and high >= target)
                    or (row.direction == "bearish" and low <= target)
                )
            )
            invalidated = (
                invalidation is not None
                and (
                    (row.direction == "bullish" and close < invalidation)
                    or (row.direction == "bearish" and close > invalidation)
                )
            )
            if first_target is None and target_touched:
                first_target = bar_index
            if first_invalidation is None and invalidated:
                first_invalidation = bar_index
        expected.update(
            {
                "signed_return": signed,
                "direction_correct": signed > 0,
                "direction_correct_after_10bps": signed > 0.001,
                "target_hit": first_target is not None,
                "invalidated": first_invalidation is not None,
                "target_before_invalidation": first_target is not None
                and (first_invalidation is None or first_target < first_invalidation),
                "first_target_bar": first_target,
                "first_invalidation_bar": first_invalidation,
            }
        )
    else:
        lower = float(row.range_lower)
        upper = float(row.range_upper)
        relaxed_lower = float(row.range_invalidation_lower)
        relaxed_upper = float(row.range_invalidation_upper)
        closes = [float(bar["close"]) for bar in future]
        final_inside = lower <= final <= upper
        strict_inside = all(lower <= close <= upper for close in closes)
        relaxed_inside = all(
            relaxed_lower <= close <= relaxed_upper for close in closes
        )
        expected.update(
            {
                "direction_correct": final_inside,
                "invalidated": not relaxed_inside,
                "range_final_inside": final_inside,
                "range_strict_path_inside": strict_inside,
                "range_relaxed_path_inside": relaxed_inside,
            }
        )

    for field, expected_value in expected.items():
        actual_value = getattr(row, field)
        if not equal(actual_value, expected_value):
            mismatches.append(
                {
                    "asset": row.asset,
                    "signalDate": str(row.signal_date),
                    "scenario": row.scenario_id,
                    "horizon": int(row.horizon),
                    "field": field,
                    "actual": None if pd.isna(actual_value) else actual_value,
                    "expected": expected_value,
                }
            )

report = {
    "recordsChecked": len(df),
    "fieldComparisons": int(
        len(df[df.direction.ne("range")]) * 14
        + len(df[df.direction.eq("range")]) * 10
    ),
    "mismatchCount": len(mismatches),
    "mismatches": mismatches[:100],
    "rawDataSha256": hashlib.sha256(raw_bytes).hexdigest(),
    "recordsSha256": hashlib.sha256(RECORDS_PATH.read_bytes()).hexdigest(),
    "verifierSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
}
REPORT_PATH.write_text(json.dumps(report, indent=2, default=str))
print(json.dumps(report, indent=2, default=str))
if mismatches:
    raise SystemExit(1)
