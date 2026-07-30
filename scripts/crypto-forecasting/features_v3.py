"""Horizon-specific v3 feature contract shared by offline training checks."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
REGISTRY_PATH = (
    ROOT
    / "server"
    / "utils"
    / "cryptoForecasting"
    / "contracts"
    / "feature-registry-v3.json"
)
REGISTRY = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
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
FIVE_MINUTES = pd.Timedelta(minutes=5)


def _rolling_regression(
    series: pd.Series, window: int
) -> tuple[pd.Series, pd.Series]:
    values = series.astype(float)
    index = pd.Series(np.arange(len(values), dtype=float), index=values.index)
    sum_y = values.rolling(window).sum()
    sum_y2 = values.pow(2).rolling(window).sum()
    sum_global_xy = values.mul(index).rolling(window).sum()
    window_start = index - (window - 1)
    sum_x = window * (window - 1) / 2
    sum_x2 = window * (window - 1) * (2 * window - 1) / 6
    denominator_x = sum_x2 - sum_x**2 / window
    sum_local_xy = sum_global_xy - window_start * sum_y
    covariance = sum_local_xy - sum_x * sum_y / window
    slope = covariance / denominator_x
    average = sum_y / window
    slope_pct = 100 * slope / average.replace(0, np.nan)
    denominator_y = sum_y2 - sum_y.pow(2) / window
    r_squared = covariance.pow(2) / (
        denominator_x * denominator_y.replace(0, np.nan)
    )
    return slope_pct, r_squared.clip(lower=0, upper=1)


def _realized_volatility(close: pd.Series, window: int) -> pd.Series:
    return np.log(close / close.shift(1)).rolling(window).std(ddof=1)


def _wilder_rsi(series: pd.Series, period: int = 14) -> pd.Series:
    change = series.diff()
    gain = change.clip(lower=0)
    loss = -change.clip(upper=0)
    average_gain = gain.ewm(
        alpha=1 / period, adjust=False, min_periods=period
    ).mean()
    average_loss = loss.ewm(
        alpha=1 / period, adjust=False, min_periods=period
    ).mean()
    ratio = average_gain / average_loss.replace(0, np.nan)
    result = 100 - 100 / (1 + ratio)
    result = result.where(~((average_gain == 0) & (average_loss == 0)), 50)
    return result.where(average_loss.ne(0), 100)


def _atr_adx(frame: pd.DataFrame, period: int = 14) -> pd.DataFrame:
    high = frame["high"].to_numpy(dtype=float)
    low = frame["low"].to_numpy(dtype=float)
    close = frame["close"].to_numpy(dtype=float)
    length = len(frame)
    tr = np.full(length, np.nan)
    plus_dm = np.zeros(length)
    minus_dm = np.zeros(length)
    if length:
        tr[0] = high[0] - low[0]
    for index in range(1, length):
        tr[index] = max(
            high[index] - low[index],
            abs(high[index] - close[index - 1]),
            abs(low[index] - close[index - 1]),
        )
        up_move = high[index] - high[index - 1]
        down_move = low[index - 1] - low[index]
        plus_dm[index] = up_move if up_move > down_move and up_move > 0 else 0
        minus_dm[index] = (
            down_move if down_move > up_move and down_move > 0 else 0
        )
    atr = np.full(length, np.nan)
    plus_di = np.full(length, np.nan)
    minus_di = np.full(length, np.nan)
    dx = np.full(length, np.nan)
    adx = np.full(length, np.nan)
    if length > period:
        smooth_tr = np.nansum(tr[1 : period + 1])
        smooth_plus = plus_dm[1 : period + 1].sum()
        smooth_minus = minus_dm[1 : period + 1].sum()
        for index in range(period, length):
            if index > period:
                smooth_tr = smooth_tr - smooth_tr / period + tr[index]
                smooth_plus = (
                    smooth_plus - smooth_plus / period + plus_dm[index]
                )
                smooth_minus = (
                    smooth_minus - smooth_minus / period + minus_dm[index]
                )
            atr[index] = smooth_tr / period
            plus_di[index] = 0 if smooth_tr == 0 else 100 * smooth_plus / smooth_tr
            minus_di[index] = (
                0 if smooth_tr == 0 else 100 * smooth_minus / smooth_tr
            )
            denominator = plus_di[index] + minus_di[index]
            dx[index] = (
                0
                if denominator == 0
                else 100 * abs(plus_di[index] - minus_di[index]) / denominator
            )
        first_adx = period * 2 - 1
        if first_adx < length:
            adx[first_adx] = np.nanmean(dx[period : first_adx + 1])
            for index in range(first_adx + 1, length):
                adx[index] = (
                    adx[index - 1] * (period - 1) + dx[index]
                ) / period
    return pd.DataFrame(
        {
            "normalized_atr": atr / np.where(close > 0, close, np.nan),
            "adx": adx,
            "adx_slope": pd.Series(adx).diff(3).to_numpy(),
        },
        index=frame.index,
    )


def _money_flow(frame: pd.DataFrame) -> pd.DataFrame:
    spread = (frame["high"] - frame["low"]).replace(0, np.nan)
    multiplier = (
        (frame["close"] - frame["low"])
        - (frame["high"] - frame["close"])
    ) / spread
    money_flow_volume = multiplier.fillna(0) * frame["volume"]
    cmf = money_flow_volume.rolling(20).sum() / frame["volume"].rolling(
        20
    ).sum().replace(0, np.nan)
    typical = (frame["high"] + frame["low"] + frame["close"]) / 3
    raw = typical * frame["volume"]
    positive = raw.where(typical.diff() > 0, 0).rolling(14).sum()
    negative = raw.where(typical.diff() < 0, 0).rolling(14).sum()
    ratio = positive / negative.replace(0, np.nan)
    mfi = 100 - 100 / (1 + ratio)
    mfi = mfi.where(~((negative == 0) & (positive > 0)), 100)
    mfi = mfi.where(~((negative == 0) & (positive == 0)), 50)
    adl = money_flow_volume.cumsum()
    return pd.DataFrame(
        {
            "cmf20_1h": cmf,
            "mfi14_1h": mfi,
            "adl_slope_1h": adl.diff(3)
            / frame["volume"].rolling(3).sum().replace(0, np.nan),
            "rsi14_1h": _wilder_rsi(frame["close"]),
        },
        index=frame.index,
    )


def _resample(source: pd.DataFrame, rule: str) -> pd.DataFrame:
    return (
        source.resample(rule, label="left", closed="left")
        .agg(
            open=("open", "first"),
            high=("high", "max"),
            low=("low", "min"),
            close=("close", "last"),
            volume=("volume", "sum"),
            quote_volume=("quote_volume", "sum"),
            trade_count=("trade_count", "sum"),
            taker_buy_quote_volume=("taker_buy_quote_volume", "sum"),
        )
        .dropna()
    )


def _donchian_position(frame: pd.DataFrame, period: int) -> pd.Series:
    upper = frame["high"].shift(1).rolling(period).max()
    lower = frame["low"].shift(1).rolling(period).min()
    return (frame["close"] - lower) / (upper - lower).replace(0, np.nan)


def _bollinger_z(frame: pd.DataFrame, period: int) -> pd.Series:
    average = frame["close"].rolling(period).mean()
    deviation = frame["close"].rolling(period).std(ddof=0)
    return (frame["close"] - average) / deviation.replace(0, np.nan)


def _market_structure(frame: pd.DataFrame, window: int = 80) -> pd.Series:
    high = frame["high"].to_numpy(dtype=float)
    low = frame["low"].to_numpy(dtype=float)
    result = np.full(len(frame), np.nan)
    for end in range(window - 1, len(frame)):
        start = end - window + 1
        highs: list[float] = []
        lows: list[float] = []
        for index in range(start + 2, end - 1):
            local_high = high[index - 2 : index + 3]
            local_low = low[index - 2 : index + 3]
            if high[index] >= local_high.max():
                highs.append(high[index])
            if low[index] <= local_low.min():
                lows.append(low[index])
        if len(highs) < 2 or len(lows) < 2:
            continue
        if highs[-1] > highs[-2] and lows[-1] > lows[-2]:
            result[end] = 1
        elif highs[-1] < highs[-2] and lows[-1] < lows[-2]:
            result[end] = -1
        else:
            result[end] = 0
    return pd.Series(result, index=frame.index)


def _robust_seasonal_surprise(
    values: pd.Series, recent: int, week_bars: int = 7 * 24 * 12
) -> pd.Series:
    current = values.rolling(recent).sum()
    comparisons = pd.concat(
        [current.shift(week * week_bars) for week in range(1, 5)], axis=1
    )
    baseline = comparisons.median(axis=1, skipna=False)
    mad = comparisons.sub(baseline, axis=0).abs().median(axis=1, skipna=False)
    scale = (1.4826 * mad).where(mad > 0, baseline)
    return (current - baseline) / scale.replace(0, np.nan)


def _flow(source: pd.DataFrame, window: int) -> pd.Series:
    quote = source["quote_volume"].rolling(window).sum()
    taker = source["taker_buy_quote_volume"].rolling(window).sum()
    return 2 * taker / quote.replace(0, np.nan) - 1


def _market_cross_features(
    closes: pd.DataFrame, asset: str
) -> pd.DataFrame:
    others = [symbol for symbol in closes.columns if symbol != asset]
    market = np.exp(np.log(closes[others]).mean(axis=1))
    asset_close = closes[asset]
    asset_return = np.log(asset_close / asset_close.shift(1))
    market_return = np.log(market / market.shift(1))
    market_variance = market_return.rolling(30 * 24 * 12).var(ddof=0)
    covariance = asset_return.rolling(30 * 24 * 12).cov(market_return, ddof=0)
    return pd.DataFrame(
        {
            "relative_market_return_4h": np.log(
                asset_close / asset_close.shift(48)
            )
            - np.log(market / market.shift(48)),
            "relative_market_return_24h": np.log(
                asset_close / asset_close.shift(288)
            )
            - np.log(market / market.shift(288)),
            "relative_market_return_4d": np.log(
                asset_close / asset_close.shift(1_152)
            )
            - np.log(market / market.shift(1_152)),
            "market_correlation_30d": asset_return.rolling(
                30 * 24 * 12
            ).corr(market_return),
            "market_beta_30d": covariance / market_variance.replace(0, np.nan),
        },
        index=closes.index,
    )


def feature_frame_v3(
    frame: pd.DataFrame, *, assets: list[str] | None = None
) -> pd.DataFrame:
    closes = (
        frame.pivot(index="time", columns="symbol", values="close")
        .sort_index()
        .dropna()
    )
    outputs: list[pd.DataFrame] = []
    selected_assets = assets or ["BTC", "ETH", "SOL"]
    for asset in selected_assets:
        if asset not in closes:
            raise ValueError(f"missing_market_asset:{asset}")
        source = (
            frame.loc[frame["symbol"] == asset]
            .copy()
            .set_index("time")
            .sort_index()
        )
        features = pd.DataFrame(index=source.index)
        features["asset_eth"] = float(asset == "ETH")
        features["asset_sol"] = float(asset == "SOL")
        for name, window in [
            ("return_15m", 3),
            ("return_1h", 12),
            ("return_4h", 48),
            ("return_12h", 144),
            ("return_24h", 288),
            ("return_4d", 1_152),
            ("return_12d", 3_456),
        ]:
            features[name] = np.log(
                source["close"] / source["close"].shift(window)
            )
        for name, window in [
            ("realized_vol_1h", 12),
            ("realized_vol_4h", 48),
            ("realized_vol_24h", 288),
            ("realized_vol_4d", 1_152),
        ]:
            features[name] = _realized_volatility(source["close"], window)

        hourly = _resample(source, "1h")
        four_hourly = _resample(source, "4h")
        daily = _resample(source, "1d")
        for suffix, resampled in [
            ("1h", hourly),
            ("4h", four_hourly),
            ("24h", daily),
        ]:
            trend = _atr_adx(resampled).rename(
                columns={
                    "normalized_atr": f"normalized_atr_{suffix}",
                    "adx": f"adx_{suffix}",
                    "adx_slope": f"adx_slope_{suffix}",
                }
            )
            for column in trend:
                features[column] = trend[column].reindex(
                    features.index, method="ffill"
                )
        features["donchian_position_4h"] = _donchian_position(
            four_hourly, 20
        ).reindex(features.index, method="ffill")
        features["donchian_position_24h"] = _donchian_position(
            hourly, 20
        ).reindex(features.index, method="ffill")
        features["donchian_position_4d"] = _donchian_position(
            four_hourly, 24
        ).reindex(features.index, method="ffill")
        features["bollinger_z_4h"] = _bollinger_z(
            four_hourly, 20
        ).reindex(features.index, method="ffill")
        features["bollinger_z_24h"] = _bollinger_z(
            hourly, 20
        ).reindex(features.index, method="ffill")
        features["bollinger_z_4d"] = _bollinger_z(
            four_hourly, 24
        ).reindex(features.index, method="ffill")
        features["market_structure_4h"] = _market_structure(
            four_hourly
        ).reindex(features.index, method="ffill")
        features["market_structure_24h"] = _market_structure(
            hourly
        ).reindex(features.index, method="ffill")

        for suffix, window in [("1h", 12), ("4h", 48), ("24h", 288)]:
            base = source["volume"].rolling(window).sum()
            quote = source["quote_volume"].rolling(window).sum()
            features[f"vwap_distance_{suffix}"] = (
                source["close"] / (quote / base.replace(0, np.nan)) - 1
            )
        quote_mean_24h = source["quote_volume"].rolling(288).mean()
        features["volume_ratio_15m_4h"] = (
            source["quote_volume"].rolling(3).mean()
            / source["quote_volume"].rolling(48).mean()
        )
        features["volume_ratio_1h_24h"] = (
            source["quote_volume"].rolling(12).mean() / quote_mean_24h
        )
        features["volume_ratio_4h_24h"] = (
            source["quote_volume"].rolling(48).mean() / quote_mean_24h
        )
        features["volume_ratio_24h_4d"] = (
            source["quote_volume"].rolling(288).mean()
            / source["quote_volume"].rolling(1_152).mean()
        )
        features["volume_acceleration_1h"] = (
            source["quote_volume"].rolling(12).mean()
            / source["quote_volume"].rolling(24).mean()
        )
        features["volume_acceleration_4h"] = (
            source["quote_volume"].rolling(48).mean()
            / source["quote_volume"].rolling(96).mean()
        )
        features["robust_volume_surprise_1h"] = _robust_seasonal_surprise(
            source["quote_volume"], 12
        )
        features["robust_volume_surprise_4h"] = _robust_seasonal_surprise(
            source["quote_volume"], 48
        )
        features["trade_count_ratio_1h_24h"] = (
            source["trade_count"].rolling(12).mean()
            / source["trade_count"].rolling(288).mean()
        )
        features["trade_count_ratio_4h_24h"] = (
            source["trade_count"].rolling(48).mean()
            / source["trade_count"].rolling(288).mean()
        )
        for suffix, window in [
            ("15m", 3),
            ("1h", 12),
            ("4h", 48),
            ("12h", 144),
            ("24h", 288),
        ]:
            features[f"taker_flow_proxy_{suffix}"] = _flow(source, window)
        fifteen = _resample(source, "15min")
        fifteen_flow = (
            2
            * fifteen["taker_buy_quote_volume"]
            / fifteen["quote_volume"].replace(0, np.nan)
            - 1
        )
        for suffix, periods in [("1h", 4), ("4h", 16), ("12h", 48)]:
            persistence = np.sign(fifteen_flow).rolling(periods).mean()
            features[f"taker_flow_persistence_{suffix}"] = persistence.reindex(
                features.index, method="ffill"
            )
        features["taker_flow_acceleration_1h"] = features[
            "taker_flow_proxy_1h"
        ] - features["taker_flow_proxy_1h"].shift(12)
        features["taker_flow_acceleration_4h"] = features[
            "taker_flow_proxy_4h"
        ] - features["taker_flow_proxy_4h"].shift(48)
        flow = _money_flow(hourly)
        for column in ["cmf20_1h", "mfi14_1h", "adl_slope_1h"]:
            features[column] = flow[column].reindex(
                features.index, method="ffill"
            )
        cross = _market_cross_features(closes, asset).reindex(features.index)
        for column in cross:
            features[column] = cross[column]
        features["breakout_volume_interaction_4h"] = (
            (features["donchian_position_4h"] - 0.5)
            * 2
            * features["volume_ratio_4h_24h"]
        )
        features["breakout_volume_interaction_24h"] = (
            (features["donchian_position_24h"] - 0.5)
            * 2
            * features["volume_ratio_24h_4d"]
        )
        features["trend_adx_interaction_4h"] = (
            features["return_4h"] * features["adx_4h"]
        )
        features["trend_adx_interaction_24h"] = (
            features["return_24h"] * features["adx_24h"]
        )
        features["symbol"] = asset
        features["open"] = source["open"]
        features["high"] = source["high"]
        features["low"] = source["low"]
        features["close"] = source["close"]
        features["one_bar_return"] = np.log(
            source["close"] / source["close"].shift(1)
        )
        features["contiguous_run"] = (
            source.index.to_series().diff().ne(FIVE_MINUTES).cumsum().to_numpy()
        )
        features["contiguous_bars"] = (
            features.groupby("contiguous_run").cumcount() + 1
        )
        outputs.append(features.reset_index())
    return pd.concat(outputs, ignore_index=True)


def feature_family_indexes(names: list[str]) -> dict[str, list[int]]:
    result: dict[str, list[int]] = {}
    for index, name in enumerate(names):
        result.setdefault(FEATURE_FAMILIES[name], []).append(index)
    return result
