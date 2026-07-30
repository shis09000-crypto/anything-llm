# Athena 微模块独立预生产运行手册

## 目的与不变量

此环境只验证部署解耦、故障隔离、断连恢复和可观测性，不改变 Athena
既有业务语义。

- 外部 `/api/*`、Chat SSE、Agent WebSocket、iOS/PWA 协议保持兼容。
- Prompt、RAG、聊天记忆、工具选择和批准 UX 保持原逻辑。
- User Root、Envelope、混合签名、格密码和账户隔离不得降级。
- PostgreSQL、NATS JetStream、S3/MinIO 和服务 mTLS 是预生产权威路径。
- SQLite、memory transport、进程内 Reader 回退在分布式预生产中均为
  fail-closed。
- 本流程不会修改或切换生产流量。

## 监控拓扑

Operations 以 20 个 `ModuleManifest v1` 为逻辑监控单位。Prometheus
以实际进程为抓取单位，包含 16 个 Athena 模块 target 和 1 个 OTel
基础设施 target。

| 逻辑模块                 | readiness 来源                                       | Prometheus 进程       |
| ------------------------ | ---------------------------------------------------- | --------------------- |
| athena-api               | API `/ready`                                         | athena-api            |
| authentication           | API `/internal/v1/module-readiness/authentication`   | athena-api            |
| knowledge-ingest         | API `/internal/v1/module-readiness/knowledge-ingest` | athena-api            |
| rag                      | API `/internal/v1/module-readiness/rag`              | athena-api            |
| edge-web                 | Edge Probe `/ready`                                  | edge-web              |
| background-worker        | Worker `/snapshot`                                   | background-worker     |
| sync-v2                  | Realtime `/snapshot`                                 | sync-v2               |
| reader-worker            | Reader `/snapshot`                                   | reader-worker         |
| scheduler                | Scheduler `/ready`                                   | scheduler             |
| operations-plane         | Operations `/ready`                                  | operations-plane      |
| operations-shadow-agents | Operations 本地独立 provider                         | operations-plane      |
| chat-runtime             | Chat `/ready`                                        | chat-runtime          |
| agent-runtime            | Agent `/ready`                                       | agent-runtime         |
| model-gateway            | Model `/ready`                                       | model-gateway         |
| tool-runtime             | Tool Broker `/ready`                                 | tool-runtime          |
| crypto-market            | Market `/ready`                                      | crypto-market         |
| crypto-account-access    | Account `/ready`                                     | crypto-account-access |
| crypto-forecast          | Forecast `/ready`                                    | crypto-forecast       |
| key-custody              | Key Custody `/ready`                                 | key-custody           |
| collector                | Collector `/health`                                  | collector             |

每个 readiness 响应必须同时返回模块 ID、版本和 Manifest 指纹。
Operations 每 15 秒通过 mTLS 探测一次，并为健康模块写入
`module.telemetry.heartbeat`。20 个模块的 heartbeat 必须全部新鲜。

## 部署前条件

- 使用独立预生产主机，不与生产 Compose 项目、网络、卷或域名共用。
- 主机安装支持 Compose v2、BuildKit 的 Docker。
- 仓库已同步到要验收的不可变提交。
- DNS 指向独立预生产入口；不得指向生产反向代理。
- 预生产模型 Provider、两个测试账户及只读 Crypto 测试连接已准备。
- 主机目录 `/data/athena-preproduction` 可写且只供本环境使用。

部署器会在 Node 24 容器内生成随机运行密钥、服务 CA、服务证书、
NATS NKey、混合 capability 密钥和权限为 `0600` 的 runtime env。
密钥原文不得复制到日志、Operations 或 evidence。

## 部署

```bash
cd /path/to/anything-llm
export ATHENA_PREPROD_CONFIRM=athena-preproduction
export ATHENA_PREPROD_STATE_DIR=/data/athena-preproduction
export ATHENA_PREPROD_PUBLIC_URL=https://preproduction.example.com
yarn preproduction:micro-modules:deploy
```

部署脚本依次执行：

1. 生成或复用预生产专属密钥材料。
2. 构建微模块镜像。
3. 启动 PostgreSQL、NATS、MinIO、Operations 与全部运行模块。
4. 执行 PostgreSQL migration。
5. 等待容器健康。
6. 验证 Operations 20/20、heartbeat 20/20、Prometheus 16/16 和权威路径。

检查状态：

```bash
export ATHENA_PREPROD_STATE_DIR=/data/athena-preproduction
yarn preproduction:micro-modules:status
```

合格状态必须满足：

