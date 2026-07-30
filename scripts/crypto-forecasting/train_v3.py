#!/usr/bin/env python3
"""Train Athena crypto forecast v3 opportunity/direction models."""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import math
import os
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.optimize import minimize
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    f1_score,
    matthews_corrcoef,
)
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from xgboost import XGBClassifier

from backtest import MarketRules, sensitivity_report
from features_v3 import (
    FEATURE_FAMILIES,
    HORIZON_FEATURE_NAMES,
    REGISTRY,
    REGISTRY_SHA256,
    feature_family_indexes,
    feature_frame_v3,
)
from train import (
    CLASS_ORDER,
    FIVE_MINUTES,
    HORIZONS,
    ROUND_TRIP_COST_RATIO,
    expected_calibration_error,
    latest_dataset_manifest,
    load_bars,
    multiclass_brier,
    shadow_observation_gate,
)

OPTIMIZED_HORIZONS = ("4h", "24h")
LEGACY_HORIZONS = ("4d", "12d", "24d")
RANDOM_SEED = 20260729
MINIMUM_COVERAGE = 0.10
MAXIMUM_CANDIDATES = 12


def table_exists(database: Path, table: str) -> bool:
    with sqlite3.connect(
        f"file:{database}?mode=ro&immutable=1", uri=True
    ) as connection:
        row = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            (table,),
        ).fetchone()
    return row is not None


def attach_execution_evidence(
    samples: pd.DataFrame, database: Path
) -> pd.DataFrame:
    result = samples.copy()
    result["short_entry_open"] = np.nan
    result["short_exit_close"] = np.nan
    result["funding_cost_ratio"] = np.nan
    result["short_execution_ready"] = False
    required = {
        "derivative_klines",
        "derivative_funding_rates",
    }
    if not all(table_exists(database, table) for table in required):
        return result
    with sqlite3.connect(
        f"file:{database}?mode=ro&immutable=1", uri=True
    ) as connection:
        klines = pd.read_sql_query(
            """
            SELECT symbol, series_type, open_time_ms, open, close
            FROM derivative_klines
            WHERE interval='5m' AND series_type IN ('contract', 'mark')
            ORDER BY symbol, open_time_ms
            """,
            connection,
        )
        funding = pd.read_sql_query(
            """
            SELECT symbol, calc_time_ms, funding_rate
            FROM derivative_funding_rates
            ORDER BY symbol, calc_time_ms
            """,
            connection,
        )
    if klines.empty or funding.empty:
        return result
    contract = (
        klines.loc[klines["series_type"].eq("contract")]
        .drop_duplicates(["symbol", "open_time_ms"], keep="last")
        .set_index(["symbol", "open_time_ms"])
    )
    mark = (
        klines.loc[klines["series_type"].eq("mark")]
        .drop_duplicates(["symbol", "open_time_ms"], keep="last")
        .set_index(["symbol", "open_time_ms"])
    )
    entry_ms = (
        pd.to_datetime(result["time"], utc=True).astype("int64") // 1_000_000
        + 5 * 60_000
    )
    exit_ms = (
        pd.to_datetime(result["outcome_time"], utc=True).astype("int64")
        // 1_000_000
    )
    entry_index = pd.MultiIndex.from_arrays(
        [result["symbol"], entry_ms], names=["symbol", "open_time_ms"]
    )
    exit_index = pd.MultiIndex.from_arrays(
        [result["symbol"], exit_ms], names=["symbol", "open_time_ms"]
    )
    result["short_entry_open"] = contract["open"].reindex(entry_index).to_numpy()
    result["short_exit_close"] = mark["close"].reindex(exit_index).to_numpy()

    funding["funding_rate"] = pd.to_numeric(
        funding["funding_rate"], errors="coerce"
    ).fillna(0)
    funding["cumulative"] = funding.groupby("symbol")["funding_rate"].cumsum()
    indexed_funding = {
        symbol: group.set_index("calc_time_ms")["cumulative"].sort_index()
        for symbol, group in funding.groupby("symbol")
    }
    funding_cost = np.full(len(result), np.nan)
    for symbol, positions in result.groupby("symbol").groups.items():
        series = indexed_funding.get(symbol)
        if series is None or series.empty:
            continue
        timestamps = series.index.to_numpy(dtype=np.int64)
        cumulative = series.to_numpy(dtype=float)
        for position in positions:
            start_index = np.searchsorted(
                timestamps, int(entry_ms.iloc[position]), side="right"
            ) - 1
            end_index = np.searchsorted(
                timestamps, int(exit_ms.iloc[position]), side="right"
            ) - 1
            start_value = cumulative[start_index] if start_index >= 0 else 0.0
            end_value = cumulative[end_index] if end_index >= 0 else 0.0
            # Positive public funding is paid by longs and received by shorts.
            funding_cost[position] = -(end_value - start_value)
    result["funding_cost_ratio"] = funding_cost
    result["short_execution_ready"] = (
        result["short_entry_open"].gt(0)
        & result["short_exit_close"].gt(0)
        & result["funding_cost_ratio"].notna()
    )
    return result


def cost_adjusted_returns(
    frame: pd.DataFrame, predicted: np.ndarray
) -> np.ndarray:
    net = np.full(len(frame), np.nan)
    up = predicted == 2
    down = predicted == 0
    spot_gross = np.exp(frame["forward_return"].to_numpy(dtype=float)) - 1
    net[up] = spot_gross[up] - ROUND_TRIP_COST_RATIO
    short_ready = (
        down
        & frame["short_execution_ready"].to_numpy(dtype=bool)
        & frame["short_entry_open"].gt(0).to_numpy()
        & frame["short_exit_close"].gt(0).to_numpy()
    )
    short_gross = (
        frame["short_entry_open"].to_numpy(dtype=float)
        - frame["short_exit_close"].to_numpy(dtype=float)
    ) / frame["short_entry_open"].to_numpy(dtype=float)
    net[short_ready] = (
        short_gross[short_ready]
        - ROUND_TRIP_COST_RATIO
        - frame["funding_cost_ratio"].to_numpy(dtype=float)[short_ready]
    )
    return net


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_sha256(value: object) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


