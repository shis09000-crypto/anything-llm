# Athena 微模块化落地与验收状态

日期：2026-07-31

## 结论

Athena 已完成微模块架构的代码级底座和本地自动化验收。当前版本具备独立运行角色、模块清单、持久运行状态、Tool/Crypto 隔离、远程 Key Custody 首个生产域以及严格的生产退休门禁。

这不等于旧单体已经可以在生产退休。生产 PostgreSQL/NATS/S3 迁移、真实蓝绿流量演练、备份恢复和连续七天零旧读取仍必须产生证据，门禁才会允许进入 retirement。

## 当前模块基线

- 20 个 `ModuleManifest v1`
- 32 个唯一 RPC 契约
- 18 个唯一公共路由所有者
- 16 个唯一数据库 Schema 所有者
- 20 个唯一服务身份
- 20 个业务微模块均有独立 Compose 服务、Docker build target 和运行角色
- 25 项密码资产纳入盘点

模块契约审计会拒绝：

- 重复 RPC provider
- 重复公共路由所有者
- 重复 Schema 所有者
- 重复服务身份
- 未知调用方
- 缺失 RPC provider
- 模块依赖环
- 清单指向不存在的源码

## 分阶段完成度

### M0：契约与边界

状态：代码级完成。

- 建立 `ModuleManifest v1`、事件信封、主体断言和 Tool Invocation 契约。
- Operations 服务图由 Manifest 动态生成。
- 敏感事件字段在进入 NATS/Operations 前被拒绝。
- CI 可执行 `yarn check:micro-modules`。

### M1：数据与分布式底座

状态：实现完成，生产迁移待执行。

- PostgreSQL Main/Auth 与 16 个逻辑 Schema 已有生成、校验和最小权限角色基础。
- SQLite → PostgreSQL 快照、单调 CDC、checkpoint、写屏障、校验与 reverse-shadow 复用既有迁移链。
- NATS JetStream、S3/MinIO、mTLS 和 OTel 配置在分布式拓扑下 fail-closed。
- SQLite 与 PostgreSQL Prisma Schema 均已通过本地校验。

生产仍需证明：

- Main/Auth 快照完整
- CDC lag 为零
- 行数、主键、外键、分块哈希、Chat Hash Chain 和 Sync 投影零差异
- 内容对象覆盖率 100%
- 备份恢复通过
- reverse-shadow 连续观察至少七天

### M2：低风险运行角色

状态：代码级完成。

已独立：

- Web
- Collector
- Reader Worker
- Background Worker
- Scheduler
- Realtime Gateway
- Operations Plane

云端分布式配置会拒绝 Reader 进程内回退、memory transport、SQLite 权威和本地对象存储。

### 独立物理运行时收口

状态：代码级完成，真实容器拓扑待独立预生产主机验收。

本轮补齐此前仍由 API 进程代报 readiness 的四个逻辑模块：

- `authentication`：独立 Identity 运行时，提供受 mTLS 保护的会话 introspection；只返回最小主体断言，不返回 JWT、设备密钥或 Root。
- `knowledge-ingest`：独立摄取控制运行时，复用现有 Collector/Reader 队列，不复制解析状态机。
- `rag`：独立 RAG 运行时；API、Chat 和 Agent 通过远程 provider 访问，分布式 cutover 后禁止回退到进程内向量实现。
- `operations-shadow-agents`：独立只读分析运行时；Operations Plane 通过受限内部接口读取评估结果，故障时只降级运维建议，不影响业务 readiness。

API 不再为 Authentication、Knowledge Ingest 或 RAG 伪造本地探针。Edge、Collector、Reader、Realtime 及上述运行时均拥有独立 `/ready`、`/metrics`、服务身份和 Prometheus mTLS target。

### 独立预生产部署门禁与 Edge 入口

状态：部署包已完成，等待合格的独立预生产主机。

