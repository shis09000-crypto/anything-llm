# Athena 加密货币量化预测前景与演进路线

> 2026-07-30 状态更新：公开工具现已切换为 `monitoring_only`。方向模型继续作为内部 Shadow 研究资产，普通 API、Agent 投影和最终报告不再公开方向、方向概率、收益目标或交易指令。当前完成边界与恢复条件见 [athena-crypto-forecasting-current-status.md](./athena-crypto-forecasting-current-status.md)。
>
> 状态：前景文件，不代表已承诺排期或自动交易授权
> 基线：`crypto-forecast-v1-20260729`，BTC/ETH/SOL，4h/24h/4d/12d/24d，全部 shadow
> 参考文件：`面向加密市场的主流量化系统构建指引.pdf`（2026-07-29 审阅，18 页）

## 1. 结论

指引的主要价值不是建议 Athena 立即接入更多框架，而是把一个预测工具应具备的完整闭环讲清楚：

1. 原始输入、标准化结果、质量状态和可用延迟必须可追溯。
2. 预测、信号、仓位和执行必须是相互隔离的层。
3. 离线训练和线上推理必须使用同一特征定义与时间可用性。
4. 回测必须同时验证统计有效性和真实执行成本。
5. 风险与数据质量层必须能够否决模型输出。
6. 每次预测都应带有可复算的证据身份证。

这些原则与 Athena 当前的 shadow、ML-DSA-65 工件验签、数据集清单、Python/Node 特征合同、概率校准、成本后晋级门槛方向一致，适合成为后续演进的长期约束。

但指引描述的是偏企业级最终形态。Athena 当前只有三个交易对、2 GiB 量化仓上限、约 2 GiB 可用内存预算，并且不做真实交易。不能直接照搬 ClickHouse + Iceberg + Redis + PostgreSQL + MLflow + Qlib + VectorBT + Backtrader 的完整技术栈，也不能长期保存全量逐笔和 L2 原始事件。

Athena 应采用“借规范、借验证方法、暂不借基础设施边界”的策略。

## 2. 当前能力基线

当前系统已经具备：

- Binance 官方月度 1 分钟数据校验、5 分钟压缩归档和持续增量采集。
- BTC/ETH/SOL 共享的三分类 Logistic 基线与 XGBoost 候选模型。
- 39 个趋势、量能、主动成交代理、相对强弱和季节性特征。
- 2021-2023 训练、2024 选择/校准、2025 至今未触碰测试集。
- 24 天 embargo、分块 bootstrap、分币种/波动制度检查。
- 多分类概率校准、Brier、ECE、Macro-F1、平衡准确率和成本后纸面结果。
- 每个周期独立晋级，失败时保持 shadow 并强制弃权。
- 100 USDT、无杠杆、包含手续费、滑点和可用资金费率的纸面结算。
- 数据集 SHA、模型 SHA、ONNX 运行合同和 ML-DSA-65 签名验证。
- 云端单实例租约、断线补齐、存储上限、磁盘保留线和低基数 Operations 观测。

当前仍缺少：

- 正式的特征注册表、可用延迟和字段级 lineage。
- 单次预测完整证据身份证。
- 收益分位数、未来波动率和市场状态等独立预测头。
- 可复用的向量化策略筛选器和事件驱动成交仿真器。
- 显式 purging、漂移检测、成本敏感度曲线和模型生命周期状态机。
- 可供用户查询预测历史、证据、结算结果和禁用原因的治理接口。
- 足够长的资金费率、OI、订单流和盘口历史，因而这些数据目前只能做旁证。

## 3. 指引内容采用决策