- Operations：`healthy=20`、`unknown=0`、`unmonitored=0`、`degraded=0`。
- heartbeat：`fresh=20`、`stale=0`、`missing=[]`。
- Prometheus：16 个 Athena target 全部 `up`。
- Database provider 为 `postgresql`。
- Broadcast provider 为 `nats`，无 memory fallback。
- Content store 为 `s3`，写入/删除探针通过。
- `serviceMtlsRequired=true`。
- Reader durable queue 已开启，进程内 fallback 已关闭。

## 演练

真实 Chat/Agent 连续性验收必须先生成独立 evidence 文件。该文件必须来自
真实预生产账户、真实模型 Provider 和客户端断连/滚动发布流程，不能由静态
测试或模拟数据替代。

双账户 Crypto 隔离也必须提供独立的真实 evidence。内置
`drill-crypto-account-isolation.js` 只作为 Registry 和私有缓存分区的代码级
预检，正式门禁不会接受它替代 Tool Broker → Crypto Account → Resolver
真实链路验证。

其 Schema 为：

```json
{
  "version": "athena.preproduction-chat-agent-continuity-drill:v1",
  "environment": "preproduction",
  "passed": true,
  "chatInFlightRolloutPassed": true,
  "agentInFlightRolloutPassed": true,
  "reconnectP95WithinTarget": true,
  "duplicateMessages": 0,
  "lostMessages": 0,
  "productionChanged": false
}
```

真实 Crypto evidence 的最小合格字段为：

```json
{
  "version": "athena.crypto-account-isolation-drill:v1",
  "environment": "preproduction",
  "passed": true,
  "accounts": 2,
  "liveServiceBoundary": true,
  "concurrentPartitioning": true,
  "ownerResolverVerified": true,
  "privateClientIsolationVerified": true,
  "cacheIsolationVerified": true,
  "websocketIsolationVerified": true,
  "credentialRotationInvalidation": true,
  "ownerRevocationInvalidation": true,
  "sensitiveScanPassed": true,
  "sensitiveValuesEmitted": false,
  "productionChanged": false
}
```

执行全套演练：

```bash
export ATHENA_PREPROD_CONFIRM=athena-preproduction
export ATHENA_PREPROD_STATE_DIR=/data/athena-preproduction
export ATHENA_PREPROD_CHAT_AGENT_DRILL_EVIDENCE=/absolute/path/chat-agent.json
export ATHENA_PREPROD_CRYPTO_ISOLATION_EVIDENCE=/absolute/path/crypto-isolation.json
yarn preproduction:micro-modules:drill
```

演练顺序：

1. Reader、Tool Broker、Crypto Forecast 分模块滚动重建，验证
   API、Chat、Agent、Realtime 容器不重启。
2. 停止 Realtime，发布 NATS sequence gap，再启动并验证精确补发、
   零重复、零缺失。
3. 停止 Crypto Market，验证仅对应模块 degraded，API、认证、
   Chat、Agent、Sync 保持 healthy。
4. PostgreSQL Main/Auth 做 custom dump、临时数据库恢复及逐表精确计数。
5. MinIO 镜像到临时 bucket，执行对象数量和 diff 校验。
6. 执行双账户 Registry 预检；随后校验外部提供的真实双账户 Tool Broker →
   Crypto Account → Resolver evidence，验证私有客户端、缓存、WebSocket、
   轮换和撤销不串账户，并扫描日志和 evidence 中的敏感值。
7. 重新确认 20/20 与 Prometheus 16/16。

## 正式 cutover evidence

`run-micro-module-drills.sh` 只有在以下 evidence 全部通过时才生成
`athena.preproduction-cutover-evidence:v1`：

- topology
- rolling release
- disconnect recovery
- service fault containment
- PostgreSQL/MinIO backup restore
- two-account Crypto isolation
- real Chat/Agent continuity

缺失、无效或失败的 evidence 会使流程非零退出，不会生成“可切生产”
结论。正式 evidence 仍只代表“允许开始生产切换规划”，不会自动切换生产。

## 回滚与安全边界

- 单模块发布使用非活动槽启动、健康验证、切流、旧槽 drain。
- 数据库仅允许 expand/contract 迁移；本轮保持
  `ATHENA_MODULE_SCHEMA_CUTOVER=false`，避免提前进行破坏性 Schema 收口。
- 任何基础设施演练失败时，脚本会恢复被停止的 Realtime 或 Crypto
  服务并保留失败 evidence。
- 不得把独立预生产脚本用于 `APP_ENV=production`；脚本会主动拒绝。
- 未达到 Operations、heartbeat、Prometheus 和全部演练门槛前，不得
  开始生产切换。
