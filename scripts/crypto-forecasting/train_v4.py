#!/usr/bin/env python3
"""Train Athena v4 shadow models and risk heads with sealed audit metadata."""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import balanced_accuracy_score, brier_score_loss
from xgboost import DMatrix, XGBClassifier, XGBRegressor

import train_v3 as v3
from features_v4 import (
    FEATURE_FAMILIES,
    HORIZON_FEATURE_NAMES,
    REGISTRY,
    REGISTRY_SHA256,
    feature_family_indexes,
    feature_frame_v3,
    stable_mrmr_selection,
)
from train import (
    CLASS_ORDER,
    apply_vector_scaling,
    expected_calibration_error,
    fit_vector_scaling,
    load_bars,
    qlike,
)

OPTIMIZED_HORIZONS = ("4h", "24h")
RANDOM_SEED = 20260730
AUDIT_DOMAIN_START = pd.Timestamp("2025-01-01", tz="UTC")


def canonical_sha256(value: object) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


def assert_sealed_training_domain(bars: pd.DataFrame) -> None:
    if bars["time"].max() >= AUDIT_DOMAIN_START:
        raise RuntimeError("sealed_training_snapshot_contains_audit_domain")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def with_label_scheme(frame: pd.DataFrame, column: str) -> pd.DataFrame:
    result = frame.copy()
    result["label"] = result[column].astype(int)
    result["action_label"] = result["label"].ne(1).astype(int)
    result["direction_label"] = result["label"].eq(2).astype(int)
    return result


def choose_label_scheme(
    samples: pd.DataFrame, horizon: str, feature_names: list[str]
) -> tuple[pd.DataFrame, dict]:
    config = v3.candidate_configs()[0]
    reports = {}
    for name, column in (
        ("dynamic_band", "dynamic_label"),
        ("triple_barrier", "triple_barrier_label"),
    ):
        candidate = with_label_scheme(samples, column)
        scores = v3.fold_scores(candidate, horizon, feature_names, config)
        reports[name] = {
            "folds": scores,
            "meanBalancedAccuracy": float(
                np.mean([value["balancedAccuracy"] for value in scores])
            ),
            "meanMacroF1": float(
                np.mean([value["macroF1"] for value in scores])
            ),
        }
    dynamic = reports["dynamic_band"]
    triple = reports["triple_barrier"]
    deltas = [
        right["balancedAccuracy"] - left["balancedAccuracy"]
        for left, right in zip(dynamic["folds"], triple["folds"])
    ]
    triple_passed = (
        triple["meanBalancedAccuracy"]
        >= dynamic["meanBalancedAccuracy"] + 0.01
        and sum(value > 0 for value in deltas) >= 3
    )
    selected = "triple_barrier" if triple_passed else "dynamic_band"
    column = (
        "triple_barrier_label"
        if selected == "triple_barrier"
        else "dynamic_label"
    )
    return with_label_scheme(samples, column), {
        "selected": selected,
        "tripleBarrierPromotionRule": {
            "minimumMeanBalancedAccuracyDelta": 0.01,
            "minimumPositiveFolds": 3,
        },
        "foldBalancedAccuracyDelta": deltas,
        "candidates": reports,
    }


