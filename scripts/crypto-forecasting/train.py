#!/usr/bin/env python3
"""Train and evaluate Athena's read-only public crypto forecast models."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sqlite3
import tempfile
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.optimize import minimize
from sklearn.compose import ColumnTransformer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    brier_score_loss,
    f1_score,
    matthews_corrcoef,
    mean_absolute_error,
    mean_pinball_loss,
)
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from xgboost import XGBClassifier, XGBRegressor
from backtest import MarketRules, sensitivity_report

FEATURE_REGISTRY_PATH = (
    Path(__file__).resolve().parents[1]
    / ".."
    / "server"
    / "utils"
    / "cryptoForecasting"
    / "contracts"
    / "feature-registry-v2.json"
).resolve()
FEATURE_REGISTRY = json.loads(FEATURE_REGISTRY_PATH.read_text(encoding="utf-8"))
FEATURE_NAMES = [
    feature["name"]
    for feature in FEATURE_REGISTRY["features"]
    if feature["status"] == "model_input"
]
FEATURE_REGISTRY_SHA256 = hashlib.sha256(
    json.dumps(
        FEATURE_REGISTRY,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
).hexdigest()
CLASS_ORDER = ["down", "range", "up"]
HORIZONS = {
    "4h": {"bars": 48, "anchor": "hourly", "block_days": 1},
    "24h": {"bars": 288, "anchor": "hourly", "block_days": 2},
    "4d": {"bars": 1_152, "anchor": "daily", "block_days": 4},
    "12d": {"bars": 3_456, "anchor": "daily", "block_days": 12},
    "24d": {"bars": 6_912, "anchor": "daily", "block_days": 24},
}
ROUND_TRIP_COST_RATIO = 0.0024
FIVE_MINUTES = pd.Timedelta(minutes=5)
EMBARGO = pd.Timedelta(days=24)
QUANTILES = (0.10, 0.50, 0.90)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_bars(database: Path) -> pd.DataFrame:
    with sqlite3.connect(
        f"file:{database}?mode=ro&immutable=1", uri=True
    ) as connection:
        frame = pd.read_sql_query(
            """
            SELECT symbol, open_time_ms, close_time_ms, open, high, low, close,
                   volume, quote_volume, trade_count,
                   taker_buy_base_volume, taker_buy_quote_volume,
                   COALESCE(available_at_ms, close_time_ms + 1)
                     AS available_at_ms
            FROM market_bars
            WHERE interval = '5m' AND symbol IN ('BTC', 'ETH', 'SOL')
            ORDER BY symbol, open_time_ms
            """,
            connection,
        )
    if frame.empty:
        raise RuntimeError("no_5m_market_bars")
    frame["time"] = pd.to_datetime(frame["open_time_ms"], unit="ms", utc=True)
    frame = frame.loc[
        frame["available_at_ms"] <= frame["close_time_ms"] + 1
    ].copy()
    frame = frame.drop_duplicates(["symbol", "open_time_ms"], keep="last")
    return frame


def rolling_regression(series: pd.Series, window: int) -> tuple[pd.Series, pd.Series]:
    values = series.astype(float)
    index = pd.Series(
        np.arange(len(values), dtype=float),
        index=values.index,
    )
    sum_y = values.rolling(window).sum()
    sum_y2 = values.pow(2).rolling(window).sum()
    sum_global_xy = values.mul(index).rolling(window).sum()
    window_start = index - (window - 1)
    sum_x = window * (window - 1) / 2
    sum_x2 = window * (window - 1) * (2 * window - 1) / 6
    denominator_x = sum_x2 - sum_x**2 / window
    sum_local_xy = sum_global_xy - window_start * sum_y
    covariance_numerator = sum_local_xy - sum_x * sum_y / window
    raw_slope = covariance_numerator / denominator_x
    mean = sum_y / window
    slope_pct = 100 * raw_slope / mean.replace(0, np.nan)
    denominator_y = sum_y2 - sum_y.pow(2) / window
    r_squared = covariance_numerator.pow(2) / (
        denominator_x * denominator_y.replace(0, np.nan)
    )
    r_squared = r_squared.clip(lower=0, upper=1).where(
        denominator_y.ne(0), 1.0
    )
    return slope_pct, r_squared


def efficiency_ratio(series: pd.Series, window: int) -> pd.Series:
    direction = series.diff(window).abs()
    path = series.diff().abs().rolling(window).sum()
    return direction / path.replace(0, np.nan)


def wilder_rsi(series: pd.Series, period: int = 14) -> pd.Series:
    change = series.diff()
    gain = change.clip(lower=0)
    loss = -change.clip(upper=0)
    average_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    average_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    ratio = average_gain / average_loss.replace(0, np.nan)
    result = 100 - 100 / (1 + ratio)
    return result.where(~((average_gain == 0) & (average_loss == 0)), 50).fillna(
        average_loss.eq(0).astype(float) * 100
    )


def hourly_money_flow(symbol: pd.DataFrame) -> pd.DataFrame:
    hourly = (
        symbol.set_index("time")
        .resample("1h", label="left", closed="left")
        .agg(
            open=("open", "first"),
            high=("high", "max"),
            low=("low", "min"),
            close=("close", "last"),
            volume=("volume", "sum"),
        )
        .dropna()
    )
    spread = (hourly["high"] - hourly["low"]).replace(0, np.nan)
    multiplier = (
        (hourly["close"] - hourly["low"]) - (hourly["high"] - hourly["close"])
    ) / spread
    money_flow_volume = multiplier.fillna(0) * hourly["volume"]
    hourly["cmf20_1h"] = money_flow_volume.rolling(20).sum() / hourly[
        "volume"
    ].rolling(20).sum().replace(0, np.nan)
    typical = (hourly["high"] + hourly["low"] + hourly["close"]) / 3
    raw_flow = typical * hourly["volume"]
    positive = raw_flow.where(typical.diff() > 0, 0).rolling(14).sum()
    negative = raw_flow.where(typical.diff() < 0, 0).rolling(14).sum()
    ratio = positive / negative.replace(0, np.nan)
    hourly["mfi14_1h"] = 100 - 100 / (1 + ratio)
    hourly.loc[(negative == 0) & (positive > 0), "mfi14_1h"] = 100
    hourly.loc[(negative == 0) & (positive == 0), "mfi14_1h"] = 50
    hourly["rsi14_1h"] = wilder_rsi(hourly["close"])
    adl = money_flow_volume.cumsum()
    hourly["adl_slope_1h"] = adl.diff(3) / hourly["volume"].rolling(3).sum()
    return hourly[
        ["rsi14_1h", "cmf20_1h", "mfi14_1h", "adl_slope_1h"]
    ]


def feature_frame(frame: pd.DataFrame) -> pd.DataFrame:
    outputs: list[pd.DataFrame] = []
    btc = frame.loc[frame["symbol"] == "BTC"].copy().set_index("time")
    btc["btc_return_4h"] = np.log(btc["close"] / btc["close"].shift(48))
    btc["btc_return_24h"] = np.log(btc["close"] / btc["close"].shift(288))
    btc_returns = np.log(btc["close"] / btc["close"].shift(1))

    for asset in ["BTC", "ETH", "SOL"]:
        source = frame.loc[frame["symbol"] == asset].copy().set_index("time")
        features = pd.DataFrame(index=source.index)
        for candidate in ["BTC", "ETH", "SOL"]:
            features[f"asset_{candidate.lower()}"] = 1.0 if asset == candidate else 0.0
        for name, window in [
            ("return_1h", 12),
            ("return_4h", 48),
            ("return_24h", 288),
            ("return_4d", 1_152),
            ("return_12d", 3_456),
            ("return_24d", 6_912),
        ]:
            features[name] = np.log(source["close"] / source["close"].shift(window))
        one_bar_return = np.log(source["close"] / source["close"].shift(1))
        features["realized_vol_4h"] = one_bar_return.rolling(48).std(ddof=1)
        features["realized_vol_24h"] = one_bar_return.rolling(288).std(ddof=1)
        features["realized_vol_4d"] = one_bar_return.rolling(1_152).std(ddof=1)
        quote_mean_24h = source["quote_volume"].rolling(288).mean()
        features["volume_ratio_1h_24h"] = (
            source["quote_volume"].rolling(12).mean() / quote_mean_24h
        )
        features["volume_ratio_4h_24h"] = (
            source["quote_volume"].rolling(48).mean() / quote_mean_24h
        )
        features["volume_acceleration_1h"] = (
            source["quote_volume"].rolling(12).mean()
            / source["quote_volume"].rolling(24).mean()
        )
        current_volume_1h = source["quote_volume"].rolling(12).sum()
        current_trades_1h = source["trade_count"].rolling(12).sum()
        features["seasonal_volume_ratio_1h"] = current_volume_1h / pd.concat(
            [
                current_volume_1h.shift(week * 7 * 24 * 12)
                for week in range(1, 5)
            ],
            axis=1,
        ).mean(axis=1, skipna=False)
        features["seasonal_trade_count_ratio_1h"] = (
            current_trades_1h
            / pd.concat(
                [
                    current_trades_1h.shift(week * 7 * 24 * 12)
                    for week in range(1, 5)
                ],
                axis=1,
            ).mean(axis=1, skipna=False)
        )
        features["trade_count_ratio_1h_24h"] = (
            source["trade_count"].rolling(12).mean()
            / source["trade_count"].rolling(288).mean()
        )
        for suffix, window in [("1h", 12), ("4h", 48)]:
            quote = source["quote_volume"].rolling(window).sum()
            taker = source["taker_buy_quote_volume"].rolling(window).sum()
            ratio = taker / quote.replace(0, np.nan)
            features[f"taker_buy_ratio_{suffix}"] = ratio
            features[f"taker_flow_proxy_{suffix}"] = ratio * 2 - 1
        features["close_vs_sma_4h"] = (
            source["close"] / source["close"].rolling(48).mean() - 1
        )
        features["close_vs_sma_24h"] = (
            source["close"] / source["close"].rolling(288).mean() - 1
        )
        (
            features["regression_slope_4h"],
            features["regression_r2_4h"],
        ) = rolling_regression(source["close"], 48)
        (
            features["regression_slope_24h"],
            features["regression_r2_24h"],
        ) = rolling_regression(source["close"], 288)
        features["efficiency_ratio_4h"] = efficiency_ratio(source["close"], 48)
        features["efficiency_ratio_24h"] = efficiency_ratio(source["close"], 288)
        flow = hourly_money_flow(source.reset_index()).reindex(
            source.index, method="ffill"
        )
        for column in flow:
            features[column] = flow[column]
        if asset == "BTC":
            features["relative_btc_return_4h"] = 0.0
            features["relative_btc_return_24h"] = 0.0
            features["btc_correlation_30d"] = 1.0
        else:
            features["relative_btc_return_4h"] = (
                features["return_4h"] - btc["btc_return_4h"].reindex(source.index)
            )
            features["relative_btc_return_24h"] = (
                features["return_24h"] - btc["btc_return_24h"].reindex(source.index)
            )
            features["btc_correlation_30d"] = one_bar_return.rolling(
                30 * 24 * 12
            ).corr(btc_returns.reindex(source.index))
        decision_time = source.index + pd.Timedelta(minutes=4)
        minute_of_week = (
            decision_time.dayofweek * 24 * 60
            + decision_time.hour * 60
            + decision_time.minute
        )
        cycle = minute_of_week / (7 * 24 * 60) * 2 * np.pi
        features["minute_of_week_sin"] = np.sin(cycle)
        features["minute_of_week_cos"] = np.cos(cycle)
        features["symbol"] = asset
        features["open"] = source["open"]
        features["close"] = source["close"]
        features["one_bar_return"] = one_bar_return
        features["contiguous_run"] = (
            source.index.to_series().diff().ne(FIVE_MINUTES).cumsum().to_numpy()
        )
        features["contiguous_bars"] = (
            features.groupby("contiguous_run").cumcount() + 1
        )
        outputs.append(features.reset_index())
    return pd.concat(outputs, ignore_index=True)


def ewma_volatility(returns: pd.Series, half_life: int = 288) -> pd.Series:
    alpha = 1 - math.exp(math.log(0.5) / half_life)
    return np.sqrt(returns.pow(2).ewm(alpha=alpha, adjust=False, min_periods=288).mean())


def samples_for_horizon(features: pd.DataFrame, horizon: str) -> pd.DataFrame:
    config = HORIZONS[horizon]
    outputs = []
    for symbol, source in features.groupby("symbol", sort=False):
        source = source.sort_values("time").copy()
        if config["anchor"] == "hourly":
            anchor = source["time"].dt.minute.eq(55)
        else:
            anchor = source["time"].dt.hour.eq(23) & source["time"].dt.minute.eq(55)
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
        volatility = ewma_volatility(source["one_bar_return"])
        future_volatility = (
            source["one_bar_return"]
            .shift(-1)
            .iloc[::-1]
            .rolling(config["bars"], min_periods=config["bars"])
            .std(ddof=1)
            .iloc[::-1]
        )
        band = np.maximum(
            ROUND_TRIP_COST_RATIO,
            0.35 * volatility * math.sqrt(config["bars"]),
        )
        label = np.where(forward_return > band, 2, np.where(forward_return < -band, 0, 1))
        selection_mask = anchor & same_run
        selected = source.loc[
            selection_mask,
            ["time", "symbol", "one_bar_return", *FEATURE_NAMES],
        ].copy()
        selected["forward_return"] = forward_return.loc[
            selection_mask
        ].to_numpy()
        selected["label_band"] = band.loc[selection_mask].to_numpy()
        selected["label"] = label[selection_mask.to_numpy()]
        selected["future_volatility"] = future_volatility.loc[
            selection_mask
        ].to_numpy()
        selected["outcome_time"] = outcome_time.loc[selection_mask].to_numpy()
        selected["entry_open"] = source["open"].shift(-1).loc[
            selection_mask
        ].to_numpy()
        selected["exit_close"] = source["close"].shift(-config["bars"]).loc[
            selection_mask
        ].to_numpy()
        selected = selected.dropna(
            subset=[
                "forward_return",
                "label_band",
                "one_bar_return",
                "future_volatility",
                *FEATURE_NAMES,
            ]
        )
        outputs.append(selected)
    result = pd.concat(outputs, ignore_index=True)
    result["horizon"] = horizon
    return result


def purged_splits(
    frame: pd.DataFrame,
    horizon: str,
    resolved_test_cutoff: pd.Timestamp,
    *,
    control_embargo: pd.Timedelta | None = None,
) -> dict[str, pd.DataFrame]:
    """Split by label end-time and embargo the next split by one horizon."""

    embargo = control_embargo or pd.Timedelta(
        milliseconds=HORIZONS[horizon]["bars"] * FIVE_MINUTES.total_seconds() * 1_000
    )
    boundaries = {
        "selection": pd.Timestamp("2024-01-01", tz="UTC"),
        "calibration": pd.Timestamp("2024-07-01", tz="UTC"),
        "test": pd.Timestamp("2025-01-01", tz="UTC"),
    }
    return {
        "train": frame.loc[
            (frame["time"] >= "2021-01-01")
            & (frame["outcome_time"] < boundaries["selection"])
        ].copy(),
        "selection": frame.loc[
            (frame["time"] >= boundaries["selection"] + embargo)
            & (frame["outcome_time"] < boundaries["calibration"])
        ].copy(),
        "calibration": frame.loc[
            (frame["time"] >= boundaries["calibration"] + embargo)
            & (frame["outcome_time"] < boundaries["test"])
        ].copy(),
        "test": frame.loc[
            (frame["time"] >= boundaries["test"] + embargo)
            & (frame["outcome_time"] <= resolved_test_cutoff)
        ].copy(),
    }


def conformal_quantile_correction(
    y: np.ndarray, predictions: np.ndarray
) -> dict:
    ordered = np.sort(np.asarray(predictions, dtype=float), axis=1)
    scores = np.maximum(ordered[:, 0] - y, y - ordered[:, 2])
    level = min(1.0, np.ceil((len(y) + 1) * 0.80) / len(y))
    interval = float(np.quantile(scores, level, method="higher"))
    median = float(np.median(y - ordered[:, 1]))
    return {"lower": -interval, "median": median, "upper": interval}


def apply_quantile_correction(
    predictions: np.ndarray, correction: dict
) -> np.ndarray:
    adjusted = np.asarray(predictions, dtype=float).copy()
    adjusted[:, 0] += float(correction["lower"])
    adjusted[:, 1] += float(correction["median"])
    adjusted[:, 2] += float(correction["upper"])
    return np.sort(adjusted, axis=1)


def quantile_metrics(y: np.ndarray, predictions: np.ndarray) -> dict:
    ordered = np.sort(np.asarray(predictions, dtype=float), axis=1)
    return {
        "samples": int(len(y)),
        "pinball": {
            f"q{int(level * 100)}": float(
                mean_pinball_loss(y, ordered[:, index], alpha=level)
            )
            for index, level in enumerate(QUANTILES)
        },
        "intervalCoverage": float(
            ((y >= ordered[:, 0]) & (y <= ordered[:, 2])).mean()
        ),
        "medianMae": float(mean_absolute_error(y, ordered[:, 1])),
    }


def qlike(y: np.ndarray, prediction: np.ndarray) -> float:
    actual = np.maximum(np.asarray(y, dtype=float), 1e-12)
    forecast = np.maximum(np.asarray(prediction, dtype=float), 1e-12)
    ratio = actual / forecast
    return float(np.mean(ratio - np.log(ratio) - 1))


def volatility_metrics(y: np.ndarray, prediction: np.ndarray) -> dict:
    actual = np.maximum(np.asarray(y, dtype=float), 0)
    forecast = np.maximum(np.asarray(prediction, dtype=float), 0)
    return {
        "samples": int(len(actual)),
        "mae": float(mean_absolute_error(actual, forecast)),
        "qlike": qlike(actual, forecast),
        "rankCorrelation": float(
            pd.Series(actual).corr(pd.Series(forecast), method="spearman")
        ),
    }


def multiclass_brier(y: np.ndarray, probabilities: np.ndarray) -> float:
    one_hot = np.eye(3)[y.astype(int)]
    return float(np.square(probabilities - one_hot).sum(axis=1).mean())


def expected_calibration_error(
    y: np.ndarray, probabilities: np.ndarray, bins: int = 10
) -> float:
    confidence = probabilities.max(axis=1)
    prediction = probabilities.argmax(axis=1)
    total = len(y)
    result = 0.0
    for lower in np.linspace(0, 1, bins, endpoint=False):
        upper = lower + 1 / bins
        mask = (confidence >= lower) & (
            confidence <= upper if upper >= 1 else confidence < upper
        )
        if not mask.any():
            continue
        accuracy = (prediction[mask] == y[mask]).mean()
        result += mask.sum() / total * abs(accuracy - confidence[mask].mean())
    return float(result)


def fit_vector_scaling(
    probabilities: np.ndarray, y: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    epsilon = 1e-12
    logits = np.log(np.clip(probabilities, epsilon, 1))

    def objective(parameters: np.ndarray) -> float:
        scale = parameters[:3]
        bias = parameters[3:]
        adjusted = logits * scale + bias
        adjusted -= adjusted.max(axis=1, keepdims=True)
        exp = np.exp(adjusted)
        calibrated = exp / exp.sum(axis=1, keepdims=True)
        loss = -np.log(np.clip(calibrated[np.arange(len(y)), y], epsilon, 1)).mean()
        regularization = 1e-4 * (
            np.square(scale - 1).sum() + np.square(bias).sum()
        )
        return float(loss + regularization)

    result = minimize(
        objective,
        np.array([1.0, 1.0, 1.0, 0.0, 0.0, 0.0]),
        method="L-BFGS-B",
        bounds=[(0.1, 10)] * 3 + [(-5, 5)] * 3,
    )
    if not result.success:
        return np.ones(3), np.zeros(3)
    return result.x[:3], result.x[3:]


def apply_vector_scaling(
    probabilities: np.ndarray, scale: np.ndarray, bias: np.ndarray
) -> np.ndarray:
    logits = np.log(np.clip(probabilities, 1e-12, 1)) * scale + bias
    logits -= logits.max(axis=1, keepdims=True)
    exp = np.exp(logits)
    return exp / exp.sum(axis=1, keepdims=True)


def momentum_baseline(frame: pd.DataFrame, horizon: str) -> np.ndarray:
    feature = {
        "4h": "return_4h",
        "24h": "return_24h",
        "4d": "return_4d",
        "12d": "return_12d",
        "24d": "return_24d",
    }[horizon]
    values = frame[feature].to_numpy()
    band = frame["label_band"].to_numpy()
    return np.where(values > band, 2, np.where(values < -band, 0, 1))


def baseline_predictions(
    frame: pd.DataFrame, horizon: str, majority_class: int
) -> dict[str, np.ndarray]:
    return {
        "majority": np.full(len(frame), majority_class, dtype=int),
        "pricePersistence": np.where(
            frame["one_bar_return"].to_numpy() >= 0, 2, 0
        ),
        "simpleMomentum": momentum_baseline(frame, horizon),
        "cryptoQuantV2Proxy": np.where(
            (
                frame["close_vs_sma_4h"].gt(0)
                & frame["close_vs_sma_24h"].gt(0)
                & frame["regression_slope_4h"].gt(0)
                & frame["regression_slope_24h"].gt(0)
            ),
            2,
            np.where(
                (
                    frame["close_vs_sma_4h"].lt(0)
                    & frame["close_vs_sma_24h"].lt(0)
                    & frame["regression_slope_4h"].lt(0)
                    & frame["regression_slope_24h"].lt(0)
                ),
                0,
                1,
            ),
        ).astype(int),
    }


def best_baseline(
    frame: pd.DataFrame, horizon: str, majority_class: int
) -> tuple[str, np.ndarray, dict]:
    y = frame["label"].to_numpy(dtype=int)
    candidates = baseline_predictions(frame, horizon, majority_class)
    metrics = {
        name: metrics_for(y, np.eye(3)[prediction])
        for name, prediction in candidates.items()
    }
    name = max(
        metrics,
        key=lambda candidate: (
            metrics[candidate]["balancedAccuracy"],
            metrics[candidate]["macroF1"],
        ),
    )
    return name, candidates[name], metrics


def metrics_for(y: np.ndarray, probabilities: np.ndarray) -> dict:
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


def finite_predict_proba(model, features: np.ndarray) -> np.ndarray:
    if not np.isfinite(features).all():
        raise RuntimeError("model_features_non_finite")
    # Apple's accelerated BLAS can raise floating point status warnings from
    # an otherwise finite matrix product.  Treat the values, not the ambient
    # status flag, as the contract: reject any non-finite probability and
    # require every row to remain normalized.
    with np.errstate(divide="ignore", over="ignore", invalid="ignore"):
        probabilities = np.asarray(model.predict_proba(features), dtype=float)
    if (
        probabilities.ndim != 2
        or probabilities.shape[1] != 3
        or not np.isfinite(probabilities).all()
        or not np.allclose(probabilities.sum(axis=1), 1.0, atol=1e-6)
    ):
        raise RuntimeError("model_probabilities_invalid")
    return probabilities


def block_bootstrap_delta(
    frame: pd.DataFrame,
    predictions: np.ndarray,
    baseline: np.ndarray,
    block_days: int,
    iterations: int = 400,
) -> dict:
    work = frame[["time", "label"]].copy()
    epoch_day = (work["time"].astype("int64") // 86_400_000_000_000).astype(int)
    work["block"] = epoch_day // max(1, block_days)
    work["prediction"] = predictions
    work["baseline"] = baseline
    blocks = [group for _, group in work.groupby("block")]
    if len(blocks) < 8:
        return {"lower95": -1.0, "upper95": 1.0, "blocks": len(blocks)}
    rng = np.random.default_rng(20260729)
    deltas = []
    for _ in range(iterations):
        sampled = pd.concat(
            [blocks[index] for index in rng.integers(0, len(blocks), len(blocks))]
        )
        y = sampled["label"].to_numpy()
        candidate_score = balanced_accuracy_score(y, sampled["prediction"])
        baseline_score = balanced_accuracy_score(y, sampled["baseline"])
        deltas.append(candidate_score - baseline_score)
    lower, upper = np.quantile(deltas, [0.025, 0.975])
    return {
        "lower95": float(lower),
        "upper95": float(upper),
        "blocks": len(blocks),
    }


def choose_thresholds(
    frame: pd.DataFrame,
    probabilities: np.ndarray,
    baseline_accuracy: float,
) -> dict:
    y = frame["label"].to_numpy(dtype=int)
    predicted = probabilities.argmax(axis=1)
    top = probabilities.max(axis=1)
    margin = np.sort(probabilities, axis=1)[:, -1] - np.sort(
        probabilities, axis=1
    )[:, -2]
    best = None
    for threshold in np.arange(0.40, 0.91, 0.01):
        mask = (top >= threshold) & (margin >= 0.10)
        coverage = float(mask.mean())
        if coverage < 0.20 or mask.sum() < 100:
            continue
        accuracy = float(accuracy_score(y[mask], predicted[mask]))
        score = float(balanced_accuracy_score(y[mask], predicted[mask]))
        if accuracy < baseline_accuracy + 0.05:
            continue
        candidate = {
            "default": round(float(threshold), 2),
            "down": round(float(threshold), 2),
            "range": round(float(threshold), 2),
            "up": round(float(threshold), 2),
            "margin": 0.10,
            "minEvidenceCoverage": 0.90,
            "maxDataFreshnessMs": 600_000,
            "coverage": coverage,
            "selectiveBalancedAccuracy": score,
            "selectiveAccuracy": accuracy,
        }
        if best is None or candidate["coverage"] > best["coverage"]:
            best = candidate
    return best or {
        "default": 1.0,
        "down": 1.0,
        "range": 1.0,
        "up": 1.0,
        "margin": 1.0,
        "minEvidenceCoverage": 1.0,
        "maxDataFreshnessMs": 600_000,
        "coverage": 0.0,
        "selectiveBalancedAccuracy": None,
        "selectiveAccuracy": None,
    }


def subgroup_guard(
    frame: pd.DataFrame,
    candidate: np.ndarray,
    baseline: np.ndarray,
    volatility_thresholds: tuple[float, float],
) -> dict:
    failures = []
    details = []
    for symbol, group in frame.assign(
        candidate=candidate, baseline=baseline
    ).groupby("symbol"):
        if len(group) < 200:
            continue
        y = group["label"].to_numpy()
        candidate_score = balanced_accuracy_score(y, group["candidate"])
        baseline_score = balanced_accuracy_score(y, group["baseline"])
        delta = float(candidate_score - baseline_score)
        details.append(
            {"symbol": symbol, "samples": len(group), "balancedAccuracyDelta": delta}
        )
        if delta < -0.05:
            failures.append(f"symbol:{symbol}")
    low, high = volatility_thresholds
    regimes = pd.cut(
        frame["realized_vol_24h"],
        bins=[-np.inf, low, high, np.inf],
        labels=["low", "medium", "high"],
    )
    for regime, group in frame.assign(
        candidate=candidate, baseline=baseline, volatilityRegime=regimes
    ).groupby("volatilityRegime", observed=True):
        if len(group) < 200:
            continue
        y = group["label"].to_numpy()
        candidate_score = balanced_accuracy_score(y, group["candidate"])
        baseline_score = balanced_accuracy_score(y, group["baseline"])
        delta = float(candidate_score - baseline_score)
        details.append(
            {
                "volatilityRegime": str(regime),
                "samples": len(group),
                "balancedAccuracyDelta": delta,
            }
        )
        if delta < -0.05:
            failures.append(f"volatility:{regime}")
    return {"passed": not failures, "failures": failures, "details": details}


def paper_metrics(
    frame: pd.DataFrame, probabilities: np.ndarray, thresholds: dict
) -> dict:
    predicted = probabilities.argmax(axis=1)
    confidence = probabilities.max(axis=1)
    margin = np.sort(probabilities, axis=1)[:, -1] - np.sort(
        probabilities, axis=1
    )[:, -2]
    active = (confidence >= thresholds["default"]) & (margin >= thresholds["margin"])
    direction = np.where(predicted == 2, 1, np.where(predicted == 0, -1, 0))
    net = direction * frame["forward_return"].to_numpy() - np.where(
        direction != 0, ROUND_TRIP_COST_RATIO, 0
    )
    selected = net[active & (direction != 0)]
    equity = np.cumsum(selected)
    running_peak = np.maximum.accumulate(np.concatenate(([0.0], equity)))
    drawdown = running_peak[1:] - equity if len(equity) else np.array([])
    positive_before_funding = bool(len(selected) and selected.mean() > 0)
    return {
        "signals": int(len(selected)),
        "meanNetReturn": float(selected.mean()) if len(selected) else 0.0,
        "totalNetReturn": float(selected.sum()) if len(selected) else 0.0,
        "maxDrawdown": float(drawdown.max()) if len(drawdown) else 0.0,
        "fundingIncluded": False,
        "fundingCoverage": 0.0,
        "positiveExpectationBeforeFunding": positive_before_funding,
        "positiveExpectation": False,
        "promotionBlocker": "historical_funding_coverage_unavailable",
    }


def export_onnx(model, kind: str, target: Path) -> tuple[str, str]:
    if kind in {"xgboost", "xgboost_regressor"}:
        from onnxmltools import convert_xgboost
        from onnxmltools.convert.common.data_types import FloatTensorType

        converted = convert_xgboost(
            model,
            initial_types=[
                ("features", FloatTensorType([None, len(FEATURE_NAMES)]))
            ],
            target_opset=15,
        )
    else:
        from skl2onnx import convert_sklearn
        from skl2onnx.common import _container as skl2onnx_container
        from skl2onnx.common.data_types import FloatTensorType

        options = (
            {id(model): {"zipmap": False}}
            if kind == "logistic"
            else None
        )
        original_make_node = skl2onnx_container.make_node

        def compatible_make_node(*args, **attributes):
            # onnx>=1.20 correctly requires INTS for this TreeEnsemble
            # attribute, while the current skl2onnx regressor converter emits
            # Python booleans. Normalize only this standardized attribute.
            missing = attributes.get("nodes_missing_value_tracks_true")
            if isinstance(missing, list):
                attributes["nodes_missing_value_tracks_true"] = [
                    int(value) for value in missing
                ]
            return original_make_node(*args, **attributes)

        skl2onnx_container.make_node = compatible_make_node
        try:
            converted = convert_sklearn(
                model,
                initial_types=[
                    ("features", FloatTensorType([None, len(FEATURE_NAMES)]))
                ],
                target_opset=15,
                options=options,
            )
        finally:
            skl2onnx_container.make_node = original_make_node
    target.write_bytes(converted.SerializeToString())
    input_name = converted.graph.input[0].name
    output_name = converted.graph.output[-1].name
    return input_name, output_name


def bootstrap_loss_improvement(
    frame: pd.DataFrame,
    candidate_loss: np.ndarray,
    baseline_loss: np.ndarray,
    block_days: int,
    iterations: int = 400,
) -> dict:
    work = frame[["time"]].copy()
    epoch_day = (work["time"].astype("int64") // 86_400_000_000_000).astype(int)
    work["block"] = epoch_day // max(1, block_days)
    work["candidate"] = candidate_loss
    work["baseline"] = baseline_loss
    blocks = [group for _, group in work.groupby("block")]
    if len(blocks) < 8:
        return {"lower95": -1.0, "upper95": 1.0, "blocks": len(blocks)}
    rng = np.random.default_rng(20260729)
    values = []
    for _ in range(iterations):
        sample = pd.concat(
            [blocks[index] for index in rng.integers(0, len(blocks), len(blocks))]
        )
        values.append(
            float(sample["baseline"].mean() - sample["candidate"].mean())
        )
    lower, upper = np.quantile(values, [0.025, 0.975])
    return {
        "lower95": float(lower),
        "upper95": float(upper),
        "blocks": len(blocks),
    }


def train_return_quantiles(
    *,
    train: pd.DataFrame,
    calibration_frame: pd.DataFrame,
    test: pd.DataFrame,
    output: Path,
    horizon: str,
) -> dict:
    x_train = train[FEATURE_NAMES].to_numpy(dtype=np.float64)
    y_train = train["forward_return"].to_numpy(dtype=float)
    x_calibration = calibration_frame[FEATURE_NAMES].to_numpy(dtype=np.float64)
    y_calibration = calibration_frame["forward_return"].to_numpy(dtype=float)
    x_test = test[FEATURE_NAMES].to_numpy(dtype=np.float64)
    y_test = test["forward_return"].to_numpy(dtype=float)
    models = []
    for level in QUANTILES:
        model = GradientBoostingRegressor(
            loss="quantile",
            alpha=level,
            n_estimators=120,
            max_depth=2,
            min_samples_leaf=24,
            learning_rate=0.035,
            random_state=20260729,
        )
        model.fit(x_train, y_train)
        models.append(model)
    raw_calibration = np.column_stack(
        [model.predict(x_calibration) for model in models]
    )
    correction = conformal_quantile_correction(
        y_calibration, raw_calibration
    )
    test_predictions = apply_quantile_correction(
        np.column_stack([model.predict(x_test) for model in models]),
        correction,
    )
    baseline_values = np.quantile(y_train, QUANTILES)
    baseline_predictions = np.tile(baseline_values, (len(test), 1))
    metrics = quantile_metrics(y_test, test_predictions)
    baseline = quantile_metrics(y_test, baseline_predictions)
    candidate_loss = np.mean(
        np.column_stack(
            [
                np.maximum(
                    level * (y_test - test_predictions[:, index]),
                    (level - 1) * (y_test - test_predictions[:, index]),
                )
                for index, level in enumerate(QUANTILES)
            ]
        ),
        axis=1,
    )
    baseline_loss = np.mean(
        np.column_stack(
            [
                np.maximum(
                    level * (y_test - baseline_predictions[:, index]),
                    (level - 1) * (y_test - baseline_predictions[:, index]),
                )
                for index, level in enumerate(QUANTILES)
            ]
        ),
        axis=1,
    )
    bootstrap = bootstrap_loss_improvement(
        test,
        candidate_loss,
        baseline_loss,
        HORIZONS[horizon]["block_days"],
    )
    artifacts = {}
    for index, (level, model) in enumerate(zip(QUANTILES, models)):
        name = f"q{int(level * 100)}"
        artifact = f"{horizon}.return-{name}.onnx"
        input_name, output_name = export_onnx(
            model, "gradient_boosting_regressor", output / artifact
        )
        artifacts[name] = {
            "artifact": artifact,
            "artifactSha256": sha256_file(output / artifact),
            "inputName": input_name,
            "outputName": output_name,
            "runtimeContract": {
                "featureVector": x_test[0].astype(np.float32).tolist(),
                "expectedRawValue": float(
                    model.predict(
                        x_test[0].astype(np.float32).reshape(1, -1)
                    )[0]
                ),
                "maxAbsoluteDelta": 1e-5,
            },
        }
    eligible = all(
        [
            sum(metrics["pinball"].values())
            < sum(baseline["pinball"].values()),
            0.75 <= metrics["intervalCoverage"] <= 0.85,
            metrics["medianMae"] < baseline["medianMae"],
            bootstrap["lower95"] > 0,
        ]
    )
    return {
        "status": "shadow",
        "artifacts": artifacts,
        "conformalCorrection": correction,
        "metrics": metrics,
        "baseline": baseline,
        "bootstrapImprovement": bootstrap,
        "eligibleForActive": eligible,
        "promotionReasons": [] if eligible else ["quantile_promotion_gate_failed"],
    }


def train_future_volatility(
    *,
    train: pd.DataFrame,
    test: pd.DataFrame,
    output: Path,
    horizon: str,
) -> dict:
    x_train = train[FEATURE_NAMES].to_numpy(dtype=np.float64)
    y_train = train["future_volatility"].to_numpy(dtype=float)
    x_test = test[FEATURE_NAMES].to_numpy(dtype=np.float64)
    y_test = test["future_volatility"].to_numpy(dtype=float)
    model = XGBRegressor(
        objective="reg:squarederror",
        n_estimators=160,
        max_depth=3,
        learning_rate=0.035,
        min_child_weight=12,
        subsample=0.8,
        colsample_bytree=0.75,
        reg_alpha=0.2,
        reg_lambda=2.0,
        tree_method="hist",
        n_jobs=max(1, min(4, os.cpu_count() or 1)),
        random_state=20260729,
    )
    model.fit(x_train, y_train, verbose=False)
    prediction = np.maximum(model.predict(x_test), 0)
    baseline_prediction = np.maximum(
        test["realized_vol_24h"].to_numpy(dtype=float), 1e-12
    )
    metrics = volatility_metrics(y_test, prediction)
    baseline = volatility_metrics(y_test, baseline_prediction)
    candidate_loss = np.abs(y_test - prediction)
    baseline_loss = np.abs(y_test - baseline_prediction)
    bootstrap = bootstrap_loss_improvement(
        test,
        candidate_loss,
        baseline_loss,
        HORIZONS[horizon]["block_days"],
    )
    artifact = f"{horizon}.future-volatility.onnx"
    input_name, output_name = export_onnx(
        model, "xgboost_regressor", output / artifact
    )
    eligible = all(
        [
            metrics["mae"] < baseline["mae"],
            metrics["qlike"] < baseline["qlike"],
            metrics["rankCorrelation"] > baseline["rankCorrelation"],
            bootstrap["lower95"] > 0,
        ]
    )
    return {
        "status": "shadow",
        "artifact": artifact,
        "artifactSha256": sha256_file(output / artifact),
        "inputName": input_name,
        "outputName": output_name,
        "runtimeContract": {
            "featureVector": x_test[0].astype(np.float32).tolist(),
            "expectedRawValue": float(
                model.predict(x_test[0].astype(np.float32).reshape(1, -1))[0]
            ),
            "maxAbsoluteDelta": 1e-5,
        },
        "metrics": metrics,
        "baseline": baseline,
        "bootstrapImprovement": bootstrap,
        "eligibleForActive": eligible,
        "promotionReasons": [] if eligible else ["volatility_promotion_gate_failed"],
    }


@dataclass
class HorizonResult:
    horizon: str
    champion: str
    artifact: str
    artifactSha256: str
    inputName: str
    outputName: str
    runtimeContract: dict
    calibration: dict
    thresholds: dict
    featureMedians: list[float]
    driverFeatureIndexes: list[int]
    validation: dict
    test: dict
    baseline: dict
    bootstrapDelta: dict
    subgroupGuard: dict
    paper: dict
    purging: dict
    returnQuantiles: dict
    futureVolatility: dict
    backtest: dict
    eligibleForActive: bool


def train_horizon(
    frame: pd.DataFrame,
    horizon: str,
    output: Path,
    resolved_test_cutoff: pd.Timestamp,
) -> HorizonResult:
    splits = purged_splits(frame, horizon, resolved_test_cutoff)
    control_splits = purged_splits(
        frame,
        horizon,
        resolved_test_cutoff,
        control_embargo=EMBARGO,
    )
    train = splits["train"]
    selection = splits["selection"]
    calibration_frame = splits["calibration"]
    test = splits["test"]
    if min(len(train), len(selection), len(calibration_frame), len(test)) < 100:
        raise RuntimeError(f"insufficient_split_samples:{horizon}")
    # Fit the linear baseline in float64.  Some scikit-learn solvers perform
    # Hessian products in the input dtype; float32 can overflow during those
    # intermediate operations even though every bounded market feature is
    # finite and small.
    x_train = train[FEATURE_NAMES].to_numpy(dtype=np.float64)
    y_train = train["label"].to_numpy(dtype=int)
    x_selection = selection[FEATURE_NAMES].to_numpy(dtype=np.float64)
    y_selection = selection["label"].to_numpy(dtype=int)
    counts = np.bincount(y_train, minlength=3)
    weights = len(y_train) / np.maximum(1, counts * 3)
    sample_weight = weights[y_train]

    logistic = Pipeline(
        [
            ("scale", StandardScaler()),
            (
                "model",
                LogisticRegression(
                    C=0.2,
                    max_iter=800,
                    solver="saga",
                    tol=1e-4,
                    random_state=20260729,
                ),
            ),
        ]
    )
    logistic.fit(x_train, y_train, model__sample_weight=sample_weight)
    xgb = XGBClassifier(
        objective="multi:softprob",
        num_class=3,
        n_estimators=240,
        max_depth=4,
        learning_rate=0.035,
        min_child_weight=8,
        subsample=0.8,
        colsample_bytree=0.75,
        reg_alpha=0.2,
        reg_lambda=2.0,
        tree_method="hist",
        n_jobs=max(1, min(4, os.cpu_count() or 1)),
        random_state=20260729,
    )
    xgb.fit(x_train, y_train, sample_weight=sample_weight, verbose=False)
    candidates = {
        "logistic": logistic,
        "xgboost": xgb,
    }
    selection_metrics = {
        name: metrics_for(
            y_selection,
            finite_predict_proba(model, x_selection),
        )
        for name, model in candidates.items()
    }
    champion_name = max(
        selection_metrics,
        key=lambda name: (
            selection_metrics[name]["balancedAccuracy"],
            -selection_metrics[name]["brier"],
        ),
    )
    champion = candidates[champion_name]

    x_calibration = calibration_frame[FEATURE_NAMES].to_numpy(dtype=np.float64)
    y_calibration = calibration_frame["label"].to_numpy(dtype=int)
    raw_calibration = finite_predict_proba(champion, x_calibration)
    scale, bias = fit_vector_scaling(raw_calibration, y_calibration)
    calibrated_validation = apply_vector_scaling(raw_calibration, scale, bias)
    majority_class = int(np.bincount(y_train, minlength=3).argmax())
    (
        calibration_baseline_name,
        baseline_calibration,
        calibration_baselines,
    ) = best_baseline(calibration_frame, horizon, majority_class)
    baseline_accuracy = accuracy_score(y_calibration, baseline_calibration)
    thresholds = choose_thresholds(
        calibration_frame, calibrated_validation, baseline_accuracy
    )

    x_test = test[FEATURE_NAMES].to_numpy(dtype=np.float64)
    y_test = test["label"].to_numpy(dtype=int)
    test_probabilities = apply_vector_scaling(
        finite_predict_proba(champion, x_test), scale, bias
    )
    candidate_prediction = test_probabilities.argmax(axis=1)
    baseline_name, baseline_prediction, baseline_candidates = best_baseline(
        test, horizon, majority_class
    )
    candidate_metrics = metrics_for(y_test, test_probabilities)
    baseline_probabilities = np.eye(3)[baseline_prediction]
    baseline_metrics = metrics_for(y_test, baseline_probabilities)
    empirical = np.bincount(y_train, minlength=3) / len(y_train)
    empirical_probabilities = np.tile(empirical, (len(y_test), 1))
    brier_reference = multiclass_brier(y_test, empirical_probabilities)
    brier_skill = (
        1 - candidate_metrics["brier"] / brier_reference
        if brier_reference > 0
        else -1
    )
    bootstrap = block_bootstrap_delta(
        test,
        candidate_prediction,
        baseline_prediction,
        HORIZONS[horizon]["block_days"],
    )
    volatility_thresholds = tuple(
        np.quantile(train["realized_vol_24h"], [1 / 3, 2 / 3]).astype(float)
    )
    subgroup = subgroup_guard(
        test,
        candidate_prediction,
        baseline_prediction,
        volatility_thresholds,
    )
    paper = paper_metrics(test, test_probabilities, thresholds)
    predicted_indexes = test_probabilities.argmax(axis=1)
    confidence = test_probabilities.max(axis=1)
    probability_margin = np.sort(test_probabilities, axis=1)[:, -1] - np.sort(
        test_probabilities, axis=1
    )[:, -2]
    event_input = pd.DataFrame(
        {
            "symbol": test["symbol"],
            "horizon": horizon,
            "decision_time": test["time"],
            "outcome_time": test["outcome_time"],
            "predicted_state": [
                CLASS_ORDER[index] for index in predicted_indexes
            ],
            "abstained": (confidence < thresholds["default"])
            | (probability_margin < thresholds["margin"]),
            "entry_open": test["entry_open"],
            "exit_close": test["exit_close"],
        }
    )
    backtest = sensitivity_report(
        event_input,
        rules=MarketRules(
            price_tick=0.01,
            quantity_step=0.000001,
            minimum_notional=5.0,
        ),
    )
    return_quantiles = train_return_quantiles(
        train=train,
        calibration_frame=calibration_frame,
        test=test,
        output=output,
        horizon=horizon,
    )
    future_volatility = train_future_volatility(
        train=train,
        test=test,
        output=output,
        horizon=horizon,
    )
    selective_improvement = (
        thresholds["selectiveBalancedAccuracy"] is not None
        and thresholds["selectiveAccuracy"] >= baseline_accuracy + 0.05
    )
    eligible = all(
        [
            bootstrap["lower95"] > 0,
            candidate_metrics["macroF1"] > baseline_metrics["macroF1"],
            brier_skill > 0,
            candidate_metrics["ece"] <= 0.05,
            thresholds["coverage"] >= 0.20,
            selective_improvement,
            subgroup["passed"],
            paper["positiveExpectation"],
        ]
    )

    artifact = f"{horizon}.onnx"
    artifact_path = output / artifact
    input_name, output_name = export_onnx(
        champion, champion_name, artifact_path
    )
    # Production ONNX input is FloatTensor.  Generate the contract from the
    # exact float32 vector that Node will execute, rather than a higher
    # precision training-only representation.
    contract_vector = x_test[0].astype(np.float32)
    contract_probabilities = finite_predict_proba(
        champion,
        contract_vector.astype(np.float64).reshape(1, -1)
    )[0]
    if champion_name == "xgboost":
        importance = champion.feature_importances_
    else:
        importance = np.abs(champion.named_steps["model"].coef_).mean(axis=0)
    driver_indexes = np.argsort(importance)[::-1][:24].astype(int).tolist()
    medians = np.nanmedian(x_train, axis=0)
    return HorizonResult(
        horizon=horizon,
        champion=champion_name,
        artifact=artifact,
        artifactSha256=sha256_file(artifact_path),
        inputName=input_name,
        outputName=output_name,
        runtimeContract={
            "featureVector": contract_vector.astype(float).tolist(),
            "expectedRawProbabilities": contract_probabilities.astype(
                float
            ).tolist(),
            "maxAbsoluteDelta": 1e-5,
        },
        calibration={
            "method": "multiclass_vector_scaling",
            "scale": scale.astype(float).tolist(),
            "bias": bias.astype(float).tolist(),
        },
        thresholds=thresholds,
        featureMedians=np.nan_to_num(medians).astype(float).tolist(),
        driverFeatureIndexes=driver_indexes,
        validation={
            "selection": selection_metrics,
            "calibrated": metrics_for(y_calibration, calibrated_validation),
        },
        test={**candidate_metrics, "brierSkill": float(brier_skill)},
        baseline={
            "selectedOnUntouchedTestForReportingOnly": baseline_name,
            "selectedOnCalibration": calibration_baseline_name,
            "test": baseline_metrics,
            "testCandidates": baseline_candidates,
            "calibrationCandidates": calibration_baselines,
        },
        bootstrapDelta=bootstrap,
        subgroupGuard=subgroup,
        paper=paper,
        purging={
            "labelEndTimeApplied": True,
            "embargo": horizon,
            "splitSamples": {
                name: int(len(value)) for name, value in splits.items()
            },
            "control24dSplitSamples": {
                name: int(len(value)) for name, value in control_splits.items()
            },
        },
        returnQuantiles=return_quantiles,
        futureVolatility=future_volatility,
        backtest=backtest,
        eligibleForActive=eligible,
    )


def latest_dataset_manifest(database: Path) -> str:
    with sqlite3.connect(
        f"file:{database}?mode=ro&immutable=1", uri=True
    ) as connection:
        row = connection.execute(
            """
            SELECT manifest_sha256 FROM dataset_manifests
            ORDER BY created_at_ms DESC LIMIT 1
            """
        ).fetchone()
    if row:
        return str(row[0])
    return sha256_file(database)


def shadow_observation_gate(database: Path, horizon: str) -> dict:
    required_days = 30 if horizon in {"4h", "24h"} else 90
    minimum_resolved = 100 if horizon in {"4h", "24h"} else 30
    with sqlite3.connect(
        f"file:{database}?mode=ro&immutable=1", uri=True
    ) as connection:
        rows = connection.execute(
            """
            SELECT created_at_ms, resolved_at_ms, payload_json, outcome_json
            FROM predictions
            WHERE horizon = ? AND status = 'shadow'
              AND resolved_at_ms IS NOT NULL AND outcome_json IS NOT NULL
            ORDER BY created_at_ms
            """,
            (horizon,),
        ).fetchall()
    if not rows:
        return {
            "passed": False,
            "requiredDays": required_days,
            "observedDays": 0.0,
            "minimumResolved": minimum_resolved,
            "resolved": 0,
            "candidateAccuracy": None,
            "meanPaperPnlUsdt": None,
            "shortFundingCoverage": None,
            "reasons": ["shadow_observation_missing"],
        }
    outcomes = []
    short_funding = []
    paper_pnl = []
    for _, _, payload_json, outcome_json in rows:
        payload = json.loads(payload_json)
        outcome = json.loads(outcome_json)
        if payload.get("candidateState") in CLASS_ORDER:
            outcomes.append(bool(outcome.get("correct")))
        try:
            paper_value = float(outcome.get("paperPnlUsdt"))
        except (TypeError, ValueError):
            paper_value = math.nan
        if math.isfinite(paper_value):
            paper_pnl.append(paper_value)
        if payload.get("candidateState") == "down":
            coverage = outcome.get("fundingCoverage")
            try:
                coverage_value = float(coverage)
            except (TypeError, ValueError):
                coverage_value = math.nan
            if math.isfinite(coverage_value):
                short_funding.append(coverage_value)
    observed_days = (
        max(row[1] for row in rows) - min(row[0] for row in rows)
    ) / 86_400_000
    funding_coverage = (
        float(np.mean(short_funding)) if short_funding else None
    )
    reasons = []
    if observed_days < required_days:
        reasons.append("shadow_duration_insufficient")
    if len(outcomes) < minimum_resolved:
        reasons.append("shadow_resolved_samples_insufficient")
    if not short_funding or funding_coverage < 0.95:
        reasons.append("shadow_short_funding_coverage_insufficient")
    return {
        "passed": not reasons,
        "requiredDays": required_days,
        "observedDays": float(observed_days),
        "minimumResolved": minimum_resolved,
        "resolved": len(outcomes),
        "candidateAccuracy": (
            float(np.mean(outcomes)) if outcomes else None
        ),
        "meanPaperPnlUsdt": (
            float(np.mean(paper_pnl)) if paper_pnl else None
        ),
        "shortFundingCoverage": funding_coverage,
        "reasons": reasons,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--model-version", default="crypto-forecast-v2")
    parser.add_argument(
        "--rollout-status", choices=["shadow", "active"], default="shadow"
    )
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    bars = load_bars(args.database)
    features = feature_frame(bars)
    resolved_test_cutoff = features["time"].max() - EMBARGO
    results = []
    for horizon in HORIZONS:
        samples = samples_for_horizon(features, horizon)
        result = train_horizon(
            samples,
            horizon,
            args.output,
            resolved_test_cutoff,
        )
        results.append(result)
        print(
            json.dumps(
                {
                    "horizon": horizon,
                    "champion": result.champion,
                    "eligibleForActive": result.eligibleForActive,
                    "test": result.test,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    shadow_gates = {
        horizon: shadow_observation_gate(args.database, horizon)
        for horizon in HORIZONS
    }
    all_eligible = all(result.eligibleForActive for result in results)
    horizon_rollouts = {
        result.horizon: (
            "active"
            if args.rollout_status == "active"
            and result.eligibleForActive
            and shadow_gates[result.horizon]["passed"]
            else "shadow"
        )
        for result in results
    }
    active_horizons = [
        horizon for horizon, status in horizon_rollouts.items() if status == "active"
    ]
    rollout_status = (
        "active"
        if len(active_horizons) == len(results)
        else "mixed"
        if active_horizons
        else "shadow"
    )
    manifest = {
        "schema": "athena.crypto.forecast-model",
        "schemaVersion": "1.0",
        "modelVersion": args.model_version,
        "featureSchemaVersion": "crypto-forecast-features-v1",
        "featureRegistryVersion": FEATURE_REGISTRY["registryVersion"],
        "featureRegistrySha256": FEATURE_REGISTRY_SHA256,
        "featureNames": FEATURE_NAMES,
        "runtimeParityRequired": True,
        "classOrder": CLASS_ORDER,
        "rolloutStatus": rollout_status,
        "trainedAt": datetime.now(timezone.utc).isoformat(),
        "trainingPeriod": {
            "train": ["2021-01-01", "outcome_before_2024-01-01"],
            "selection": ["2024-01-01 + horizon embargo", "outcome_before_2024-07-01"],
            "calibration": ["2024-07-01 + horizon embargo", "outcome_before_2025-01-01"],
            "untouchedTest": [
                "2025-01-01 + horizon embargo",
                resolved_test_cutoff.isoformat(),
            ],
            "embargoBetweenSplits": "one full prediction horizon",
            "isolationControlReport": "24d",
            "purging": "all labels must end before the next split",
        },
        "datasetManifestSha256": latest_dataset_manifest(args.database),
        "costAssumptions": {
            "feeBpsPerSide": 10,
            "slippageBpsPerSide": 2,
            "paperNotionalUsdt": 100,
            "leverage": 0,
        },
        "promotionPolicy": {
            "bootstrapBalancedAccuracyDeltaLower95": ">0",
            "macroF1Delta": ">0",
            "brierSkill": ">0",
            "ece": "<=0.05",
            "selectiveCoverage": ">=0.20",
            "selectiveBalancedAccuracyDelta": ">=0.05",
            "subgroupMaximumRegression": "-0.05",
            "paperExpectedNetReturn": ">0",
        },
        "horizons": {
            result.horizon: {
                "artifact": result.artifact,
                "artifactSha256": result.artifactSha256,
                "inputName": result.inputName,
                "outputName": result.outputName,
                "runtimeContract": result.runtimeContract,
                "classOrder": CLASS_ORDER,
                "champion": result.champion,
                "calibration": result.calibration,
                "thresholds": result.thresholds,
                "featureMedians": result.featureMedians,
                "driverFeatureIndexes": result.driverFeatureIndexes,
                "eligibleForActive": result.eligibleForActive,
                "rolloutStatus": horizon_rollouts[result.horizon],
                "shadowObservationGate": shadow_gates[result.horizon],
                "predictionHeads": {
                    "direction": {
                        "version": "direction-v2",
                        "status": horizon_rollouts[result.horizon],
                        "eligibleForActive": result.eligibleForActive,
                    },
                    "returnQuantiles": result.returnQuantiles,
                    "futureVolatility": result.futureVolatility,
                    "currentRegime": {
                        "version": "deterministic-regime-v1",
                        "status": "shadow",
                        "directionIndependent": True,
                    },
                },
                "purging": result.purging,
            }
            for result in results
        },
    }
    (args.output / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    report = {
        "schema": "athena.crypto.forecast-training-report",
        "schemaVersion": "1.0",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "rolloutStatus": rollout_status,
        "allHorizonsEligibleForActive": all_eligible,
        "activeHorizons": active_horizons,
        "shadowObservationGates": shadow_gates,
        "horizons": {result.horizon: asdict(result) for result in results},
    }
    (args.output / "training-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "output": str(args.output),
                "rolloutStatus": rollout_status,
                "allHorizonsEligibleForActive": all_eligible,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