def samples_for_horizon_v3(
    features: pd.DataFrame, horizon: str, feature_names: list[str]
) -> pd.DataFrame:
    config = HORIZONS[horizon]
    outputs: list[pd.DataFrame] = []
    for symbol, source in features.groupby("symbol", sort=False):
        source = source.sort_values("time").copy()
        anchor = source["time"].dt.minute.eq(55)
        forward_return = np.log(
            source["close"].shift(-config["bars"]) / source["open"].shift(-1)
        )
        outcome_time = source["time"].shift(-config["bars"])
        entry_time = source["time"].shift(-1)
        same_run = (
            source["contiguous_run"].eq(source["contiguous_run"].shift(-1))
            & source["contiguous_run"].eq(
                source["contiguous_run"].shift(-config["bars"])
            )
            & source["contiguous_bars"].ge(30 * 24 * 12)
            & entry_time.sub(source["time"]).eq(FIVE_MINUTES)
            & outcome_time.sub(source["time"]).eq(
                FIVE_MINUTES * config["bars"]
            )
        )
        one_bar_return = source["one_bar_return"]
        alpha = 1 - math.exp(math.log(0.5) / 288)
        volatility = np.sqrt(
            one_bar_return.pow(2).ewm(
                alpha=alpha, adjust=False, min_periods=288
            ).mean()
        )
        band = np.maximum(
            ROUND_TRIP_COST_RATIO,
            0.35 * volatility * math.sqrt(config["bars"]),
        )
        label = np.where(
            forward_return > band,
            2,
            np.where(forward_return < -band, 0, 1),
        )
        selected = source.loc[
            anchor & same_run,
            [
                "time",
                "symbol",
                "one_bar_return",
                "open",
                "high",
                "low",
                "close",
                *feature_names,
            ],
        ].copy()
        mask = (anchor & same_run).to_numpy()
        selected["forward_return"] = forward_return[anchor & same_run].to_numpy()
        selected["label_band"] = band[anchor & same_run].to_numpy()
        selected["label"] = label[mask]
        selected["dynamic_label"] = selected["label"]
        selected["action_label"] = (selected["label"] != 1).astype(int)
        selected["direction_label"] = (selected["label"] == 2).astype(int)
        selected["outcome_time"] = outcome_time[anchor & same_run].to_numpy()
        selected["entry_open"] = source["open"].shift(-1)[
            anchor & same_run
        ].to_numpy()
        selected["exit_close"] = source["close"].shift(-config["bars"])[
            anchor & same_run
        ].to_numpy()
        future_volatility = (
            source["one_bar_return"]
            .shift(-1)
            .rolling(config["bars"], min_periods=config["bars"])
            .std(ddof=1)
            .shift(-(config["bars"] - 1))
        )
        selected["future_volatility"] = future_volatility[
            anchor & same_run
        ].to_numpy()
        anchor_positions = np.flatnonzero(mask)
        triple_labels = []
        for position in anchor_positions:
            entry = float(source["open"].iloc[position + 1])
            barrier = float(band.iloc[position])
            upper = entry * math.exp(barrier)
            lower = entry * math.exp(-barrier)
            triple_label = 1
            for offset in range(1, config["bars"] + 1):
                future = source.iloc[position + offset]
                upper_hit = float(future["high"]) >= upper
                lower_hit = float(future["low"]) <= lower
                if upper_hit and lower_hit:
                    triple_label = 1
                    break
                if upper_hit:
                    triple_label = 2
                    break
                if lower_hit:
                    triple_label = 0
                    break
            triple_labels.append(triple_label)
        selected["triple_barrier_label"] = np.asarray(
            triple_labels, dtype=int
        )
        selected = selected.replace([np.inf, -np.inf], np.nan).dropna(
            subset=[
                "forward_return",
                "label_band",
                "one_bar_return",
                *feature_names,
            ]
        )
        outputs.append(selected)
    result = pd.concat(outputs, ignore_index=True)
    result["horizon"] = horizon
    return result


def chronological_splits(
    frame: pd.DataFrame, horizon: str, resolved_test_cutoff: pd.Timestamp
) -> dict[str, pd.DataFrame]:
    embargo = pd.Timedelta(
        milliseconds=HORIZONS[horizon]["bars"]
        * FIVE_MINUTES.total_seconds()
        * 1_000
    )
    return {
        "train": frame.loc[
            (frame["time"] >= "2021-01-01")
            & (frame["outcome_time"] < "2024-01-01")
        ].copy(),
        "calibration": frame.loc[
            (frame["time"] >= pd.Timestamp("2024-01-01", tz="UTC") + embargo)
            & (frame["outcome_time"] < "2024-07-01")
        ].copy(),
        "threshold": frame.loc[
            (frame["time"] >= pd.Timestamp("2024-07-01", tz="UTC") + embargo)
            & (frame["outcome_time"] < "2025-01-01")
        ].copy(),
        "test": frame.loc[
            (frame["time"] >= pd.Timestamp("2025-01-01", tz="UTC") + embargo)
            & (frame["outcome_time"] <= resolved_test_cutoff)
        ].copy(),
    }


