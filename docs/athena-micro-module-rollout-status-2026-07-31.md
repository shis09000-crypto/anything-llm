# Athena 微模块化落地与验收状态

日期：2026-07-31

## 结论

Athena 已完成微模块架构的代码级底座和本地自动化验收。当前版本具备独立运行角色、模块清单、持久运行状态、Tool/Crypto 隔离、远程 Key Custody 首个生产域以及严格的生产退休门禁。

这不等于旧单体已经可以在生产退休。生产 PostgreSQL/NATS/S3 迁移、真实蓝绿流量演练、备份恢复和连续七天零旧读取仍必须产生证据，门禁才会允许进入 retirement。

## 当前模块基线

- 20 个 `ModuleManifest v1`
- 30 个唯一 RPC 契约
- 18 个唯一公共路由所有者
- 16 个唯一数据库 Schema 所有者
- 20 个唯一服务身份
- 16 个 Compose 服务
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

### 统一 AI 运维中心兼容性

状态：微模块运行观测链路已完成代码级收口，真实分布式基础设施验收待预生产执行。

- API 在 `Operations Plane` 独立部署后通过 API 服务身份和 mTLS 读取远程权威状态，不再读取未启动的本地 singleton。
- Chat、Agent、Tool、Crypto、Scheduler、Reader、Background、Realtime 和 API 进程会将脱敏语义事件批量转发至独立 Operations Plane；失败时使用有界队列和指数退避，不阻塞业务请求。
- 各独立 Node 运行角色定期发送 `module.telemetry.heartbeat`；Operations health 会展示已观测 producer、最后事件时间和 stale 状态，用于识别“模块存活但事件链路断开”。
- Operations Plane 每 15 秒主动探测已配置模块的 Manifest readiness endpoint，并校验 `moduleId`、版本和 Manifest fingerprint。
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

- 综合 Jest：19 个通过套件，77 个通过断言；Node 22 下 1 个真实 PQ 用例按设计跳过。
- 新增 Operations 微模块回归：9 个套件、33 个断言通过，覆盖远程代理、事件批量转发与失败重试、producer 心跳、模块身份/版本/fingerprint 漂移、实时状态优先级和跨模块流程聚合。
- Node 24.18.0：真实 Ed25519 + ML-DSA-65 capability round-trip 通过。
- Agent/Model Gateway 回归：3 个套件，21 个断言通过。
- 启动安全与远程 Agent 隔离：2 个套件，19 个断言通过。
- `yarn operations:verify` 隔离契约验收通过：20/20 模块健康、5/5 Golden Journey 相关性覆盖、36 个语义事件写入 ClickHouse 协议实现并输出 OTel、状态图 35 个节点/89 条依赖边、Shadow Monitoring/RCA 和四类人工批准动作均通过。

### 构建与静态门禁

以下命令通过：

```bash
yarn check:micro-module-runtimes
```

该命令覆盖：

- 20 个模块清单与 30 个 RPC 契约审计
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
- Compose YAML 可解析为 16 个服务
- Docker entrypoint shell 语法通过

本机没有可用 Docker daemon，因此本报告不把 Docker 镜像构建、真实容器健康、PostgreSQL/NATS/S3/ClickHouse 联机、真实 mTLS 模块探针或蓝绿切流标记为已通过。`ATHENA_OPERATIONS_VERIFY_LIVE=true yarn operations:verify` 必须在预生产环境再次运行，且只有已配置模块全部健康、JetStream 的 stream sequence 与 ACK floor 对齐、lag/ACK pending/redelivery/DLQ 归零并确认 ClickHouse 最新落盘后才算真实验收通过。

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
