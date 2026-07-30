"""Cost-aware first-touch labels for Athena crypto forecast v5."""

from __future__ import annotations

import math
import sqlite3
from pathlib import Path

import numpy as np
import pandas as pd

from features_v5 import LABEL_CONTRACT

FIVE_MINUTES = pd.Timedelta(minutes=5)
HORIZON_BARS = 48
HORIZON_DELTA = FIVE_MINUTES * HORIZON_BARS
LABEL_ROUND_TRIP_COST_RATIO = (
    2
    * (
        float(LABEL_CONTRACT["feeBpsPerSide"])
        + float(LABEL_CONTRACT["labelSlippageBpsPerSide"])
    )
    / 10_000
)
SAFETY_BUFFER_RATIO = float(LABEL_CONTRACT["safetyBufferBps"]) / 10_000
MINIMUM_BARRIER_RATIO = LABEL_ROUND_TRIP_COST_RATIO + SAFETY_BUFFER_RATIO


def load_derivative_history(database: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    with sqlite3.connect(
        f"file:{database}?mode=ro&immutable=1", uri=True
    ) as connection:
        klines = pd.read_sql_query(
            """
            SELECT symbol, series_type, open_time_ms, close_time_ms,
                   open, high, low, close, available_at_ms
            FROM derivative_klines
            WHERE interval='5m' AND series_type IN ('contract', 'mark')
            ORDER BY symbol, series_type, open_time_ms
            """,
            connection,
        )
        funding = pd.read_sql_query(
            """
            SELECT symbol, calc_time_ms, funding_rate, available_at_ms
            FROM derivative_funding_rates
            ORDER BY symbol, calc_time_ms
            """,
            connection,
        )
    for column in ("open_time_ms", "close_time_ms", "available_at_ms"):
        klines[column] = pd.to_numeric(klines[column], errors="coerce")
    for column in ("calc_time_ms", "available_at_ms"):
        funding[column] = pd.to_numeric(funding[column], errors="coerce")
    return klines, funding


def _ewma_horizon_volatility(source: pd.DataFrame) -> pd.Series:
    returns = np.log(source["close"] / source["close"].shift(1))
    alpha = 1 - math.exp(math.log(0.5) / 288)
    per_bar = np.sqrt(
        returns.pow(2).ewm(
            alpha=alpha,
            adjust=False,
            min_periods=288,
        ).mean()
    )
    return per_bar * math.sqrt(HORIZON_BARS)


def _indexed_derivatives(
    klines: pd.DataFrame,
) -> dict[tuple[str, str], pd.DataFrame]:
    result = {}
    for (symbol, series_type), group in klines.groupby(
        ["symbol", "series_type"], sort=False
    ):
        clean = (
            group.drop_duplicates("open_time_ms", keep="last")
            .sort_values("open_time_ms")
            .set_index("open_time_ms")
        )
        result[(symbol, series_type)] = clean
    return result


def _indexed_funding(
    funding: pd.DataFrame,
) -> dict[str, pd.DataFrame]:
    return {
        symbol: group.drop_duplicates("calc_time_ms", keep="last")
        .sort_values("calc_time_ms")
        .reset_index(drop=True)
        for symbol, group in funding.groupby("symbol", sort=False)
    }


def _funding_cost(
    funding: pd.DataFrame | None,
    entry_ms: int,
    exit_ms: int,
) -> tuple[float, bool]:
    if funding is None or funding.empty:
        return math.nan, False
    first = int(funding["calc_time_ms"].iloc[0])
    last = int(funding["calc_time_ms"].iloc[-1])
    # A settlement can be absent inside a 4h position. Coverage means the
    # surrounding 8h public series exists, not that a future rate is invented.
    covered = first <= entry_ms and last >= exit_ms - 8 * 60 * 60 * 1_000
    if not covered:
        return math.nan, False
    selected = funding.loc[
        (funding["calc_time_ms"] > entry_ms)
        & (funding["calc_time_ms"] <= exit_ms)
    ]
    # Positive funding is received by the simulated short.
    return -float(selected["funding_rate"].sum()), True


def first_touch_outcome(
    spot_window: pd.DataFrame,
    contract_window: pd.DataFrame,
    *,
    barrier_ratio: float,
) -> dict:
    """Return the first executable barrier touch without resolving OHLC order."""
    if len(spot_window) != HORIZON_BARS or len(contract_window) != HORIZON_BARS:
        raise ValueError("invalid_first_touch_window")
    if not math.isfinite(barrier_ratio) or barrier_ratio <= 0:
        raise ValueError("invalid_first_touch_barrier")
    entry_spot = float(spot_window.iloc[0]["open"])
    entry_short = float(contract_window.iloc[0]["open"])
    if not (entry_spot > 0 and entry_short > 0):
        raise ValueError("invalid_first_touch_entry")
    upper = entry_spot * math.exp(barrier_ratio)
    lower = entry_short * math.exp(-barrier_ratio)
    for offset in range(HORIZON_BARS):
        up_hit = float(spot_window.iloc[offset]["high"]) >= upper
        down_hit = float(contract_window.iloc[offset]["low"]) <= lower
        if up_hit and down_hit:
            return {
                "event": "ambiguous",
                "touchOffsetBars": offset + 1,
                "upper": upper,
                "lower": lower,
            }
        if up_hit:
            return {
                "event": "up",
                "touchOffsetBars": offset + 1,
                "upper": upper,
                "lower": lower,
            }
        if down_hit:
            return {
                "event": "down",
                "touchOffsetBars": offset + 1,
                "upper": upper,
                "lower": lower,
            }
    return {
        "event": "no_trade",
        "touchOffsetBars": None,
        "upper": upper,
        "lower": lower,
    }


def samples_for_multiplier(
    features: pd.DataFrame,
    klines: pd.DataFrame,
    funding: pd.DataFrame,
    multiplier: float,
    feature_names: list[str],
) -> pd.DataFrame:
    if multiplier not in {
        float(value) for value in LABEL_CONTRACT["barrierMultipliers"]
    }:
        raise ValueError("invalid_barrier_multiplier")
    derivatives = _indexed_derivatives(klines)
    funding_by_symbol = _indexed_funding(funding)
    outputs: list[dict] = []
    selected_columns = [
        "time",
        "symbol",
        "open",
        "high",
        "low",
        "close",
        "one_bar_return",
        "contiguous_run",
        "contiguous_bars",
        *feature_names,
    ]
    for symbol, source in features.groupby("symbol", sort=False):
        source = source.sort_values("time").reset_index(drop=True).copy()
        source["horizon_volatility"] = _ewma_horizon_volatility(source)
        contract = derivatives.get((symbol, "contract"))
        mark = derivatives.get((symbol, "mark"))
        symbol_funding = funding_by_symbol.get(symbol)
        for position in range(len(source) - HORIZON_BARS):
            decision = source.iloc[position]
            if pd.Timestamp(decision["time"]).minute != 55:
                continue
            if int(decision["contiguous_bars"]) < 30 * 24 * 12:
                continue
            future = source.iloc[position + 1 : position + HORIZON_BARS + 1]
            if len(future) != HORIZON_BARS:
                continue
            if not (
                future["contiguous_run"].eq(decision["contiguous_run"]).all()
                and pd.Timestamp(future.iloc[0]["time"])
                - pd.Timestamp(decision["time"])
                == FIVE_MINUTES
                and pd.Timestamp(future.iloc[-1]["time"])
                - pd.Timestamp(decision["time"])
                == HORIZON_DELTA
            ):
                continue
            horizon_volatility = float(decision["horizon_volatility"])
            if not math.isfinite(horizon_volatility):
                continue
            barrier = max(
                MINIMUM_BARRIER_RATIO,
                multiplier * horizon_volatility,
            )
            entry_spot = float(future.iloc[0]["open"])
            entry_ms = int(pd.Timestamp(future.iloc[0]["time"]).timestamp() * 1000)
            outcome_ms = int(
                pd.Timestamp(future.iloc[-1]["time"]).timestamp() * 1000
            )
            expected_times = [
                entry_ms + offset * int(FIVE_MINUTES.total_seconds() * 1000)
                for offset in range(HORIZON_BARS)
            ]
            if contract is None or mark is None:
                continue
            contract_window = contract.reindex(expected_times)
            mark_window = mark.reindex(expected_times)
            if (
                contract_window[["open", "high", "low", "close"]]
                .isna()
                .any()
                .any()
                or mark_window[["open", "close"]].isna().any().any()
            ):
                continue
            funding_cost, funding_covered = _funding_cost(
                symbol_funding, entry_ms, outcome_ms
            )
            if not funding_covered:
                continue
            entry_short = float(contract_window.iloc[0]["open"])
            touch = first_touch_outcome(
                future,
                contract_window,
                barrier_ratio=barrier,
            )
            event = touch["event"]
            touch_offset = touch["touchOffsetBars"]
            touch_time_ms = (
                expected_times[touch_offset - 1]
                if touch_offset is not None
                else outcome_ms
            )
            funding_to_touch, touch_funding_covered = _funding_cost(
                symbol_funding, entry_ms, touch_time_ms
            )
            if not touch_funding_covered:
                continue
            row = {column: decision[column] for column in selected_columns}
            row.update(
                {
                    "horizon": "4h",
                    "barrier_multiplier": multiplier,
                    "barrier_ratio": barrier,
                    "label_cost_ratio": LABEL_ROUND_TRIP_COST_RATIO,
                    "safety_buffer_ratio": SAFETY_BUFFER_RATIO,
                    "first_touch_event": event,
                    "ambiguous": event == "ambiguous",
                    "action_label": int(event in {"up", "down"}),
                    "side_label": int(event == "up"),
                    "label": (
                        2
                        if event == "up"
                        else 0
                        if event == "down"
                        else 1
                    ),
                    "touch_offset_bars": touch_offset,
                    "touch_time_ms": touch_time_ms,
                    "decision_time_ms": int(
                        pd.Timestamp(decision["time"]).timestamp() * 1000
                    ),
                    "entry_time_ms": entry_ms,
                    "outcome_time_ms": outcome_ms,
                    "outcome_time": pd.Timestamp(outcome_ms, unit="ms", tz="UTC"),
                    "entry_open": entry_spot,
                    "exit_close": float(future.iloc[-1]["close"]),
                    "forward_return": math.log(
                        float(future.iloc[-1]["close"]) / entry_spot
                    ),
                    "label_band": barrier,
                    "short_entry_open": entry_short,
                    "short_exit_close": float(mark_window.iloc[-1]["close"]),
                    "short_execution_ready": True,
                    "funding_cost_ratio": funding_cost,
                    "funding_cost_to_touch": funding_to_touch,
                    "derivatives_coverage": 1.0,
                    "future_volatility": float(
                        np.log(
                            future["close"].to_numpy(dtype=float)
                            / future["close"].shift(1).to_numpy(dtype=float)
                        )[1:].std(ddof=1)
                    ),
                }
            )
            outputs.append(row)
    result = pd.DataFrame(outputs)
    if result.empty:
        raise RuntimeError("v5_label_samples_empty")
    result = result.replace([np.inf, -np.inf], np.nan).dropna(
        subset=[*feature_names, "barrier_ratio", "future_volatility"]
    )
    return result.reset_index(drop=True)


def label_distribution(frame: pd.DataFrame) -> dict:
    counts = frame["first_touch_event"].value_counts().to_dict()
    usable = frame.loc[~frame["ambiguous"]]
    total = max(1, len(usable))
    action = int(usable["action_label"].sum())
    no_trade = int((usable["action_label"] == 0).sum())
    return {
        "rows": int(len(frame)),
        "usableRows": int(len(usable)),
        "events": {name: int(value) for name, value in counts.items()},
        "actionShare": action / total,
        "noTradeShare": no_trade / total,
        "ambiguousShare": float(frame["ambiguous"].mean()),
        "derivativesCoverage": float(frame["derivatives_coverage"].mean()),
    }


__all__ = [
    "HORIZON_BARS",
    "LABEL_ROUND_TRIP_COST_RATIO",
    "MINIMUM_BARRIER_RATIO",
    "SAFETY_BUFFER_RATIO",
    "first_touch_outcome",
    "label_distribution",
    "load_derivative_history",
    "samples_for_multiplier",
]
