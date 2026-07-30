"""Resolved v5 feature and label contracts for the cost-adjusted 4h model."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from features_v4 import (
    FEATURE_FAMILIES as V4_FEATURE_FAMILIES,
    REGISTRY as V4_REGISTRY,
    feature_family_indexes,
    feature_frame_v3,
    stable_mrmr_selection,
)

ROOT = Path(__file__).resolve().parents[2]
REGISTRY_PATH = (
    ROOT
    / "server"
    / "utils"
    / "cryptoForecasting"
    / "contracts"
    / "feature-registry-v5.json"
)
SOURCE_REGISTRY = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))


def canonical_sha256(value: object) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


def resolved_registry() -> dict:
    if (
        SOURCE_REGISTRY.get("inheritsRegistryVersion")
        != V4_REGISTRY["registryVersion"]
    ):
        raise RuntimeError("feature_registry_v5_parent_mismatch")
    horizons = {}
    for horizon in ("4h", "24h"):
        inherited = V4_REGISTRY["horizons"][horizon]
        override = SOURCE_REGISTRY["horizons"].get(horizon, {})
        horizons[horizon] = {
            **inherited,
            **override,
            "features": list(inherited["features"]),
            "candidateFeatures": list(inherited["features"]),
        }
    return {
        **V4_REGISTRY,
        **SOURCE_REGISTRY,
        "inheritsRegistrySha256": canonical_sha256(V4_REGISTRY),
        "horizons": horizons,
        "featureDefinitions": dict(V4_REGISTRY["featureDefinitions"]),
        "supportingFeatures": dict(V4_REGISTRY.get("supportingFeatures", {})),
    }


REGISTRY = resolved_registry()
REGISTRY_SHA256 = canonical_sha256(REGISTRY)
HORIZON_FEATURE_NAMES = {
    horizon: list(entry["features"])
    for horizon, entry in REGISTRY["horizons"].items()
}
FEATURE_FAMILIES = dict(V4_FEATURE_FAMILIES)
SIDE_MAXIMUM_INPUTS = int(
    REGISTRY["selectionContract"]["maximumSideInputs"]
)
META_MAXIMUM_INPUTS = int(
    REGISTRY["selectionContract"]["maximumMetaInputs"]
)
META_CANDIDATE_FEATURES = list(
    REGISTRY["horizons"]["4h"]["metaCandidateFeatures"]
)
DERIVED_META_FEATURES = list(
    REGISTRY["horizons"]["4h"]["derivedMetaFeatures"]
)
LABEL_CONTRACT = dict(REGISTRY["labelContract"])


__all__ = [
    "DERIVED_META_FEATURES",
    "FEATURE_FAMILIES",
    "HORIZON_FEATURE_NAMES",
    "LABEL_CONTRACT",
    "META_CANDIDATE_FEATURES",
    "META_MAXIMUM_INPUTS",
    "REGISTRY",
    "REGISTRY_SHA256",
    "SIDE_MAXIMUM_INPUTS",
    "feature_family_indexes",
    "feature_frame_v3",
    "stable_mrmr_selection",
]
