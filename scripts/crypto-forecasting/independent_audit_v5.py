#!/usr/bin/env python3
"""Independent cost-first-touch audit for Athena crypto forecast v5.

The v5 label, first-touch order, funding coverage, execution cost, and paper
settlement below are recomputed from raw SQLite rows. This module intentionally
does not import training, feature, label, or backtest code.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sqlite3
from bisect import bisect_left, bisect_right
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from scipy.stats import norm
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    confusion_matrix,
    f1_score,
    log_loss,
    matthews_corrcoef,
    precision_recall_fscore_support,
)

CLASS_ORDER = ("down", "range", "up")
CLASS_INDEX = {name: index for index, name in enumerate(CLASS_ORDER)}
SYMBOLS = ("BTC", "ETH", "SOL")
HORIZON_BARS = 48
FIVE_MINUTES_MS = 300_000
HORIZON_MS = HORIZON_BARS * FIVE_MINUTES_MS
LABEL_FEE_BPS_PER_SIDE = 10.0
LABEL_SLIPPAGE_BPS_PER_SIDE = 5.0
SAFETY_BUFFER_BPS = 5.0
RANDOM_SEED = 20260730
PAPER_NOTIONAL_USDT = 100.0
_INDEX_CACHE: dict[tuple[int, str], list[int]] = {}


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
        allow_nan=False,
    )


def canonical_sha256(value: object) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def load_jsonl(path: Path) -> list[dict]:
    records = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise RuntimeError(
                    f"invalid_replay_json:{line_number}"
                ) from error
            if value.get("horizon") == "4h":
                records.append(value)
    if not records:
        raise RuntimeError("v5_replay_empty")
    return records


def verify_model(model_root: Path) -> dict:
    manifest_path = model_root / "manifest.json"
    signature_path = model_root / "manifest.signature.json"
    manifest = json.loads(manifest_path.read_text("utf-8"))
    entry = manifest.get("horizons", {}).get("4h", {})
    failures = []
    artifacts = list(entry.get("decisionLayers", {}).values())
    heads = entry.get("predictionHeads", {})
    for name in ("marketState", "tailRisk"):
        if heads.get(name, {}).get("artifact"):
            artifacts.append(heads[name])
    future_volatility = heads.get("futureVolatility", {})
    if future_volatility.get("artifact"):
        artifacts.append(future_volatility)
    artifacts.extend(future_volatility.get("artifacts", {}).values())
    for artifact in artifacts:
        target = (model_root / artifact["artifact"]).resolve()
        if (
            not target.is_relative_to(model_root.resolve())
            or not target.exists()
            or file_sha256(target) != artifact.get("artifactSha256")
        ):
            failures.append(artifact.get("artifact"))
    return {
        "manifest": manifest,
        "manifestSha256": file_sha256(manifest_path),
        "signaturePresent": signature_path.exists(),
        "signatureSha256": (
            file_sha256(signature_path) if signature_path.exists() else None
        ),
        "artifactsChecked": len(artifacts),
        "artifactFailures": failures,
    }


def _row_index(rows: list[dict], field: str) -> list[int]:
    key = (id(rows), field)
    cached = _INDEX_CACHE.get(key)
    if cached is None:
        cached = [int(row[field]) for row in rows]
        _INDEX_CACHE[key] = cached
    return cached


def _slice_exact(
    rows: list[dict], start_ms: int, count: int
) -> list[dict] | None:
    start = bisect_left(_row_index(rows, "open_time_ms"), start_ms)
    result = rows[start : start + count]
    if len(result) != count:
        return None
    for offset, row in enumerate(result):
        if int(row["open_time_ms"]) != start_ms + offset * FIVE_MINUTES_MS:
            return None
    return result


def _history_before(
    rows: list[dict], decision_at_ms: int, count: int
) -> list[dict]:
    end = bisect_right(_row_index(rows, "close_time_ms"), decision_at_ms - 1)
    return rows[max(0, end - count) : end]


def _funding_coverage_and_cost(
    rows: list[dict], entry_ms: int, exit_ms: int
) -> tuple[float | None, bool]:
    if not rows:
        return None, False
    times = _row_index(rows, "calc_time_ms")
    if times[0] > entry_ms or times[-1] < exit_ms - 8 * 3_600_000:
        return None, False
    start = bisect_right(times, entry_ms)
    end = bisect_right(times, exit_ms)
    selected = rows[start:end]
    if any(int(row["available_at_ms"]) > exit_ms for row in selected):
        return None, False
    # Positive funding is received by a short, so it reduces short cost.
    return -sum(float(row["funding_rate"]) for row in selected), True


def load_market(database: Path, records: list[dict]) -> dict:
    from_ms = min(record["decisionAtMs"] for record in records) - 40 * 86_400_000
    to_ms = max(record["outcomeDueMs"] for record in records) + 86_400_000
    market = {"spot": {}, "contract": {}, "mark": {}, "funding": {}}
    with sqlite3.connect(
        f"file:{database}?mode=ro&immutable=1", uri=True
    ) as connection:
        connection.row_factory = sqlite3.Row
        for symbol in SYMBOLS:
            market["spot"][symbol] = [
                dict(row)
                for row in connection.execute(
                    """
                    SELECT open_time_ms, close_time_ms, open, high, low, close,
                           quote_volume, trade_count, taker_buy_quote_volume,
                           COALESCE(available_at_ms, close_time_ms + 1)
                             AS available_at_ms
                    FROM market_bars
                    WHERE symbol=? AND interval='5m'
                      AND close_time_ms>=? AND open_time_ms<=?
                    ORDER BY open_time_ms
                    """,
                    (symbol, from_ms, to_ms),
                )
            ]
            for series_type in ("contract", "mark"):
                market[series_type][symbol] = [
                    dict(row)
                    for row in connection.execute(
                        """
                        SELECT open_time_ms, close_time_ms, open, high, low,
                               close, available_at_ms
                        FROM derivative_klines
                        WHERE symbol=? AND series_type=? AND interval='5m'
                          AND close_time_ms>=? AND open_time_ms<=?
                        ORDER BY open_time_ms
                        """,
                        (symbol, series_type, from_ms, to_ms),
                    )
                ]
            market["funding"][symbol] = [
                dict(row)
                for row in connection.execute(
                    """
                    SELECT calc_time_ms, funding_rate, available_at_ms
                    FROM derivative_funding_rates
                    WHERE symbol=? AND calc_time_ms>=? AND calc_time_ms<=?
                    ORDER BY calc_time_ms
                    """,
                    (symbol, from_ms, to_ms),
                )
            ]
    return market


def independent_barrier(
    spot_rows: list[dict],
    decision_at_ms: int,
    multiplier: float,
) -> float | None:
    history = _history_before(spot_rows, decision_at_ms, 2_017)
    if len(history) < 289:
        return None
    alpha = 1 - math.exp(math.log(0.5) / 288)
    variance = None
    for previous, current in zip(history, history[1:]):
        value = math.log(float(current["close"]) / float(previous["close"]))
        variance = (
            value * value
            if variance is None
            else alpha * value * value + (1 - alpha) * variance
        )
    horizon_volatility = math.sqrt(max(0.0, variance or 0.0)) * math.sqrt(
        HORIZON_BARS
    )
    cost_floor = (
        2 * (LABEL_FEE_BPS_PER_SIDE + LABEL_SLIPPAGE_BPS_PER_SIDE)
        + SAFETY_BUFFER_BPS
    ) / 10_000
    return max(cost_floor, multiplier * horizon_volatility)


def independent_first_touch(
    record: dict,
    market: dict,
    multiplier: float,
) -> dict:
    symbol = record["symbol"]
    entry_ms = ((int(record["decisionAtMs"]) + FIVE_MINUTES_MS - 1)
                // FIVE_MINUTES_MS) * FIVE_MINUTES_MS
    spot = _slice_exact(market["spot"][symbol], entry_ms, HORIZON_BARS)
    contract = _slice_exact(
        market["contract"][symbol], entry_ms, HORIZON_BARS
    )
    mark = _slice_exact(market["mark"][symbol], entry_ms, HORIZON_BARS)
    if spot is None or contract is None or mark is None:
        return {"valid": False, "reason": "execution_window_missing"}
    if any(
        int(row["available_at_ms"]) <= record["decisionAtMs"]
        for row in spot[1:] + contract[1:] + mark[1:]
    ):
        return {"valid": False, "reason": "future_row_available_too_early"}
    barrier = independent_barrier(
        market["spot"][symbol], record["decisionAtMs"], multiplier
    )
    if barrier is None:
        return {"valid": False, "reason": "volatility_history_missing"}
    entry_spot = float(spot[0]["open"])
    entry_short = float(contract[0]["open"])
    upper = entry_spot * math.exp(barrier)
    lower = entry_short * math.exp(-barrier)
    event = "no_trade"
    touch_offset = None
    for offset, (spot_row, contract_row) in enumerate(zip(spot, contract)):
        up_hit = float(spot_row["high"]) >= upper
        down_hit = float(contract_row["low"]) <= lower
        if up_hit and down_hit:
            event = "ambiguous"
            touch_offset = offset
            break
        if up_hit:
            event = "up"
            touch_offset = offset
            break
        if down_hit:
            event = "down"
            touch_offset = offset
            break
    exit_offset = touch_offset if touch_offset is not None else HORIZON_BARS - 1
    exit_ms = entry_ms + exit_offset * FIVE_MINUTES_MS
    funding, funding_covered = _funding_coverage_and_cost(
        market["funding"][symbol], entry_ms, exit_ms
    )
    if not funding_covered:
        return {"valid": False, "reason": "funding_window_missing"}
    return {
        "valid": True,
        "event": event,
        "barrier": barrier,
        "entryMs": entry_ms,
        "exitMs": exit_ms,
        "touchOffset": touch_offset,
        "spotEntry": entry_spot,
        "spotTimeoutExit": float(spot[-1]["close"]),
        "shortEntry": entry_short,
        "shortTimeoutExit": float(mark[-1]["close"]),
        "funding": funding,
        "maximumAvailableAtMs": max(
            int(row["available_at_ms"])
            for row in _history_before(
                market["spot"][symbol], record["decisionAtMs"], 2_017
            )
        ),
    }


def execution_return(
    outcome: dict, predicted: str, slippage_bps: float
) -> float | None:
    if predicted not in {"up", "down"} or not outcome.get("valid"):
        return None
    barrier = float(outcome["barrier"])
    event = outcome["event"]
    total_cost = (20.0 + 2 * slippage_bps) / 10_000
    if predicted == "up":
        gross = (
            math.exp(barrier) - 1
            if event == "up"
            else math.exp(-barrier) - 1
            if event == "down"
            else outcome["spotTimeoutExit"] / outcome["spotEntry"] - 1
        )
        return gross - total_cost
    gross = (
        1 - math.exp(-barrier)
        if event == "down"
        else 1 - math.exp(barrier)
        if event == "up"
        else (
            outcome["shortEntry"] - outcome["shortTimeoutExit"]
        ) / outcome["shortEntry"]
    )
    return gross - total_cost - float(outcome["funding"])


def ece(labels: np.ndarray, probabilities: np.ndarray) -> float:
    confidence = probabilities.max(axis=1)
    predicted = probabilities.argmax(axis=1)
    result = 0.0
    for lower in np.linspace(0, 1, 10, endpoint=False):
        upper = lower + 0.1
        mask = (confidence >= lower) & (
            confidence <= upper if upper >= 1 else confidence < upper
        )
        if mask.any():
            result += (
                mask.mean()
                * abs(
                    float((predicted[mask] == labels[mask]).mean())
                    - float(confidence[mask].mean())
                )
            )
    return float(result)


def classification_metrics(
    labels: np.ndarray, predicted: np.ndarray
) -> dict:
    precision, recall, f1, support = precision_recall_fscore_support(
        labels, predicted, labels=[0, 1, 2], zero_division=0
    )
    return {
        "samples": int(len(labels)),
        "accuracy": float(accuracy_score(labels, predicted)),
        "balancedAccuracy": float(
            balanced_accuracy_score(labels, predicted)
        ),
        "macroF1": float(f1_score(labels, predicted, average="macro")),
        "mcc": float(matthews_corrcoef(labels, predicted)),
        "confusionMatrix": confusion_matrix(
            labels, predicted, labels=[0, 1, 2]
        ).astype(int).tolist(),
        "classes": {
            name: {
                "precision": float(precision[index]),
                "recall": float(recall[index]),
                "f1": float(f1[index]),
                "support": int(support[index]),
            }
            for index, name in enumerate(CLASS_ORDER)
        },
    }


def multiclass_brier(
    labels: np.ndarray, probabilities: np.ndarray
) -> float:
    return float(
        np.square(probabilities - np.eye(3)[labels]).sum(axis=1).mean()
    )


def block_bootstrap(values: np.ndarray, decisions: np.ndarray) -> dict:
    valid = np.isfinite(values)
    values = values[valid]
    decisions = decisions[valid]
    blocks = np.unique(decisions // 86_400_000)
    if len(values) < 30 or len(blocks) < 8:
        return {"lower95": None, "upper95": None, "blocks": int(len(blocks))}
    grouped = [values[(decisions // 86_400_000) == block] for block in blocks]
    rng = np.random.default_rng(RANDOM_SEED)
    means = []
    for _ in range(1_000):
        sample = np.concatenate(
            [grouped[index] for index in rng.integers(0, len(grouped), len(grouped))]
        )
        means.append(float(sample.mean()))
    lower, upper = np.quantile(means, [0.025, 0.975])
    return {
        "lower95": float(lower),
        "upper95": float(upper),
        "blocks": int(len(blocks)),
    }


def trading_metrics(values: np.ndarray, decisions: np.ndarray) -> dict:
    valid = np.isfinite(values)
    values = values[valid]
    decisions = decisions[valid]
    if not len(values):
        return {"signals": 0}
    equity = np.cumsum(values)
    peak = np.maximum.accumulate(np.concatenate(([0.0], equity)))[1:]
    downside = values[values < 0]
    standard = values.std(ddof=1) if len(values) > 1 else 0
    downside_standard = downside.std(ddof=1) if len(downside) > 1 else 0
    gains = float(values[values > 0].sum())
    losses = float(-values[values < 0].sum())
    return {
        "signals": int(len(values)),
        "winRate": float((values > 0).mean()),
        "meanNetReturn": float(values.mean()),
        "totalNetReturn": float(values.sum()),
        "paperPnlUsdt": float(values.sum() * PAPER_NOTIONAL_USDT),
        "profitFactor": gains / losses if losses > 0 else None,
        "sharpe": (
            float(values.mean() / standard * math.sqrt(365))
            if standard > 0
            else 0.0
        ),
        "sortino": (
            float(values.mean() / downside_standard * math.sqrt(365))
            if downside_standard > 0
            else 0.0
        ),
        "maximumDrawdown": float(np.max(peak - equity)),
        "turnover": int(len(values) * 2),
        "bootstrapMean": block_bootstrap(values, decisions),
    }


def diebold_mariano(
    candidate_loss: np.ndarray,
    baseline_loss: np.ndarray,
    lag: int = 4,
) -> dict:
    difference = candidate_loss - baseline_loss
    difference = difference[np.isfinite(difference)]
    if len(difference) < 30:
        return {"statistic": None, "pValue": None}
    centered = difference - difference.mean()
    variance = float(np.dot(centered, centered) / len(centered))
    for offset in range(1, min(lag, len(centered) - 1) + 1):
        covariance = float(
            np.dot(centered[offset:], centered[:-offset]) / len(centered)
        )
        variance += 2 * (1 - offset / (lag + 1)) * covariance
    statistic = difference.mean() / math.sqrt(
        max(variance, 1e-12) / len(difference)
    )
    return {
        "statistic": float(statistic),
        "pValue": float(2 * (1 - norm.cdf(abs(statistic)))),
        "candidateBetter": bool(statistic < 0),
    }


def holm_bonferroni(comparisons: dict[str, dict]) -> dict:
    result = {
        name: {**value, "holmAdjustedPValue": None, "holmRejected": False}
        for name, value in comparisons.items()
    }
    valid = sorted(
        (
            (name, float(value["pValue"]))
            for name, value in comparisons.items()
            if value.get("pValue") is not None
        ),
        key=lambda item: item[1],
    )
    running = 0.0
    prefix = True
    for rank, (name, p_value) in enumerate(valid):
        remaining = len(valid) - rank
        running = max(running, min(1.0, remaining * p_value))
        result[name]["holmAdjustedPValue"] = running
        if prefix and p_value <= 0.05 / remaining:
            result[name]["holmRejected"] = True
        else:
            prefix = False
    return result


def pbo_estimate(strategy_returns: np.ndarray) -> dict:
    if strategy_returns.ndim != 2 or strategy_returns.shape[0] < 80:
        return {"pbo": None, "combinations": 0}
    blocks = np.array_split(np.arange(len(strategy_returns)), 8)
    logits = []
    from itertools import combinations

    for selected in combinations(range(8), 4):
        train_index = np.concatenate([blocks[index] for index in selected])
        test_index = np.concatenate(
            [blocks[index] for index in range(8) if index not in selected]
        )
        train_mean = strategy_returns[train_index].mean(axis=0)
        winner = int(np.argmax(train_mean))
        test_mean = strategy_returns[test_index].mean(axis=0)
        rank = int(np.argsort(np.argsort(test_mean))[winner]) + 1
        percentile = rank / (len(test_mean) + 1)
        logits.append(math.log(percentile / max(1e-12, 1 - percentile)))
    return {
        "pbo": float(np.mean(np.asarray(logits) < 0)),
        "combinations": len(logits),
    }


def deflated_sharpe_confidence(values: np.ndarray, trials: int) -> float | None:
    if len(values) < 30 or values.std(ddof=1) <= 0:
        return None
    observed = float(values.mean() / values.std(ddof=1))
    expected_max = math.sqrt(2 * math.log(max(2, trials))) / math.sqrt(
        len(values)
    )
    standard_error = 1 / math.sqrt(max(1, len(values) - 1))
    return float(norm.cdf((observed - expected_max) / standard_error))


def audit_traces(records: list[dict], manifest: dict) -> dict:
    entry = manifest["horizons"]["4h"]
    thresholds = entry.get("thresholds", {})
    traced = [record for record in records if record.get("trace")][:50]
    failures = []
    for record in traced:
        probabilities = np.asarray(
            [record["probabilities"][name] for name in CLASS_ORDER],
            dtype=float,
        )
        if not np.isclose(probabilities.sum(), 1, atol=1e-8):
            failures.append(f"{record['passportRef']}:probability_sum")
        if record["maximumAvailableAtMs"] > record["decisionAtMs"]:
            failures.append(f"{record['passportRef']}:availability_leak")
        if record.get("labelPolicyVersion") != "cost-first-touch-v5":
            failures.append(f"{record['passportRef']}:label_policy")
        if record.get("actionProbability") != record.get(
            "tradeabilityProbability"
        ):
            failures.append(f"{record['passportRef']}:action_alias")
        trace = record["trace"]
        if len(trace.get("featureNames", [])) != len(
            trace.get("featureVector", [])
        ):
            failures.append(f"{record['passportRef']}:feature_order")
        risk = record.get("riskHeads") or {}
        selected = (
            float(record.get("evidenceCoverage") or 0)
            >= float(thresholds.get("minEvidenceCoverage", 0.9))
            and
            float(record.get("tradeabilityProbability") or 0)
            >= float(thresholds.get("minActionProbability", 1))
            and max(
                float(
                    record.get("conditionalSideProbability", {}).get("up", 0)
                ),
                float(
                    record.get("conditionalSideProbability", {}).get(
                        "down", 0
                    )
                ),
            )
            >= float(thresholds.get("minDirectionProbability", 1))
            and float(
                risk.get("tailRisk", {}).get("probability", 0)
            )
            <= float(thresholds.get("maxTailRiskProbability", 1))
            and float(
                risk.get("marketState", {})
                .get("probabilities", {})
                .get("stress", 0)
            )
            <= float(thresholds.get("maxStressProbability", 1))
        )
        if bool(record["selectedIgnoringShadow"]) != selected:
            failures.append(f"{record['passportRef']}:selection_policy")
    return {
        "requested": 50,
        "traces": len(traced),
        "failures": failures,
        "passed": len(traced) >= min(50, len(records)) and not failures,
    }


def _non_overlapping(rows: list[dict], selected_field: str) -> np.ndarray:
    selected = np.zeros(len(rows), dtype=bool)
    next_available = {symbol: 0 for symbol in SYMBOLS}
    for index, row in enumerate(rows):
        if not row[selected_field]:
            continue
        record = row["record"]
        symbol = record["symbol"]
        if record["decisionAtMs"] < next_available[symbol]:
            continue
        selected[index] = True
        next_available[symbol] = record["outcomeDueMs"]
    return selected


def audit(records: list[dict], market: dict, manifest: dict) -> dict:
    entry = manifest["horizons"]["4h"]
    multiplier = float(
        entry.get("labelContract", {}).get("selectedBarrierMultiplier", 0)
    )
    if multiplier not in {0.5, 0.75, 1.0}:
        raise RuntimeError("invalid_v5_barrier_multiplier")
    rows = []
    invalid = {}
    barrier_mismatches = []
    ambiguous_abstentions = 0
    for record in records:
        outcome = independent_first_touch(record, market, multiplier)
        if not outcome.get("valid"):
            reason = outcome.get("reason", "unknown")
            invalid[reason] = invalid.get(reason, 0) + 1
            continue
        if outcome["event"] == "ambiguous":
            ambiguous_abstentions += 1
            continue
        replay_barrier = record.get("labelBarrierRatio")
        if (
            replay_barrier is None
            or not math.isclose(
                float(replay_barrier),
                float(outcome["barrier"]),
                rel_tol=0,
                abs_tol=1e-10,
            )
        ):
            barrier_mismatches.append(record["passportRef"])
        event = outcome["event"]
        actual = "range" if event == "no_trade" else event
        history = _history_before(
            market["spot"][record["symbol"]],
            record["decisionAtMs"],
            HORIZON_BARS + 1,
        )
        past_return = (
            math.log(float(history[-1]["close"]) / float(history[0]["close"]))
            if len(history) > HORIZON_BARS
            else 0.0
        )
        candidate = record["candidateState"]
        row = {
            "record": record,
            "outcome": outcome,
            "actual": CLASS_INDEX[actual],
            "candidate": CLASS_INDEX[candidate],
            "selected": bool(record["selectedIgnoringShadow"]),
            "momentum": CLASS_INDEX["up" if past_return >= 0 else "down"],
            "persistence": CLASS_INDEX[
                "up"
                if len(history) > 1
                and float(history[-1]["close"]) >= float(history[-2]["close"])
                else "down"
            ],
            "fixed_up": CLASS_INDEX["up"],
            "fixed_down": CLASS_INDEX["down"],
            "probability": np.asarray(
                [record["probabilities"][name] for name in CLASS_ORDER],
                dtype=float,
            ),
        }
        for slippage in (2, 5, 10, 20):
            row[f"net_{slippage}"] = execution_return(
                outcome, candidate, float(slippage)
            )
        rows.append(row)
    rows.sort(
        key=lambda row: (
            row["record"]["decisionAtMs"],
            row["record"]["symbol"],
        )
    )
    if not rows:
        return {"samples": 0, "invalid": invalid, "historicalGatePassed": False}
    labels = np.asarray([row["actual"] for row in rows], dtype=int)
    predicted = np.asarray([row["candidate"] for row in rows], dtype=int)
    probabilities = np.vstack([row["probability"] for row in rows])
    selected = np.asarray([row["selected"] for row in rows], dtype=bool)
    # Hindsight selected-majority is intentionally a strict baseline.
    selected_sides = labels[selected & (labels != CLASS_INDEX["range"])]
    majority = (
        CLASS_INDEX["up"]
        if len(selected_sides)
        and float(np.mean(selected_sides == CLASS_INDEX["up"])) >= 0.5
        else CLASS_INDEX["down"]
    )
    for row in rows:
        row["selected_majority"] = majority
    baseline_names = (
        "momentum",
        "persistence",
        "fixed_up",
        "fixed_down",
        "selected_majority",
    )
    baseline_predictions = {
        name: np.asarray([row[name] for row in rows], dtype=int)
        for name in baseline_names
    }
    candidate_metrics = classification_metrics(labels, predicted)
    baseline_metrics = {
        name: classification_metrics(labels, values)
        for name, values in baseline_predictions.items()
    }
    selected_accuracy = (
        float(accuracy_score(labels[selected], predicted[selected]))
        if selected.any()
        else None
    )
    selected_baseline = {
        name: (
            float(accuracy_score(labels[selected], values[selected]))
            if selected.any()
            else None
        )
        for name, values in baseline_predictions.items()
    }
    best_baseline_name = max(
        selected_baseline,
        key=lambda name: selected_baseline[name] or 0,
    )
    best_baseline_accuracy = selected_baseline[best_baseline_name]
    empirical = np.bincount(labels, minlength=3) / len(labels)
    brier = multiclass_brier(labels, probabilities)
    reference_probability = np.tile(empirical, (len(labels), 1))
    reference_brier = multiclass_brier(labels, reference_probability)
    decisions = np.asarray(
        [row["record"]["decisionAtMs"] for row in rows], dtype=np.int64
    )
    non_overlapping = _non_overlapping(rows, "selected")
    trading = {}
    for slippage in (2, 5, 10, 20):
        values = np.asarray(
            [
                row[f"net_{slippage}"]
                if non_overlapping[index] and row["candidate"] != CLASS_INDEX["range"]
                else np.nan
                for index, row in enumerate(rows)
            ],
            dtype=float,
        )
        trading[str(slippage)] = trading_metrics(values, decisions)
    strategy_returns = []
    candidate_returns = np.nan_to_num(
        np.asarray(
            [
                row["net_5"]
                if non_overlapping[index] and row["candidate"] != CLASS_INDEX["range"]
                else np.nan
                for index, row in enumerate(rows)
            ],
            dtype=float,
        ),
        nan=0,
    )
    strategy_returns.append(candidate_returns)
    for name in baseline_names:
        values = []
        for row in rows:
            side = CLASS_ORDER[row[name]]
            value = execution_return(row["outcome"], side, 5)
            values.append(0.0 if value is None else value)
        strategy_returns.append(np.asarray(values, dtype=float))
    pbo = pbo_estimate(np.column_stack(strategy_returns))
    active_returns = candidate_returns[candidate_returns != 0]
    deflated = deflated_sharpe_confidence(active_returns, trials=16)
    candidate_loss = np.square(
        probabilities - np.eye(3)[labels]
    ).sum(axis=1)
    comparisons = {
        "empiricalFrequency": diebold_mariano(
            candidate_loss,
            np.square(reference_probability - np.eye(3)[labels]).sum(axis=1),
        )
    }
    for name, values in baseline_predictions.items():
        comparisons[name] = diebold_mariano(
            candidate_loss,
            np.square(np.eye(3)[values] - np.eye(3)[labels]).sum(axis=1),
        )
    historical_volatility = []
    for row in rows:
        history = _history_before(
            market["spot"][row["record"]["symbol"]],
            row["record"]["decisionAtMs"],
            289,
        )
        values = np.asarray([float(value["close"]) for value in history])
        historical_volatility.append(
            float(np.diff(np.log(values)).std(ddof=1))
            if len(values) >= 289
            else 0.0
        )
    low, high = np.quantile(historical_volatility, [1 / 3, 2 / 3])
    for row, value in zip(rows, historical_volatility):
        row["regime"] = "low" if value <= low else "high" if value >= high else "medium"
    grouped = {"symbol": {}, "regime": {}}
    subgroup_gate = True
    for field, values in (
        ("symbol", SYMBOLS),
        ("regime", ("low", "medium", "high")),
    ):
        for value in values:
            mask = np.asarray(
                [
                    (
                        row["record"]["symbol"]
                        if field == "symbol"
                        else row["regime"]
                    )
                    == value
                    for row in rows
                ],
                dtype=bool,
            )
            group_selected = mask & selected
            if not mask.any():
                continue
            group_candidate = (
                float(accuracy_score(labels[group_selected], predicted[group_selected]))
                if group_selected.any()
                else None
            )
            group_baseline = (
                max(
                    float(
                        accuracy_score(
                            labels[group_selected],
                            baseline_predictions[name][group_selected],
                        )
                    )
                    for name in baseline_names
                )
                if group_selected.any()
                else None
            )
            grouped[field][value] = {
                "samples": int(mask.sum()),
                "selectedSamples": int(group_selected.sum()),
                "candidateSelectedAccuracy": group_candidate,
                "bestBaselineSelectedAccuracy": group_baseline,
            }
            if (
                group_selected.sum() >= 80
                and group_candidate is not None
                and group_baseline is not None
                and group_candidate < group_baseline - 0.05
            ):
                subgroup_gate = False
    high_confidence_errors = sorted(
        (
            {
                "passportRef": row["record"]["passportRef"],
                "symbol": row["record"]["symbol"],
                "decisionAtMs": row["record"]["decisionAtMs"],
                "actual": CLASS_ORDER[row["actual"]],
                "predicted": CLASS_ORDER[row["candidate"]],
                "confidence": float(row["probability"].max()),
                "netReturn5Bps": row["net_5"],
            }
            for row in rows
            if row["selected"] and row["actual"] != row["candidate"]
        ),
        key=lambda value: value["confidence"],
        reverse=True,
    )[:50]
    probability_ece = ece(labels, probabilities)
    derivative_covered = len(rows) + ambiguous_abstentions
    gates = {
        "derivativesCoverage": (
            derivative_covered / max(1, len(records)) >= 0.95
        ),
        "labelParity": not barrier_mismatches,
        "coverage": float(selected.mean()) >= 0.10,
        "selectiveAccuracy": (
            selected_accuracy is not None
            and best_baseline_accuracy is not None
            and selected_accuracy >= best_baseline_accuracy + 0.05
        ),
        "brierSkill": reference_brier > 0 and 1 - brier / reference_brier > 0,
        "ece": probability_ece <= 0.05,
        "mcc": candidate_metrics["mcc"] > 0,
        "costBootstrap5Bps": (
            trading["5"].get("bootstrapMean", {}).get("lower95") is not None
            and trading["5"]["bootstrapMean"]["lower95"] > 0
        ),
        "pbo": pbo.get("pbo") is not None and pbo["pbo"] < 0.20,
        "deflatedSharpe": deflated is not None and deflated > 0.95,
        "subgroupRegression": subgroup_gate,
    }
    return {
        "samples": len(rows),
        "inputReplayRecords": len(records),
        "invalid": invalid,
        "ambiguousAbstentions": ambiguous_abstentions,
        "barrierMismatches": barrier_mismatches[:50],
        "derivativesCoverage": derivative_covered / max(1, len(records)),
        "candidate": candidate_metrics,
        "probability": {
            "brier": brier,
            "referenceBrier": reference_brier,
            "brierSkill": (
                float(1 - brier / reference_brier)
                if reference_brier > 0
                else None
            ),
            "logLoss": float(
                log_loss(labels, probabilities, labels=[0, 1, 2])
            ),
            "ece": probability_ece,
            "meanProbability": dict(
                zip(CLASS_ORDER, probabilities.mean(axis=0).astype(float))
            ),
            "actualFrequency": dict(
                zip(CLASS_ORDER, empirical.astype(float))
            ),
        },
        "selective": {
            "coverage": float(selected.mean()),
            "samples": int(selected.sum()),
            "accuracy": selected_accuracy,
            "bestBaseline": best_baseline_name,
            "bestBaselineAccuracy": best_baseline_accuracy,
            "baselineAccuracies": selected_baseline,
        },
        "baselines": baseline_metrics,
        "grouped": grouped,
        "trading": trading,
        "statistics": {
            "dieboldMariano": holm_bonferroni(comparisons),
            "pbo": pbo,
            "deflatedSharpeConfidence": deflated,
            "multipleComparisonCorrection": "holm_bonferroni",
        },
        "highConfidenceErrors": high_confidence_errors,
        "gates": gates,
        "historicalGatePassed": all(gates.values()),
    }


def markdown_report(report: dict) -> str:
    result = report["result"]
    lower = (
        result.get("trading", {})
        .get("5", {})
        .get("bootstrapMean", {})
        .get("lower95")
    )
    lines = [
        "# Athena Crypto Forecast v5 Independent Audit",
        "",
        f"- Verdict: **{report['verdict']}**",
        f"- Classification: `{report['classification']}`",
        f"- Generated: {report['generatedAt']}",
        f"- Replay records: {report['replay']['records']}",
        f"- Independently usable records: {result.get('samples', 0)}",
        f"- Trace failures: {len(report['traceAudit']['failures'])}",
        "",
        "## 4h result",
        "",
        "| Coverage | Selective accuracy | Best baseline | Baseline accuracy | Brier skill | ECE | 5bps net lower 95% |",
        "|---:|---:|---|---:|---:|---:|---:|",
        "| "
        + " | ".join(
            [
                f"{result.get('selective', {}).get('coverage', 0):.2%}",
                (
                    f"{result['selective']['accuracy']:.2%}"
                    if result.get("selective", {}).get("accuracy") is not None
                    else "n/a"
                ),
                str(result.get("selective", {}).get("bestBaseline", "n/a")),
                (
                    f"{result['selective']['bestBaselineAccuracy']:.2%}"
                    if result.get("selective", {}).get(
                        "bestBaselineAccuracy"
                    )
                    is not None
                    else "n/a"
                ),
                (
                    f"{result['probability']['brierSkill']:.4f}"
                    if result.get("probability", {}).get("brierSkill")
                    is not None
                    else "n/a"
                ),
                f"{result.get('probability', {}).get('ece', 0):.4f}",
                f"{lower:.6f}" if lower is not None else "n/a",
            ]
        )
        + " |",
        "",
        "## Failed gates",
        "",
    ]
    failed = [
        name for name, passed in result.get("gates", {}).items() if not passed
    ]
    lines.append(f"- {', '.join(failed) if failed else 'none'}")
    lines.extend(
        [
            "",
            "## Slippage sensitivity",
            "",
            "| Slippage per side | Signals | Mean net return | Paper PnL USDT | Lower 95% |",
            "|---:|---:|---:|---:|---:|",
        ]
    )
    for slippage, value in result.get("trading", {}).items():
        lines.append(
            f"| {slippage}bps | {value.get('signals', 0)} | "
            f"{value.get('meanNetReturn', 0):.6f} | "
            f"{value.get('paperPnlUsdt', 0):.2f} | "
            f"{value.get('bootstrapMean', {}).get('lower95', 'n/a')} |"
        )
    lines.extend(
        [
            "",
            "## Highest-confidence selected errors",
            "",
            "| Passport | Symbol | Actual | Predicted | Confidence | Net return 5bps |",
            "|---|---|---|---|---:|---:|",
        ]
    )
    for value in result.get("highConfidenceErrors", [])[:20]:
        lines.append(
            f"| {value['passportRef'][:16]} | {value['symbol']} | "
            f"{value['actual']} | {value['predicted']} | "
            f"{value['confidence']:.4f} | {value['netReturn5Bps']:.6f} |"
        )
    lines.extend(
        [
            "",
            "Historical replay is semi-blind. Even a passing historical result "
            "can only enter prospective Shadow and cannot activate v5.",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--model-root", required=True, type=Path)
    parser.add_argument("--replay", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    records = load_jsonl(args.replay)
    model = verify_model(args.model_root)
    manifest = model.pop("manifest")
    if manifest.get("featureRegistryVersion") != "crypto-forecast-features-v5":
        raise RuntimeError("independent_audit_requires_v5_model")
    if any(not record.get("modelSignatureValid") for record in records):
        raise RuntimeError("replay_contains_unverified_model")
    market = load_market(args.database, records)
    trace_audit = audit_traces(records, manifest)
    result = audit(records, market, manifest)
    authenticity = (
        not model["artifactFailures"]
        and model["signaturePresent"]
        and trace_audit["passed"]
    )
    historical_passed = authenticity and result["historicalGatePassed"]
    verdict = "PASS_WITH_LIMITATIONS" if historical_passed else "FAIL"
    report = {
        "schema": "athena.crypto.forecast-independent-audit",
        "schemaVersion": "5.0",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "classification": "historical_semi_blind",
        "verdict": verdict,
        "activationAllowed": False,
        "shadowDeploymentEligible": historical_passed,
        "model": model,
        "replay": {
            "path": str(args.replay),
            "sha256": file_sha256(args.replay),
            "records": len(records),
        },
        "database": {
            "sha256": file_sha256(args.database),
        },
        "traceAudit": trace_audit,
        "result": result,
        "authenticityPassed": authenticity,
    }
    json_path = args.output / "crypto-forecast-v5-independent-audit.json"
    md_path = args.output / "crypto-forecast-v5-independent-audit.md"
    json_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    md_path.write_text(markdown_report(report), encoding="utf-8")
    manifest_body = {
        "schema": "athena.crypto.forecast-audit-manifest",
        "schemaVersion": "5.0",
        "reportSha256": file_sha256(json_path),
        "markdownSha256": file_sha256(md_path),
        "auditorSha256": file_sha256(Path(__file__)),
        "modelManifestSha256": model["manifestSha256"],
        "replaySha256": file_sha256(args.replay),
        "databaseSha256": file_sha256(args.database),
        "verdict": verdict,
    }
    manifest_body["manifestSha256"] = canonical_sha256(manifest_body)
    (args.output / "audit-manifest.json").write_text(
        json.dumps(manifest_body, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "verdict": verdict,
                "report": str(json_path),
                "samples": result.get("samples", 0),
                "coverage": result.get("selective", {}).get("coverage"),
                "failedGates": [
                    name
                    for name, passed in result.get("gates", {}).items()
                    if not passed
                ],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