- 部署前新增 `athena.preproduction-host-admission:v1`，在生成密钥或构建镜像前验证独立 HTTPS 域名、Docker Engine、Compose v2、Buildx、amd64、最低 4 vCPU/12 GiB/40 GiB，以及生产容器和生产数据目录未与预生产共址。
- Compose 内置独立 Caddy Edge，监听 80/443，并使用预生产专属证书状态卷；`edge-web` readiness 会穿过 Caddy → Web，而非仅检查容器内部页面。
- 预生产资格拆成两个状态：`operationalReady` 表示隔离拓扑可以运行；`productionCutoverReady` 仍要求逻辑 Schema 和共享存储均已成为权威路径。
- 正式 cutover evidence 继续严格拒绝 `ATHENA_MODULE_SCHEMA_CUTOVER=false` 或 `ATHENA_SHARED_STORAGE_CUTOVER=false`，运行就绪不会被误当成生产切换授权。

当前开发机准入实测为 fail-closed：无 Docker Engine/Compose/Buildx，且目标文件系统只有约 7.3 GiB 可用空间，未达到 40 GiB 门槛。因此本轮没有在开发机伪造容器或真实预生产通过结论，也没有使用现有生产主机承载该拓扑。

### 统一 AI 运维中心兼容性

状态：微模块运行观测链路已完成代码级收口，真实分布式基础设施验收待预生产执行。

- API 在 `Operations Plane` 独立部署后通过 API 服务身份和 mTLS 读取远程权威状态，不再读取未启动的本地 singleton。
- Chat、Agent、Tool、Crypto、Scheduler、Reader、Background、Realtime 和 API 进程会将脱敏语义事件批量转发至独立 Operations Plane；失败时使用有界队列和指数退避，不阻塞业务请求。
- 各独立 Node 运行角色定期发送 `module.telemetry.heartbeat`；Operations health 会展示已观测 producer、最后事件时间和 stale 状态，用于识别“模块存活但事件链路断开”。
- Operations Plane 每 15 秒主动探测已配置模块的 Manifest readiness endpoint，并校验 `moduleId`、版本和 Manifest fingerprint。
- Operations Plane 同时以权威只读探针监测 9 个基础设施节点：PostgreSQL Main/Auth、NATS JetStream、S3/MinIO、ClickHouse、OTel Collector、向量数据库、模型 Provider、Embedding Provider 和后量子安全控制。基础设施状态不再依赖“最近出现过事件”的推断。
- S3 健康探针执行真实 `HeadBucket`；数据库执行 Main/Auth `SELECT 1`；RAG 运行时执行向量 heartbeat 并验证 Embedding 合约；模型网关只验证 Provider 合约，不产生付费推理请求。
- 状态图优先采用实时探针结果；事件时间线只作为未配置探针模块的观测证据，不再把“最近有成功事件”误当作当前健康。
- `/api/operations/services` 返回每个模块的部署契约和实时状态。
- `/api/operations/state-graph` 返回模块、基础设施、Agent 和依赖爆炸半径。
- `/api/operations/flows` 按 `operationId/clientTurnId/invocationId/toolCallId/sourceActionId/requestId` 聚合跨模块流程，显示完成、失败、运行中、耗时、经过模块和终态完整性。
- `/api/operations/timeline` 与 `/api/operations/explain` 保留 ClickHouse → NATS → recent buffer 的完整性标记和原有相关性字段。
- 模块状态变化产生 `module.health.changed` 元数据事件，可继续被原有 Monitoring/RCA Shadow Agent 检测；事件不包含凭据、Root、DEK、余额或完整工具结果。
- `isolated-degraded` 模块故障只在图中标记对应能力及影响范围，不会把主系统 readiness 直接拉成 `runtime_not_ready`。

### M3：Chat、Agent 与 Model Gateway

状态：代码级完成。

