#!/usr/bin/env python3
"""Cross-runtime contract tests for Athena crypto forecasting."""

from __future__ import annotations

import json
import hashlib
import math
import subprocess
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd
from xgboost import XGBClassifier, XGBRegressor

import train
import train_v3
import train_v4
import independent_audit_v4 as independent_audit
from features_v4 import (
    HORIZON_FEATURE_NAMES as HORIZON_FEATURE_NAMES_V4,
    REGISTRY as REGISTRY_V4,
    REGISTRY_SHA256 as REGISTRY_SHA256_V4,
    stable_mrmr_selection,
)
from features_v3 import HORIZON_FEATURE_NAMES, feature_frame_v3
from backtest import MarketRules, event_simulation, sensitivity_report

REPO_ROOT = Path(__file__).resolve().parents[2]


def fixture_bars(count: int = 30 * 24 * 12 + 100) -> list[dict]:
    start = int(pd.Timestamp("2025-01-01", tz="UTC").timestamp() * 1_000)
    bars = []
    for index in range(count):
        close = 10_000 * math.exp(
            index * 0.000002 + math.sin(index / 53) * 0.0008
        )
        volume = 20 + index % 31
        taker_ratio = 0.45 + (index % 7) * 0.01
        open_time = start + index * 300_000
        bars.append(
            {
                "symbol": "BTC",
                "interval": "5m",
                "openTimeMs": open_time,
                "closeTimeMs": open_time + 299_999,
                "open": close * 0.9999,
                "high": close * 1.001,
                "low": close * 0.999,
                "close": close,
                "volume": volume,
                "quoteVolume": volume * close,
                "tradeCount": 100 + index % 23,
                "takerBuyBaseVolume": volume * taker_ratio,
                "takerBuyQuoteVolume": volume * close * taker_ratio,
                "source": "contract_fixture",
            }
        )
    return bars


def python_frame(bars: list[dict]) -> pd.DataFrame:
    frame = pd.DataFrame(bars).rename(
        columns={
            "openTimeMs": "open_time_ms",
            "closeTimeMs": "close_time_ms",
            "quoteVolume": "quote_volume",
            "tradeCount": "trade_count",
            "takerBuyBaseVolume": "taker_buy_base_volume",
            "takerBuyQuoteVolume": "taker_buy_quote_volume",
        }
    )
    frame["time"] = pd.to_datetime(frame["open_time_ms"], unit="ms", utc=True)
    return frame