| 指引建议 | 决策 | Athena 采用方式 |
|---|---|---|
| 原始信封 + 标准化载荷 + 质量标记 | 立即采用 | 为 bar、候选旁证和预测定义统一元数据，不复制大体积 `raw` 正文 |
| 特征记录可用延迟、空值策略和 lineage | 立即采用 | 建立版本化 `FeatureSpec` 清单，并由 Python/Node 合同共同校验 |
| 预测、信号、仓位、执行分层 | 立即采用 | 当前只到预测与 paper 层；不新增真实下单能力 |
| walk-forward + purged split + embargo | 补强采用 | 保留固定未触碰测试集和 24d embargo，增加标签窗口级 purging |
| 单次预测证据身份证 | 立即采用 | 将模型、数据、特征、质量、驱动因素和结算引用绑定到 `prediction_id` |
| 方向、收益分位数、波动率、regime 多头输出 | 分阶段采用 | 先做独立轻量模型，不做一个不可解释的大型多任务网络 |
| VectorBT 粗筛 + 事件驱动精验 | 改造采用 | 先实现 Athena 自有 NumPy 筛选器和最小事件仿真器；框架仅作为离线可替换适配器 |
| 交易规则、费用、滑点、资金费率和最小单位 | 立即采用 | 将固定成本升级为按 symbol/time 的版本化成本快照 |
| 订单簿序列感知与缺口重建 | 条件采用 | 先用于实时旁证；达到历史覆盖与质量门槛后才进入模型 |
| Qlib workflow/recorder 思想 | 轻量采用 | 复用“实验、参数、指标、工件”结构，不常驻部署 Qlib/MLflow |
| ClickHouse 时序层 | 暂缓 | Operations ClickHouse 与量化数据继续隔离；SQLite/压缩分片不足时再评估独立时序层 |
| Parquet + Iceberg 数据湖 | 暂缓 | 先把月度压缩分片升级为 Parquet；只有多版本模式演进需求出现后再评估 Iceberg |
| Redis 在线 Feature Store | 不采用 | 三个交易对可继续使用进程内状态和 SQLite WAL |
| CCXT 统一接入 | 暂缓 | Binance/Gate 数量少，原生接口能保留序列与专有字段；扩到第三家以上再引入 |
| 长期保存全部逐笔与 L2 增量 | 不采用 | 与 2 GiB 上限冲突，改为聚合保存和异常窗口采样 |
| DeepLOB/TFT | 研究候选 | 只有数据质量、样本量和消融增益达标后才训练 |
| FinRL/PPO/SAC 等强化学习 | 不进入生产路线 | 仅允许未来做仓位或执行实验，不能决定方向或直接下单 |
| 新闻、社媒、全量链上数据 | 暂缓 | 成本、噪声和时间对齐风险高，低频候选特征必须先做未触碰测试 |

## 4. 低成本目标架构

```text
Binance 官方历史 + Binance 实时 + Gate 旁证
  -> 质量信封与时间可用性
  -> SQLite WAL（180 天在线数据）
  -> 月度压缩 Parquet/CSV 分片（历史训练）
  -> 版本化 FeatureSpec + Python/Node 同构计算
  -> 方向 / 收益分位数 / 波动率 / regime 独立模型
  -> 概率校准与风险否决
  -> shadow prediction passport
  -> paper outcome + 回测/漂移评估
  -> crypto_market_snapshot 的受约束解释
```

以下组件在当前规模下不常驻：

- Redis
- 独立 PostgreSQL/Timescale
- 独立量化 ClickHouse
- Iceberg catalog
- MLflow 服务
- Qlib 在线服务
- GPU 推理服务
- 深度学习或 RL 常驻训练任务

## 5. 下一阶段：可信数据与特征注册

### 5.1 Market Data Envelope

为当前已保存的数据增加统一信封，至少包含：

```json
{
  "eventId": "stable-id",
  "source": "binance",
  "marketType": "spot",
  "symbol": "BTCUSDT",
  "eventType": "bar_5m",
  "exchangeTs": 0,
  "receivedTs": 0,
  "availableAtMs": 0,
  "schemaVersion": "market-event-v1",
  "quality": {
    "delayed": false,
    "backfilled": false,
    "gapDetected": false,
    "deduped": true,
    "formingCandleExcluded": true
  }
}
```

不在 SQLite 中复制完整 `raw` 载荷。原始逐笔和盘口仅在下列情况下保存短窗口压缩样本：

- 序列缺口前后
- 价格或成交量异常
- 预测高置信但随后快速失效
- 交易所之间出现异常价差
- 人工触发的事故取证

### 5.2 FeatureSpec

每个正式特征必须登记：

- `featureName`
- `version`
- `frequency`
- `lookbackBars`
- `sourceDependencies`
- `availableDelayMs`
- `nullPolicy`
- `trainingImplementation`
- `runtimeImplementation`
- `onlineOfflineParity`
- 合法范围和最大 NaN 比例
- 是否允许参与模型、仅旁证或已退役

模型清单应引用 `featureRegistrySha256`，而不仅是特征名称数组。

### 5.3 验收门槛

- Python/Node 对同一快照逐值一致。
- 任一特征不得使用 `availableAt` 晚于决策时点的数据。
- 标签窗口与训练样本显式 purge。
- 缺失数据不允许静默零填充。
- 回填、实时和重启补齐产生相同特征。

## 6. 准确度提升路线

### 6.1 从单一方向分类扩展为四个独立问题

1. 方向概率：保留 up/range/down。
2. 收益分位数：预测 q10/q50/q90，而不是只给目标方向。
3. 未来波动率：预测波动大小，用于判断方向信号是否值得执行。
4. 市场状态：趋势、震荡、高波动、流动性收缩等有限状态。