def expanding_folds(frame: pd.DataFrame, horizon: str) -> list[tuple[pd.DataFrame, pd.DataFrame]]:
    embargo = pd.Timedelta(
        milliseconds=HORIZONS[horizon]["bars"]
        * FIVE_MINUTES.total_seconds()
        * 1_000
    )
    boundaries = [
        ("2022-01-01", "2022-07-01"),
        ("2022-07-01", "2023-01-01"),
        ("2023-01-01", "2023-07-01"),
        ("2023-07-01", "2024-01-01"),
    ]
    folds = []
    for start, end in boundaries:
        validation_start = pd.Timestamp(start, tz="UTC")
        validation_end = pd.Timestamp(end, tz="UTC")
        train = frame.loc[
            (frame["time"] >= "2021-01-01")
            & (frame["outcome_time"] < validation_start)
        ]
        validation = frame.loc[
            (frame["time"] >= validation_start + embargo)
            & (frame["outcome_time"] < validation_end)
        ]
        if len(train) >= 500 and len(validation) >= 100:
            folds.append((train, validation))
    if len(folds) != 4:
        raise RuntimeError(f"invalid_expanding_folds:{horizon}:{len(folds)}")
    return folds


def candidate_configs() -> list[dict]:
    configs = [
        {"name": "logistic-c0.1", "kind": "logistic", "C": 0.1},
        {"name": "logistic-c0.5", "kind": "logistic", "C": 0.5},
    ]
    grid = [
        (2, 80, 0.04, 12, 0.75),
        (2, 140, 0.03, 8, 0.85),
        (3, 100, 0.035, 12, 0.75),
        (3, 160, 0.025, 8, 0.85),
        (3, 220, 0.02, 16, 0.8),
        (4, 100, 0.03, 16, 0.7),
        (4, 160, 0.025, 12, 0.8),
        (4, 220, 0.018, 20, 0.75),
        (5, 120, 0.025, 20, 0.7),
        (5, 180, 0.018, 24, 0.75),
    ]
    for index, (depth, estimators, rate, child, columns) in enumerate(grid, 1):
        configs.append(
            {
                "name": f"xgb-{index:02d}",
                "kind": "xgboost",
                "max_depth": depth,
                "n_estimators": estimators,
                "learning_rate": rate,
                "min_child_weight": child,
                "colsample_bytree": columns,
            }
        )
    if len(configs) != MAXIMUM_CANDIDATES:
        raise RuntimeError("candidate_budget_contract_failed")
    return configs


def balanced_weights(labels: np.ndarray) -> np.ndarray:
    counts = np.bincount(labels.astype(int), minlength=2)
    weights = len(labels) / np.maximum(1, counts * 2)
    return weights[labels.astype(int)]


def build_binary_model(config: dict):
    if config["kind"] == "logistic":
        return Pipeline(
            [
                ("scale", StandardScaler()),
                (
                    "model",
                    LogisticRegression(
                        C=config["C"],
                        max_iter=800,
                        solver="saga",
                        tol=1e-4,
                        random_state=RANDOM_SEED,
                    ),
                ),
            ]
        )
    return XGBClassifier(
        objective="binary:logistic",
        eval_metric="logloss",
        n_estimators=config["n_estimators"],
        max_depth=config["max_depth"],
        learning_rate=config["learning_rate"],
        min_child_weight=config["min_child_weight"],
        subsample=0.8,
        colsample_bytree=config["colsample_bytree"],
        reg_alpha=0.2,
        reg_lambda=2.0,
        tree_method="hist",
        n_jobs=max(1, min(4, os.cpu_count() or 1)),
        random_state=RANDOM_SEED,
    )


def fit_binary(model, x: np.ndarray, y: np.ndarray) -> None:
    weights = balanced_weights(y)
    if isinstance(model, Pipeline):
        model.fit(x, y, model__sample_weight=weights)
    else:
        model.fit(x, y, sample_weight=weights, verbose=False)


def fit_pair(
    frame: pd.DataFrame, feature_names: list[str], config: dict
) -> tuple[object, object]:
    x = frame[feature_names].to_numpy(dtype=np.float64)
    action_y = frame["action_label"].to_numpy(dtype=int)
    action = build_binary_model(config)
    fit_binary(action, x, action_y)
    actionable = action_y == 1
    direction = build_binary_model(config)
    fit_binary(
        direction,
        x[actionable],
        frame.loc[actionable, "direction_label"].to_numpy(dtype=int),
    )
    return action, direction


def binary_probability(model, x: np.ndarray) -> np.ndarray:
    probability = np.asarray(model.predict_proba(x), dtype=float)[:, 1]
    if not np.isfinite(probability).all():
        raise RuntimeError("binary_probability_non_finite")
    return np.clip(probability, 1e-12, 1 - 1e-12)


def combine_probabilities(
    action_probability: np.ndarray, up_given_action: np.ndarray
) -> np.ndarray:
    return np.column_stack(
        [
            action_probability * (1 - up_given_action),
            1 - action_probability,
            action_probability * up_given_action,
        ]
    )


def fit_binary_scaling(probability: np.ndarray, y: np.ndarray) -> dict:
    logits = np.log(probability / (1 - probability))

    def objective(parameters: np.ndarray) -> float:
        adjusted = logits * parameters[0] + parameters[1]
        predicted = 1 / (1 + np.exp(-np.clip(adjusted, -50, 50)))
        return float(
            -np.mean(
                y * np.log(np.clip(predicted, 1e-12, 1))
                + (1 - y) * np.log(np.clip(1 - predicted, 1e-12, 1))
            )
        )

    result = minimize(objective, np.array([1.0, 0.0]), method="L-BFGS-B")
    if not result.success:
        return {"method": "platt_scaling", "scale": 1.0, "bias": 0.0}
    return {
        "method": "platt_scaling",
        "scale": float(result.x[0]),
        "bias": float(result.x[1]),
    }


def apply_binary_scaling(probability: np.ndarray, calibration: dict) -> np.ndarray:
    logits = np.log(probability / (1 - probability))
    adjusted = logits * calibration["scale"] + calibration["bias"]
    return 1 / (1 + np.exp(-np.clip(adjusted, -50, 50)))


def model_metrics(y: np.ndarray, probabilities: np.ndarray) -> dict:
    predicted = probabilities.argmax(axis=1)
    return {
        "samples": int(len(y)),
        "accuracy": float(accuracy_score(y, predicted)),
        "balancedAccuracy": float(balanced_accuracy_score(y, predicted)),
        "macroF1": float(f1_score(y, predicted, average="macro")),
        "mcc": float(matthews_corrcoef(y, predicted)),
        "brier": multiclass_brier(y, probabilities),
        "ece": expected_calibration_error(y, probabilities),
    }