class RuntimeContractTest(unittest.TestCase):
    def test_v4_registry_is_canonical_across_python_and_node(self) -> None:
        completed = subprocess.run(
            [
                "node",
                "-e",
                (
                    "process.stdout.write(require("
                    "'./server/utils/cryptoForecasting/contracts'"
                    ").FEATURE_REGISTRY_V4_SHA256)"
                ),
            ],
            cwd=REPO_ROOT,
            text=True,
            capture_output=True,
            check=True,
        )
        self.assertEqual(REGISTRY_SHA256_V4, completed.stdout)
        self.assertLessEqual(
            max(len(names) for names in HORIZON_FEATURE_NAMES_V4.values()),
            64,
        )

    def test_v4_fold_local_mrmr_enforces_model_input_budget(self) -> None:
        rng = np.random.default_rng(20260730)
        times = pd.date_range(
            "2021-01-01", "2024-01-01", freq="1D", tz="UTC", inclusive="left"
        )
        target = np.tile(np.arange(3), math.ceil(len(times) / 3))[: len(times)]
        frame = pd.DataFrame({"time": times, "label": target})
        feature_names = [f"feature_{index}" for index in range(24)]
        for index, name in enumerate(feature_names):
            frame[name] = (
                target * (0.03 if index < 4 else 0)
                + rng.normal(0, 1, len(frame))
            )
        selected, report = stable_mrmr_selection(frame, feature_names)
        self.assertGreaterEqual(len(selected), 8)
        self.assertLessEqual(len(selected), 20)
        self.assertEqual(report["maximumModelInputs"], 20)
        self.assertTrue(set(selected).issubset(feature_names))

    def test_v4_risk_heads_have_explicit_volatility_inputs(self) -> None:
        for horizon in train_v4.OPTIMIZED_HORIZONS:
            entry = REGISTRY_V4["horizons"][horizon]
            required = {
                name
                for names in entry["headRequiredFeatures"].values()
                for name in names
            }
            self.assertTrue(required)
            self.assertTrue(
                required.issubset(entry["candidateFeatures"])
            )
            self.assertTrue(
                any(name.startswith("realized_vol_") for name in required)
            )

    def test_independent_cost_recalculation_uses_aligned_trade_dates(self) -> None:
        values = np.asarray([np.nan, 0.02, np.nan, -0.01, 0.03])
        decisions = np.asarray(
            [
                1 * 86_400_000,
                10 * 86_400_000,
                11 * 86_400_000,
                20 * 86_400_000,
                30 * 86_400_000,
            ],
            dtype=np.int64,
        )
        metrics = independent_audit.trading_metrics(values, decisions)
        self.assertEqual(metrics["signals"], 3)
        self.assertAlmostEqual(metrics["meanNetReturn"], 0.04 / 3)

    def test_independent_v2_proxy_requires_two_confirming_trends(self) -> None:
        rising = [
            {"close": 100 + index * 0.1} for index in range(289)
        ]
        falling = [
            {"close": 200 - index * 0.1} for index in range(289)
        ]
        self.assertEqual(
            independent_audit.independent_crypto_quant_v2(rising), "up"
        )
        self.assertEqual(
            independent_audit.independent_crypto_quant_v2(falling), "down"
        )

    def test_v4_label_promotion_rule_is_not_mutable_during_audit(self) -> None:
        source = Path(independent_audit.__file__).read_text("utf-8")
        self.assertNotIn("import train", source)
        self.assertNotIn("import features", source)
        self.assertNotIn("import backtest", source)
        self.assertIn("historical_semi_blind", source)
        self.assertEqual(train_v4.OPTIMIZED_HORIZONS, ("4h", "24h"))

    def test_independent_auditor_applies_holm_correction(self) -> None:
        corrected = independent_audit.holm_bonferroni(
            {
                "strong": {"pValue": 0.001, "candidateBetter": True},
                "weak": {"pValue": 0.06, "candidateBetter": True},
                "missing": {"pValue": None, "candidateBetter": False},
            }
        )
        self.assertTrue(corrected["strong"]["holmRejected"])
        self.assertAlmostEqual(
            corrected["strong"]["holmAdjustedPValue"], 0.002
        )
        self.assertFalse(corrected["weak"]["holmRejected"])
        self.assertIsNone(corrected["missing"]["holmAdjustedPValue"])

    def test_independent_auditor_matches_javascript_number_canonicalization(
        self,
    ) -> None:
        vector = [7.058092556566642e-05, 0, -1.2e-07]
        self.assertEqual(
            independent_audit.javascript_canonical_json(vector),
            "[0.00007058092556566642,0,-1.2e-7]",
        )

    def test_v4_training_rejects_mounted_historical_audit_rows(self) -> None:
        safe = pd.DataFrame(
            {"time": [pd.Timestamp("2024-12-31T23:55:00Z")]}
        )
        train_v4.assert_sealed_training_domain(safe)
        unsafe = pd.DataFrame(
            {"time": [pd.Timestamp("2025-01-01T00:00:00Z")]}
        )
        with self.assertRaisesRegex(
            RuntimeError,
            "sealed_training_snapshot_contains_audit_domain",
        ):
            train_v4.assert_sealed_training_domain(unsafe)

    def test_v4_can_preserve_v3_legacy_per_horizon_contracts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "legacy"
            output = Path(directory) / "output"
            root.mkdir()
            output.mkdir()
            horizons = {}
            for horizon in train_v3.LEGACY_HORIZONS:
                artifact = f"{horizon}.onnx"
                payload = f"fixture:{horizon}".encode()
                (root / artifact).write_bytes(payload)
                horizons[horizon] = {
                    "artifact": artifact,
                    "artifactSha256": hashlib.sha256(payload).hexdigest(),
                    "featureNames": ["return_24h"],
                    "featureRegistrySha256": "registry-per-horizon",
                }
            (root / "manifest.json").write_text(
                json.dumps(
                    {
                        "modelVersion": "v3-fixture",
                        "featureRegistrySha256": "v3-top-level",
                        "horizons": horizons,
                    }
                ),
                "utf-8",
            )
            copied, _ = train_v3.copy_legacy_horizons(root, output)
            for entry in copied.values():
                self.assertEqual(entry["featureNames"], ["return_24h"])
                self.assertEqual(
                    entry["featureRegistrySha256"],
                    "registry-per-horizon",
                )

    def test_purged_splits_use_horizon_embargo_and_no_label_overlap(self):
        times = pd.date_range(
            "2023-12-01", "2026-01-01", freq="1h", tz="UTC"
        )
        frame = pd.DataFrame(
            {
                "time": times,
                "outcome_time": times + pd.Timedelta(hours=4),
            }
        )
        splits = train.purged_splits(
            frame,
            "4h",
            pd.Timestamp("2025-12-01", tz="UTC"),
        )
        self.assertLess(
            splits["train"]["outcome_time"].max(),
            pd.Timestamp("2024-01-01", tz="UTC"),
        )
        self.assertGreaterEqual(
            splits["selection"]["time"].min(),
            pd.Timestamp("2024-01-01T04:00:00Z"),
        )
        self.assertLess(
            splits["selection"]["outcome_time"].max(),
            pd.Timestamp("2024-07-01", tz="UTC"),
        )

    def test_event_simulator_rejects_overlap_and_applies_market_rules(self):
        frame = pd.DataFrame(
            [
                {
                    "symbol": "BTC",
                    "horizon": "4h",
                    "decision_time": "2026-01-01T00:00:00Z",
                    "outcome_time": "2026-01-01T04:00:00Z",
                    "predicted_state": "up",
                    "abstained": False,
                    "entry_open": 100.0,
                    "exit_close": 110.0,
                },
                {
                    "symbol": "BTC",
                    "horizon": "4h",
                    "decision_time": "2026-01-01T01:00:00Z",
                    "outcome_time": "2026-01-01T05:00:00Z",
                    "predicted_state": "up",
                    "abstained": False,
                    "entry_open": 105.0,
                    "exit_close": 115.0,
                },
            ]
        )
        report = event_simulation(
            frame,
            rules=MarketRules(0.01, 0.0001, 5.0),
            slippage_bps=20,
        )
        self.assertEqual(report["signals"], 1)
        self.assertEqual(report["rejects"]["position_already_open"], 1)
        self.assertEqual(report["fillModelReason"], "fill_model_unavailable")

    def test_fine_event_layer_cannot_outperform_vectorized_screen(self):
        frame = pd.DataFrame(
            [
                {
                    "symbol": "ETH",
                    "horizon": "24h",
                    "decision_time": "2026-01-01T00:00:00Z",
                    "outcome_time": "2026-01-02T00:00:00Z",
                    "predicted_state": "down",
                    "abstained": False,
                    "entry_open": 100.0,
                    "exit_close": 90.0,
                    "funding_cost_usdt": 0.1,
                }
            ]
        )
        report = sensitivity_report(
            frame,
            rules=MarketRules(0.01, 0.001, 5.0),
        )
        self.assertTrue(report["integrity"]["passed"])
        self.assertEqual(
            set(report["event"]), {"2.0", "5.0", "10.0", "20.0"}
        )

    def test_v3_short_backtest_uses_perpetual_prices_and_funding(self):
        frame = pd.DataFrame(
            [
                {
                    "symbol": "BTC",
                    "horizon": "4h",
                    "decision_time": "2026-01-01T00:00:00Z",
                    "outcome_time": "2026-01-01T04:00:00Z",
                    "predicted_state": "down",
                    "abstained": False,
                    "entry_open": 100.0,
                    "exit_close": 120.0,
                    "short_entry_open": 100.0,
                    "short_exit_close": 90.0,
                    "short_execution_ready": True,
                    "funding_cost_ratio": -0.001,
                }
            ]
        )
        report = sensitivity_report(
            frame,
            rules=MarketRules(0.01, 0.0001, 5.0),
            slippage_grid=(2,),
            require_perp_short=True,
        )
        vectorized = report["vectorized"]["2.0"]
        event = report["event"]["2.0"]
        self.assertGreater(vectorized["meanNetReturn"], 0.09)
        self.assertEqual(event["signals"], 1)
        self.assertLess(event["trades"][0]["fundingUsdt"], 0)
        self.assertGreater(event["trades"][0]["netReturn"], 0.09)

    def test_horizon_samples_preserve_finite_persistence_baseline(self) -> None:
        bars = fixture_bars(30 * 24 * 12 + train.HORIZONS["4h"]["bars"] + 200)
        samples = train.samples_for_horizon(
            train.feature_frame(python_frame(bars)),
            "4h",
        )
        self.assertFalse(samples.empty)
        self.assertIn("one_bar_return", samples.columns)
        self.assertTrue(
            np.isfinite(samples["one_bar_return"].to_numpy(dtype=float)).all()
        )
        predictions = train.baseline_predictions(samples, "4h", 1)
        self.assertEqual(set(predictions), {
            "majority",
            "pricePersistence",
            "simpleMomentum",
            "cryptoQuantV2Proxy",
        })
        self.assertTrue(
            all(len(values) == len(samples) for values in predictions.values())
        )

    def test_probability_guard_rejects_non_finite_output(self) -> None:
        class InvalidModel:
            def predict_proba(self, _features):
                return np.asarray([[np.nan, 0.5, 0.5]])

        with self.assertRaisesRegex(
            RuntimeError,
            "model_probabilities_invalid",
        ):
            train.finite_predict_proba(
                InvalidModel(),
                np.zeros((1, len(train.FEATURE_NAMES))),
            )

    def test_python_and_node_features_match(self) -> None:
        bars = fixture_bars()
        python_values = (
            train.feature_frame(python_frame(bars))
            .sort_values("time")
            .iloc[-1]
        )
        script = """
const fs = require("node:fs");
const { buildFeatureVector } = require(
  "./server/utils/cryptoForecasting/features"
);
const bars = JSON.parse(fs.readFileSync(0, "utf8"));
const result = buildFeatureVector({
  symbol: "BTC",
  bars,
  btcBars: bars,
  asOfMs: bars.at(-1).closeTimeMs,
});
process.stdout.write(JSON.stringify(result.values));
"""
        completed = subprocess.run(
            ["node", "-e", script],
            cwd=REPO_ROOT,
            input=json.dumps(bars),
            text=True,
            capture_output=True,
            check=True,
        )
        node_values = json.loads(completed.stdout)
        for name in train.FEATURE_NAMES:
            self.assertTrue(math.isfinite(float(python_values[name])), name)
            self.assertAlmostEqual(
                float(python_values[name]),
                float(node_values[name]),
                delta=2e-5,
                msg=name,
            )

    def test_v3_python_and_node_features_match_by_horizon(self) -> None:
        market: dict[str, list[dict]] = {}
        frames = []
        for offset, symbol in enumerate(["BTC", "ETH", "SOL"], start=1):
            values = fixture_bars(30 * 24 * 12 + 1_000)
            for index, bar in enumerate(values):
                multiplier = 1 + offset * 0.3
                wave = 1 + math.sin(index / (41 + offset)) * 0.0003 * offset
                for field in ["open", "high", "low", "close"]:
                    bar[field] *= multiplier * wave
                bar["quoteVolume"] = bar["volume"] * bar["close"]
                bar["takerBuyQuoteVolume"] = (
                    bar["takerBuyBaseVolume"] * bar["close"]
                )
                bar["symbol"] = symbol
            market[symbol] = values
            frames.append(python_frame(values))
        python_values = (
            feature_frame_v3(pd.concat(frames, ignore_index=True))
            .loc[lambda value: value["symbol"].eq("BTC")]
            .sort_values("time")
            .iloc[-1]
        )
        script = """
const fs = require("node:fs");
const { buildFeatureVectorV3 } = require(
  "./server/utils/cryptoForecasting/features"
);
const market = JSON.parse(fs.readFileSync(0, "utf8"));
const result = {};
for (const horizon of ["4h", "24h"]) {
  result[horizon] = buildFeatureVectorV3({
    horizon,
    symbol: "BTC",
    bars: market.BTC,
    marketBarsBySymbol: market,
    asOfMs: market.BTC.at(-1).closeTimeMs,
  }).values;
}
process.stdout.write(JSON.stringify(result));
"""
        completed = subprocess.run(
            ["node", "-e", script],
            cwd=REPO_ROOT,
            input=json.dumps(market),
            text=True,
            capture_output=True,
            check=True,
        )
        node_values = json.loads(completed.stdout)
        for horizon, names in HORIZON_FEATURE_NAMES.items():
            for name in names:
                self.assertTrue(math.isfinite(float(python_values[name])), name)
                self.assertAlmostEqual(
                    float(python_values[name]),
                    float(node_values[horizon][name]),
                    delta=2e-4,
                    msg=f"{horizon}:{name}",
                )

    def test_v3_candidate_budget_and_probability_composition(self) -> None:
        self.assertEqual(len(train_v3.candidate_configs()), 12)
        combined = train_v3.combine_probabilities(
            np.asarray([0.6]), np.asarray([0.75])
        )
        np.testing.assert_allclose(combined, [[0.15, 0.4, 0.45]], atol=1e-12)
        np.testing.assert_allclose(combined.sum(axis=1), [1.0], atol=1e-12)

    def test_v3_cost_contract_uses_spot_for_long_and_perpetual_for_short(self):
        frame = pd.DataFrame(
            {
                "forward_return": [math.log(1.10), math.log(0.95), math.log(0.95)],
                "short_execution_ready": [True, True, False],
                "short_entry_open": [100.0, 100.0, np.nan],
                "short_exit_close": [90.0, 90.0, np.nan],
                "funding_cost_ratio": [0.0, -0.001, np.nan],
            }
        )
        result = train_v3.cost_adjusted_returns(
            frame, np.asarray([2, 0, 0])
        )
        self.assertAlmostEqual(result[0], 0.10 - train.ROUND_TRIP_COST_RATIO)
        self.assertAlmostEqual(
            result[1],
            (100 - 90) / 100 - train.ROUND_TRIP_COST_RATIO + 0.001,
        )
        self.assertTrue(np.isnan(result[2]))

    def test_xgboost_onnx_matches_node_runtime(self) -> None:
        rng = np.random.default_rng(20260729)
        features = rng.normal(
            size=(900, len(train.FEATURE_NAMES))
        ).astype(np.float32)
        labels = np.tile(np.arange(3), 300)
        rng.shuffle(labels)
        model = XGBClassifier(
            objective="multi:softprob",
            num_class=3,
            n_estimators=12,
            max_depth=2,
            n_jobs=1,
            random_state=20260729,
        ).fit(features, labels)
        expected = model.predict_proba(features[:1])[0]
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "model.onnx"
            input_name, output_name = train.export_onnx(
                model, "xgboost", artifact
            )
            script = """
const fs = require("node:fs");
const ort = require("./server/node_modules/onnxruntime-node");
(async () => {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  const session = await ort.InferenceSession.create(input.artifact);
  const outputs = await session.run({
    [input.inputName]: new ort.Tensor(
      "float32",
      Float32Array.from(input.vector),
      [1, input.vector.length]
    ),
  });
  process.stdout.write(JSON.stringify(Array.from(outputs[input.outputName].data)));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
"""
            completed = subprocess.run(
                ["node", "-e", script],
                cwd=REPO_ROOT,
                input=json.dumps(
                    {
                        "artifact": str(artifact),
                        "inputName": input_name,
                        "outputName": output_name,
                        "vector": features[0].astype(float).tolist(),
                    }
                ),
                text=True,
                capture_output=True,
                check=True,
            )
            actual = np.asarray(json.loads(completed.stdout))
        self.assertLess(float(np.max(np.abs(expected - actual))), 1e-5)

    def test_quantile_regressor_onnx_matches_node_runtime(self) -> None:
        rng = np.random.default_rng(20260729)
        features = rng.normal(
            size=(600, len(train.FEATURE_NAMES))
        ).astype(np.float32)
        target = features[:, 3] * 0.01 + features[:, 8] * 0.005
        model = XGBRegressor(
            objective="reg:quantileerror",
            quantile_alpha=0.5,
            n_estimators=16,
            max_depth=2,
            min_child_weight=8,
            tree_method="hist",
            n_jobs=1,
            random_state=20260729,
        ).fit(features, target)
        expected = float(model.predict(features[:1])[0])
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "quantile.onnx"
            entry = train_v4.scalar_artifact_entry(
                model, artifact, features[0]
            )
            input_name = entry["inputName"]
            output_name = entry["outputName"]
            script = """
const fs = require("node:fs");
const ort = require("./server/node_modules/onnxruntime-node");
(async () => {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  const session = await ort.InferenceSession.create(input.artifact);
  const outputs = await session.run({
    [input.inputName]: new ort.Tensor(
      "float32",
      Float32Array.from(input.vector),
      [1, input.vector.length]
    ),
  });
  process.stdout.write(JSON.stringify(Number(outputs[input.outputName].data[0])));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
"""
            completed = subprocess.run(
                ["node", "-e", script],
                cwd=REPO_ROOT,
                input=json.dumps(
                    {
                        "artifact": str(artifact),
                        "inputName": input_name,
                        "outputName": output_name,
                        "vector": features[0].astype(float).tolist(),
                    }
                ),
                text=True,
                capture_output=True,
                check=True,
            )
            actual = float(json.loads(completed.stdout))
        self.assertLess(abs(expected - actual), 1e-5)


if __name__ == "__main__":
    unittest.main()
