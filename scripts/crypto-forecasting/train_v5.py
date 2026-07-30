#!/usr/bin/env python3
"""Train Athena v5 4h cost-adjusted side and tradeability models."""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import math
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    brier_score_loss,
    f1_score,
    log_loss,
    matthews_corrcoef,
)
from xgboost import XGBClassifier, XGBRegressor

import train_v3 as v3
import train_v4 as v4
from features_v5 import (
    DERIVED_META_FEATURES,
    FEATURE_FAMILIES,
    HORIZON_FEATURE_NAMES,
    LABEL_CONTRACT,
    META_CANDIDATE_FEATURES,
    META_MAXIMUM_INPUTS,
    REGISTRY,
    REGISTRY_SHA256,
    SIDE_MAXIMUM_INPUTS,
    feature_family_indexes,
    feature_frame_v3,
    stable_mrmr_selection,
)
from labels_v5 import (
    HORIZON_BARS,
    LABEL_ROUND_TRIP_COST_RATIO,
    label_distribution,
    load_derivative_history,
    samples_for_multiplier,
)
from train import (
    CLASS_ORDER,
    apply_vector_scaling,
    expected_calibration_error,
    fit_vector_scaling,
    load_bars,
    multiclass_brier,
)

RANDOM_SEED = 20260730
HORIZON = "4h"
TRAIN_END = pd.Timestamp("2024-01-01", tz="UTC")
CALIBRATION_END = pd.Timestamp("2024-07-01", tz="UTC")
THRESHOLD_END = pd.Timestamp("2025-01-01", tz="UTC")
MINIMUM_COVERAGE = 0.10


def canonical_sha256(value: object) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def candidate_configs() -> list[dict]:
    configs = v3.candidate_configs()[:8]
    if len(configs) != 8:
        raise RuntimeError("v5_candidate_budget_contract_failed")
    return configs


def splits(frame: pd.DataFrame) -> dict[str, pd.DataFrame]:
    outcome = pd.to_datetime(frame["outcome_time"], utc=True)
    time = pd.to_datetime(frame["time"], utc=True)
    result = {
        "train": frame.loc[(time < TRAIN_END) & (outcome < TRAIN_END)].copy(),
        "calibration": frame.loc[
            (time >= TRAIN_END)
            & (time < CALIBRATION_END)
            & (outcome < CALIBRATION_END)
        ].copy(),
        "threshold": frame.loc[
            (time >= CALIBRATION_END)
            & (time < THRESHOLD_END)
            & (outcome < THRESHOLD_END)
        ].copy(),
    }
    if min(map(len, result.values())) < 500:
        raise RuntimeError("v5_insufficient_chronological_split")
    return result


def side_metrics(y: np.ndarray, probability: np.ndarray) -> dict:
    predicted = (probability >= 0.5).astype(int)
    return {
        "samples": int(len(y)),
        "accuracy": float(accuracy_score(y, predicted)),
        "balancedAccuracy": float(balanced_accuracy_score(y, predicted)),
        "macroF1": float(f1_score(y, predicted, average="macro")),
        "mcc": float(matthews_corrcoef(y, predicted)),
        "logLoss": float(log_loss(y, probability, labels=[0, 1])),
        "brier": float(brier_score_loss(y, probability)),
    }


def expanding_folds(frame: pd.DataFrame) -> list[tuple[pd.DataFrame, pd.DataFrame]]:
    boundaries = (
        ("2022-01-01", "2022-07-01"),
        ("2022-07-01", "2023-01-01"),
        ("2023-01-01", "2023-07-01"),
        ("2023-07-01", "2024-01-01"),
    )
    folds = []
    outcome = pd.to_datetime(frame["outcome_time"], utc=True)
    time = pd.to_datetime(frame["time"], utc=True)
    for start, end in boundaries:
        start_at = pd.Timestamp(start, tz="UTC")
        end_at = pd.Timestamp(end, tz="UTC")
        train = frame.loc[(time < start_at) & (outcome < start_at)]
        validation = frame.loc[(time >= start_at) & (time < end_at)]
        if len(train) >= 1_000 and len(validation) >= 500:
            folds.append((train.copy(), validation.copy()))
    if len(folds) != 4:
        raise RuntimeError(f"v5_invalid_expanding_folds:{len(folds)}")
    return folds


def fit_side(
    frame: pd.DataFrame,
    feature_names: list[str],
    config: dict,
):
    actionable = frame.loc[frame["action_label"].eq(1)]
    model = v3.build_binary_model(config)
    v3.fit_binary(
        model,
        actionable[feature_names].to_numpy(dtype=np.float64),
        actionable["side_label"].to_numpy(dtype=int),
    )
    return model


