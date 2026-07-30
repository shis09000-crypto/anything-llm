# Athena 黄金 GQSS V1 当前状态与后续改造方向

更新时间：2026-07-30

生产版本：`gold-cftc-release-v2-20260730T145816Z`

## 当前结论

`gold_market_analysis({})` 当前是可用的黄金市场数据监测与确定性分析工具，不是已训练、已校准或已通过前瞻验证的预测模型。

- 可以整理并判断当前宏观、CFTC 持仓、ETF、跨市场和波动状态。
- 可以在有合格 XAU/USD K 线时计算 GQSS 技术与波动因子。
- 公开结果禁止输出未来方向、方向概率、目标价格和交易指令。
- Shadow 研究头保持 `candidate_untrained + abstained`。
- 当前没有可用于声称“预测准确率”的已结算预测样本。

因此：

- 作为监测分析工具：可用，但因 Twelve Data 尚未配置而处于 `partial/provider_not_configured`。
- 作为预测或回测系统：尚不可用，准确率为 `not_applicable`，不能用当前状态推导命中率。

## 已完成能力

### 数据与公式

- 65 项版本化 GQSS 因子注册表。
- XAU/USD 5 分钟、日线以及派生 1 小时、4 小时、自然周线合同。
- FRED 美元、实际利率、收益率、通胀补偿、VIX、GVZ 和 WTI 状态。
- COMEX 黄金 CFTC Disaggregated COT 持仓比例和 156 周拥挤度。
- GLD/IAU、SGE、USD/CNY 和金银比旁证。
- SMA、EMA、RSI、MACD、Donchian、ATR、ADX、BOLL、Parkinson 波动率、RV、HAR、下行半方差、BPV 和跳跃强度。
- 形成中 K 线排除、缺失不补零、无集中成交量时不伪造 OBV/CMF/VPIN。

### 真实性与治理

- 结构化结果、数据清单和公式版本均带 SHA-256。
- 公开 Shadow 结果删除方向、概率、收益分位数和交易指令。
- 确定性中文报告中的判断引用结构化字段路径。
- Node 24、OpenSSL 3.5 和 ML-DSA-65 运行能力已在生产候选及现役容器验证。

### CFTC 点时修复

旧实现将所有报告日固定加三天并标记为 `exact`，会在节假日、周一报告日和政府停摆期间造成未来数据泄漏。

当前实现：

- 使用版本化 `cftc-release-calendar-v1`。
- 官方特殊公告确认的实际发布时间标记为 `exact`。
- 官方年度计划中的节假日发布时间标记为 `official_schedule`。
- 其余历史日期按下一个周五 15:30 美东时间保守估算，并明确标记 `estimated`。
- 未知历史发布时间不再冒充精确点时数据。
- 生产黄金仓 134 条 CFTC 记录已完成幂等迁移；17 条发布时间后移，最大修正 47.042 天。
- 修复后 `quick_check=ok`、重复观察时点为 0、旧版 provider 行为 0、二次 dry-run 待修复数为 0。

## 当前数据覆盖

| 数据族 | 当前状态 | 能否进入公开分析 | 能否用于预测训练 |
| --- | --- | --- | --- |
| Gold API 当前价格 | available | 是，交叉参考 | 否，历史不足 |
| FRED 宏观序列 | available | 是 | 需保守发布时间合同 |
| CFTC COT | available | 是，持仓风险观察 | 仅允许 `exact` 或经审计的点时样本 |
| GLD/IAU | partial/available | 是，旁证 | 历史覆盖不足 |
| SGE | 间歇性超时 | 有数据时使用 | 否 |
| Twelve Data XAU/USD | not_configured | 否，K 线为空 | 否 |
| 订单簿、真实量能、期权曲面 | unavailable | 明确缺失 | 否 |

## 回测能力与准确率

当前仓中不存在以下对象：

- 已训练方向模型。
- 收益分位数模型。
- 已签名模型工件。
- 历史 Prediction Passport。
- 到期结算标签与交易成本结果。
- 前瞻 Shadow 预测样本。

因此当前不能计算 Accuracy、Balanced Accuracy、Macro-F1、MCC、Brier、ECE、成本后收益或最大回撤。任何将当前监测状态写成“预测准确率”的行为都属于不真实表述。

## 后续改造顺序

### 1. 补齐主行情

- 通过既有加密秘密边界配置 Twelve Data 免费密钥。
- 实际验证 XAU/USD 5 分钟和日线权限、额度与历史深度。
- 回填时只保存规范化已收盘 K 线、时间质量和 SHA。
- 保持黄金域不超过 512MiB、云盘至少保留 12GiB。

### 2. 建立独立历史审计器

- 从原始规范化 K 线独立生成标签、成本和评价指标。
- 不复用训练侧的标签、收益或成本函数。
- 强制 `availableAtMs <= decisionAtMs`。
- CFTC `estimated` 样本默认不得进入点时模型输入。
- 输出最好、最差、分制度、分成本和置信区间结果。

### 3. 训练永久 Shadow 候选

- 下一交易日与下一周分别训练 Logistic/ElasticNet 基线和小型 XGBoost。
- 仅使用 development 数据研究，calibration 数据校准，historical audit 数据隔离。
- 先完成模型、Registry、校准器和选择策略的 ML-DSA-65 签名，再挂载审计数据。
- 历史回测最多证明“值得继续 Shadow”，不得直接激活。

### 4. 前瞻验证

- 公开工具继续不显示方向。
- 保存前瞻 Shadow Passport 和到期结算。
- 样本量、校准、成本后收益、稳定性和数据时间合同全部通过后，是否开放预测仍需单独审批。

## 硬边界

- 未配置 Twelve Data 或历史 K 线不足时，不得宣布完整验收。
- 未训练、未签名或未校准时，不得输出预测准确率。
- 历史审计失败时不得激活。
- 不得以 OHLC 推算量能、订单簿、VPIN 或机构行为。
- 不新增付费数据、真实交易、账户访问或未经审计的数据抓取源。