- Chat 和 Agent 使用持久 run/event/sequence。
- 客户端使用 `runId + lastSequence` 进行补发，不以连接生命周期取消服务端运行。
- drain 停止接收新 run，并等待在途 run。
- Agent 的 complete/stream 已进入 Model Gateway。
- Agent Runtime 使用纯远程 Provider 代理，不再构造本地模型客户端。
- Agent 切换后若仍挂载模型 API Key，生产启动会 fail-closed。
- 不支持原生 Agent streaming 的 Provider 由 Model Gateway 使用 complete 安全降级。

注意：Chat Runtime 仍复用现有 Provider 的本地上下文压缩、token window 和流处理方法；模型网络调用已可切到 Gateway。后续生产密钥拆分必须验证 Chat 容器不保留 Provider 凭据。

### M4：Tool 与 Crypto

状态：代码级完成。

- Tool Registry/Broker 使用持久 invocation、精确批准范围和数据库原子 nonce。
- 普通工具保留兼容 capability；账户私有工具强制 hybrid capability。
- 私有 capability 使用 Ed25519 + ML-DSA-65，阈值为 2，经典和 PQ 签名均必需，不接受 HMAC 降级。
- Crypto Market、Crypto Account、Crypto Forecast 为独立服务。
- Crypto Account 的 owner 只来自受信 invocation，不接受模型参数中的用户 ID。
- Crypto Account 在批准后重新检查 owner、连接版本、Root 包装和只读状态。
- Gate 私有连接、缓存和账户状态按账户/连接隔离。

### M5：Key Custody 与退休

状态：远程能力和退休门禁完成；生产退休未执行。

- Key Custody 为独立 mTLS 服务。
- 只有 Key Custody 挂载平台 Key lease。
- Crypto Account 的平台包装 DEK 通过远程 wrap/unwrap。
- 非 Key Custody 服务在全局 cutover 后读取本地平台 Key 会 fail-closed。
- 退休证据采用 `athena.micro-module-cutover-evidence:v2`。

全局 Key Custody cutover 不能提前开启。当前远程 purpose 首先覆盖 `crypto-account-dek`；其它仍直接依赖平台信封的字段必须先完成随机 DEK/用户域包装迁移，否则启动门禁会拒绝或业务操作会安全失败。

## 本轮本地验收

### 自动化

- 独立运行时与 Identity introspection：5 个套件、17 个断言通过。
- Operations 专项回归：15 个套件、62 个断言通过，覆盖远程代理、事件批量转发与失败重试、producer 心跳、模块身份/版本/fingerprint 漂移、实时状态优先级、跨模块流程聚合及 Shadow 远程降级。
- Crypto、User Root/Envelope、远程 Key Custody 与账户隔离：13 个套件、43 个断言通过；Node 22 下 1 个真实 PQ 插件用例按设计跳过。
- Node 24.18.0：真实 Ed25519 + ML-DSA-65 capability round-trip 通过。
- Agent/Model Gateway 回归：3 个套件，21 个断言通过。
- 启动安全与远程 Agent 隔离：2 个套件，19 个断言通过。
- `yarn operations:verify` 隔离契约验收通过：20/20 模块和 9/9 基础设施健康，5/5 Golden Journey 相关性覆盖、36 个语义事件写入 ClickHouse 协议实现并输出 OTel；状态图 35 个节点/89 条依赖边，`unknown=0`、`unmonitored=0`、`degraded=0`，Shadow Monitoring/RCA 和四类人工批准动作均通过。
- `yarn check:independent-module-topology` 通过：20/20 物理运行时、20/20 readiness、20/20 Prometheus target、20/20 mTLS 身份均完整；平台 Master Key 只挂载于 Key Custody。

### 构建与静态门禁

以下命令通过：

```bash
yarn check:micro-module-runtimes
```

预生产主机准入命令为：

```bash
yarn preproduction:micro-modules:preflight
```

该命令覆盖：