四个头独立训练、独立校准、独立晋级。一个头失败不能污染其他头。

最终方向仍由方向模型给出，其他头只可以：

- 降低置信度
- 触发弃权
- 调整 paper 风险预算
- 解释为何当前预测不可执行

### 6.2 优先模型

优先级如下：

1. Logistic/EWMA/简单动量等可解释基线。
2. XGBoost/LightGBM/CatBoost 中的小型树模型候选。
3. 分位数树模型和轻量 regime 模型。
4. regime-conditioned ensemble。
5. 数据充分后才评估 TCN/TFT。

DeepLOB 只有在每个目标交易对至少积累 180 天连续、可重放、序列完整的 L2 数据，并且在未触碰测试集上显著优于聚合订单流基线时才进入候选。

强化学习不用于方向预测。未来如果研究，只能用于 paper 环境下的仓位调整或执行切片。

### 6.3 量能与微观结构

下一轮最有希望增加独立信息的特征不是更多均线，而是：

- 同时段季节性成交量异常
- 成交速度和成交笔数加速度
- taker buy/sell 不平衡
- CVD 与价格背离
- spread、microprice、top-N depth imbalance
- 突破时的深度消耗和成交跟随
- OI 与价格四象限
- funding、basis 与 OI 的联合拥挤状态

这些特征必须按证据族做消融，不能把高度相关指标简单投票。

## 7. 双层回测，但不引入重型常驻服务

### 7.1 快速筛选层

实现可替换的向量化研究接口，用于：

- 特征单调性和 RankIC
- 参数敏感度
- 阈值/覆盖率曲线
- 成本敏感度
- 多币种、多周期快速筛选

第一版优先使用 Athena 自有 NumPy/Pandas 实现。VectorBT 可作为按需离线适配器，但不能成为模型工件或生产推理的必需依赖。其社区版本带 Commons Clause，未来若用途改变必须重新审查许可。

### 7.2 精细仿真层

实现小型事件驱动 paper simulator，至少支持：

- 下一可交易 bar 开盘成交
- maker/taker 费用版本
- spread 与深度驱动滑点
- 最小下单额、价格精度和数量步长
- 资金费率
- 部分成交与拒绝
- 数据缺口时禁止成交
- 无杠杆作为默认且当前唯一允许模式

Backtrader 可用于校验设计，但不直接采用指引中的 10 倍杠杆示例。该示例与 Athena 当前“100 USDT、无杠杆、不下单”的边界冲突。

## 8. Prediction Passport

每次预测应保存：

```json
{
  "predictionId": "stable-id",
  "symbol": "BTCUSDT",
  "horizon": "4h",
  "decisionAt": "ISO-8601",
  "dataAvailableThrough": "ISO-8601",
  "modelVersion": "crypto-forecast-v2",
  "modelArtifactSha256": "...",
  "datasetManifestSha256": "...",
  "featureRegistrySha256": "...",
  "featureSnapshotSha256": "...",
  "calibrationVersion": "...",
  "costModelVersion": "...",
  "quality": {
    "coverage": 0,
    "freshnessMs": 0,
    "gapDetected": false
  },
  "forecast": {
    "direction": {"up": 0, "range": 0, "down": 0},
    "returnQuantiles": {"q10": null, "q50": null, "q90": null},
    "futureVolatility": null,
    "regime": null
  },
  "decision": {
    "status": "shadow",
    "abstained": true,
    "reasons": []
  },
  "drivers": [],
  "warnings": [],
  "outcomeRef": null
}
```

Passport 不保存提示词、模型自由文本或私人账户数据。DeepSeek 只能读取这个结构和现有 supporting evidence 生成解释。

## 9. 治理状态机

每个周期和每个预测头独立维护：

```text
candidate
  -> offline_validated
  -> shadow
  -> paper_eligible
  -> active
  -> degraded
  -> suspended
  -> retired
```

硬否决条件：

- 数据缺口或时间回退
- 特征版本/顺序不一致
- Python/Node parity 失败
- 模型 SHA 或 ML-DSA-65 验签失败
- 数据新鲜度超限
- 校准、漂移或成本后表现低于阈值
- 旁证覆盖不足且该模型声明依赖旁证

`degraded` 可以自动恢复；`suspended` 和 `retired` 需要明确的人为晋级或替换流程。

## 10. 存储与基础设施升级触发条件

继续使用 SQLite WAL + 月度压缩分片，直到出现任一条件：

- 量化域长期超过 1.2 GiB，且清理 180 天 1 分钟数据后仍持续增长。
- 交易对超过 20 个。
- 持续保存逐秒盘口聚合，单机查询影响线上采集。
- 回测快照生成 p95 超过 5 分钟。
- SQLite 写锁或恢复时间影响 Runtime Coordinator。

