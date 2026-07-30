#!/usr/bin/env python3
"""Focused contracts for the v5 cost-aware first-touch policy."""

from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

import independent_audit_v5 as independent_audit
from labels_v5 import (
    HORIZON_BARS,
    MINIMUM_BARRIER_RATIO,
    _funding_cost,
    first_touch_outcome,
)


def window() -> tuple[pd.DataFrame, pd.DataFrame]:
    times = np.arange(HORIZON_BARS, dtype=np.int64) * 300_000
    spot = pd.DataFrame(
        {
            "open_time_ms": times,
            "open": np.full(HORIZON_BARS, 100.0),
            "high": np.full(HORIZON_BARS, 100.1),
            "low": np.full(HORIZON_BARS, 99.9),
            "close": np.full(HORIZON_BARS, 100.0),
        }
    )
    contract = spot.copy()
    return spot, contract


class CostFirstTouchV5Test(unittest.TestCase):
    def test_first_upper_touch_wins(self) -> None:
        spot, contract = window()
        spot.loc[3, "high"] = 101.0
        contract.loc[8, "low"] = 99.0
        result = first_touch_outcome(
            spot, contract, barrier_ratio=math.log(1.005)
        )
        self.assertEqual(result["event"], "up")
        self.assertEqual(result["touchOffsetBars"], 4)

    def test_first_lower_touch_wins(self) -> None:
        spot, contract = window()
        contract.loc[2, "low"] = 99.0
        spot.loc[7, "high"] = 101.0
        result = first_touch_outcome(
            spot, contract, barrier_ratio=math.log(1.005)
        )
        self.assertEqual(result["event"], "down")
        self.assertEqual(result["touchOffsetBars"], 3)

    def test_same_bar_double_touch_is_ambiguous(self) -> None:
        spot, contract = window()
        spot.loc[5, "high"] = 101.0
        contract.loc[5, "low"] = 99.0
        result = first_touch_outcome(
            spot, contract, barrier_ratio=math.log(1.005)
        )
        self.assertEqual(result["event"], "ambiguous")
        self.assertEqual(result["touchOffsetBars"], 6)

    def test_timeout_is_no_trade(self) -> None:
        spot, contract = window()
        result = first_touch_outcome(
            spot, contract, barrier_ratio=math.log(1.005)
        )
        self.assertEqual(result["event"], "no_trade")
        self.assertIsNone(result["touchOffsetBars"])

    def test_barrier_floor_covers_round_trip_cost_and_buffer(self) -> None:
        self.assertAlmostEqual(MINIMUM_BARRIER_RATIO, 0.0035)

    def test_funding_is_not_imputed_when_history_does_not_cover_window(
        self,
    ) -> None:
        entry = 1_000_000_000
        exit_ms = entry + 4 * 3_600_000
        missing = pd.DataFrame(
            {
                "calc_time_ms": [entry + 9 * 3_600_000],
                "funding_rate": [0.0001],
            }
        )
        value, covered = _funding_cost(missing, entry, exit_ms)
        self.assertFalse(covered)
        self.assertTrue(math.isnan(value))

    def test_short_receives_positive_funding(self) -> None:
        entry = 1_000_000_000
        exit_ms = entry + 4 * 3_600_000
        funding = pd.DataFrame(
            {
                "calc_time_ms": [entry, entry + 2 * 3_600_000],
                "funding_rate": [0.0002, 0.0001],
            }
        )
        value, covered = _funding_cost(funding, entry, exit_ms)
        self.assertTrue(covered)
        self.assertAlmostEqual(value, -0.0001)

    def test_independent_auditor_does_not_share_training_or_label_code(
        self,
    ) -> None:
        source = Path(independent_audit.__file__).read_text("utf-8")
        for module in ("train", "features", "labels", "backtest"):
            self.assertNotIn(f"\nimport {module}", source)
            self.assertNotIn(f"\nfrom {module}", source)
        self.assertIn("historical_semi_blind", source)

    def test_independent_execution_cost_is_slippage_sensitive(self) -> None:
        outcome = {
            "valid": True,
            "barrier": math.log(1.01),
            "event": "up",
            "spotEntry": 100,
            "spotTimeoutExit": 101,
            "shortEntry": 100,
            "shortTimeoutExit": 99,
            "funding": 0,
        }
        low = independent_audit.execution_return(outcome, "up", 2)
        high = independent_audit.execution_return(outcome, "up", 20)
        self.assertIsNotNone(low)
        self.assertIsNotNone(high)
        self.assertGreater(low, high)
        self.assertAlmostEqual(low - high, 0.0036)


if __name__ == "__main__":
    unittest.main()