- 20 个模块清单与 32 个 RPC 契约审计
- 20 个独立 Compose 服务、Docker build target、entrypoint、readiness、Prometheus mTLS target 和服务身份
- Identity、Knowledge Ingest、RAG 与 Operations Shadow Agents
- Scheduler
- Operations Plane
- Chat Runtime
- Agent Runtime
- Model Gateway
- Tool Broker
- Crypto Market/Account/Forecast
- Key Custody
- Reader Worker
- Background Worker
- Realtime Gateway
- PostgreSQL Prisma Schema
- 密码资产盘点

另外：

- SQLite Prisma Schema 校验通过
- 独立拓扑静态验收返回 `physicalRuntimes=20`、`operationsReadinessEndpoints=20`、`prometheusTargets=20`、`mtlsIdentities=20`
- Docker entrypoint shell 语法通过

本机没有可用 Docker daemon，因此本报告不把 Docker 镜像构建、真实容器健康、PostgreSQL/NATS/S3/ClickHouse 联机、真实 mTLS 模块探针或蓝绿切流标记为已通过。`ATHENA_OPERATIONS_VERIFY_LIVE=true yarn operations:verify` 必须在预生产环境再次运行，且只有已配置模块全部健康、JetStream 的 stream sequence 与 ACK floor 对齐、lag/ACK pending/redelivery/DLQ 归零并确认 ClickHouse 最新落盘后才算真实验收通过。

`ATHENA_MODULE_SCHEMA_CUTOVER` 与 `ATHENA_SHARED_STORAGE_CUTOVER` 仍保持关闭。PostgreSQL 已是预生产配置中的数据库权威，但 16 个领域 Schema 尚未完成 expand/contract 的物理搬迁和角色收紧；Collector 热目录、输出目录及兼容存储仍存在跨运行时共享挂载。静态门禁会把这些状态明确报告为 warning，并令 `productionCutoverReady=false`，因此不能把“20 个容器已经独立”误报为“数据平面已经完全隔离”。

正式 cutover evidence 现已强制要求逻辑 Schema 和共享存储两项切换均为权威状态，并要求 Operations 同时达到模块 20/20 与基础设施 9/9；任一 `unknown`、`unmonitored` 或 `degraded` 都会拒绝生产切换。

## 生产发布顺序

1. 在独立预生产主机部署 PostgreSQL Main/Auth、NATS JetStream、S3/MinIO、OTel 和 Operations。
2. 使用快照 + CDC 将 SQLite shadow 到 PostgreSQL，校验零差异后执行写屏障切换。
3. 先发布 Web、Reader、Background、Scheduler、Realtime 和 Operations。
4. 发布 Model Gateway，再以关闭 Provider 凭据的 Agent Runtime 验证远程 complete/stream。
5. 发布 Chat Runtime，演练后台、断网、重连、滚动发布和 sequence replay。
6. 发布 Tool Broker 与三个 Crypto 服务，演练两账户隔离、批准拒绝、nonce 重放和私有服务故障降级。
7. 先对 `crypto-account-dek` 开启 Key Custody 域级 cutover。
8. 完成其它直接字段的随机 DEK/用户域包装迁移后，才评估全局 Key Custody cutover。
9. 生成并验证 retirement v2 证据；连续七天零旧命中后关闭旧写入。
10. 旧单体先进入只读回滚观察期，最后才移除生产路由。

## 退休硬门槛

必须同时满足：

- PostgreSQL、NATS、对象存储和 mTLS 均为权威路径
- Main/Auth 与内容对象覆盖率 100%
- User Root/Envelope 包装覆盖率 100%
- 各模块数据库角色已强制
- 备份恢复通过
- Chat/Agent 蓝绿、Identity/Key Custody 故障、Crypto 账户隔离演练通过
- 平台 Key 不存在于 Key Custody 之外
- 本地 Key material read 为零
- decrypt-only Key read 为零
- 旧路由、旧 Tool executor、SQLite、共享目录和 memory transport 命中均为零
- reverse-shadow 与 Key Custody 观察期均至少七天

任何一项不满足，`verify-micro-module-cutover.js --phase retirement --strict` 都必须返回未就绪。
