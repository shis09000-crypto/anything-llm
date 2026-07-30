# Athena low-cost crypto forecasting

This pipeline is read-only. It covers BTC/USDT, ETH/USDT, and SOL/USDT and
never sends an exchange order. Production starts in `shadow` and therefore
does not expose a directional prediction.

## Cloud data collection

The application Runtime Coordinator owns a single SQLite lease and collects
closed Binance one-minute bars, complete five-minute aggregates, Gate
derivatives candidates, and daily Coin Metrics/DefiLlama candidates. The
default persistent root is:

```text
/app/server/storage/production/crypto-forecasting
```

The store stops backfill at 2 GiB or when free disk falls below 12 GiB.
Historical five-minute archives are produced from checksum-verified official
Binance one-minute monthly files:

```bash
node server/scripts/crypto-forecast-backfill.js \
  --root=/app/server/storage/production/crypto-forecasting \
  --from=2021-01 --to=2026-06 --apply
```

The command is a dry run without `--apply`.

The v3 cost and derivative evidence contract is populated separately so public
futures data can never be mistaken for spot OHLCV:

```bash
node server/scripts/crypto-forecast-derivatives-backfill.js \
  --root=/app/server/storage/production/crypto-forecasting \
  --from=2021-01 --to=2026-06 \
  --metrics-from=2025-01-01 --metrics-to=2026-06-30 \
  --apply
```

This verifies every official checksum, stores contract/mark/index/premium
klines, funding rates, and public metrics in dedicated SQLite tables, and
reports the 180-day coverage and gap gates. Raw ZIP files are not retained.

## On-demand offline training

Create a consistent read-only cloud snapshot outside the persistent store:

```bash
node server/scripts/export-crypto-forecast-dataset.js \
  --root=/app/server/storage/production/crypto-forecasting \
  --output=/tmp/crypto-forecast-training.db
```

Keep the database on the cloud host whenever possible. Mount the frozen
snapshot read-only into a resource-limited, one-off training container, verify
the reported SHA-256, and delete the temporary snapshot after the audit. A
local copy is allowed only for an explicitly requested training run and must
not become a resident collector.

```bash
cd scripts/crypto-forecasting
uv sync --no-cache
uv run --no-sync python -m unittest -v test_contract.py
uv run --no-sync python train.py \
  --database=/temporary/crypto-forecast-training.db \
  --output=/temporary/crypto-forecast-v1 \
  --model-version=crypto-forecast-v1 \
  --rollout-status=shadow
```

For v3, keep the currently verified v2 model available so the research-only
`4d`, `12d`, and `24d` artifacts can be copied without retraining or changing
their history:

```bash
uv run --no-sync python train_v3.py \
  --database=/temporary/crypto-forecast-training.db \
  --legacy-model-root=/temporary/verified-v2-model \
  --output=/temporary/crypto-forecast-v3 \
  --model-version=crypto-forecast-v3-YYYYMMDD
```

V3 trains only `4h` and `24h`. Each horizon receives its own feature order,
12 paired opportunity/direction candidates, four expanding selection folds,
separate 2024 calibration and threshold windows, and an untouched 2025+
test. The training report contains the duplicate filter, family ablation,
conditional references, cost-adjusted bootstrap interval, subgroup guards,
and the exact reason a horizon remains Shadow.

V4 keeps v3 as the comparison baseline and adds fold-local feature selection,
dynamic-band versus triple-barrier promotion, market-state, future-volatility,
and tail-risk heads. Every v4 horizon remains Shadow regardless of its
training report:

```bash
uv run --no-sync python train_v4.py \
  --database=/temporary/crypto-forecast-training.db \
  --legacy-model-root=/temporary/verified-v3-model \
  --output=/temporary/crypto-forecast-v4 \
  --model-version=crypto-forecast-v4-YYYYMMDD
```

After ML-DSA-65 signing, produce two replays on the exact same audit window:

```bash
node server/scripts/crypto-forecast-v4-replay.js \
  --database=/temporary/crypto-forecast-training.db \
  --model-root=/temporary/crypto-forecast-v4 \
  --output=/temporary/v4-hourly.jsonl \
  --from=2025-01-01T00:00:00Z --cadence=hourly --trace-limit=50

node server/scripts/crypto-forecast-v4-replay.js \
  --database=/temporary/crypto-forecast-training.db \
  --model-root=/temporary/verified-v3-model \
  --output=/temporary/v3-hourly.jsonl \
  --from=2025-01-01T00:00:00Z --cadence=hourly --trace-limit=0
```

The final report must come from the independent implementation, not the
training report:

```bash
uv run --no-sync python independent_audit_v4.py \
  --database=/temporary/crypto-forecast-training.db \
  --model-root=/temporary/crypto-forecast-v4 \
  --replay=/temporary/v4-hourly.jsonl \
  --v3-replay=/temporary/v3-hourly.jsonl \
  --output=/temporary/crypto-forecast-v4-independent-audit
```

The historical audit is explicitly `historical_semi_blind`. A passing result
can only be `PASS_WITH_LIMITATIONS`; `4h` still needs 60 prospective Shadow
days and `24h` needs 120 before either can be considered for activation.

Delete the local database snapshot after training. Upload only the ONNX files,
manifest, and training report to a candidate directory below the cloud
forecasting root.

## Post-quantum signing and promotion

On the production Node 24/OpenSSL 3.5 runtime, sign and atomically promote the
candidate:

```bash
node server/scripts/sign-crypto-forecast-model.js \
  --root=/app/server/storage/production/crypto-forecasting \
  --candidate=/app/server/storage/production/crypto-forecasting/models/candidate-v1 \
  --promote
```

Before ML-DSA-65 signing, this command verifies every artifact SHA and runs a
Python-to-Node ONNX probability contract embedded in the manifest. A failed
active model falls back only to a separately verified previous directory.

Activation remains per horizon. V3 retains its existing policy. V4 requires
every offline gate plus 60 prospective Shadow days for `4h` and 120 days for
`24h`. Missing historical funding coverage is a hard promotion blocker, not
an assumed zero cost.