达到触发条件后，优先顺序为：

1. 将历史月度分片统一为 Parquet。
2. 将冷历史迁移到低成本对象存储。
3. 评估独立量化 ClickHouse，而不是复用 Operations ClickHouse。
4. 只有需要模式演进、快照和多引擎并发访问时才引入 Iceberg。

不得把量化行情写入 Operations ClickHouse，也不得为了接入框架突破 2 GiB 量化仓和 12 GiB 构建保留线。

## 11. 分阶段路线

### 阶段 A：证据与时间正确性

- Market Data Envelope
- FeatureSpec 注册表
- feature snapshot SHA
- 标签窗口 purging
- Prediction Passport v1
- 成本模型版本化

完成标准：任意预测可以仅凭保存的清单和数据快照重新计算。

### 阶段 B：预测目标扩展

- 收益分位数头
- 未来波动率头
- regime 头
- 各头独立校准与晋级
- 成本/阈值/覆盖率曲线

完成标准：新增预测头在未触碰测试集上优于对应简单基线，且不会提高方向误确认率。

### 阶段 C：双层回测

- 向量化快速筛选
- 最小事件驱动仿真
- symbol 规则与动态成本
- 资金费率和部分成交
- paper 结果与预测 Passport 关联

完成标准：同一信号在两层回测中的差异可解释，精细仿真结果不优于粗筛结果。

### 阶段 D：微观结构入模评估

- 连续订单流和盘口质量统计
- 异常窗口原始事件采样
- 180 天覆盖门槛
- 证据族消融
- 漂移与数据污染演练

完成标准：新增证据在未触碰测试集上产生稳定增益，且收益不是由单一币种或单一行情制度贡献。

### 阶段 E：受控集成

- regime-conditioned ensemble
- 查询型预测/证据/治理 API
- 前端预测卡、证据页和时间尺度矩阵
- 仍保持 shadow/paper 默认

只有现有严格晋级门槛和长期 shadow 观察同时通过，某个周期才允许独立 active。

## 12. 明确不做

- 不购买数据源。
- 不新增服务器。
- 不把本机变为常驻采集或推理节点。
- 不执行真实交易。
- 不允许 LLM 决定预测方向。
- 不把技术指标投票包装成概率。
- 不使用未来不可知的 OI、资金费率、新闻或链上数据。
- 不因为模型复杂度更高而降低晋级门槛。
- 不将确定性场景、斐波那契或支撑阻力伪装成已校准概率。
- 不在当前阶段引入深度学习、RL 或企业级数据湖全栈。

## 13. 参考资料与采用说明

- 原始指引：`/Users/shijie/Downloads/面向加密市场的主流量化系统构建指引.pdf`
- [Qlib Workflow](https://qlib.readthedocs.io/en/stable/component/workflow.html)：采用实验记录与工件闭环思想，不部署整套在线服务。
- [Qlib Recorder](https://qlib.readthedocs.io/en/stable/component/recorder.html)：作为轻量实验/模型注册结构参考。
- [Binance Spot WebSocket](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/ws-streams/~)：订单流、book ticker、depth 更新速度与字段定义。
- [Binance 本地订单簿维护](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/How-to-manage-a-local-order-book-correctly)：序列、快照和增量重建原则。
- [VectorBT Portfolio API](https://vectorbt.dev/api/portfolio/base/)：只作为可替换的离线向量化研究参考。
- [VectorBT 仓库与许可](https://github.com/polakowo/vectorbt)：社区版为 Apache 2.0 with Commons Clause，不能默认视作无限制商业依赖。
- [Backtrader Slippage](https://www.backtrader.com/docu/slippage/slippage/) 与 [Commission](https://www.backtrader.com/docu/commission-schemes/commission-schemes/)：用于检查事件仿真的成本语义。
- [ClickHouse 增量物化视图说明](https://clickhouse.com/blog/common-getting-started-issues-with-clickhouse)：仅作为未来独立时序层参考。
- [FinRL-X](https://arxiv.org/abs/2603.21330)：参考研究、回测和部署一致性的分层，不进入当前生产依赖。

## 14. 最终判断

这份指引可以作为 Athena 量化工具的长期方向参考，但不能作为直接采购或实施清单。

对当前系统最有价值的近期工作依次是：

1. 特征时间可用性和 lineage。
2. Prediction Passport。
3. 显式 purging 与成本模型版本化。
4. 收益分位数、波动率和 regime 独立预测头。
5. 低成本双层回测。
6. 满足历史覆盖后再评估微观结构入模。

这条路线优先解决“预测是否真实、是否可复算、是否能在成本后成立”，而不是追求模型数量或技术栈规模。