def stability_report(
    samples: pd.DataFrame,
    horizon: str,
    feature_names: list[str],
) -> tuple[list[str], dict]:
    reports = []
    positive_counts = {name: 0 for name in feature_names}
    shap_counts = {name: 0 for name in feature_names}
    folds = v3.expanding_folds(samples, horizon)
    for fold_index, (train, validation) in enumerate(folds):
        if len(validation) > 12_000:
            validation = validation.iloc[
                :: max(1, len(validation) // 12_000)
            ]
        model = XGBClassifier(
            objective="multi:softprob",
            num_class=3,
            n_estimators=80,
            max_depth=2,
            learning_rate=0.05,
            min_child_weight=16,
            subsample=0.8,
            colsample_bytree=0.8,
            reg_alpha=0.2,
            reg_lambda=2.0,
            tree_method="hist",
            n_jobs=max(1, min(4, os.cpu_count() or 1)),
            random_state=RANDOM_SEED + fold_index,
        )
        x_train = train[feature_names].to_numpy(dtype=np.float64)
        x_validation = validation[feature_names].to_numpy(dtype=np.float64)
        y_train = train["label"].to_numpy(dtype=int)
        y_validation = validation["label"].to_numpy(dtype=int)
        model.fit(x_train, y_train, verbose=False)
        baseline = balanced_accuracy_score(
            y_validation, model.predict(x_validation)
        )
        rng = np.random.default_rng(RANDOM_SEED + fold_index)
        deltas = {}
        block = max(1, min(len(validation), 7 * 24))
        for index, name in enumerate(feature_names):
            permuted = x_validation.copy()
            blocks = [
                permuted[start : start + block, index].copy()
                for start in range(0, len(permuted), block)
            ]
            order = rng.permutation(len(blocks))
            shuffled = np.concatenate([blocks[position] for position in order])
            permuted[:, index] = shuffled[: len(permuted)]
            delta = baseline - balanced_accuracy_score(
                y_validation, model.predict(permuted)
            )
            deltas[name] = float(delta)
            if delta > 0:
                positive_counts[name] += 1
        contributions = model.get_booster().predict(
            DMatrix(x_validation[: min(3_000, len(x_validation))]),
            pred_contribs=True,
        )
        reshaped = np.asarray(contributions)
        if reshaped.ndim == 3:
            importance = np.abs(reshaped[:, :, :-1]).mean(axis=(0, 1))
        else:
            importance = np.abs(reshaped[:, :-1]).mean(axis=0)
        top = np.argsort(importance)[::-1][
            : max(8, int(np.ceil(len(feature_names) / 2)))
        ]
        for index in top:
            shap_counts[feature_names[int(index)]] += 1
        reports.append(
            {
                "fold": fold_index,
                "blockedPermutationBalancedAccuracyDelta": deltas,
                "shapMeanAbsolute": {
                    name: float(importance[index])
                    for index, name in enumerate(feature_names)
                },
            }
        )
    required = max(1, int(np.ceil(len(folds) * 0.7)))
    stable = [
        name
        for name in feature_names
        if positive_counts[name] >= required and shap_counts[name] >= required
    ]
    if len(stable) < 8:
        stable = sorted(
            feature_names,
            key=lambda name: (
                positive_counts[name] + shap_counts[name],
                -feature_names.index(name),
            ),
            reverse=True,
        )[: min(20, max(8, len(feature_names)))]
        stable.sort(key=feature_names.index)
    return stable[:20], {
        "method": "blocked_permutation_shap_stability_v1",
        "requiredFolds": required,
        "positivePermutationCounts": positive_counts,
        "shapTopHalfCounts": shap_counts,
        "folds": reports,
        "selected": stable[:20],
    }


def scalar_artifact_entry(
    model, target: Path, contract_vector: np.ndarray
) -> dict:
    from onnxmltools import convert_xgboost
    from onnxmltools.convert.common.data_types import FloatTensorType

    converted = convert_xgboost(
        model,
        initial_types=[
            ("features", FloatTensorType([None, len(contract_vector)]))
        ],
        target_opset=15,
    )
    target.write_bytes(converted.SerializeToString())
    expected = float(
        model.predict(contract_vector.astype(np.float64).reshape(1, -1))[0]
    )
    return {
        "artifact": target.name,
        "artifactSha256": sha256_file(target),
        "inputName": converted.graph.input[0].name,
        "outputName": converted.graph.output[-1].name,
        "runtimeContract": {
            "featureVector": contract_vector.astype(float).tolist(),
            "expectedRawValue": expected,
            "maxAbsoluteDelta": 1e-5,
        },
    }


def multiclass_artifact_entry(
    model,
    target: Path,
    contract_vector: np.ndarray,
    calibration: dict,
) -> dict:
    from onnxmltools import convert_xgboost
    from onnxmltools.convert.common.data_types import FloatTensorType

    converted = convert_xgboost(
        model,
        initial_types=[
            ("features", FloatTensorType([None, len(contract_vector)]))
        ],
        target_opset=15,
    )
    target.write_bytes(converted.SerializeToString())
    expected = model.predict_proba(
        contract_vector.astype(np.float64).reshape(1, -1)
    )[0]
    return {
        "artifact": target.name,
        "artifactSha256": sha256_file(target),
        "inputName": converted.graph.input[0].name,
        "outputName": converted.graph.output[-1].name,
        "calibration": calibration,
        "runtimeContract": {
            "featureVector": contract_vector.astype(float).tolist(),
            "expectedRawProbabilities": expected.astype(float).tolist(),
            "maxAbsoluteDelta": 1e-5,
        },
    }


def train_risk_heads(
    samples: pd.DataFrame,
    horizon: str,
    feature_names: list[str],
    output: Path,
    resolved_test_cutoff: pd.Timestamp,
    champion_config: dict,
    *,
    sealed_audit: bool = False,
) -> tuple[dict, dict]:
    splits = v3.chronological_splits(
        samples, horizon, resolved_test_cutoff
    )
    if sealed_audit:
        splits["test"] = splits["threshold"].copy()
    train = splits["train"]
    calibration = splits["calibration"]
    test = splits["test"]
    x_train = train[feature_names].to_numpy(dtype=np.float64)
    x_calibration = calibration[feature_names].to_numpy(dtype=np.float64)
    x_test = test[feature_names].to_numpy(dtype=np.float64)
    contract_vector = x_test[0].astype(np.float32)

    stress_threshold = float(train["future_volatility"].quantile(0.8))
    tail_return_threshold = float(
        min(
            train["forward_return"].quantile(0.05),
            -2 * train["label_band"].median(),
        )
    )

    def state_labels(frame: pd.DataFrame) -> np.ndarray:
        return np.where(
            frame["future_volatility"].to_numpy() >= stress_threshold,
            2,
            np.where(
                frame["forward_return"].abs().to_numpy()
                > frame["label_band"].to_numpy(),
                0,
                1,
            ),
        ).astype(int)

    state_model = XGBClassifier(
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
    state_model.fit(x_train, state_labels(train), verbose=False)
    raw_calibration = state_model.predict_proba(x_calibration)
    scale, bias = fit_vector_scaling(
        raw_calibration, state_labels(calibration)
    )
    state_calibration = {
        "method": "multiclass_vector_scaling",
        "scale": scale.astype(float).tolist(),
        "bias": bias.astype(float).tolist(),
    }
    state_test_probability = apply_vector_scaling(
        state_model.predict_proba(x_test), scale, bias
    )
    state_test = state_labels(test)
    state_entry = multiclass_artifact_entry(
        state_model,
        output / f"{horizon}-market-state.onnx",
        contract_vector,
        state_calibration,
    )
    state_entry.update(
        {
            "status": "shadow",
            "classOrder": ["trend", "range", "stress"],
            "modelVersion": "market-state-v4",
            "directionIndependent": True,
            "stressThreshold": stress_threshold,
        }
    )

    tail_train = (
        (train["forward_return"] <= tail_return_threshold)
        | (train["future_volatility"] >= stress_threshold)
    ).astype(int)
    tail_calibration_y = (
        (calibration["forward_return"] <= tail_return_threshold)
        | (calibration["future_volatility"] >= stress_threshold)
    ).astype(int)
    tail_test_y = (
        (test["forward_return"] <= tail_return_threshold)
        | (test["future_volatility"] >= stress_threshold)
    ).astype(int)
    tail_model = v3.build_binary_model(champion_config)
    v3.fit_binary(tail_model, x_train, tail_train.to_numpy())
    tail_calibration = v3.fit_binary_scaling(
        v3.binary_probability(tail_model, x_calibration),
        tail_calibration_y.to_numpy(),
    )
    tail_probability = v3.apply_binary_scaling(
        v3.binary_probability(tail_model, x_test), tail_calibration
    )
    tail_entry = v3.artifact_entry(
        tail_model,
        champion_config,
        output / f"{horizon}-tail-risk.onnx",
        contract_vector,
        tail_calibration,
    )
    tail_entry.update(
        {
            "status": "shadow",
            "definition": "downside_or_stress_event_v4",
            "directionIndependent": True,
            "tailReturnThreshold": tail_return_threshold,
            "stressThreshold": stress_threshold,
        }
    )

    volatility_artifacts = {}
    volatility_predictions = {}
    volatility_calibration_predictions = {}
    for name, level in (("p50", 0.5), ("p90", 0.9)):
        model = XGBRegressor(
            objective="reg:quantileerror",
            quantile_alpha=level,
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
        model.fit(x_train, train["future_volatility"].to_numpy(dtype=float))
        volatility_predictions[name] = np.maximum(model.predict(x_test), 0)
        volatility_calibration_predictions[name] = np.maximum(
            model.predict(x_calibration), 0
        )
        volatility_artifacts[name] = scalar_artifact_entry(
            model,
            output / f"{horizon}-future-volatility-{name}.onnx",
            contract_vector,
        )
    baseline_feature = "realized_vol_24h"
    baseline_feature_index = feature_names.index(baseline_feature)
    calibration_baseline = np.maximum(
        calibration[baseline_feature].to_numpy(dtype=float), 1e-12
    )
    calibration_actual = calibration["future_volatility"].to_numpy(
        dtype=float
    )
    blend_candidates = []
    for model_weight in np.linspace(0, 1, 21):
        blended = (
            model_weight * volatility_calibration_predictions["p50"]
            + (1 - model_weight) * calibration_baseline
        )
        blend_candidates.append(
            {
                "modelWeight": float(model_weight),
                "qlike": qlike(calibration_actual, blended),
            }
        )
    selected_blend = min(blend_candidates, key=lambda value: value["qlike"])
    model_weight = selected_blend["modelWeight"]
    p50 = (
        model_weight * volatility_predictions["p50"]
        + (1 - model_weight)
        * np.maximum(test[baseline_feature].to_numpy(dtype=float), 1e-12)
    )
    p90 = np.maximum(p50, volatility_predictions["p90"])
    actual_volatility = test["future_volatility"].to_numpy(dtype=float)
    ewma_baseline = np.maximum(
        test["realized_vol_24h"].to_numpy(dtype=float), 1e-12
    )
    heads = {
        "marketState": state_entry,
        "tailRisk": tail_entry,
        "futureVolatility": {
            "status": "shadow",
            "artifacts": volatility_artifacts,
            "directionIndependent": True,
            "unit": "horizon_realized_log_return_volatility",
            "blend": {
                "method": "calibration_qlike_grid_v1",
                "modelWeight": model_weight,
                "baselineFeature": baseline_feature,
                "baselineFeatureIndex": baseline_feature_index,
                "calibrationCandidates": blend_candidates,
            },
        },
    }
    report = {
        "evaluationClassification": (
            "development_threshold_replay_not_independent"
            if sealed_audit
            else "historical_test"
        ),
        "marketState": {
            "samples": int(len(test)),
            "balancedAccuracy": float(
                balanced_accuracy_score(
                    state_test, state_test_probability.argmax(axis=1)
                )
            ),
            "ece": expected_calibration_error(
                state_test, state_test_probability
            ),
            "stressThreshold": stress_threshold,
        },
        "tailRisk": {
            "samples": int(len(test)),
            "brier": float(brier_score_loss(tail_test_y, tail_probability)),
            "baselineBrier": float(
                brier_score_loss(
                    tail_test_y,
                    np.full(len(tail_test_y), tail_train.mean()),
                )
            ),
            "tailReturnThreshold": tail_return_threshold,
        },
        "futureVolatility": {
            "samples": int(len(test)),
            "p50Mae": float(np.mean(np.abs(actual_volatility - p50))),
            "p50Qlike": qlike(actual_volatility, p50),
            "baselineQlike": qlike(actual_volatility, ewma_baseline),
            "blendModelWeight": model_weight,
            "calibrationBlendQlike": selected_blend["qlike"],
            "p50P90Coverage": float(
                (
                    (actual_volatility >= p50)
                    & (actual_volatility <= p90)
                ).mean()
            ),
        },
    }
    return heads, report


def copy_legacy_horizons(
    legacy_root: Path, output: Path
) -> tuple[dict, dict]:
    return v3.copy_legacy_horizons(legacy_root, output)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--legacy-model-root", required=True, type=Path)
    parser.add_argument("--model-version", default="crypto-forecast-v4")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    bars = load_bars(args.database)
    assert_sealed_training_domain(bars)
    resolved_test_cutoff = pd.Timestamp("2024-12-31", tz="UTC")
    samples_by_horizon: dict[str, list[pd.DataFrame]] = {
        horizon: [] for horizon in OPTIMIZED_HORIZONS
    }
    for symbol in ("BTC", "ETH", "SOL"):
        symbol_features = feature_frame_v3(bars, assets=[symbol])
        for horizon in OPTIMIZED_HORIZONS:
            samples_by_horizon[horizon].append(
                v3.samples_for_horizon_v3(
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
        checkpoint_path = args.output / f"{horizon}-training-checkpoint.json"
        if checkpoint_path.exists():
            checkpoint = json.loads(checkpoint_path.read_text("utf-8"))
            horizon_entries[horizon] = checkpoint["entry"]
            reports[horizon] = checkpoint["report"]
            samples_by_horizon.pop(horizon, None)
            print(
                json.dumps(
                    {
                        "horizon": horizon,
                        "selectedFeatures": len(
                            checkpoint["entry"]["featureNames"]
                        ),
                        "labelScheme": checkpoint["entry"]["labelScheme"],
                        "rolloutStatus": "shadow",
                        "resumedFromCheckpoint": True,
                    }
                ),
                flush=True,
            )
            continue
        samples = pd.concat(
            samples_by_horizon.pop(horizon), ignore_index=True
        )
        samples = v3.attach_execution_evidence(samples, args.database)
        candidates, duplicate = v3.duplicate_filter(
            samples, HORIZON_FEATURE_NAMES[horizon]
        )
        mrmr_features, mrmr_report = stable_mrmr_selection(
            samples, candidates
        )
        stable_features, stability = stability_report(
            samples, horizon, mrmr_features
        )
        required_by_head = REGISTRY["horizons"][horizon].get(
            "headRequiredFeatures", {}
        )
        required_features = {
            name
            for names in required_by_head.values()
            for name in names
        }
        stable_features = [
            name
            for name in HORIZON_FEATURE_NAMES[horizon]
            if name in set(stable_features) | required_features
        ][:20]
        if not required_features.issubset(stable_features):
            raise RuntimeError(
                f"required_head_feature_budget_exceeded:{horizon}"
            )
        selected_samples, label_report = choose_label_scheme(
            samples, horizon, stable_features
        )

        direction_checkpoint_path = (
            args.output / f"{horizon}-direction-checkpoint.json"
        )
        if direction_checkpoint_path.exists():
            direction_checkpoint = json.loads(
                direction_checkpoint_path.read_text("utf-8")
            )
            entry = direction_checkpoint["entry"]
            direction_report = direction_checkpoint["report"]
        else:
            original_names = v3.HORIZON_FEATURE_NAMES[horizon]
            original_registry = v3.REGISTRY_SHA256
            original_families = v3.FEATURE_FAMILIES
            try:
                v3.HORIZON_FEATURE_NAMES[horizon] = stable_features
                v3.REGISTRY_SHA256 = REGISTRY_SHA256
                v3.FEATURE_FAMILIES = FEATURE_FAMILIES
                entry, direction_report = v3.train_horizon(
                    selected_samples,
                    horizon,
                    args.output,
                    resolved_test_cutoff,
                    sealed_audit=True,
                    required_features=required_features,
                )
            finally:
                v3.HORIZON_FEATURE_NAMES[horizon] = original_names
                v3.REGISTRY_SHA256 = original_registry
                v3.FEATURE_FAMILIES = original_families
            direction_checkpoint_path.write_text(
                json.dumps(
                    {
                        "schema": (
                            "athena.crypto.forecast-direction-checkpoint"
                        ),
                        "schemaVersion": "4.0",
                        "horizon": horizon,
                        "entry": entry,
                        "report": direction_report,
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )

        heads, head_report = train_risk_heads(
            selected_samples,
            horizon,
            entry["featureNames"],
            args.output,
            resolved_test_cutoff,
            entry["champion"],
            sealed_audit=True,
        )
        selection_body = {
            "schema": "athena.crypto.feature-selection-report",
            "schemaVersion": "4.0",
            "horizon": horizon,
            "duplicateFilter": duplicate,
            "mrmr": mrmr_report,
            "blockedPermutationAndShap": stability,
            "headRequiredFeatures": required_by_head,
            "selectedFeatures": entry["featureNames"],
            "labelScheme": label_report,
        }
        selection_sha = canonical_sha256(selection_body)
        (
            args.output
            / f"{horizon}-feature-selection-{selection_sha}.json"
        ).write_text(
            json.dumps(selection_body, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        entry["featureRegistrySha256"] = REGISTRY_SHA256
        entry["selectivePolicyVersion"] = "cost-adjusted-selective-v4"
        entry["driverMethod"] = "conditional_block_permutation_v2"
        entry["driverFamilies"] = feature_family_indexes(
            entry["featureNames"]
        )
        entry["featureSelectionVersion"] = "crypto-feature-selection-v4"
        entry["featureSelectionReportSha256"] = selection_sha
        entry["validationProtocolVersion"] = "crypto-validation-v4"
        entry["labelScheme"] = label_report["selected"]
        entry["thresholds"]["maxTailRiskProbability"] = 0.65
        entry["predictionHeads"].update(heads)
        entry["dataFamilyCoverage"] = {
            "priceTrend": "model_input",
            "priceVolume": "model_input",
            "derivatives": "supporting_until_coverage_gate",
            "microstructure": "supporting_until_180d",
            "onChain": "supporting_until_180d_point_in_time",
            "optionsVolatility": "supporting_until_180d",
            "macro": "supporting_only_estimated_availability",
        }
        entry["prospectiveEvidence"] = {
            "status": "not_started",
            "settledNonOverlapping": 0,
            "requiredDays": 60 if horizon == "4h" else 120,
            "requiredNonOverlapping": 600 if horizon == "4h" else 300,
        }
        training_split = v3.chronological_splits(
            selected_samples, horizon, resolved_test_cutoff
        )["train"]
        training_counts = (
            training_split["label"].value_counts().reindex([0, 1, 2], fill_value=0)
        )
        entry["trainingClassDistribution"] = {
            name: int(training_counts.iloc[index])
            for index, name in enumerate(CLASS_ORDER)
        }
        entry["rolloutStatus"] = "shadow"
        entry["eligibleForActive"] = False
        entry["disableReasons"] = list(
            dict.fromkeys(
                [
                    *entry.get("disableReasons", []),
                    "prospective_shadow_required",
                    "independent_audit_required",
                ]
            )
        )
        horizon_entries[horizon] = entry
        reports[horizon] = {
            "direction": direction_report,
            "riskHeads": head_report,
            "featureSelection": selection_body,
            "historicalAuditClassification": "sealed_not_mounted",
            "historicalAuditMounted": False,
            "eligibleForActive": False,
        }
        checkpoint_path.write_text(
            json.dumps(
                {
                    "schema": "athena.crypto.forecast-training-checkpoint",
                    "schemaVersion": "4.0",
                    "horizon": horizon,
                    "entry": entry,
                    "report": reports[horizon],
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        print(
            json.dumps(
                {
                    "horizon": horizon,
                    "selectedFeatures": len(entry["featureNames"]),
                    "labelScheme": entry["labelScheme"],
                    "rolloutStatus": "shadow",
                }
            ),
            flush=True,
        )
    legacy, legacy_provenance = copy_legacy_horizons(
        args.legacy_model_root, args.output
    )
    horizon_entries.update(legacy)
    manifest = {
        "schema": "athena.crypto.forecast-model",
        "schemaVersion": "1.0",
        "modelVersion": args.model_version,
        "featureSchemaVersion": "crypto-forecast-features-v4",
        "featureRegistryVersion": REGISTRY["registryVersion"],
        "featureRegistrySha256": REGISTRY_SHA256,
        "runtimeParityRequired": True,
        "classOrder": CLASS_ORDER,
        "rolloutStatus": "shadow",
        "trainedAt": datetime.now(timezone.utc).isoformat(),
        "datasetManifestSha256": sha256_file(args.database),
        "costModelVersion": "crypto-cost-model-v3",
        "trainingPeriod": {
            "historicalDataClassification": "development_and_semi_blind_audit",
            "featureAndCandidateSelection": "2021-2023 expanding folds",
            "calibration": "2024-01-01 through 2024-06-30",
            "selectiveThreshold": "2024-07-01 through 2024-12-31",
            "historicalAudit": "sealed_not_mounted_during_training",
            "prospectiveEvidenceRequired": True,
            "purging": "label outcome must precede next split",
            "embargo": "one full prediction horizon",
        },
        "promotionPolicy": {
            "historicalAuditCannotActivate": True,
            "optimizedHorizons": list(OPTIMIZED_HORIZONS),
            "minimumSelectiveCoverage": 0.10,
            "selectiveAccuracyDelta": ">=0.05",
            "brierSkill": ">0",
            "ece": "<=0.05",
            "mcc": ">0",
            "costAdjustedBootstrapMeanLower95": ">0",
            "pbo": "<0.20",
            "deflatedSharpeConfidence": ">0.95",
            "onlineShadowDays": {"4h": 60, "24h": 120},
        },
        "legacyProvenance": legacy_provenance,
        "horizons": horizon_entries,
    }
    (args.output / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    report = {
        "schema": "athena.crypto.forecast-training-report",
        "schemaVersion": "4.0",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "modelVersion": args.model_version,
        "historicalAuditClassification": "sealed_not_mounted",
        "horizons": reports,
        "legacyHorizons": list(v3.LEGACY_HORIZONS),
    }
    (args.output / "training-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "output": str(args.output),
                "rolloutStatus": "shadow",
                "eligibleHorizons": [],
                "independentAuditRequired": True,
            }
        )
    )


if __name__ == "__main__":
    main()