def fold_scores(
    frame: pd.DataFrame,
    horizon: str,
    feature_names: list[str],
    config: dict,
) -> list[dict]:
    results = []
    for train, validation in expanding_folds(frame, horizon):
        action, direction = fit_pair(train, feature_names, config)
        x = validation[feature_names].to_numpy(dtype=np.float64)
        probabilities = combine_probabilities(
            binary_probability(action, x),
            binary_probability(direction, x),
        )
        results.append(model_metrics(validation["label"].to_numpy(), probabilities))
    return results


def duplicate_filter(
    frame: pd.DataFrame, feature_names: list[str]
) -> tuple[list[str], dict]:
    sample = frame.loc[frame["time"] < "2024-01-01", feature_names]
    if len(sample) > 100_000:
        sample = sample.iloc[:: max(1, len(sample) // 100_000)]
    correlation = sample.corr(method="spearman").abs()
    retained: list[str] = []
    rejected: list[dict] = []
    for name in feature_names:
        conflict = next(
            (
                candidate
                for candidate in retained
                if float(correlation.loc[name, candidate]) > 0.995
            ),
            None,
        )
        if conflict:
            rejected.append(
                {
                    "feature": name,
                    "duplicateOf": conflict,
                    "spearman": float(correlation.loc[name, conflict]),
                }
            )
        else:
            retained.append(name)
    return retained, {
        "limit": 0.995,
        "retained": len(retained),
        "rejected": rejected,
    }


def ablation_gate(
    frame: pd.DataFrame,
    horizon: str,
    feature_names: list[str],
    config: dict,
    full_scores: list[dict],
) -> tuple[list[str], dict]:
    families = sorted({FEATURE_FAMILIES[name] for name in feature_names})
    report = {}
    retained_families = []
    for family in families:
        reduced = [
            name for name in feature_names if FEATURE_FAMILIES[name] != family
        ]
        if not reduced:
            continue
        scores = fold_scores(frame, horizon, reduced, config)
        improvements = [
            full["balancedAccuracy"] - ablated["balancedAccuracy"]
            for full, ablated in zip(full_scores, scores)
        ]
        passed = sum(value > 0 for value in improvements) >= 3
        report[family] = {
            "passed": passed,
            "foldBalancedAccuracyDelta": improvements,
            "positiveFolds": sum(value > 0 for value in improvements),
        }
        if passed:
            retained_families.append(family)
    retained = [
        name for name in feature_names if FEATURE_FAMILIES[name] in retained_families
    ]
    if len(retained) < 8:
        return feature_names, {
            "fallback": "minimum_feature_contract",
            "families": report,
        }
    return retained, {"fallback": None, "families": report}


def baseline_predictions(frame: pd.DataFrame, horizon: str) -> dict[str, np.ndarray]:
    feature = "return_4h" if horizon == "4h" else "return_24h"
    values = frame[feature].to_numpy()
    band = frame["label_band"].to_numpy()
    trend_window = "4h" if horizon == "4h" else "24h"
    trend_return = frame[f"return_{trend_window}"].to_numpy()
    broader_return = frame["return_24h"].to_numpy()
    donchian = frame[f"donchian_position_{trend_window}"].to_numpy()
    return {
        "majorityRange": np.ones(len(frame), dtype=int),
        "simpleMomentum": np.where(
            values > band, 2, np.where(values < -band, 0, 1)
        ),
        "pricePersistence": np.where(values >= 0, 2, 0),
        "deterministicTrendProxy": np.where(
            (trend_return > 0) & (broader_return > 0) & (donchian > 0.5),
            2,
            np.where(
                (trend_return < 0)
                & (broader_return < 0)
                & (donchian < 0.5),
                0,
                1,
            ),
        ),
    }


def choose_baseline(
    frame: pd.DataFrame, horizon: str
) -> tuple[str, np.ndarray, dict[str, dict[str, float]]]:
    labels = frame["label"].to_numpy()
    candidates = baseline_predictions(frame, horizon)
    scores = {
        name: {
            "accuracy": float(accuracy_score(labels, predicted)),
            "balancedAccuracy": float(
                balanced_accuracy_score(labels, predicted)
            ),
            "macroF1": float(
                f1_score(labels, predicted, average="macro")
            ),
        }
        for name, predicted in candidates.items()
    }
    name = max(
        scores,
        key=lambda candidate: (
            scores[candidate]["balancedAccuracy"],
            scores[candidate]["macroF1"],
        ),
    )
    return name, candidates[name], scores


def bootstrap_net_lower(
    frame: pd.DataFrame,
    selected: np.ndarray,
    predicted: np.ndarray,
    iterations: int = 400,
) -> dict:
    net = cost_adjusted_returns(frame, predicted)
    selected = selected & np.isfinite(net)
    work = pd.DataFrame(
        {
            "time": frame["time"].to_numpy(),
            "net": net,
            "selected": selected,
        }
    )
    work = work.loc[work["selected"]].copy()
    if len(work) < 100:
        return {"lower95": -1.0, "upper95": 1.0, "blocks": 0}
    work["block"] = (
        pd.to_datetime(work["time"], utc=True).astype("int64")
        // 86_400_000_000_000
    )
    blocks = [group["net"].to_numpy() for _, group in work.groupby("block")]
    if len(blocks) < 8:
        return {"lower95": -1.0, "upper95": 1.0, "blocks": len(blocks)}
    rng = np.random.default_rng(RANDOM_SEED)
    means = []
    for _ in range(iterations):
        sampled = np.concatenate(
            [blocks[index] for index in rng.integers(0, len(blocks), len(blocks))]
        )
        means.append(float(sampled.mean()))
    lower, upper = np.quantile(means, [0.025, 0.975])
    return {
        "lower95": float(lower),
        "upper95": float(upper),
        "blocks": len(blocks),
    }


def choose_selective_policy(
    frame: pd.DataFrame,
    probabilities: np.ndarray,
    baseline_predictions: np.ndarray,
) -> dict:
    action_probability = probabilities[:, 0] + probabilities[:, 2]
    conditional_up = probabilities[:, 2] / np.maximum(action_probability, 1e-12)
    direction_confidence = np.maximum(conditional_up, 1 - conditional_up)
    predicted = np.where(conditional_up >= 0.5, 2, 0)
    y = frame["label"].to_numpy()
    candidates = []
    for action_threshold in np.arange(0.45, 0.91, 0.02):
        for direction_threshold in np.arange(0.50, 0.91, 0.02):
            selected = (action_probability >= action_threshold) & (
                direction_confidence >= direction_threshold
            )
            coverage = float(selected.mean())
            if coverage < MINIMUM_COVERAGE or selected.sum() < 100:
                continue
            accuracy = float(accuracy_score(y[selected], predicted[selected]))
            baseline_accuracy = float(
                accuracy_score(y[selected], baseline_predictions[selected])
            )
            if accuracy < baseline_accuracy + 0.05:
                continue
            net = cost_adjusted_returns(frame, predicted)
            selected = selected & np.isfinite(net)
            coverage = float(selected.mean())
            if coverage < MINIMUM_COVERAGE or selected.sum() < 100:
                continue
            candidates.append(
                {
                    "minActionProbability": round(float(action_threshold), 2),
                    "minDirectionProbability": round(
                        float(direction_threshold), 2
                    ),
                    "minEvidenceCoverage": 0.90,
                    "maxDataFreshnessMs": 600_000,
                    "coverage": coverage,
                    "selectiveAccuracy": accuracy,
                    "baselineSelectiveAccuracy": baseline_accuracy,
                    "meanNetReturn": float(net[selected].mean()),
                    "_selected": selected,
                    "_predicted": predicted,
                }
            )
    if not candidates:
        return {
            "minActionProbability": 1.0,
            "minDirectionProbability": 1.0,
            "minEvidenceCoverage": 1.0,
            "maxDataFreshnessMs": 600_000,
            "coverage": 0.0,
            "selectiveAccuracy": None,
            "meanNetReturn": 0.0,
            "bootstrapNet": {"lower95": -1.0, "upper95": 1.0, "blocks": 0},
        }
    candidates.sort(key=lambda value: value["meanNetReturn"], reverse=True)
    for candidate in candidates[:50]:
        candidate["bootstrapNet"] = bootstrap_net_lower(
            frame, candidate["_selected"], candidate["_predicted"]
        )
    best = max(
        candidates[:50],
        key=lambda value: (
            value["bootstrapNet"]["lower95"],
            value["meanNetReturn"],
            value["coverage"],
        ),
    )
    return {key: value for key, value in best.items() if not key.startswith("_")}


def subgroup_guard(
    frame: pd.DataFrame,
    selected: np.ndarray,
    predicted: np.ndarray,
    baseline: np.ndarray,
) -> dict:
    failures = []
    details = []
    volatility = pd.qcut(
        frame["realized_vol_24h"],
        3,
        labels=["low", "medium", "high"],
        duplicates="drop",
    )
    grouped = [
        ("symbol", frame["symbol"]),
        ("volatility", volatility),
    ]
    for kind, values in grouped:
        for name in pd.Series(values).dropna().unique():
            mask = np.asarray(values == name) & selected
            if mask.sum() < 200:
                continue
            accuracy = float(
                accuracy_score(frame.loc[mask, "label"], predicted[mask])
            )
            baseline_accuracy = float(
                accuracy_score(frame.loc[mask, "label"], baseline[mask])
            )
            details.append(
                {
                    "kind": kind,
                    "name": str(name),
                    "samples": int(mask.sum()),
                    "selectiveAccuracy": accuracy,
                    "baselineSelectiveAccuracy": baseline_accuracy,
                    "delta": accuracy - baseline_accuracy,
                }
            )
    for value in details:
        if value["delta"] < -0.05:
            failures.append(f"{value['kind']}:{value['name']}")
    return {"passed": not failures, "failures": failures, "details": details}


def conditional_references(
    frame: pd.DataFrame, feature_names: list[str]
) -> dict:
    work = frame.copy()
    low, high = work["realized_vol_24h"].quantile([1 / 3, 2 / 3])
    work["regime"] = np.where(
        work["realized_vol_24h"] >= high,
        "high_volatility",
        np.where(
            (work["return_4h"] > 0) & (work.get("adx_4h", 0) >= 25),
            "trending_up",
            np.where(
                (work["return_4h"] < 0) & (work.get("adx_4h", 0) >= 25),
                "trending_down",
                "range_or_mixed",
            ),
        ),
    )
    by_symbol = {
        symbol: group[feature_names].median().fillna(0).astype(float).tolist()
        for symbol, group in work.groupby("symbol")
    }
    by_symbol_regime = {
        symbol: {
            regime: group[feature_names]
            .median()
            .fillna(0)
            .astype(float)
            .tolist()
            for regime, group in symbol_group.groupby("regime")
        }
        for symbol, symbol_group in work.groupby("symbol")
    }
    return {
        "method": "training_median_by_symbol_and_regime",
        "global": work[feature_names].median().fillna(0).astype(float).tolist(),
        "bySymbol": by_symbol,
        "bySymbolRegime": by_symbol_regime,
        "regimeThresholds": {"realizedVolatilityLow": float(low), "high": float(high)},
    }


def export_binary_onnx(
    model, config: dict, target: Path, feature_count: int
) -> tuple[str, str]:
    if config["kind"] == "xgboost":
        from onnxmltools import convert_xgboost
        from onnxmltools.convert.common.data_types import FloatTensorType

        converted = convert_xgboost(
            model,
            initial_types=[("features", FloatTensorType([None, feature_count]))],
            target_opset=15,
        )
    else:
        from skl2onnx import convert_sklearn
        from skl2onnx.common.data_types import FloatTensorType

        converted = convert_sklearn(
            model,
            initial_types=[("features", FloatTensorType([None, feature_count]))],
            options={id(model): {"zipmap": False}},
            target_opset=15,
        )
    target.write_bytes(converted.SerializeToString())
    return converted.graph.input[0].name, converted.graph.output[-1].name


def artifact_entry(
    model,
    config: dict,
    target: Path,
    contract_vector: np.ndarray,
    calibration: dict,
) -> dict:
    input_name, output_name = export_binary_onnx(
        model, config, target, len(contract_vector)
    )
    expected = float(
        binary_probability(
            model, contract_vector.astype(np.float64).reshape(1, -1)
        )[0]
    )
    return {
        "artifact": target.name,
        "artifactSha256": sha256_file(target),
        "inputName": input_name,
        "outputName": output_name,
        "calibration": calibration,
        "runtimeContract": {
            "featureVector": contract_vector.astype(float).tolist(),
            "expectedRawProbability": expected,
            "maxAbsoluteDelta": 1e-5,
        },
    }


def copy_legacy_horizons(
    legacy_root: Path, output: Path
) -> tuple[dict, dict]:
    manifest = json.loads((legacy_root / "manifest.json").read_text("utf-8"))
    copied = {}
    hashes = {}
    for horizon in LEGACY_HORIZONS:
        entry = json.loads(json.dumps(manifest["horizons"][horizon]))
        artifacts = [entry]
        heads = entry.get("predictionHeads", {})
        artifacts.extend(
            heads.get("returnQuantiles", {}).get("artifacts", {}).values()
        )
        if heads.get("futureVolatility", {}).get("artifact"):
            artifacts.append(heads["futureVolatility"])
        for artifact in artifacts:
            source = legacy_root / artifact["artifact"]
            target = output / artifact["artifact"]
            shutil.copy2(source, target)
            if sha256_file(target) != artifact["artifactSha256"]:
                raise RuntimeError(f"legacy_artifact_hash_mismatch:{horizon}")
        entry["featureNames"] = entry.get("featureNames") or manifest.get(
            "featureNames"
        )
        entry["featureRegistrySha256"] = entry.get(
            "featureRegistrySha256"
        ) or manifest.get("featureRegistrySha256")
        if not entry["featureNames"] or not entry["featureRegistrySha256"]:
            raise RuntimeError(f"legacy_feature_contract_missing:{horizon}")
        entry["rolloutStatus"] = "shadow"
        entry["eligibleForActive"] = False
        entry["disableReasons"] = [
            "legacy_horizon_not_optimized_in_v3",
            "research_shadow_only",
        ]
        copied[horizon] = entry
        hashes[horizon] = entry["artifactSha256"]
    return copied, {
        "modelVersion": manifest["modelVersion"],
        "manifestSha256": sha256_file(legacy_root / "manifest.json"),
        "artifactSha256": hashes,
    }


def train_horizon(
    samples: pd.DataFrame,
    horizon: str,
    output: Path,
    resolved_test_cutoff: pd.Timestamp,
    *,
    sealed_audit: bool = False,
    required_features: set[str] | None = None,
) -> tuple[dict, dict]:
    required_features = required_features or set()
    initial_features, duplicate_report = duplicate_filter(
        samples, HORIZON_FEATURE_NAMES[horizon]
    )
    initial_features = [
        name
        for name in HORIZON_FEATURE_NAMES[horizon]
        if name in set(initial_features) | required_features
    ][:20]
    if not required_features.issubset(initial_features):
        raise RuntimeError(
            f"required_head_feature_budget_exceeded:{horizon}"
        )
    configs = candidate_configs()
    candidate_reports = []
    for config in configs:
        scores = fold_scores(samples, horizon, initial_features, config)
        candidate_reports.append(
            {
                "config": config,
                "folds": scores,
                "meanBalancedAccuracy": float(
                    np.mean([score["balancedAccuracy"] for score in scores])
                ),
                "meanBrier": float(np.mean([score["brier"] for score in scores])),
            }
        )
    champion_report = max(
        candidate_reports,
        key=lambda value: (
            value["meanBalancedAccuracy"],
            -value["meanBrier"],
        ),
    )
    config = champion_report["config"]
    selected_features, ablation = ablation_gate(
        samples,
        horizon,
        initial_features,
        config,
        champion_report["folds"],
    )
    selected_features = [
        name
        for name in initial_features
        if name in set(selected_features) | required_features
    ][:20]
    if not required_features.issubset(selected_features):
        raise RuntimeError(
            f"required_head_feature_budget_exceeded:{horizon}"
        )
    splits = chronological_splits(samples, horizon, resolved_test_cutoff)
    if sealed_audit:
        splits["test"] = splits["threshold"].copy()
    if min(len(value) for value in splits.values()) < 100:
        raise RuntimeError(f"insufficient_split_samples:{horizon}")
    action, direction = fit_pair(splits["train"], selected_features, config)
    calibration_x = splits["calibration"][selected_features].to_numpy(
        dtype=np.float64
    )
    action_calibration = fit_binary_scaling(
        binary_probability(action, calibration_x),
        splits["calibration"]["action_label"].to_numpy(),
    )
    actionable = splits["calibration"]["action_label"].to_numpy() == 1
    direction_calibration = fit_binary_scaling(
        binary_probability(direction, calibration_x[actionable]),
        splits["calibration"].loc[actionable, "direction_label"].to_numpy(),
    )

    def calibrated(frame: pd.DataFrame) -> np.ndarray:
        x = frame[selected_features].to_numpy(dtype=np.float64)
        action_probability = apply_binary_scaling(
            binary_probability(action, x), action_calibration
        )
        direction_probability = apply_binary_scaling(
            binary_probability(direction, x), direction_calibration
        )
        return combine_probabilities(action_probability, direction_probability)

    threshold_probabilities = calibrated(splits["threshold"])
    (
        threshold_baseline_name,
        threshold_baseline,
        threshold_baseline_scores,
    ) = choose_baseline(splits["threshold"], horizon)
    thresholds = choose_selective_policy(
        splits["threshold"],
        threshold_probabilities,
        threshold_baseline,
    )
    test_probabilities = calibrated(splits["test"])
    test_y = splits["test"]["label"].to_numpy()
    test_metrics = model_metrics(test_y, test_probabilities)
    empirical = np.bincount(
        splits["train"]["label"].to_numpy(), minlength=3
    ) / len(splits["train"])
    reference_brier = multiclass_brier(
        test_y, np.tile(empirical, (len(test_y), 1))
    )
    brier_skill = (
        1 - test_metrics["brier"] / reference_brier
        if reference_brier > 0
        else -1
    )
    action_probability = test_probabilities[:, 0] + test_probabilities[:, 2]
    conditional_up = test_probabilities[:, 2] / np.maximum(
        action_probability, 1e-12
    )
    direction_confidence = np.maximum(conditional_up, 1 - conditional_up)
    selected = (
        action_probability >= thresholds["minActionProbability"]
    ) & (direction_confidence >= thresholds["minDirectionProbability"])
    predicted = np.where(conditional_up >= 0.5, 2, 0)
    test_net = bootstrap_net_lower(splits["test"], selected, predicted)
    test_baseline_candidates = baseline_predictions(splits["test"], horizon)
    baseline_test = test_baseline_candidates[threshold_baseline_name]
    subgroup = subgroup_guard(
        splits["test"], selected, predicted, baseline_test
    )
    selective_accuracy = (
        float(accuracy_score(test_y[selected], predicted[selected]))
        if selected.any()
        else None
    )
    baseline_test_accuracy = float(accuracy_score(test_y, baseline_test))
    baseline_selective_accuracy = (
        float(accuracy_score(test_y[selected], baseline_test[selected]))
        if selected.any()
        else None
    )
    short_execution_coverage = float(
        splits["test"]["short_execution_ready"].mean()
    )
    backtest_input = splits["test"][
        [
            "symbol",
            "horizon",
            "time",
            "outcome_time",
            "entry_open",
            "exit_close",
            "short_entry_open",
            "short_exit_close",
            "short_execution_ready",
            "funding_cost_ratio",
        ]
    ].copy()
    backtest_input = backtest_input.rename(
        columns={"time": "decision_time"}
    )
    backtest_input["predicted_state"] = np.where(
        predicted == 2, "up", "down"
    )
    backtest_input["abstained"] = ~selected
    cost_sensitivity = sensitivity_report(
        backtest_input,
        rules=MarketRules(
            price_tick=0.01,
            quantity_step=1e-8,
            minimum_notional=5.0,
            fee_bps_per_side=10.0,
        ),
        slippage_grid=(2, 5, 10, 20),
        require_perp_short=True,
    )
    eligible = (not sealed_audit) and all(
        [
            test_metrics["brier"] < reference_brier,
            brier_skill > 0,
            test_metrics["ece"] <= 0.05,
            float(selected.mean()) >= MINIMUM_COVERAGE,
            selective_accuracy is not None
            and baseline_selective_accuracy is not None
            and selective_accuracy >= baseline_selective_accuracy + 0.05,
            test_net["lower95"] > 0,
            subgroup["passed"],
            short_execution_coverage >= 0.95,
        ]
    )
    contract_vector = (
        splits["test"][selected_features]
        .iloc[0]
        .to_numpy(dtype=np.float32)
    )
    action_entry = artifact_entry(
        action,
        config,
        output / f"{horizon}-opportunity.onnx",
        contract_vector,
        action_calibration,
    )
    direction_entry = artifact_entry(
        direction,
        config,
        output / f"{horizon}-direction.onnx",
        contract_vector,
        direction_calibration,
    )
    ablation_body = {
        "schema": "athena.crypto.feature-ablation",
        "schemaVersion": "1.0",
        "horizon": horizon,
        "duplicateFilter": duplicate_report,
        "familyAblation": ablation,
        "selectedFeatures": selected_features,
    }
    ablation_sha = canonical_sha256(ablation_body)
    (output / f"{horizon}-ablation-{ablation_sha}.json").write_text(
        json.dumps(ablation_body, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    driver_families = feature_family_indexes(selected_features)
    composite_artifact_sha = canonical_sha256(
        {
            "opportunity": action_entry["artifactSha256"],
            "conditionalDirection": direction_entry["artifactSha256"],
        }
    )
    entry = {
        "featureNames": selected_features,
        "featureRegistrySha256": REGISTRY_SHA256,
        "classOrder": CLASS_ORDER,
        "champion": config,
        "decisionLayers": {
            "opportunity": action_entry,
            "conditionalDirection": direction_entry,
        },
        "modelArtifactSha256": composite_artifact_sha,
        "thresholds": thresholds,
        "selectivePolicyVersion": "cost-adjusted-selective-v3",
        "costModelVersion": "crypto-cost-model-v3",
        "driverMethod": "conditional_family_sensitivity_v1",
        "driverFamilies": driver_families,
        "conditionalReferences": conditional_references(
            splits["train"], selected_features
        ),
        "featureFamilyEligibility": {
            family: {
                "included": family in driver_families,
                "reason": (
                    "passed_time_fold_ablation"
                    if family in driver_families
                    else "failed_time_fold_ablation"
                ),
            }
            for family in sorted(
                {FEATURE_FAMILIES[name] for name in initial_features}
            )
        }
        | {
            "derivatives": {
                "included": False,
                "reason": "requires_180d_coverage_and_separate_ablation",
            },
            "microstructure": {
                "included": False,
                "reason": "requires_180d_organic_history",
            },
        },
        "ablationReportSha256": ablation_sha,
        "eligibleForActive": eligible,
        "rolloutStatus": "shadow",
        "disableReasons": (
            []
            if eligible
            else [
                (
                    "independent_historical_audit_pending"
                    if sealed_audit
                    else "offline_promotion_gate_failed"
                )
            ]
        ),
        "predictionHeads": {
            "direction": {
                "version": "opportunity-direction-v3",
                "status": "shadow",
                "eligibleForActive": eligible,
            },
            "currentRegime": {
                "version": "deterministic-regime-v1",
                "status": "shadow",
                "directionIndependent": True,
            },
        },
        "purging": {
            "labelEndTimeApplied": True,
            "embargo": horizon,
            "splitSamples": {
                name: int(len(value)) for name, value in splits.items()
            },
            "selectionFolds": 4,
        },
    }
    report = {
        "horizon": horizon,
        "candidateBudget": MAXIMUM_CANDIDATES,
        "candidates": candidate_reports,
        "champion": config,
        "duplicateFilter": duplicate_report,
        "ablation": ablation,
        "selectedFeatures": selected_features,
        "thresholds": thresholds,
        "test": {
            **test_metrics,
            "brierSkill": float(brier_skill),
            "classification": (
                "development_threshold_replay_not_independent"
                if sealed_audit
                else "historical_test"
            ),
        },
        "baseline": {
            "name": threshold_baseline_name,
            "accuracy": baseline_test_accuracy,
            "selectiveAccuracy": baseline_selective_accuracy,
            "thresholdSelectionScores": threshold_baseline_scores,
        },
        "selective": {
            "coverage": float(selected.mean()),
            "accuracy": selective_accuracy,
            "bootstrapNet": test_net,
            "shortExecutionCoverage": short_execution_coverage,
        },
        "costSensitivity": cost_sensitivity,
        "subgroupGuard": subgroup,
        "eligibleForActive": eligible,
        "historicalAuditMounted": not sealed_audit,
    }
    return entry, report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--legacy-model-root", required=True, type=Path)
    parser.add_argument("--model-version", default="crypto-forecast-v3")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    bars = load_bars(args.database)
    resolved_test_cutoff = bars["time"].max() - pd.Timedelta(days=24)
    samples_by_horizon: dict[str, list[pd.DataFrame]] = {
        horizon: [] for horizon in OPTIMIZED_HORIZONS
    }
    for symbol in ("BTC", "ETH", "SOL"):
        symbol_features = feature_frame_v3(bars, assets=[symbol])
        for horizon in OPTIMIZED_HORIZONS:
            samples_by_horizon[horizon].append(
                samples_for_horizon_v3(
                    symbol_features,
                    horizon,
                    HORIZON_FEATURE_NAMES[horizon],
                )
            )
        del symbol_features
        gc.collect()
    del bars
    gc.collect()
    horizon_entries = {}
    reports = {}
    for horizon in OPTIMIZED_HORIZONS:
        samples = pd.concat(samples_by_horizon.pop(horizon), ignore_index=True)
        samples = attach_execution_evidence(samples, args.database)
        entry, report = train_horizon(
            samples, horizon, args.output, resolved_test_cutoff
        )
        horizon_entries[horizon] = entry
        reports[horizon] = report
        print(
            json.dumps(
                {
                    "horizon": horizon,
                    "eligibleForActive": report["eligibleForActive"],
                    "test": report["test"],
                    "selective": report["selective"],
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    legacy, legacy_provenance = copy_legacy_horizons(
        args.legacy_model_root, args.output
    )
    horizon_entries.update(legacy)
    shadow_gates = {
        horizon: shadow_observation_gate(args.database, horizon)
        for horizon in OPTIMIZED_HORIZONS
    }
    manifest = {
        "schema": "athena.crypto.forecast-model",
        "schemaVersion": "1.0",
        "modelVersion": args.model_version,
        "featureSchemaVersion": "crypto-forecast-features-v3",
        "featureRegistryVersion": REGISTRY["registryVersion"],
        "featureRegistrySha256": REGISTRY_SHA256,
        "runtimeParityRequired": True,
        "classOrder": CLASS_ORDER,
        "rolloutStatus": "shadow",
        "trainedAt": datetime.now(timezone.utc).isoformat(),
        "datasetManifestSha256": latest_dataset_manifest(args.database),
        "costModelVersion": "crypto-cost-model-v3",
        "trainingPeriod": {
            "featureAndCandidateSelection": "2021-2023 expanding four folds",
            "calibration": "2024-01-01 through 2024-06-30",
            "selectiveThreshold": "2024-07-01 through 2024-12-31",
            "untouchedTest": [
                "2025-01-01 + horizon embargo",
                resolved_test_cutoff.isoformat(),
            ],
            "purging": "label outcome must precede next split",
            "embargo": "one full prediction horizon",
        },
        "promotionPolicy": {
            "optimizedHorizons": list(OPTIMIZED_HORIZONS),
            "minimumSelectiveCoverage": MINIMUM_COVERAGE,
            "selectiveAccuracyDelta": ">=0.05",
            "brierSkill": ">0",
            "ece": "<=0.05",
            "costAdjustedBootstrapMeanLower95": ">0",
            "subgroupMaximumRegression": "-0.05",
            "onlineShadowDays": 30,
        },
        "legacyProvenance": legacy_provenance,
        "horizons": horizon_entries,
    }
    (args.output / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    report = {
        "schema": "athena.crypto.forecast-training-report",
        "schemaVersion": "3.0",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "modelVersion": args.model_version,
        "shadowObservationGates": shadow_gates,
        "horizons": reports,
        "legacyHorizons": list(LEGACY_HORIZONS),
    }
    (args.output / "training-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "output": str(args.output),
                "rolloutStatus": "shadow",
                "eligibleHorizons": [
                    horizon
                    for horizon, value in reports.items()
                    if value["eligibleForActive"]
                ],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