def barrier_selection_report(
    candidates: dict[float, pd.DataFrame],
    feature_names: list[str],
) -> tuple[float, dict]:
    config = candidate_configs()[0]
    reports = {}
    valid = []
    for multiplier, frame in candidates.items():
        distribution = label_distribution(frame)
        fold_reports = []
        for train, validation in expanding_folds(frame):
            model = fit_side(train, feature_names, config)
            actionable = validation.loc[validation["action_label"].eq(1)]
            probability = v3.binary_probability(
                model,
                actionable[feature_names].to_numpy(dtype=np.float64),
            )
            fold_reports.append(
                side_metrics(
                    actionable["side_label"].to_numpy(dtype=int),
                    probability,
                )
            )
        report = {
            "multiplier": multiplier,
            "distribution": distribution,
            "folds": fold_reports,
            "minimumFoldBalancedAccuracy": float(
                min(item["balancedAccuracy"] for item in fold_reports)
            ),
            "meanBalancedAccuracy": float(
                np.mean([item["balancedAccuracy"] for item in fold_reports])
            ),
            "meanLogLoss": float(
                np.mean([item["logLoss"] for item in fold_reports])
            ),
        }
        report["distributionGatePassed"] = (
            distribution["actionShare"]
            >= float(LABEL_CONTRACT["minimumActionShare"])
            and distribution["noTradeShare"]
            >= float(LABEL_CONTRACT["minimumNoTradeShare"])
            and distribution["derivativesCoverage"] >= 0.95
        )
        reports[str(multiplier)] = report
        if report["distributionGatePassed"]:
            valid.append(report)
    if not valid:
        raise RuntimeError("v5_no_barrier_multiplier_passed_distribution_gate")
    winner = max(
        valid,
        key=lambda item: (
            item["minimumFoldBalancedAccuracy"],
            item["meanBalancedAccuracy"],
            -item["meanLogLoss"],
        ),
    )
    return float(winner["multiplier"]), {
        "selection": "max_min_fold_side_accuracy_then_mean_then_logloss",
        "selected": float(winner["multiplier"]),
        "candidates": reports,
    }


def side_candidate_report(
    frame: pd.DataFrame,
    feature_names: list[str],
    config: dict,
) -> dict:
    fold_reports = []
    for train, validation in expanding_folds(frame):
        model = fit_side(train, feature_names, config)
        actionable = validation.loc[validation["action_label"].eq(1)]
        probability = v3.binary_probability(
            model, actionable[feature_names].to_numpy(dtype=np.float64)
        )
        fold_reports.append(
            side_metrics(
                actionable["side_label"].to_numpy(dtype=int), probability
            )
        )
    return {
        "config": config,
        "folds": fold_reports,
        "meanBalancedAccuracy": float(
            np.mean([item["balancedAccuracy"] for item in fold_reports])
        ),
        "meanLogLoss": float(
            np.mean([item["logLoss"] for item in fold_reports])
        ),
    }


def family_ablation(
    frame: pd.DataFrame,
    feature_names: list[str],
    config: dict,
    full_report: dict,
) -> tuple[list[str], dict]:
    retained_families = []
    report = {}
    for family in sorted({FEATURE_FAMILIES[name] for name in feature_names}):
        reduced = [
            name for name in feature_names if FEATURE_FAMILIES[name] != family
        ]
        if len(reduced) < 4:
            continue
        candidate = side_candidate_report(frame, reduced, config)
        deltas = [
            full["balancedAccuracy"] - ablated["balancedAccuracy"]
            for full, ablated in zip(
                full_report["folds"], candidate["folds"]
            )
        ]
        passed = sum(delta > 0 for delta in deltas) >= 3
        report[family] = {
            "passed": passed,
            "positiveFolds": int(sum(delta > 0 for delta in deltas)),
            "foldBalancedAccuracyDelta": deltas,
        }
        if passed:
            retained_families.append(family)
    retained = [
        name
        for name in feature_names
        if FEATURE_FAMILIES[name] in retained_families
    ]
    if len(retained) < 8:
        return feature_names, {
            "fallback": "minimum_feature_contract",
            "families": report,
        }
    return retained[:SIDE_MAXIMUM_INPUTS], {
        "fallback": None,
        "families": report,
    }


