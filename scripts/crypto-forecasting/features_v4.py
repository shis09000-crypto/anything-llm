"""Resolved v4 feature contract and fold-local selection helpers."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.feature_selection import mutual_info_classif

from features_v3 import (
    FEATURE_FAMILIES as V3_FEATURE_FAMILIES,
    REGISTRY as V3_REGISTRY,
    feature_frame_v3,
)

ROOT = Path(__file__).resolve().parents[2]
REGISTRY_PATH = (
    ROOT
    / "server"
    / "utils"
    / "cryptoForecasting"
    / "contracts"
    / "feature-registry-v4.json"
)
SOURCE_REGISTRY = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))


def resolved_registry() -> dict:
    if (
        SOURCE_REGISTRY.get("inheritsRegistryVersion")
        != V3_REGISTRY["registryVersion"]
    ):
        raise RuntimeError("feature_registry_v4_parent_mismatch")
    definitions = dict(V3_REGISTRY["featureDefinitions"])
    for name, definition in SOURCE_REGISTRY.get(
        "supportingFeatures", {}
    ).items():
        definitions[name] = {
            "family": definition["family"],
            "lookbackBars": 0,
            "dependencies": definition.get("sources", []),
            "nullPolicy": "unavailable_with_explicit_mask",
            "range": [-1_000_000_000_000, 1_000_000_000_000],
            "role": "supporting_only",
            **definition,
        }
    parent_sha = hashlib.sha256(
        json.dumps(
            V3_REGISTRY,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    return {
        **SOURCE_REGISTRY,
        "inheritsRegistrySha256": parent_sha,
        "horizons": {
            horizon: {
                **entry,
                "features": list(entry["candidateFeatures"]),
            }
            for horizon, entry in SOURCE_REGISTRY["horizons"].items()
        },
        "featureDefinitions": definitions,
    }


REGISTRY = resolved_registry()
REGISTRY_SHA256 = hashlib.sha256(
    json.dumps(
        REGISTRY,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
).hexdigest()
HORIZON_FEATURE_NAMES = {
    horizon: list(entry["features"])
    for horizon, entry in REGISTRY["horizons"].items()
}
FEATURE_FAMILIES = {
    name: definition["family"]
    for name, definition in REGISTRY["featureDefinitions"].items()
}
MAXIMUM_MODEL_INPUTS = int(
    REGISTRY["selectionContract"]["maximumModelInputsPerHead"]
)


def _chronological_selection_folds(
    frame: pd.DataFrame,
) -> list[tuple[pd.DataFrame, pd.DataFrame]]:
    boundaries = (
        ("2022-01-01", "2022-07-01"),
        ("2022-07-01", "2023-01-01"),
        ("2023-01-01", "2023-07-01"),
        ("2023-07-01", "2024-01-01"),
    )
    folds = []
    for start, end in boundaries:
        train = frame.loc[frame["time"] < start]
        validation = frame.loc[
            (frame["time"] >= start) & (frame["time"] < end)
        ]
        if len(train) >= 200 and len(validation) >= 100:
            folds.append((train, validation))
    return folds


def stable_mrmr_selection(
    frame: pd.DataFrame,
    feature_names: list[str],
    *,
    target: str = "label",
    maximum: int = MAXIMUM_MODEL_INPUTS,
    minimum_fold_ratio: float = 0.7,
) -> tuple[list[str], dict]:
    """Select stable features without fitting preprocessing on future folds."""

    folds = _chronological_selection_folds(frame)
    if not folds:
        raise RuntimeError("feature_selection_folds_missing")
    selection_counts = {name: 0 for name in feature_names}
    fold_reports = []
    per_fold_limit = min(maximum, len(feature_names))
    for fold_index, (train, _) in enumerate(folds):
        sample = train[feature_names].replace([np.inf, -np.inf], np.nan)
        medians = sample.median()
        x = sample.fillna(medians).to_numpy(dtype=np.float64)
        y = train[target].to_numpy(dtype=int)
        if len(x) > 80_000:
            step = max(1, len(x) // 80_000)
            x = x[::step]
            y = y[::step]
        relevance = mutual_info_classif(
            x,
            y,
            discrete_features=False,
            random_state=20260730 + fold_index,
        )
        correlation = (
            pd.DataFrame(x, columns=feature_names).corr(method="spearman").abs()
        )
        selected: list[str] = []
        available = set(feature_names)
        while available and len(selected) < per_fold_limit:
            candidate = max(
                available,
                key=lambda name: float(relevance[feature_names.index(name)])
                - (
                    max(
                        float(correlation.loc[name, prior])
                        for prior in selected
                    )
                    if selected
                    else 0
                ),
            )
            selected.append(candidate)
            available.remove(candidate)
        for name in selected:
            selection_counts[name] += 1
        fold_reports.append(
            {
                "fold": fold_index,
                "trainThrough": train["time"].max().isoformat(),
                "selected": selected,
            }
        )
    required = max(1, int(np.ceil(len(folds) * minimum_fold_ratio)))
    stable = [
        name for name in feature_names if selection_counts[name] >= required
    ]
    if len(stable) > maximum:
        stable.sort(
            key=lambda name: (
                selection_counts[name],
                -feature_names.index(name),
            ),
            reverse=True,
        )
        stable = stable[:maximum]
        stable.sort(key=feature_names.index)
    if len(stable) < 8:
        ranked = sorted(
            feature_names,
            key=lambda name: (
                selection_counts[name],
                -feature_names.index(name),
            ),
            reverse=True,
        )[: min(maximum, max(8, len(stable)))]
        stable = sorted(set(stable) | set(ranked), key=feature_names.index)[
            :maximum
        ]
    return stable, {
        "method": "fold_local_mrmr_v1",
        "folds": fold_reports,
        "selectionCounts": selection_counts,
        "requiredFolds": required,
        "selected": stable,
        "maximumModelInputs": maximum,
    }


def feature_family_indexes(names: list[str]) -> dict[str, list[int]]:
    result: dict[str, list[int]] = {}
    for index, name in enumerate(names):
        result.setdefault(FEATURE_FAMILIES[name], []).append(index)
    return result


__all__ = [
    "FEATURE_FAMILIES",
    "HORIZON_FEATURE_NAMES",
    "MAXIMUM_MODEL_INPUTS",
    "REGISTRY",
    "REGISTRY_SHA256",
    "feature_family_indexes",
    "feature_frame_v3",
    "stable_mrmr_selection",
]
