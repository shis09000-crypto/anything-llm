"""Leakage-safe, low-cost backtesting primitives for Athena crypto forecasts."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Iterable

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class MarketRules:
    price_tick: float
    quantity_step: float
    minimum_notional: float
    fee_bps_per_side: float = 10.0
    notional_usdt: float = 100.0


def _direction(state: str) -> int:
    return 1 if state == "up" else -1 if state == "down" else 0


def _round_down(value: float, step: float) -> float:
    if not np.isfinite(value) or not np.isfinite(step) or step <= 0:
        return 0.0
    return float(np.floor(value / step + 1e-12) * step)


def vectorized_screen(
    predictions: pd.DataFrame,
    *,
    slippage_bps: float = 2.0,
    fee_bps_per_side: float = 10.0,
    require_perp_short: bool = False,
) -> dict:
    required = {
        "predicted_state",
        "entry_open",
        "exit_close",
        "abstained",
    }
    missing = required.difference(predictions.columns)
    if missing:
        raise ValueError(f"missing_columns:{','.join(sorted(missing))}")
    active = predictions.loc[~predictions["abstained"].astype(bool)].copy()
    directions = active["predicted_state"].map(_direction).to_numpy(dtype=float)
    prices = active[["entry_open", "exit_close"]].to_numpy(dtype=float)
    short_entry = pd.to_numeric(
        active.get("short_entry_open", pd.Series(np.nan, index=active.index)),
        errors="coerce",
    ).to_numpy(dtype=float)
    short_exit = pd.to_numeric(
        active.get("short_exit_close", pd.Series(np.nan, index=active.index)),
        errors="coerce",
    ).to_numpy(dtype=float)
    short_ready = (
        np.isfinite(short_entry)
        & np.isfinite(short_exit)
        & (short_entry > 0)
        & (short_exit > 0)
    )
    down = directions < 0
    if require_perp_short:
        prices[down, 0] = short_entry[down]
        prices[down, 1] = short_exit[down]
    valid = (
        np.isfinite(prices).all(axis=1)
        & (prices[:, 0] > 0)
        & (prices[:, 1] > 0)
        & (directions != 0)
    )
    if require_perp_short:
        valid &= ~down | short_ready
    gross = np.zeros(len(active), dtype=float)
    up = valid & (directions > 0)
    valid_down = valid & down
    gross[up] = prices[up, 1] / prices[up, 0] - 1
    gross[valid_down] = (
        prices[valid_down, 0] - prices[valid_down, 1]
    ) / prices[valid_down, 0]
    funding_ratio = pd.to_numeric(
        active.get("funding_cost_ratio", pd.Series(0.0, index=active.index)),
        errors="coerce",
    ).fillna(0.0).to_numpy(dtype=float)
    round_trip = 2 * (fee_bps_per_side + slippage_bps) / 10_000
    net = (
        gross[valid]
        - round_trip
        - np.where(down[valid], funding_ratio[valid], 0.0)
    )
    return {
        "signals": int(valid.sum()),
        "coverage": float(valid.sum() / len(predictions))
        if len(predictions)
        else 0.0,
        "meanNetReturn": float(net.mean()) if len(net) else 0.0,
        "totalNetReturn": float(net.sum()) if len(net) else 0.0,
        "costRatio": float(round_trip),
    }


def event_simulation(
    predictions: pd.DataFrame,
    *,
    rules: MarketRules,
    slippage_bps: float,
    require_perp_short: bool = False,
) -> dict:
    required = {
        "symbol",
        "horizon",
        "decision_time",
        "outcome_time",
        "predicted_state",
        "abstained",
        "entry_open",
        "exit_close",
    }
    missing = required.difference(predictions.columns)
    if missing:
        raise ValueError(f"missing_columns:{','.join(sorted(missing))}")
    work = predictions.sort_values(
        ["symbol", "horizon", "decision_time"], kind="stable"
    )
    open_until: dict[tuple[str, str], pd.Timestamp] = {}
    trades: list[dict] = []
    comparable_screen_returns: list[float] = []
    rejects: dict[str, int] = {}

    def reject(reason: str) -> None:
        rejects[reason] = rejects.get(reason, 0) + 1

    for row in work.itertuples(index=False):
        if bool(row.abstained) or _direction(row.predicted_state) == 0:
            reject("abstained_or_range")
            continue
        decision = pd.Timestamp(row.decision_time)
        outcome = pd.Timestamp(row.outcome_time)
        key = (str(row.symbol), str(row.horizon))
        if key in open_until and decision < open_until[key]:
            reject("position_already_open")
            continue
        direction = _direction(row.predicted_state)
        if direction < 0 and require_perp_short:
            entry = float(getattr(row, "short_entry_open", np.nan))
            exit_price = float(getattr(row, "short_exit_close", np.nan))
            if not bool(getattr(row, "short_execution_ready", False)):
                reject("perp_short_execution_unavailable")
                continue
        else:
            entry = float(row.entry_open)
            exit_price = float(row.exit_close)
        if not np.isfinite(entry) or not np.isfinite(exit_price):
            reject("data_gap")
            continue
        if entry <= 0 or exit_price <= 0:
            reject("invalid_price")
            continue
        adverse = slippage_bps / 10_000
        executed_entry = entry * (1 + adverse if direction > 0 else 1 - adverse)
        executed_exit = exit_price * (
            1 - adverse if direction > 0 else 1 + adverse
        )
        quantity = _round_down(
            rules.notional_usdt / executed_entry, rules.quantity_step
        )
        if quantity <= 0:
            reject("quantity_step")
            continue
        notional = quantity * executed_entry
        if notional < rules.minimum_notional:
            reject("minimum_notional")
            continue
        entry_fee = notional * rules.fee_bps_per_side / 10_000
        exit_notional = quantity * executed_exit
        exit_fee = exit_notional * rules.fee_bps_per_side / 10_000
        funding_ratio = float(
            getattr(row, "funding_cost_ratio", 0.0) or 0.0
        )
        funding = (
            funding_ratio * rules.notional_usdt if direction < 0 else 0.0
        )
        pnl = (
            quantity * (executed_exit - executed_entry)
            if direction > 0
            else quantity * (executed_entry - executed_exit)
        )
        net = pnl - entry_fee - exit_fee - funding
        comparable_screen_returns.append(net / rules.notional_usdt)
        trades.append(
            {
                "symbol": key[0],
                "horizon": key[1],
                "decisionTime": decision.isoformat(),
                "outcomeTime": outcome.isoformat(),
                "direction": direction,
                "quantity": quantity,
                "entry": executed_entry,
                "exit": executed_exit,
                "feesUsdt": entry_fee + exit_fee,
                "fundingUsdt": funding,
                "netPnlUsdt": net,
                "netReturn": net / rules.notional_usdt,
            }
        )
        open_until[key] = outcome
    returns = np.asarray([trade["netReturn"] for trade in trades], dtype=float)
    equity = np.cumsum(returns)
    peaks = np.maximum.accumulate(np.concatenate(([0.0], equity)))
    drawdown = peaks[1:] - equity if len(equity) else np.array([])
    return {
        "fillModel": "next_tradeable_bar_open_no_partial_fills",
        "fillModelUnavailable": True,
        "fillModelReason": "fill_model_unavailable",
        "rules": asdict(rules),
        "slippageBpsPerSide": float(slippage_bps),
        "signals": len(trades),
        "meanNetReturn": float(returns.mean()) if len(returns) else 0.0,
        "totalNetReturn": float(returns.sum()) if len(returns) else 0.0,
        "comparableVectorizedNetReturn": float(
            np.asarray(comparable_screen_returns, dtype=float).sum()
        )
        if comparable_screen_returns
        else 0.0,
        "maxDrawdown": float(drawdown.max()) if len(drawdown) else 0.0,
        "rejects": rejects,
        "trades": trades,
    }


def sensitivity_report(
    predictions: pd.DataFrame,
    *,
    rules: MarketRules,
    slippage_grid: Iterable[float] = (2, 5, 10, 20),
    require_perp_short: bool = False,
) -> dict:
    screening = {
        str(float(slippage)): vectorized_screen(
            predictions,
            slippage_bps=float(slippage),
            fee_bps_per_side=rules.fee_bps_per_side,
            require_perp_short=require_perp_short,
        )
        for slippage in slippage_grid
    }
    events = {
        str(float(slippage)): event_simulation(
            predictions,
            rules=rules,
            slippage_bps=float(slippage),
            require_perp_short=require_perp_short,
        )
        for slippage in slippage_grid
    }
    violations = [
        f"event_better_than_vectorized:{key}"
        for key, event in events.items()
        if event["totalNetReturn"]
        > event["comparableVectorizedNetReturn"] + 1e-12
    ]
    return {
        "schema": "athena.crypto.backtest",
        "schemaVersion": "2.0",
        "vectorized": screening,
        "event": events,
        "integrity": {"passed": not violations, "violations": violations},
    }