def risk_targets(frame: pd.DataFrame, reference: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    stress_threshold = float(reference["future_volatility"].quantile(0.8))
    tail_threshold = float(
        min(
            reference["forward_return"].quantile(0.05),
            -2 * reference["label_band"].median(),
        )
    )
    stress = frame["future_volatility"].to_numpy() >= stress_threshold
    state = np.where(
        stress,
        2,
        np.where(
            frame["forward_return"].abs().to_numpy()
            > frame["label_band"].to_numpy(),
            0,
            1,
        ),
    ).astype(int)
    tail = (
        (frame["forward_return"].to_numpy() <= tail_threshold) | stress
    ).astype(int)
    return state, tail


def fit_risk_bundle(
    train: pd.DataFrame,
    feature_names: list[str],
    config: dict,
) -> dict:
    x = train[feature_names].to_numpy(dtype=np.float64)
    state_y, tail_y = risk_targets(train, train)
    state = XGBClassifier(
        objective="multi:softprob",
        num_class=3,
        n_estimators=120,
        max_depth=2,
        learning_rate=0.04,
        min_child_weight=16,
        subsample=0.8,
        colsample_bytree=0.8,
        reg_alpha=0.2,
        reg_lambda=2.0,
        tree_method="hist",
        n_jobs=max(1, min(4, os.cpu_count() or 1)),
        random_state=RANDOM_SEED,
    )
    state.fit(x, state_y, verbose=False)
    tail = v3.build_binary_model(config)
    v3.fit_binary(tail, x, tail_y)
    volatility = XGBRegressor(
        objective="reg:quantileerror",
        quantile_alpha=0.5,
        n_estimators=120,
        max_depth=2,
        min_child_weight=24,
        learning_rate=0.035,
        subsample=0.8,
        colsample_bytree=0.8,
        reg_alpha=0.2,
        reg_lambda=2.0,
        tree_method="hist",
        n_jobs=max(1, min(4, os.cpu_count() or 1)),
        random_state=RANDOM_SEED,
    )
    volatility.fit(x, train["future_volatility"].to_numpy(dtype=float))
    return {
        "state": state,
        "tail": tail,
        "volatility": volatility,
        "reference": train,
    }


def risk_predictions(
    bundle: dict,
    frame: pd.DataFrame,
    feature_names: list[str],
) -> dict[str, np.ndarray]:
    x = frame[feature_names].to_numpy(dtype=np.float64)
    state = bundle["state"].predict_proba(x)
    return {
        "future_volatility_p50": np.maximum(
            bundle["volatility"].predict(x), 0
        ),
        "tail_risk_probability": v3.binary_probability(bundle["tail"], x),
        "stress_probability": state[:, 2],
    }


def execution_net_return(
    frame: pd.DataFrame, predicted_up: np.ndarray
) -> np.ndarray:
    event = frame["first_touch_event"].to_numpy()
    barrier = frame["barrier_ratio"].to_numpy(dtype=float)
    long_timeout = (
        frame["exit_close"].to_numpy(dtype=float)
        / frame["entry_open"].to_numpy(dtype=float)
        - 1
    )
    short_timeout = (
        frame["short_entry_open"].to_numpy(dtype=float)
        - frame["short_exit_close"].to_numpy(dtype=float)
    ) / frame["short_entry_open"].to_numpy(dtype=float)
    funding = np.where(
        frame["first_touch_event"].eq("no_trade").to_numpy(),
        frame["funding_cost_ratio"].to_numpy(dtype=float),
        frame["funding_cost_to_touch"].to_numpy(dtype=float),
    )
    long_gross = np.where(
        event == "up",
        np.exp(barrier) - 1,
        np.where(event == "down", np.exp(-barrier) - 1, long_timeout),
    )
    short_gross = np.where(
        event == "down",
        1 - np.exp(-barrier),
        np.where(event == "up", 1 - np.exp(barrier), short_timeout),
    )
    return np.where(
        predicted_up,
        long_gross - LABEL_ROUND_TRIP_COST_RATIO,
        short_gross - LABEL_ROUND_TRIP_COST_RATIO - funding,
    )


def meta_frame(
    frame: pd.DataFrame,
    side_probability: np.ndarray,
    risk: dict[str, np.ndarray],
) -> pd.DataFrame:
    result = frame.copy()
    result["side_up_probability"] = side_probability
    for name, values in risk.items():
        result[name] = values
    predicted_up = side_probability >= 0.5
    net = execution_net_return(result, predicted_up)
    result["predicted_side_up"] = predicted_up.astype(int)
    result["predicted_side_net_return"] = net
    result["meta_label"] = (net > 0).astype(int)
    return result


def cross_fitted_meta_rows(
    frame: pd.DataFrame,
    side_features: list[str],
    side_config: dict,
) -> pd.DataFrame:
    rows = []
    for train, validation in expanding_folds(frame):
        side = fit_side(train, side_features, side_config)
        side_probability = v3.binary_probability(
            side, validation[side_features].to_numpy(dtype=np.float64)
        )
        risk = fit_risk_bundle(train, side_features, side_config)
        predictions = risk_predictions(risk, validation, side_features)
        rows.append(meta_frame(validation, side_probability, predictions))
    return pd.concat(rows, ignore_index=True)


def select_meta_features(frame: pd.DataFrame) -> tuple[list[str], dict]:
    stable_counts = {name: 0 for name in META_CANDIDATE_FEATURES}
    reports = []
    for start, end in (
        ("2022-01-01", "2023-01-01"),
        ("2023-01-01", "2024-01-01"),
    ):
        fold = frame.loc[
            (frame["time"] >= start) & (frame["time"] < end)
        ]
        correlations = {}
        for name in META_CANDIDATE_FEATURES:
            value = fold[name].corr(fold["meta_label"], method="spearman")
            correlations[name] = abs(float(value)) if pd.notna(value) else 0
        selected = sorted(
            META_CANDIDATE_FEATURES,
            key=lambda name: correlations[name],
            reverse=True,
        )[: META_MAXIMUM_INPUTS - len(DERIVED_META_FEATURES)]
        for name in selected:
            stable_counts[name] += 1
        reports.append(
            {
                "period": [start, end],
                "selected": selected,
                "absoluteSpearman": correlations,
            }
        )
    required = math.ceil(len(reports) * 0.7)
    stable = [
        name for name in META_CANDIDATE_FEATURES if stable_counts[name] >= required
    ]
    if len(stable) < META_MAXIMUM_INPUTS - len(DERIVED_META_FEATURES):
        ranked = sorted(
            META_CANDIDATE_FEATURES,
            key=lambda name: stable_counts[name],
            reverse=True,
        )
        for name in ranked:
            if name not in stable:
                stable.append(name)
            if len(stable) >= META_MAXIMUM_INPUTS - len(DERIVED_META_FEATURES):
                break
    names = [
        *DERIVED_META_FEATURES,
        *stable[: META_MAXIMUM_INPUTS - len(DERIVED_META_FEATURES)],
    ]
    return names, {
        "method": "blocked_stable_rank_v1",
        "minimumFoldRatio": 0.7,
        "folds": reports,
        "selectionCounts": stable_counts,
        "selected": names,
    }


def meta_candidate_report(
    frame: pd.DataFrame,
    feature_names: list[str],
    config: dict,
) -> dict:
    reports = []
    for start, end in (
        ("2023-01-01", "2023-07-01"),
        ("2023-07-01", "2024-01-01"),
    ):
        train = frame.loc[frame["time"] < start]
        validation = frame.loc[
            (frame["time"] >= start) & (frame["time"] < end)
        ]
        if len(train) < 1_000 or len(validation) < 500:
            continue
        model = v3.build_binary_model(config)
        v3.fit_binary(
            model,
            train[feature_names].to_numpy(dtype=np.float64),
            train["meta_label"].to_numpy(dtype=int),
        )
        probability = v3.binary_probability(
            model, validation[feature_names].to_numpy(dtype=np.float64)
        )
        reports.append(
            side_metrics(
                validation["meta_label"].to_numpy(dtype=int), probability
            )
        )
    if len(reports) != 2:
        raise RuntimeError("v5_meta_candidate_folds_missing")
    return {
        "config": config,
        "folds": reports,
        "meanBalancedAccuracy": float(
            np.mean([item["balancedAccuracy"] for item in reports])
        ),
        "meanLogLoss": float(np.mean([item["logLoss"] for item in reports])),
    }


def baseline_side_predictions(frame: pd.DataFrame) -> dict[str, np.ndarray]:
    return_4h = frame["return_4h"].to_numpy(dtype=float)
    actual = frame["first_touch_event"].to_numpy()
    action = np.isin(actual, ["up", "down"])
    majority_up = (
        (actual[action] == "up").mean() >= (actual[action] == "down").mean()
        if action.any()
        else True
    )
    return {
        "momentum": return_4h >= 0,
        "persistence": frame["one_bar_return"].to_numpy(dtype=float) >= 0,
        "fixed_up": np.ones(len(frame), dtype=bool),
        "fixed_down": np.zeros(len(frame), dtype=bool),
        "selected_majority": np.full(len(frame), majority_up, dtype=bool),
    }


def selected_side_accuracy(
    frame: pd.DataFrame,
    selected: np.ndarray,
    predicted_up: np.ndarray,
) -> float:
    actual = frame["first_touch_event"].to_numpy()
    correct = np.where(predicted_up, actual == "up", actual == "down")
    return float(correct[selected].mean()) if selected.any() else 0.0


def block_bootstrap_lower(
    frame: pd.DataFrame,
    selected: np.ndarray,
    predicted_up: np.ndarray,
    iterations: int = 400,
) -> dict:
    net = execution_net_return(frame, predicted_up)
    work = pd.DataFrame(
        {
            "time": pd.to_datetime(frame["time"], utc=True),
            "net": net,
        }
    ).loc[selected & np.isfinite(net)]
    if len(work) < 100:
        return {"lower95": -1.0, "upper95": 1.0, "blocks": 0}
    work["block"] = work["time"].dt.floor("1D")
    blocks = [group["net"].to_numpy() for _, group in work.groupby("block")]
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


def choose_thresholds(
    frame: pd.DataFrame,
    meta_probability: np.ndarray,
    side_probability: np.ndarray,
    tail_probability: np.ndarray,
    stress_probability: np.ndarray,
) -> dict:
    predicted_up = side_probability >= 0.5
    side_confidence = np.maximum(side_probability, 1 - side_probability)
    baselines = baseline_side_predictions(frame)
    candidates = []
    for trade_threshold in np.arange(0.50, 0.91, 0.05):
        for side_threshold in np.arange(0.50, 0.81, 0.05):
            selected = (
                (meta_probability >= trade_threshold)
                & (side_confidence >= side_threshold)
                & (tail_probability <= 0.65)
                & (stress_probability <= 0.70)
            )
            coverage = float(selected.mean())
            if coverage < MINIMUM_COVERAGE or selected.sum() < 100:
                continue
            accuracy = selected_side_accuracy(frame, selected, predicted_up)
            baseline_scores = {
                name: selected_side_accuracy(frame, selected, values)
                for name, values in baselines.items()
            }
            best_name = max(baseline_scores, key=baseline_scores.get)
            best_accuracy = baseline_scores[best_name]
            if accuracy < best_accuracy + 0.05:
                continue
            bootstrap = block_bootstrap_lower(
                frame, selected, predicted_up
            )
            net = execution_net_return(frame, predicted_up)
            candidates.append(
                {
                    "minActionProbability": float(trade_threshold),
                    "minTradeabilityProbability": float(trade_threshold),
                    "minDirectionProbability": float(side_threshold),
                    "maxTailRiskProbability": 0.65,
                    "maxStressProbability": 0.70,
                    "minEvidenceCoverage": 0.90,
                    "maxDataFreshnessMs": 600_000,
                    "minimumDerivativesCoverage": 0.95,
                    "coverage": coverage,
                    "selectiveAccuracy": accuracy,
                    "bestBaseline": best_name,
                    "bestBaselineAccuracy": best_accuracy,
                    "baselineScores": baseline_scores,
                    "meanNetReturn": float(net[selected].mean()),
                    "bootstrapNet": bootstrap,
                }
            )
    if not candidates:
        return {
            "minActionProbability": 1.0,
            "minTradeabilityProbability": 1.0,
            "minDirectionProbability": 1.0,
            "maxTailRiskProbability": 0.0,
            "maxStressProbability": 0.0,
            "minEvidenceCoverage": 1.0,
            "maxDataFreshnessMs": 600_000,
            "minimumDerivativesCoverage": 0.95,
            "coverage": 0.0,
            "selectiveAccuracy": None,
            "selectionFailed": True,
            "failureReason": "no_policy_passed_accuracy_and_coverage",
        }
    winner = max(
        candidates,
        key=lambda item: (
            item["bootstrapNet"]["lower95"],
            item["meanNetReturn"],
            item["selectiveAccuracy"],
            item["coverage"],
        ),
    )
    return {**winner, "selectionFailed": False}


def export_risk_heads(
    bundle: dict,
    calibration: pd.DataFrame,
    feature_names: list[str],
    output: Path,
    config: dict,
) -> tuple[dict, dict, dict[str, np.ndarray]]:
    x_calibration = calibration[feature_names].to_numpy(dtype=np.float64)
    contract_vector = x_calibration[0].astype(np.float32)
    state_y, tail_y = risk_targets(calibration, bundle["reference"])
    raw_state = bundle["state"].predict_proba(x_calibration)
    scale, bias = fit_vector_scaling(raw_state, state_y)
    state_calibration = {
        "method": "multiclass_vector_scaling",
        "scale": scale.astype(float).tolist(),
        "bias": bias.astype(float).tolist(),
    }
    state_probability = apply_vector_scaling(raw_state, scale, bias)
    state_entry = v4.multiclass_artifact_entry(
        bundle["state"],
        output / "4h-market-state.onnx",
        contract_vector,
        state_calibration,
    )
    state_entry.update(
        {
            "status": "shadow",
            "classOrder": ["trend", "range", "stress"],
            "modelVersion": "market-state-v5",
            "directionIndependent": True,
        }
    )
    raw_tail = v3.binary_probability(bundle["tail"], x_calibration)
    tail_calibration = v3.fit_binary_scaling(raw_tail, tail_y)
    tail_probability = v3.apply_binary_scaling(
        raw_tail, tail_calibration
    )
    tail_entry = v3.artifact_entry(
        bundle["tail"],
        config,
        output / "4h-tail-risk.onnx",
        contract_vector,
        tail_calibration,
    )
    tail_entry.update(
        {
            "status": "shadow",
            "definition": "downside_or_stress_event_v5",
            "directionIndependent": True,
        }
    )
    volatility_entry = v4.scalar_artifact_entry(
        bundle["volatility"],
        output / "4h-future-volatility.onnx",
        contract_vector,
    )
    volatility_entry.update(
        {
            "status": "shadow",
            "directionIndependent": True,
            "unit": "horizon_realized_log_return_volatility",
        }
    )
    volatility = np.maximum(
        bundle["volatility"].predict(x_calibration), 0
    )
    heads = {
        "marketState": state_entry,
        "tailRisk": tail_entry,
        "futureVolatility": volatility_entry,
    }
    report = {
        "marketState": {
            "balancedAccuracy": float(
                balanced_accuracy_score(
                    state_y, state_probability.argmax(axis=1)
                )
            )
        },
        "tailRisk": {
            "brier": float(brier_score_loss(tail_y, tail_probability))
        },
        "futureVolatility": {
            "mae": float(
                np.mean(
                    np.abs(
                        calibration["future_volatility"].to_numpy(dtype=float)
                        - volatility
                    )
                )
            )
        },
    }
    predictions = {
        "future_volatility_p50": volatility,
        "tail_risk_probability": tail_probability,
        "stress_probability": state_probability[:, 2],
    }
    return heads, report, predictions


def artifact_paths(value: object) -> set[str]:
    result: set[str] = set()
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "artifact" and isinstance(child, str):
                result.add(child)
            else:
                result.update(artifact_paths(child))
    elif isinstance(value, list):
        for child in value:
            result.update(artifact_paths(child))
    return result


def copy_inherited_horizons(
    legacy_root: Path, output: Path
) -> tuple[dict, dict]:
    manifest = json.loads((legacy_root / "manifest.json").read_text("utf-8"))
    copied = {}
    artifact_hashes = {}
    for horizon in ("24h", "4d", "12d", "24d"):
        entry = json.loads(json.dumps(manifest["horizons"][horizon]))
        entry["rolloutStatus"] = "shadow"
        entry["eligibleForActive"] = False
        entry["disableReasons"] = list(
            dict.fromkeys(
                [
                    *entry.get("disableReasons", []),
                    "inherited_shadow_not_optimized_in_v5",
                ]
            )
        )
        if not entry.get("featureRegistrySha256"):
            entry["featureRegistrySha256"] = manifest.get(
                "featureRegistrySha256"
            )
        for artifact in artifact_paths(entry):
            source = legacy_root / artifact
            target = output / Path(artifact).name
            if not target.exists():
                shutil.copy2(source, target)
            artifact_hashes[f"{horizon}:{target.name}"] = sha256_file(target)
            # Existing artifacts are stored at the model root.
            def rewrite(value: object) -> None:
                if isinstance(value, dict):
                    for key, child in value.items():
                        if key == "artifact" and child == artifact:
                            value[key] = target.name
                        else:
                            rewrite(child)
                elif isinstance(value, list):
                    for child in value:
                        rewrite(child)
            rewrite(entry)
        copied[horizon] = entry
    return copied, {
        "modelVersion": manifest["modelVersion"],
        "manifestSha256": sha256_file(legacy_root / "manifest.json"),
        "artifacts": artifact_hashes,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--legacy-model-root", required=True, type=Path)
    parser.add_argument("--model-version", default="crypto-forecast-v5")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    bars = load_bars(args.database)
    if bars["time"].max() >= THRESHOLD_END:
        raise RuntimeError("v5_training_snapshot_contains_audit_domain")
    klines, funding = load_derivative_history(args.database)
    features_by_symbol = []
    for symbol in ("BTC", "ETH", "SOL"):
        features_by_symbol.append(feature_frame_v3(bars, assets=[symbol]))
    del bars
    gc.collect()
    all_features = pd.concat(features_by_symbol, ignore_index=True)
    base_features = HORIZON_FEATURE_NAMES[HORIZON]
    multiplier_samples = {}
    for multiplier in LABEL_CONTRACT["barrierMultipliers"]:
        multiplier_samples[float(multiplier)] = samples_for_multiplier(
            all_features,
            klines,
            funding,
            float(multiplier),
            base_features,
        )
    selected_multiplier, barrier_report = barrier_selection_report(
        multiplier_samples, base_features[:16]
    )
    samples = multiplier_samples[selected_multiplier]
    samples = samples.loc[~samples["ambiguous"]].reset_index(drop=True)
    del multiplier_samples, all_features, klines, funding
    gc.collect()

    duplicate_features, duplicate_report = v3.duplicate_filter(
        samples, base_features
    )
    actionable = samples.loc[samples["action_label"].eq(1)]
    selected_features, selection_report = stable_mrmr_selection(
        actionable,
        duplicate_features,
        target="side_label",
        maximum=SIDE_MAXIMUM_INPUTS,
    )
    required_risk = {
        "realized_vol_1h",
        "realized_vol_4h",
        "realized_vol_24h",
        "normalized_atr_1h",
        "normalized_atr_4h",
    }
    selected_features = [
        name
        for name in base_features
        if name in set(selected_features) | required_risk
    ][:SIDE_MAXIMUM_INPUTS]
    if not required_risk.issubset(selected_features):
        raise RuntimeError("v5_risk_feature_budget_exceeded")

    side_reports = [
        side_candidate_report(samples, selected_features, config)
        for config in candidate_configs()
    ]
    side_champion = max(
        side_reports,
        key=lambda item: (
            item["meanBalancedAccuracy"],
            -item["meanLogLoss"],
        ),
    )
    selected_features, ablation_report = family_ablation(
        samples,
        selected_features,
        side_champion["config"],
        side_champion,
    )
    selected_features = [
        name
        for name in base_features
        if name in set(selected_features) | required_risk
    ][:SIDE_MAXIMUM_INPUTS]

    chronological = splits(samples)
    train = chronological["train"]
    calibration = chronological["calibration"]
    threshold = chronological["threshold"]
    cross_fitted = cross_fitted_meta_rows(
        train, selected_features, side_champion["config"]
    )
    meta_features, meta_selection = select_meta_features(cross_fitted)
    meta_reports = [
        meta_candidate_report(cross_fitted, meta_features, config)
        for config in candidate_configs()
    ]
    meta_champion = max(
        meta_reports,
        key=lambda item: (
            item["meanBalancedAccuracy"],
            -item["meanLogLoss"],
        ),
    )

    side_model = fit_side(
        train, selected_features, side_champion["config"]
    )
    raw_side_calibration = v3.binary_probability(
        side_model,
        calibration[selected_features].to_numpy(dtype=np.float64),
    )
    side_actionable = calibration["action_label"].to_numpy(dtype=bool)
    side_calibration = v3.fit_binary_scaling(
        raw_side_calibration[side_actionable],
        calibration.loc[side_actionable, "side_label"].to_numpy(dtype=int),
    )
    side_probability_calibration = v3.apply_binary_scaling(
        raw_side_calibration, side_calibration
    )

    risk_bundle = fit_risk_bundle(
        train, selected_features, side_champion["config"]
    )
    heads, risk_report, risk_calibration = export_risk_heads(
        risk_bundle,
        calibration,
        selected_features,
        args.output,
        side_champion["config"],
    )
    calibration_meta = meta_frame(
        calibration,
        side_probability_calibration,
        risk_calibration,
    )
    meta_model = v3.build_binary_model(meta_champion["config"])
    v3.fit_binary(
        meta_model,
        cross_fitted[meta_features].to_numpy(dtype=np.float64),
        cross_fitted["meta_label"].to_numpy(dtype=int),
    )
    raw_meta_calibration = v3.binary_probability(
        meta_model,
        calibration_meta[meta_features].to_numpy(dtype=np.float64),
    )
    meta_calibration = v3.fit_binary_scaling(
        raw_meta_calibration,
        calibration_meta["meta_label"].to_numpy(dtype=int),
    )

    raw_side_threshold = v3.binary_probability(
        side_model, threshold[selected_features].to_numpy(dtype=np.float64)
    )
    side_probability_threshold = v3.apply_binary_scaling(
        raw_side_threshold, side_calibration
    )
    risk_threshold_raw = risk_predictions(
        risk_bundle, threshold, selected_features
    )
    state_scale = np.asarray(
        heads["marketState"]["calibration"]["scale"], dtype=float
    )
    state_bias = np.asarray(
        heads["marketState"]["calibration"]["bias"], dtype=float
    )
    raw_state_threshold = risk_bundle["state"].predict_proba(
        threshold[selected_features].to_numpy(dtype=np.float64)
    )
    state_threshold = apply_vector_scaling(
        raw_state_threshold, state_scale, state_bias
    )
    risk_threshold = {
        "future_volatility_p50": risk_threshold_raw[
            "future_volatility_p50"
        ],
        "tail_risk_probability": v3.apply_binary_scaling(
            risk_threshold_raw["tail_risk_probability"],
            heads["tailRisk"]["calibration"],
        ),
        "stress_probability": state_threshold[:, 2],
    }
    threshold_meta = meta_frame(
        threshold, side_probability_threshold, risk_threshold
    )
    raw_meta_threshold = v3.binary_probability(
        meta_model, threshold_meta[meta_features].to_numpy(dtype=np.float64)
    )
    meta_probability_threshold = v3.apply_binary_scaling(
        raw_meta_threshold, meta_calibration
    )
    thresholds = choose_thresholds(
        threshold_meta,
        meta_probability_threshold,
        side_probability_threshold,
        risk_threshold["tail_risk_probability"],
        risk_threshold["stress_probability"],
    )

    side_contract = calibration[selected_features].iloc[0].to_numpy(
        dtype=np.float32
    )
    meta_contract = calibration_meta[meta_features].iloc[0].to_numpy(
        dtype=np.float32
    )
    side_entry = v3.artifact_entry(
        side_model,
        side_champion["config"],
        args.output / "4h-side.onnx",
        side_contract,
        side_calibration,
    )
    meta_entry = v3.artifact_entry(
        meta_model,
        meta_champion["config"],
        args.output / "4h-tradeability-meta.onnx",
        meta_contract,
        meta_calibration,
    )
    meta_entry["inputFeatureNames"] = meta_features
    composite_sha = canonical_sha256(
        {
            "side": side_entry["artifactSha256"],
            "tradeabilityMeta": meta_entry["artifactSha256"],
        }
    )
    derivatives_coverage = {
        "shortExecutionCoverage": float(
            label_distribution(samples)["derivativesCoverage"]
        ),
        "fundingCoverage": float(
            samples["funding_cost_ratio"].notna().mean()
        ),
        "minimumRequired": 0.95,
    }
    feature_selection_body = {
        "schema": "athena.crypto.feature-selection-report",
        "schemaVersion": "5.0",
        "horizon": HORIZON,
        "duplicateFilter": duplicate_report,
        "sideMrmr": selection_report,
        "sideFamilyAblation": ablation_report,
        "sideFeatures": selected_features,
        "metaSelection": meta_selection,
        "metaFeatures": meta_features,
        "barrierSelection": barrier_report,
    }
    feature_selection_sha = canonical_sha256(feature_selection_body)
    (
        args.output
        / f"4h-feature-selection-{feature_selection_sha}.json"
    ).write_text(
        json.dumps(
            feature_selection_body, ensure_ascii=False, indent=2
        ),
        encoding="utf-8",
    )
    entry_4h = {
        "featureNames": selected_features,
        "featureRegistrySha256": REGISTRY_SHA256,
        "classOrder": CLASS_ORDER,
        "champion": {
            "side": side_champion["config"],
            "tradeabilityMeta": meta_champion["config"],
        },
        "decisionLayers": {
            "side": side_entry,
            "tradeabilityMeta": meta_entry,
        },
        "predictionHeads": heads,
        "modelArtifactSha256": composite_sha,
        "metaModelArtifactSha256": meta_entry["artifactSha256"],
        "thresholds": thresholds,
        "selectivePolicyVersion": "cost-adjusted-selective-v5",
        "costModelVersion": "crypto-cost-model-v5",
        "labelPolicyVersion": LABEL_CONTRACT["version"],
        "labelContract": {
            **LABEL_CONTRACT,
            "selectedBarrierMultiplier": selected_multiplier,
        },
        "driverMethod": "conditional_block_permutation_v2",
        "driverFamilies": feature_family_indexes(selected_features),
        "featureFamilyEligibility": {
            family: {
                "included": any(
                    FEATURE_FAMILIES[name] == family
                    for name in selected_features
                ),
                "reason": (
                    "passed_time_fold_ablation"
                    if ablation_report["families"].get(family, {}).get(
                        "passed"
                    )
                    else "supporting_only_or_failed_ablation"
                ),
            }
            for family in sorted(set(FEATURE_FAMILIES.values()))
        },
        "derivativesCoverage": derivatives_coverage,
        "featureSelectionVersion": "crypto-feature-selection-v5",
        "featureSelectionReportSha256": feature_selection_sha,
        "validationProtocolVersion": "crypto-validation-v5",
        "rolloutStatus": "shadow",
        "eligibleForActive": False,
        "disableReasons": [
            "historical_audit_required",
            "prospective_shadow_required",
        ],
        "prospectiveEvidence": {
            "status": "not_started",
            "requiredDays": 60,
            "requiredNonOverlapping": 600,
            "requiredPerSymbol": 150,
            "settledNonOverlapping": 0,
        },
    }
    inherited, inherited_provenance = copy_inherited_horizons(
        args.legacy_model_root, args.output
    )
    horizons = {"4h": entry_4h, **inherited}
    manifest = {
        "schema": "athena.crypto.forecast-model",
        "schemaVersion": "1.0",
        "modelVersion": args.model_version,
        "featureSchemaVersion": "crypto-forecast-features-v5",
        "featureRegistryVersion": REGISTRY["registryVersion"],
        "featureRegistrySha256": REGISTRY_SHA256,
        "runtimeParityRequired": True,
        "classOrder": CLASS_ORDER,
        "rolloutStatus": "shadow",
        "trainedAt": datetime.now(timezone.utc).isoformat(),
        "datasetManifestSha256": sha256_file(args.database),
        "costModelVersion": "crypto-cost-model-v5",
        "trainingPeriod": {
            "development": "2021-2023 expanding folds",
            "calibration": "2024-01-01 through 2024-06-30",
            "selectiveThreshold": "2024-07-01 through 2024-12-31",
            "historicalAudit": "2025+ sealed_not_mounted",
            "purging": "outcome_time_precedes_next_split",
            "embargo": "4h",
        },
        "promotionPolicy": {
            "historicalAuditCannotActivate": True,
            "optimizedHorizons": ["4h"],
            "minimumSelectiveCoverage": 0.10,
            "selectiveAccuracyDelta": ">=0.05_vs_same_selected_best_baseline",
            "brierSkill": ">0",
            "ece": "<=0.05",
            "mcc": ">0",
            "costAdjustedBootstrapMeanLower95": ">0_at_5bps",
            "onlineShadowDays": {"4h": 60},
        },
        "legacyProvenance": inherited_provenance,
        "horizons": horizons,
    }
    (args.output / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    report = {
        "schema": "athena.crypto.forecast-training-report",
        "schemaVersion": "5.0",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "modelVersion": args.model_version,
        "historicalAuditClassification": "sealed_not_mounted",
        "horizons": {
            "4h": {
                "labelDistribution": label_distribution(samples),
                "barrierSelection": barrier_report,
                "sideCandidates": side_reports,
                "sideChampion": side_champion,
                "metaCandidates": meta_reports,
                "metaChampion": meta_champion,
                "riskHeads": risk_report,
                "featureSelection": feature_selection_body,
                "thresholds": thresholds,
                "derivativesCoverage": derivatives_coverage,
                "eligibleForActive": False,
            }
        },
        "inheritedHorizons": ["24h", "4d", "12d", "24d"],
    }
    (args.output / "training-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "output": str(args.output),
                "modelVersion": args.model_version,
                "selectedBarrierMultiplier": selected_multiplier,
                "sideFeatures": len(selected_features),
                "metaFeatures": len(meta_features),
                "thresholdSelectionFailed": thresholds["selectionFailed"],
                "rolloutStatus": "shadow",
                "independentAuditRequired": True,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
