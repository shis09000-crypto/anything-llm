#!/usr/bin/env python3
"""Independent v4 historical replay auditor.

This module intentionally does not import Athena training, feature, label, or
backtest modules. It recomputes labels, execution, costs, metrics, and selected
feature traces from the raw SQLite snapshot.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sqlite3
from bisect import bisect_left, bisect_right
from decimal import Decimal
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
HORIZON_MS = {"4h": 4 * 3_600_000, "24h": 24 * 3_600_000}
HORIZON_BARS = {"4h": 48, "24h": 288}
ROUND_TRIP_FEE_BPS = 20.0
PAPER_NOTIONAL_USDT = 100.0
RANDOM_SEED = 20260730
_ROW_INDEX_CACHE: dict[tuple[int, str], list[int]] = {}


def javascript_number(value: float) -> str:
    if not math.isfinite(value):
        return "null"
    if value == 0:
        return "0"
    raw = repr(float(value)).lower()
    absolute = abs(value)
    if 1e-6 <= absolute < 1e21:
        return format(Decimal(raw), "f")
    if "e" not in raw:
        return raw
    mantissa, exponent = raw.split("e", 1)
    exponent_value = int(exponent)
    sign = "+" if exponent_value >= 0 else ""
    return f"{mantissa}e{sign}{exponent_value}"


def javascript_canonical_json(value: object) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return javascript_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return (
            "["
            + ",".join(javascript_canonical_json(item) for item in value)
            + "]"
        )
    if isinstance(value, dict):
        return (
            "{"
            + ",".join(
                f"{json.dumps(key, ensure_ascii=False)}:"
                f"{javascript_canonical_json(value[key])}"
                for key in sorted(value)
            )
            + "}"
        )
    raise TypeError(f"unsupported_canonical_type:{type(value).__name__}")


def canonical_sha256(value: object) -> str:
    return hashlib.sha256(
        javascript_canonical_json(value).encode("utf-8")
    ).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_jsonl(path: Path) -> list[dict]:
    records = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as error:
                raise RuntimeError(
                    f"invalid_replay_json:{line_number}"
                ) from error
    return records


def verify_model_artifacts(model_root: Path) -> dict:
    manifest_path = model_root / "manifest.json"
    signature_path = model_root / "manifest.signature.json"
    manifest = json.loads(manifest_path.read_text("utf-8"))
    failures = []
    checked = 0
    for horizon, entry in manifest["horizons"].items():
        artifacts = []
        if entry.get("decisionLayers"):
            artifacts.extend(entry["decisionLayers"].values())
        elif entry.get("artifact"):
            artifacts.append(entry)
        heads = entry.get("predictionHeads", {})
        artifacts.extend(
            heads.get("returnQuantiles", {}).get("artifacts", {}).values()
        )
        future_volatility = heads.get("futureVolatility", {})
        if future_volatility.get("artifact"):
            artifacts.append(future_volatility)
        artifacts.extend(future_volatility.get("artifacts", {}).values())
        for name in ("marketState", "tailRisk"):
            if heads.get(name, {}).get("artifact"):
                artifacts.append(heads[name])
        for artifact in artifacts:
            target = (model_root / artifact["artifact"]).resolve()
            checked += 1
            if (
                not target.is_relative_to(model_root.resolve())
                or not target.exists()
                or file_sha256(target) != artifact.get("artifactSha256")
            ):
                failures.append(f"{horizon}:{artifact.get('artifact')}")
    return {
        "manifest": manifest,
        "manifestSha256": file_sha256(manifest_path),
        "signaturePresent": signature_path.exists(),
        "signatureSha256": (
            file_sha256(signature_path) if signature_path.exists() else None
        ),
        "artifactsChecked": checked,
        "artifactFailures": failures,
    }


def load_market_data(database: Path, records: list[dict]) -> dict:
    from_ms = min(record["decisionAtMs"] for record in records) - 40 * 86_400_000
    to_ms = max(record["outcomeDueMs"] for record in records) + 86_400_000
    result = {"spot": {}, "derivatives": {}, "funding": {}}
    with sqlite3.connect(
        f"file:{database}?mode=ro&immutable=1", uri=True
    ) as connection:
        connection.row_factory = sqlite3.Row
        for symbol in ("BTC", "ETH", "SOL"):
            spot = connection.execute(
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
            ).fetchall()
            result["spot"][symbol] = [dict(row) for row in spot]
            result["derivatives"][symbol] = {}
            for series_type in ("contract", "mark"):
                rows = connection.execute(
                    """
                    SELECT open_time_ms, close_time_ms, open, high, low, close,
                           available_at_ms
                    FROM derivative_klines
                    WHERE symbol=? AND series_type=? AND interval='5m'
                      AND close_time_ms>=? AND open_time_ms<=?
                    ORDER BY open_time_ms
                    """,
                    (symbol, series_type, from_ms, to_ms),
                ).fetchall()
                result["derivatives"][symbol][series_type] = [
                    dict(row) for row in rows
                ]
            funding = connection.execute(
                """
                SELECT calc_time_ms, funding_rate, available_at_ms
                FROM derivative_funding_rates
                WHERE symbol=? AND calc_time_ms>=? AND calc_time_ms<=?
                ORDER BY calc_time_ms
                """,
                (symbol, from_ms, to_ms),
            ).fetchall()
            result["funding"][symbol] = [dict(row) for row in funding]
    return result


def row_index(rows: list[dict], field: str) -> list[int]:
    key = (id(rows), field)
    cached = _ROW_INDEX_CACHE.get(key)
    if cached is None:
        cached = [int(row[field]) for row in rows]
        _ROW_INDEX_CACHE[key] = cached
    return cached


def row_at_or_after(rows: list[dict], open_time_ms: int) -> dict | None:
    if not rows:
        return None
    index = bisect_left(row_index(rows, "open_time_ms"), open_time_ms)
    return rows[index] if index < len(rows) else None


def row_at_or_before_close(rows: list[dict], close_time_ms: int) -> dict | None:
    if not rows:
        return None
    closes = row_index(rows, "close_time_ms")
    index = bisect_right(closes, close_time_ms) - 1
    return rows[index] if index >= 0 else None


def window_before(rows: list[dict], close_time_ms: int, count: int) -> list[dict]:
    closes = row_index(rows, "close_time_ms")
    end = bisect_right(closes, close_time_ms)
    return rows[max(0, end - count) : end]


def independent_label_band(rows: list[dict], horizon: str) -> float:
    if len(rows) < 289:
        return 0.0024
    subset = rows[-2_017:]
    alpha = 1 - math.exp(math.log(0.5) / 288)
    variance = None
    for previous, current in zip(subset, subset[1:]):
        value = math.log(current["close"] / previous["close"])
        variance = (
            value * value
            if variance is None
            else alpha * value * value + (1 - alpha) * variance
        )
    scaled = 0.35 * math.sqrt(max(0.0, variance or 0.0)) * math.sqrt(
        HORIZON_BARS[horizon]
    )
    return max(0.0024, scaled)


def actual_label(
    rows: list[dict],
    decision_ms: int,
    due_ms: int,
    horizon: str,
    label_scheme: str,
) -> tuple[str, dict] | tuple[None, dict]:
    entry = row_at_or_after(rows, decision_ms)
    exit_row = row_at_or_before_close(rows, due_ms)
    history = window_before(rows, decision_ms - 1, 2_017)
    if not entry or not exit_row or not history:
        return None, {"reason": "spot_execution_missing"}
    band = independent_label_band(history, horizon)
    if label_scheme == "triple_barrier":
        upper = entry["open"] * math.exp(band)
        lower = entry["open"] * math.exp(-band)
        start = bisect_left(
            row_index(rows, "open_time_ms"), entry["open_time_ms"]
        )
        end = bisect_right(row_index(rows, "close_time_ms"), due_ms)
        state = "range"
        for row in rows[start:end]:
            upper_hit = row["high"] >= upper
            lower_hit = row["low"] <= lower
            if upper_hit and lower_hit:
                state = "range"
                break
            if upper_hit:
                state = "up"
                break
            if lower_hit:
                state = "down"
                break
    else:
        value = math.log(exit_row["close"] / entry["open"])
        state = "up" if value > band else "down" if value < -band else "range"
    return state, {
        "entry": entry,
        "exit": exit_row,
        "band": band,
    }


def funding_cost(
    rows: list[dict], entry_ms: int, due_ms: int
) -> tuple[float, float]:
    selected = [
        row
        for row in rows
        if entry_ms < row["calc_time_ms"] <= due_ms
        and row["available_at_ms"] <= due_ms
    ]
    expected = max(1, round((due_ms - entry_ms) / (8 * 3_600_000)))
    return (
        -sum(float(row["funding_rate"]) for row in selected),
        min(1.0, len(selected) / expected),
    )


def paper_return(
    record: dict,
    market: dict,
    execution: dict,
    slippage_bps: float,
    state: str | None = None,
) -> tuple[float | None, dict]:
    state = state or record["candidateState"]
    if state == "range":
        return 0.0, {"market": "none", "fundingCoverage": 1.0}
    fee_and_slippage = (
        ROUND_TRIP_FEE_BPS + 2 * slippage_bps
    ) / 10_000
    if state == "up":
        gross = execution["exit"]["close"] / execution["entry"]["open"] - 1
        return gross - fee_and_slippage, {
            "market": "spot",
            "gross": gross,
            "fundingCoverage": 1.0,
        }
    derivatives = market["derivatives"][record["symbol"]]
    entry = row_at_or_after(derivatives["contract"], record["decisionAtMs"])
    exit_row = row_at_or_before_close(
        derivatives["mark"], record["outcomeDueMs"]
    )
    if not entry or not exit_row:
        return None, {
            "market": "usdm_perpetual",
            "reason": "short_execution_missing",
            "fundingCoverage": 0.0,
        }
    funding, coverage = funding_cost(
        market["funding"][record["symbol"]],
        entry["open_time_ms"],
        record["outcomeDueMs"],
    )
    gross = (entry["open"] - exit_row["close"]) / entry["open"]
    return gross - fee_and_slippage - funding, {
        "market": "usdm_perpetual",
        "gross": gross,
        "funding": funding,
        "fundingCoverage": coverage,
    }


def ece(labels: np.ndarray, probabilities: np.ndarray, bins: int = 10) -> float:
    confidence = probabilities.max(axis=1)
    predicted = probabilities.argmax(axis=1)
    total = len(labels)
    result = 0.0
    for lower in np.linspace(0, 1, bins, endpoint=False):
        upper = lower + 1 / bins
        mask = (confidence >= lower) & (
            confidence <= upper if upper >= 1 else confidence < upper
        )
        if mask.any():
            result += (
                mask.sum()
                / total
                * abs((predicted[mask] == labels[mask]).mean() - confidence[mask].mean())
            )
    return float(result)


def multiclass_brier(
    labels: np.ndarray, probabilities: np.ndarray
) -> float:
    return float(
        np.square(probabilities - np.eye(3)[labels]).sum(axis=1).mean()
    )


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


def block_bootstrap(values: np.ndarray, blocks: np.ndarray) -> dict:
    valid = np.isfinite(values)
    values = values[valid]
    blocks = blocks[valid]
    unique = np.unique(blocks)
    if len(values) < 30 or len(unique) < 8:
        return {"lower95": None, "upper95": None, "blocks": int(len(unique))}
    grouped = [values[blocks == block] for block in unique]
    rng = np.random.default_rng(RANDOM_SEED)
    estimates = []
    for _ in range(1_000):
        sample = np.concatenate(
            [
                grouped[index]
                for index in rng.integers(0, len(grouped), len(grouped))
            ]
        )
        estimates.append(float(sample.mean()))
    lower, upper = np.quantile(estimates, [0.025, 0.975])
    return {
        "lower95": float(lower),
        "upper95": float(upper),
        "blocks": int(len(unique)),
    }


def trading_metrics(values: np.ndarray, decisions_ms: np.ndarray) -> dict:
    valid = np.isfinite(values)
    values = values[valid]
    decisions_ms = decisions_ms[valid]
    if not len(values):
        return {"signals": 0}
    equity = np.cumsum(values)
    peak = np.maximum.accumulate(np.concatenate(([0.0], equity)))[1:]
    downside = values[values < 0]
    annualization = math.sqrt(365)
    sharpe = (
        values.mean() / values.std(ddof=1) * annualization
        if len(values) > 1 and values.std(ddof=1) > 0
        else 0.0
    )
    sortino = (
        values.mean() / downside.std(ddof=1) * annualization
        if len(downside) > 1 and downside.std(ddof=1) > 0
        else 0.0
    )
    gains = values[values > 0].sum()
    losses = -values[values < 0].sum()
    return {
        "signals": int(len(values)),
        "winRate": float((values > 0).mean()),
        "meanNetReturn": float(values.mean()),
        "totalNetReturn": float(values.sum()),
        "paperPnlUsdt": float(values.sum() * PAPER_NOTIONAL_USDT),
        "profitFactor": float(gains / losses) if losses > 0 else None,
        "sharpe": float(sharpe),
        "sortino": float(sortino),
        "maximumDrawdown": float(np.max(peak - equity)),
        "turnover": int(len(values) * 2),
        "bootstrapMean": block_bootstrap(
            values, decisions_ms // 86_400_000
        ),
    }


def diebold_mariano(
    candidate_loss: np.ndarray,
    baseline_loss: np.ndarray,
    lag: int,
) -> dict:
    difference = candidate_loss - baseline_loss
    difference = difference[np.isfinite(difference)]
    if len(difference) < max(30, lag * 3):
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


def holm_bonferroni(comparisons: dict[str, dict]) -> dict[str, dict]:
    result = {
        name: {**value, "holmAdjustedPValue": None, "holmRejected": False}
        for name, value in comparisons.items()
    }
    valid = sorted(
        [
            (name, float(value["pValue"]))
            for name, value in comparisons.items()
            if value.get("pValue") is not None
        ],
        key=lambda item: item[1],
    )
    adjusted_running_max = 0.0
    rejected_prefix = True
    total = len(valid)
    for rank, (name, p_value) in enumerate(valid):
        adjusted = min(1.0, (total - rank) * p_value)
        adjusted_running_max = max(adjusted_running_max, adjusted)
        result[name]["holmAdjustedPValue"] = adjusted_running_max
        if rejected_prefix and p_value <= 0.05 / (total - rank):
            result[name]["holmRejected"] = True
        else:
            rejected_prefix = False
    return result


def pbo_estimate(strategy_returns: np.ndarray) -> dict:
    if strategy_returns.ndim != 2 or strategy_returns.shape[0] < 80:
        return {"pbo": None, "combinations": 0}
    block_ids = np.array_split(np.arange(len(strategy_returns)), 8)
    logits = []
    combinations = 0
    from itertools import combinations as choose

    for train_blocks in choose(range(8), 4):
        test_blocks = [index for index in range(8) if index not in train_blocks]
        train_index = np.concatenate([block_ids[index] for index in train_blocks])
        test_index = np.concatenate([block_ids[index] for index in test_blocks])
        train_scores = np.nanmean(strategy_returns[train_index], axis=0)
        champion = int(np.nanargmax(train_scores))
        test_scores = np.nanmean(strategy_returns[test_index], axis=0)
        rank = int(np.argsort(np.argsort(test_scores))[champion]) + 1
        percentile = rank / (strategy_returns.shape[1] + 1)
        logits.append(math.log(percentile / max(1e-12, 1 - percentile)))
        combinations += 1
    return {
        "pbo": float(np.mean(np.asarray(logits) < 0)),
        "combinations": combinations,
    }


def deflated_sharpe_confidence(
    returns: np.ndarray, trials: int
) -> float | None:
    returns = returns[np.isfinite(returns)]
    if len(returns) < 30 or returns.std(ddof=1) <= 0:
        return None
    sharpe = returns.mean() / returns.std(ddof=1)
    skew = float(
        np.mean(((returns - returns.mean()) / returns.std(ddof=1)) ** 3)
    )
    kurtosis = float(
        np.mean(((returns - returns.mean()) / returns.std(ddof=1)) ** 4)
    )
    expected_max = math.sqrt(2 * math.log(max(2, trials))) / math.sqrt(
        len(returns) - 1
    )
    denominator = math.sqrt(
        max(
            1e-12,
            1
            - skew * sharpe
            + ((kurtosis - 1) / 4) * sharpe * sharpe,
        )
    )
    statistic = (
        (sharpe - expected_max)
        * math.sqrt(len(returns) - 1)
        / denominator
    )
    return float(norm.cdf(statistic))


def independent_feature_value(
    name: str, rows: list[dict]
) -> float | None:
    windows = {
        "return_15m": 3,
        "return_1h": 12,
        "return_4h": 48,
        "return_12h": 144,
        "return_24h": 288,
        "return_4d": 1_152,
        "return_12d": 3_456,
    }
    if name in windows and len(rows) > windows[name]:
        return math.log(rows[-1]["close"] / rows[-1 - windows[name]]["close"])
    realized = {
        "realized_vol_1h": 12,
        "realized_vol_4h": 48,
        "realized_vol_24h": 288,
        "realized_vol_4d": 1_152,
    }
    if name in realized and len(rows) > realized[name]:
        window = realized[name]
        values = np.diff(np.log([row["close"] for row in rows[-(window + 1) :]]))
        return float(values.std(ddof=1))
    ratio = {
        "volume_ratio_15m_4h": (3, 48),
        "volume_ratio_1h_24h": (12, 288),
        "volume_ratio_4h_24h": (48, 288),
        "volume_ratio_24h_4d": (288, 1_152),
        "trade_count_ratio_1h_24h": (12, 288),
        "trade_count_ratio_4h_24h": (48, 288),
    }
    if name in ratio:
        recent, baseline = ratio[name]
        field = "trade_count" if name.startswith("trade_count") else "quote_volume"
        if len(rows) >= baseline:
            recent_value = np.mean([row[field] for row in rows[-recent:]])
            baseline_value = np.mean([row[field] for row in rows[-baseline:]])
            return float(recent_value / baseline_value) if baseline_value else None
    if name.startswith("taker_flow_proxy_"):
        window = {
            "15m": 3,
            "1h": 12,
            "4h": 48,
            "12h": 144,
            "24h": 288,
        }[name.rsplit("_", 1)[-1]]
        if len(rows) >= window:
            selected = rows[-window:]
            quote = sum(row["quote_volume"] for row in selected)
            taker = sum(row["taker_buy_quote_volume"] for row in selected)
            return 2 * taker / quote - 1 if quote else None
    return None


def audit_traces(records: list[dict], market: dict) -> dict:
    traces = [record for record in records if record.get("trace")]
    failures = []
    checked_values = 0
    for record in traces:
        trace = record["trace"]
        if canonical_sha256(trace["featureVector"]) != record["featureVectorSha256"]:
            failures.append(f"{record['symbol']}:{record['horizon']}:vector_sha")
        if record["maximumAvailableAtMs"] > record["decisionAtMs"]:
            failures.append(f"{record['symbol']}:{record['horizon']}:future_data")
        if abs(sum(record["probabilities"].values()) - 1) > 1e-6:
            failures.append(f"{record['symbol']}:{record['horizon']}:probability_sum")
        rows = window_before(
            market["spot"][record["symbol"]],
            record["asOfMs"],
            10_000,
        )
        for name, expected in trace["featureValues"].items():
            actual = independent_feature_value(name, rows)
            if actual is None:
                continue
            checked_values += 1
            if not math.isclose(
                float(expected), float(actual), rel_tol=1e-6, abs_tol=1e-8
            ):
                failures.append(
                    f"{record['symbol']}:{record['horizon']}:{name}"
                )
    return {
        "traces": len(traces),
        "independentFeatureValuesChecked": checked_values,
        "failures": failures[:200],
        "passed": len(traces) >= 50 and not failures,
    }


def audit_risk_heads(
    records: list[dict], market: dict, manifest: dict
) -> dict:
    def historical_ewma_volatility(history: list[dict]) -> float:
        returns = np.diff(np.log([row["close"] for row in history]))
        alpha = 1 - math.exp(math.log(0.5) / 288)
        variance = None
        for value in returns:
            variance = (
                float(value * value)
                if variance is None
                else alpha * float(value * value)
                + (1 - alpha) * variance
            )
        return math.sqrt(max(variance or 0.0, 1e-24))

    rows = []
    for record in records:
        heads = record.get("riskHeads") or (
            (record.get("trace") or {}).get("predictionHeads") or {}
        )
        volatility = heads.get("futureVolatility")
        tail = heads.get("tailRisk")
        if not volatility or not tail:
            continue
        spot = market["spot"][record["symbol"]]
        prior = row_at_or_before_close(spot, record["decisionAtMs"] - 1)
        start = bisect_left(
            row_index(spot, "open_time_ms"), record["decisionAtMs"]
        )
        end = bisect_right(
            row_index(spot, "close_time_ms"), record["outcomeDueMs"]
        )
        future = spot[start:end]
        history = window_before(spot, record["decisionAtMs"] - 1, 2_017)
        if (
            prior is None
            or len(future) != HORIZON_BARS[record["horizon"]]
            or len(history) < 2_017
        ):
            continue
        future_closes = np.asarray(
            [prior["close"], *[row["close"] for row in future]], dtype=float
        )
        future_returns = np.diff(np.log(future_closes))
        actual_volatility = float(future_returns.std(ddof=1))
        baseline_volatility = historical_ewma_volatility(history)
        entry = float(future[0]["open"])
        exit_close = float(future[-1]["close"])
        forward_return = math.log(exit_close / entry)
        entry_manifest = manifest["horizons"][record["horizon"]]
        tail_entry = entry_manifest["predictionHeads"]["tailRisk"]
        actual_tail = int(
            forward_return <= float(tail_entry["tailReturnThreshold"])
            or actual_volatility >= float(tail_entry["stressThreshold"])
        )
        rows.append(
            {
                "horizon": record["horizon"],
                "actualVolatility": actual_volatility,
                "baselineVolatility": baseline_volatility,
                "p50": float(volatility["p50"]),
                "p90": float(volatility["p90"]),
                "tailProbability": float(tail["probability"]),
                "actualTail": actual_tail,
            }
        )
    def qlike(actual: np.ndarray, forecast: np.ndarray) -> float:
        actual = np.maximum(actual, 1e-12)
        forecast = np.maximum(forecast, 1e-12)
        ratio = actual / forecast
        return float(np.mean(ratio - np.log(ratio) - 1))

    def summarize(selected: list[dict]) -> dict:
        if not selected:
            return {
                "samples": 0,
                "passed": False,
                "reason": "risk_head_traces_missing",
            }
        actual_volatility = np.asarray(
            [row["actualVolatility"] for row in selected], dtype=float
        )
        predicted_volatility = np.asarray(
            [row["p50"] for row in selected], dtype=float
        )
        baseline_volatility = np.asarray(
            [row["baselineVolatility"] for row in selected], dtype=float
        )
        actual_tail = np.asarray(
            [row["actualTail"] for row in selected], dtype=int
        )
        tail_probability = np.asarray(
            [row["tailProbability"] for row in selected], dtype=float
        )
        prevalence = float(actual_tail.mean())
        tail_brier = float(
            np.mean(np.square(tail_probability - actual_tail))
        )
        baseline_brier = float(
            np.mean(
                np.square(
                    np.full(len(selected), prevalence) - actual_tail
                )
            )
        )
        volatility_qlike = qlike(actual_volatility, predicted_volatility)
        baseline_qlike = qlike(actual_volatility, baseline_volatility)
        tail_skill = (
            float(1 - tail_brier / baseline_brier)
            if baseline_brier > 0
            else None
        )
        return {
            "samples": len(selected),
            "futureVolatility": {
                "qlike": volatility_qlike,
                "ewmaBaselineQlike": baseline_qlike,
                "qlikeSkill": (
                    float(1 - volatility_qlike / baseline_qlike)
                    if baseline_qlike > 0
                    else None
                ),
                "p50P90Coverage": float(
                    np.mean(
                        [
                            row["p50"]
                            <= row["actualVolatility"]
                            <= row["p90"]
                            for row in selected
                        ]
                    )
                ),
            },
            "tailRisk": {
                "brier": tail_brier,
                "referenceBrier": baseline_brier,
                "brierSkill": tail_skill,
                "prevalence": prevalence,
            },
            "passed": bool(
                len(selected) >= 50
                and volatility_qlike < baseline_qlike
                and tail_skill is not None
                and tail_skill > 0
            ),
        }

    by_horizon = {
        horizon: summarize(
            [row for row in rows if row["horizon"] == horizon]
        )
        for horizon in ("4h", "24h")
    }
    return {
        "samples": len(rows),
        "horizons": by_horizon,
        "passed": all(value["passed"] for value in by_horizon.values()),
    }


def replay_key(record: dict) -> tuple[str, str, int]:
    return (
        record["symbol"],
        record["horizon"],
        int(record["decisionAtMs"]),
    )


def independent_crypto_quant_v2(rows: list[dict]) -> str:
    if len(rows) < 289:
        return "range"

    def positive_trend(window: int) -> tuple[bool, bool]:
        values = np.asarray(
            [float(row["close"]) for row in rows[-window:]], dtype=float
        )
        distance = values[-1] / values.mean() - 1
        slope = float(np.polyfit(np.arange(window, dtype=float), values, 1)[0])
        return distance > 0 and slope > 0, distance < 0 and slope < 0

    up_4h, down_4h = positive_trend(48)
    up_24h, down_24h = positive_trend(288)
    if up_4h and up_24h:
        return "up"
    if down_4h and down_24h:
        return "down"
    return "range"


def assign_non_overlapping_returns(
    rows: list[dict],
    strategy: str,
    market: dict,
    *,
    selected_field: str | None = None,
) -> None:
    next_available: dict[str, int] = {}
    for row in rows:
        symbol = row["record"]["symbol"]
        decision_at = int(row["record"]["decisionAtMs"])
        selected = (
            bool(row.get(selected_field))
            if selected_field is not None
            else True
        )
        state_index = row.get(strategy)
        can_trade = (
            selected
            and state_index is not None
            and state_index != CLASS_INDEX["range"]
            and decision_at >= next_available.get(symbol, 0)
        )
        row[f"{strategy}NonOverlapping"] = can_trade
        if not can_trade:
            row[f"{strategy}Net2"] = 0.0
            continue
        state = CLASS_ORDER[int(state_index)]
        value, _ = paper_return(
            row["record"],
            market,
            row["labelExecution"],
            2.0,
            state=state,
        )
        row[f"{strategy}Net2"] = float(value) if value is not None else 0.0
        next_available[symbol] = int(row["record"]["outcomeDueMs"])


def audit_horizon(
    records: list[dict],
    horizon: str,
    manifest_entry: dict,
    market: dict,
    replay_baselines: dict[str, dict[tuple[str, str, int], dict]],
) -> dict:
    selected_records = [
        record for record in records if record["horizon"] == horizon
    ]
    rows = []
    random = np.random.default_rng(RANDOM_SEED + HORIZON_BARS[horizon])
    majority = max(
        manifest_entry.get("trainingClassDistribution", {"range": 1}),
        key=manifest_entry.get(
            "trainingClassDistribution", {"range": 1}
        ).get,
    )
    for record in selected_records:
        actual, execution = actual_label(
            market["spot"][record["symbol"]],
            record["decisionAtMs"],
            record["outcomeDueMs"],
            horizon,
            manifest_entry.get("labelScheme", "dynamic_band"),
        )
        if actual is None:
            continue
        history = window_before(
            market["spot"][record["symbol"]],
            record["decisionAtMs"] - 1,
            HORIZON_BARS[horizon] + 1,
        )
        past_return = (
            math.log(history[-1]["close"] / history[0]["close"])
            if len(history) > HORIZON_BARS[horizon]
            else 0
        )
        momentum = (
            "up"
            if past_return > execution["band"]
            else "down"
            if past_return < -execution["band"]
            else "range"
        )
        persistence = "up" if past_return >= 0 else "down"
        probability = np.asarray(
            [record["probabilities"][name] for name in CLASS_ORDER],
            dtype=float,
        )
        history_v2 = window_before(
            market["spot"][record["symbol"]],
            record["decisionAtMs"] - 1,
            289,
        )
        history_returns = (
            np.diff(np.log([value["close"] for value in history_v2]))
            if len(history_v2) >= 289
            else np.asarray([], dtype=float)
        )
        row = {
            "record": record,
            "labelExecution": execution,
            "actual": CLASS_INDEX[actual],
            "candidate": CLASS_INDEX[record["candidateState"]],
            "probability": probability,
            "selected": bool(record["selectedIgnoringShadow"]),
            "historicalVolatility": (
                float(history_returns.std(ddof=1))
                if len(history_returns)
                else 0.0
            ),
            "random": int(random.integers(0, 3)),
            "majority": CLASS_INDEX[majority],
            "momentum": CLASS_INDEX[momentum],
            "persistence": CLASS_INDEX[persistence],
            "cryptoQuantV2": CLASS_INDEX[
                independent_crypto_quant_v2(history_v2)
            ],
            "opportunityOnly": (
                CLASS_INDEX["range"]
                if float(record["actionProbability"] or 0)
                < float(
                    manifest_entry.get("thresholds", {}).get(
                        "minActionProbability", 1
                    )
                )
                else CLASS_INDEX["up" if past_return >= 0 else "down"]
            ),
        }
        for baseline_name, baseline_records in replay_baselines.items():
            baseline_record = baseline_records.get(replay_key(record))
            if baseline_record is None:
                row[baseline_name] = None
                row[f"{baseline_name}Selected"] = False
            else:
                row[baseline_name] = CLASS_INDEX[
                    baseline_record["candidateState"]
                ]
                row[f"{baseline_name}Selected"] = bool(
                    baseline_record.get("selectedIgnoringShadow")
                )
        for slippage in (2, 5, 10, 20):
            value, detail = paper_return(
                record, market, execution, float(slippage)
            )
            row[f"net_{slippage}"] = value
            if slippage == 2:
                row["execution"] = detail
        rows.append(row)
    if not rows:
        return {"samples": 0, "verdict": "FAIL"}
    rows.sort(
        key=lambda row: (
            row["record"]["decisionAtMs"],
            row["record"]["symbol"],
        )
    )
    next_available = {}
    for row in rows:
        symbol = row["record"]["symbol"]
        row["nonOverlapping"] = (
            row["record"]["decisionAtMs"] >= next_available.get(symbol, 0)
        )
        if (
            row["nonOverlapping"]
            and row["selected"]
            and row["candidate"] != CLASS_INDEX["range"]
        ):
            next_available[symbol] = row["record"]["outcomeDueMs"]
    strategy_names = [
        "momentum",
        "persistence",
        "cryptoQuantV2",
        "opportunityOnly",
    ]
    for baseline_name in replay_baselines:
        if any(row.get(baseline_name) is not None for row in rows):
            strategy_names.append(baseline_name)
    for strategy in strategy_names:
        assign_non_overlapping_returns(
            rows,
            strategy,
            market,
            selected_field=(
                f"{strategy}Selected"
                if strategy in replay_baselines
                else None
            ),
        )
    labels = np.asarray([row["actual"] for row in rows], dtype=int)
    probability = np.vstack([row["probability"] for row in rows])
    predicted = np.asarray([row["candidate"] for row in rows], dtype=int)
    selected = np.asarray([row["selected"] for row in rows], dtype=bool)
    candidate_metrics = classification_metrics(labels, predicted)
    empirical = np.bincount(labels, minlength=3) / len(labels)
    brier = multiclass_brier(labels, probability)
    reference_brier = multiclass_brier(
        labels, np.tile(empirical, (len(labels), 1))
    )
    baseline_metric_names = [
        "random",
        "majority",
        "momentum",
        "persistence",
        "cryptoQuantV2",
        "opportunityOnly",
    ]
    baseline_metric_names.extend(
        name
        for name in replay_baselines
        if all(row.get(name) is not None for row in rows)
    )
    baseline_metrics = {
        name: classification_metrics(
            labels, np.asarray([row[name] for row in rows], dtype=int)
        )
        for name in baseline_metric_names
    }
    best_non_ml_name = max(
        ("majority", "momentum", "persistence", "cryptoQuantV2"),
        key=lambda name: baseline_metrics[name]["balancedAccuracy"],
    )
    best_non_ml = baseline_metrics[best_non_ml_name]
    selected_accuracy = (
        float(accuracy_score(labels[selected], predicted[selected]))
        if selected.any()
        else None
    )
    selected_baseline_accuracy = (
        float(
            accuracy_score(
                labels[selected],
                np.asarray(
                    [row[best_non_ml_name] for row in rows], dtype=int
                )[selected],
            )
        )
        if selected.any()
        else None
    )
    decisions = np.asarray(
        [row["record"]["decisionAtMs"] for row in rows], dtype=np.int64
    )
    trading = {}
    for slippage in (2, 5, 10, 20):
        values = np.asarray(
            [
                row[f"net_{slippage}"]
                if row["selected"]
                and row["nonOverlapping"]
                and row["candidate"] != CLASS_INDEX["range"]
                else np.nan
                for row in rows
            ],
            dtype=float,
        )
        trading[str(slippage)] = trading_metrics(values, decisions)
    candidate_loss = np.square(
        probability - np.eye(3)[labels]
    ).sum(axis=1)
    baseline_probability = np.tile(empirical, (len(labels), 1))
    baseline_loss = np.square(
        baseline_probability - np.eye(3)[labels]
    ).sum(axis=1)
    dm_comparisons = {
        "empiricalFrequency": diebold_mariano(
            candidate_loss,
            baseline_loss,
            lag=HORIZON_BARS[horizon] // 12,
        )
    }
    for name in baseline_metric_names:
        baseline_prediction = np.asarray(
            [row[name] for row in rows], dtype=int
        )
        deterministic_probability = np.eye(3)[baseline_prediction]
        deterministic_loss = np.square(
            deterministic_probability - np.eye(3)[labels]
        ).sum(axis=1)
        dm_comparisons[name] = diebold_mariano(
            candidate_loss,
            deterministic_loss,
            lag=HORIZON_BARS[horizon] // 12,
        )
    strategy_matrix = np.column_stack(
        [
            np.nan_to_num(
                np.asarray(
                    [
                        row["net_2"]
                        if row["selected"]
                        and row["nonOverlapping"]
                        and row["candidate"] != CLASS_INDEX["range"]
                        else np.nan
                        for row in rows
                    ],
                    dtype=float,
                ),
                nan=0,
            ),
            *[
                np.asarray(
                    [row[f"{name}Net2"] for row in rows], dtype=float
                )
                for name in strategy_names
            ],
        ]
    )
    pbo = pbo_estimate(strategy_matrix)
    active_returns = np.asarray(
        [
            row["net_2"]
            for row in rows
            if row["selected"]
            and row["nonOverlapping"]
            and row["candidate"] != CLASS_INDEX["range"]
            and row["net_2"] is not None
        ],
        dtype=float,
    )
    deflated = deflated_sharpe_confidence(active_returns, trials=12)
    volatility_values = np.asarray(
        [row["historicalVolatility"] for row in rows], dtype=float
    )
    low_volatility, high_volatility = np.quantile(
        volatility_values, [1 / 3, 2 / 3]
    )
    for row in rows:
        row["volatilityRegime"] = (
            "low"
            if row["historicalVolatility"] <= low_volatility
            else "high"
            if row["historicalVolatility"] >= high_volatility
            else "medium"
        )

    grouped = {"symbol": {}, "volatilityRegime": {}}
    for field, values in (
        ("symbol", ("BTC", "ETH", "SOL")),
        ("volatilityRegime", ("low", "medium", "high")),
    ):
        for value in values:
            mask = np.asarray(
                [
                    (
                        row["record"]["symbol"]
                        if field == "symbol"
                        else row["volatilityRegime"]
                    )
                    == value
                    for row in rows
                ],
                dtype=bool,
            )
            if not mask.any():
                continue
            grouped[field][value] = {
                "candidate": classification_metrics(
                    labels[mask], predicted[mask]
                ),
                "bestNonMlBaseline": classification_metrics(
                    labels[mask],
                    np.asarray(
                        [row[best_non_ml_name] for row in rows], dtype=int
                    )[mask],
                ),
            }
    failure_samples = sorted(
        [
            {
                "passportRef": row["record"].get("passportRef"),
                "symbol": row["record"]["symbol"],
                "horizon": horizon,
                "decisionAtMs": row["record"]["decisionAtMs"],
                "actual": CLASS_ORDER[row["actual"]],
                "predicted": CLASS_ORDER[row["candidate"]],
                "confidence": float(row["probability"].max()),
                "netReturn2Bps": row["net_2"],
            }
            for row in rows
            if row["selected"] and row["actual"] != row["candidate"]
        ],
        key=lambda value: value["confidence"],
        reverse=True,
    )[:50]
    gates = {
        "coverage": float(selected.mean()) >= 0.10,
        "selectiveAccuracy": (
            selected_accuracy is not None
            and selected_baseline_accuracy is not None
            and selected_accuracy >= selected_baseline_accuracy + 0.05
        ),
        "brierSkill": reference_brier > 0 and 1 - brier / reference_brier > 0,
        "ece": ece(labels, probability) <= 0.05,
        "mcc": candidate_metrics["mcc"] > 0,
        "costBootstrap": (
            trading["2"]
            .get("bootstrapMean", {})
            .get("lower95")
            is not None
            and trading["2"]["bootstrapMean"]["lower95"] > 0
        ),
        "pbo": pbo.get("pbo") is not None and pbo["pbo"] < 0.20,
        "deflatedSharpe": deflated is not None and deflated > 0.95,
        "subgroupRegression": all(
            value["candidate"]["balancedAccuracy"]
            >= value["bestNonMlBaseline"]["balancedAccuracy"] - 0.05
            for family in grouped.values()
            for value in family.values()
            if value["candidate"]["samples"] >= 80
        ),
    }
    return {
        "samples": len(rows),
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
                log_loss(labels, probability, labels=[0, 1, 2])
            ),
            "ece": ece(labels, probability),
            "meanProbability": dict(
                zip(CLASS_ORDER, probability.mean(axis=0).astype(float))
            ),
            "actualFrequency": dict(
                zip(CLASS_ORDER, empirical.astype(float))
            ),
        },
        "selective": {
            "coverage": float(selected.mean()),
            "samples": int(selected.sum()),
            "accuracy": selected_accuracy,
            "bestNonMlBaseline": best_non_ml_name,
            "baselineAccuracy": selected_baseline_accuracy,
            "actualClassDistribution": {
                name: (
                    float(np.mean(labels[selected] == index))
                    if selected.any()
                    else None
                )
                for index, name in enumerate(CLASS_ORDER)
            },
            "predictedClassDistribution": {
                name: (
                    float(np.mean(predicted[selected] == index))
                    if selected.any()
                    else None
                )
                for index, name in enumerate(CLASS_ORDER)
            },
        },
        "baselines": baseline_metrics,
        "grouped": grouped,
        "failureSamples": failure_samples,
        "baselineReplayCoverage": {
            name: float(
                np.mean([row.get(name) is not None for row in rows])
            )
            for name in replay_baselines
        },
        "trading": trading,
        "statistics": {
            "dieboldMariano": holm_bonferroni(dm_comparisons),
            "multipleComparisonCorrection": "holm_bonferroni",
            "pbo": pbo,
            "deflatedSharpeConfidence": deflated,
        },
        "executionCoverage": {
            "shortFundingMean": float(
                np.mean(
                    [
                        row["execution"].get("fundingCoverage", 0)
                        for row in rows
                        if row["candidate"] == CLASS_INDEX["down"]
                    ]
                    or [0]
                )
            )
        },
        "gates": gates,
        "historicalGatePassed": all(gates.values()),
    }


def markdown_report(report: dict) -> str:
    lines = [
        "# Athena Crypto Forecast v4 Independent Audit",
        "",
        f"- Verdict: **{report['verdict']}**",
        f"- Classification: `{report['classification']}`",
        f"- Generated: {report['generatedAt']}",
        f"- Replay records: {report['replay']['records']}",
        f"- Trace verification: {report['traceAudit']['traces']} traces, "
        f"{len(report['traceAudit']['failures'])} failures",
        "",
        "## Horizon results",
        "",
        "| Horizon | Samples | Coverage | Selective accuracy | Brier skill | ECE | Net lower 95% | Gate |",
        "|---|---:|---:|---:|---:|---:|---:|---|",
    ]
    for horizon, value in report["horizons"].items():
        net_lower = (
            value.get("trading", {})
            .get("2", {})
            .get("bootstrapMean", {})
            .get("lower95")
        )
        lines.append(
            "| "
            + " | ".join(
                [
                    horizon,
                    str(value.get("samples", 0)),
                    f"{value.get('selective', {}).get('coverage', 0):.2%}",
                    (
                        f"{value['selective']['accuracy']:.2%}"
                        if value.get("selective", {}).get("accuracy") is not None
                        else "n/a"
                    ),
                    (
                        f"{value['probability']['brierSkill']:.4f}"
                        if value.get("probability", {}).get("brierSkill")
                        is not None
                        else "n/a"
                    ),
                    f"{value.get('probability', {}).get('ece', 0):.4f}",
                    f"{net_lower:.6f}" if net_lower is not None else "n/a",
                    "pass" if value.get("historicalGatePassed") else "fail",
                ]
            )
            + " |"
        )
    risk = report.get("riskHeadAudit", {})
    lines.extend(
        [
            "",
            "## Independent risk-head replay",
            "",
            f"- Samples: {risk.get('samples', 0)}",
            f"- Gate: {'pass' if risk.get('passed') else 'fail'}",
            "",
            "| Horizon | Samples | Vol QLIKE | EWMA QLIKE | Tail Brier skill | Gate |",
            "|---|---:|---:|---:|---:|---|",
        ]
    )
    for horizon, value in risk.get("horizons", {}).items():
        lines.append(
            "| "
            + " | ".join(
                [
                    horizon,
                    str(value.get("samples", 0)),
                    str(
                        value.get("futureVolatility", {}).get(
                            "qlike", "n/a"
                        )
                    ),
                    str(
                        value.get("futureVolatility", {}).get(
                            "ewmaBaselineQlike", "n/a"
                        )
                    ),
                    str(
                        value.get("tailRisk", {}).get(
                            "brierSkill", "n/a"
                        )
                    ),
                    "pass" if value.get("passed") else "fail",
                ]
            )
            + " |"
        )
    lines.extend(
        [
            "",
            "## Failed gates",
            "",
        ]
    )
    for horizon, value in report["horizons"].items():
        failures = [
            name for name, passed in value.get("gates", {}).items() if not passed
        ]
        lines.append(
            f"- {horizon}: {', '.join(failures) if failures else 'none'}"
        )
    lines.extend(
        [
            "",
            "## Highest-confidence selected errors",
            "",
            "| Passport | Symbol | Horizon | Actual | Predicted | Confidence | Net return (2bps) |",
            "|---|---|---|---|---|---:|---:|",
        ]
    )
    failures = sorted(
        [
            value
            for horizon in report["horizons"].values()
            for value in horizon.get("failureSamples", [])
        ],
        key=lambda value: value["confidence"],
        reverse=True,
    )[:20]
    for value in failures:
        lines.append(
            "| "
            + " | ".join(
                [
                    str(value.get("passportRef", "n/a"))[:16],
                    value["symbol"],
                    value["horizon"],
                    value["actual"],
                    value["predicted"],
                    f"{value['confidence']:.4f}",
                    (
                        f"{value['netReturn2Bps']:.6f}"
                        if value.get("netReturn2Bps") is not None
                        else "n/a"
                    ),
                ]
            )
            + " |"
        )
    lines.extend(
        [
            "",
            "## Inspector conclusion",
            "",
            report["inspectorConclusion"],
            "",
            "Historical results are semi-blind and cannot activate v4. "
            "Only prospective Shadow evidence can satisfy the final promotion gate.",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--model-root", required=True, type=Path)
    parser.add_argument("--replay", required=True, type=Path)
    parser.add_argument("--v3-replay", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    records = load_jsonl(args.replay)
    if not records:
        raise RuntimeError("audit_replay_empty")
    v3_records = load_jsonl(args.v3_replay)
    if not v3_records:
        raise RuntimeError("audit_v3_replay_empty")
    v3_replay = {
        replay_key(record): record for record in v3_records
    }
    artifact_audit = verify_model_artifacts(args.model_root)
    manifest = artifact_audit.pop("manifest")
    if any(
        record["modelManifestSha256"]
        != artifact_audit["manifestSha256"]
        for record in records
    ):
        raise RuntimeError("audit_manifest_replay_mismatch")
    market = load_market_data(args.database, records)
    trace_audit = audit_traces(records, market)
    risk_head_audit = audit_risk_heads(records, market, manifest)
    horizons = {
        horizon: audit_horizon(
            records,
            horizon,
            manifest["horizons"][horizon],
            market,
            {"cryptoForecastV3": v3_replay},
        )
        for horizon in ("4h", "24h")
    }
    baseline_replay_passed = all(
        value.get("baselineReplayCoverage", {}).get(
            "cryptoForecastV3", 0
        )
        >= 0.99
        for value in horizons.values()
    ) and all(record.get("modelSignatureValid") for record in v3_records)
    authenticity_passed = all(
        [
            artifact_audit["signaturePresent"],
            not artifact_audit["artifactFailures"],
            all(record.get("modelSignatureValid") for record in records),
            trace_audit["passed"],
            baseline_replay_passed,
        ]
    )
    historical_passed = all(
        value.get("historicalGatePassed") for value in horizons.values()
    ) and risk_head_audit["passed"]
    if not authenticity_passed:
        verdict = "FAIL"
        conclusion = (
            "真实性审查未通过：模型签名、制品哈希、时间边界或独立特征"
            "复算存在失败。v4不得加载。"
        )
    elif historical_passed:
        verdict = "PASS_WITH_LIMITATIONS"
        conclusion = (
            "历史半盲回测通过，但它不是未触碰的未来样本，只能证明v4值得"
            "继续前瞻Shadow，不能据此激活。"
        )
    else:
        verdict = "FAIL"
        conclusion = (
            "真实性链路可以复算，但至少一个准确度、校准、风险头、过拟合"
            "或成本后门槛未通过。v4未优于完整基线，必须保持Shadow且本轮"
            "审计判定失败。"
        )
    report = {
        "schema": "athena.crypto.forecast-independent-audit",
        "schemaVersion": "1.0",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "classification": "historical_semi_blind",
        "verdict": verdict,
        "artifactAudit": artifact_audit,
        "replay": {
            "path": str(args.replay),
            "sha256": file_sha256(args.replay),
            "records": len(records),
            "cadence": records[0].get("replayCadence", "unknown"),
        },
        "traceAudit": trace_audit,
        "riskHeadAudit": risk_head_audit,
        "baselineReplay": {
            "path": str(args.v3_replay),
            "sha256": file_sha256(args.v3_replay),
            "records": len(v3_records),
            "modelVersions": sorted(
                {
                    str(record.get("modelVersion"))
                    for record in v3_records
                }
            ),
            "passed": baseline_replay_passed,
        },
        "horizons": horizons,
        "prospectiveActivationAllowed": False,
        "inspectorConclusion": conclusion,
    }
    args.output.mkdir(parents=True, exist_ok=True)
    json_path = args.output / "crypto-forecast-v4-independent-audit.json"
    markdown_path = args.output / "crypto-forecast-v4-independent-audit.md"
    json_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    markdown_path.write_text(markdown_report(report), encoding="utf-8")
    manifest_path = args.output / "audit-manifest.json"
    audit_manifest = {
        "schema": "athena.crypto.forecast-audit-manifest",
        "schemaVersion": "1.0",
        "generatedAt": report["generatedAt"],
        "modelManifestSha256": artifact_audit["manifestSha256"],
        "datasetSha256": file_sha256(args.database),
        "replaySha256": report["replay"]["sha256"],
        "v3ReplaySha256": report["baselineReplay"]["sha256"],
        "auditProgramSha256": file_sha256(Path(__file__)),
        "reportSha256": file_sha256(json_path),
        "markdownSha256": file_sha256(markdown_path),
        "verdict": verdict,
    }
    manifest_path.write_text(
        json.dumps(audit_manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "verdict": verdict,
                "json": str(json_path),
                "markdown": str(markdown_path),
                "manifest": str(manifest_path),
                "historicalGates": {
                    horizon: value.get("historicalGatePassed")
                    for horizon, value in horizons.items()
                },
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
