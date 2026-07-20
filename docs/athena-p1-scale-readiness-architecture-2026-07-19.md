# Athena P1 规模化稳定性架构

## 完成边界

本轮 P1 不改变 REST、Sync V2、领域表、WS/SSE/APNs 和客户端缓存语义，也不引入 Redis/NATS 或微服务拆分。目标是让现有单实例权威链路具备可证明的失败恢复、最小权限、审计完整性和生产观测能力，并让尚未具备共享 transport 的独立 Realtime Gateway 明确保持 not-ready。

## 写入与通知链路

```text
HTTP mutation
  -> correlation context (requestId / traceId / spanId)
  -> domain repository transaction
     -> business rows
     -> sync_nodes version/hash
     -> sync_outbox pending + traceparent
  -> Outbox claim lease
     -> same-node ordered lane
     -> independent-node bounded parallel dispatch
     -> durable Broadcast replay record
     -> memory WS/SSE fanout / APNs wakeup
     -> dispatched | exponential retry | dead_letter
  -> client durable apply
  -> cursor ACK + lag metric
```

Outbox 的 `dispatchedAt` 只在 Broadcast Center 的持久 replay 记录成功提交且实时 fanout 已执行后写入；不能再把“已进入内存函数”误当成投递成功。旧的视觉广播仍保持非阻塞语义，只有事务 Outbox 使用这个强确认边界。客户端即使错过实时通知，仍可通过 `/sync/v2/events`、manifest 和 Hash 校验恢复。毒事件进入 DLQ 后不阻塞其他节点；同一节点在失败事件重试前保持顺序，进入 DLQ 后允许更高版本失效通知继续推进。

## Outbox 生产语义

- `pending/retry -> claimed -> dispatched` 由数据库 lease owner 做 CAS。
- 进程崩溃后的过期 claim 自动回到 retry。
- 同一 `nodeKey` 严格按 `seq` 处理；不同节点默认四路并行。
- 失败采用带抖动指数退避，默认八次后进入 DLQ。
- DLQ 默认保留至少 90 天；管理员脚本默认只读，重排必须显式 `--execute`。
- 每个事件保留 request ID、trace ID 和 W3C traceparent，API、Outbox 与实时推送可关联。
- 独立 Realtime Gateway 在 memory transport 下明确 not-ready；当前实时路由继续由 API 进程持有。

## Mutation receipt

- 新 receipt 在创建时获得租约；并发请求只能有一个 owner。
- 已完成请求返回保存的结果；活动 pending 返回 425。
- 过期 Sync mutation 先以 `nodeKey + mutationId` 对账 Outbox：已提交则补齐 completed，未提交则释放为 recoverable。
- 非 Sync 旧 mutation 无法安全证明是否已经产生副作用，超时后标记 `mutation_recovery_required`，不盲目重放。
- 已迁移的 Workspace/Thread 旧 REST 动作在所有确定性返回和异常分支结算 lease；无法证明副作用边界的异常采用 fail-closed，并要求客户端先 reconcile 再使用新 action ID。
- receipt sweeper 独立于 Sync V2 开关运行，过期清理只删除 completed/failed，不删除待恢复记录。

## Auth DB 跨库副链路

Auth DB 会话仍是权限权威，主库 Sync Outbox 只负责跨设备失效通知。登录/吊销后计算不包含 token 和 `lastSeenAt` 的来源修订指纹；相同指纹不递增节点版本。独立对账器按账户分页复核，失败不推进分页，且不再运行在 Outbox flush 内，因此 Auth DB 的暂时异常不会阻塞普通状态事件。

## 插件和 Agent 权限

- 每个 MCP server 根据名称和连接定义获得稳定 `plugin:<fingerprint>` 服务身份。
- 生产默认要求 capability manifest；开发默认 warning-only，可用独立开关回滚。
- stdio 子进程只继承 PATH、locale、时区等最小环境，不再继承服务端全部变量。
- Secret Broker 只解析 manifest 明确声明的 `${env:NAME}`；不记录或回写 Secret。
- HTTP MCP 在首次连接和每次 GET/HEAD 重定向都重新校验远程域；跨域跳转移除认证头，非幂等重定向拒绝重放；工具调用再次校验 URL 和文件路径参数。
- stdio 必须声明 process/container isolation；普通 process 仅允许显式 trusted 插件。untrusted container 必须以 Docker/Podman 启动，并具备只读根文件系统、无网络、drop all capabilities、no-new-privileges、PID 限制和非 root 用户；不允许宿主 volume/device/privileged 入口。
- 定时任务的工具可见范围和自动批准范围分离；生产只批准 manifest 明确列出的操作，高风险能力还要求 `allowHighRisk`。
- 旧 UI 只修改 tools 时，服务端原子同步 capability manifest，避免正常编辑后在 enforce 模式下静默停用；现有高风险禁用规则不会因此放宽。
- 关键批准/拒绝写入安全审计链；工具参数和结果进入日志前递归脱敏。

进程隔离并不等同于完整 OS sandbox。本阶段对不受信任本地插件采用“无宿主文件、无网络”的可证明基线；确需网络或宿主文件的插件必须先进入 trusted 审核或等待带 egress/filesystem broker 的后续容器策略。`maxToolCalls` 和运行 deadline 已强制执行；`maxCostUsd` 目前只保留协议位，未获得统一、可靠的供应商计费数据前不虚构美元级硬限额。

## 安全审计

原 `event_logs` 保留可查询产品日志。高风险事件同步进入独立 `security_audit_ledger`：

- 每条记录包含前一条 Hash，形成 SHA-256 Hash Chain；
- 检查点使用从现有托管主密钥经 HKDF 域隔离派生的 Ed25519 内存密钥签名；
- 公钥、key ID 和签名持久化，私钥与派生 seed 不落盘；
- 数据库写入失败时，脱敏记录同步 fsync 到 0600 JSONL 失败队列；
- 后台按 byte cursor 幂等补录失败队列并周期验链；
- 账本校验失败会使 readiness 失效并产生结构化错误。

这提供防篡改证据，不把 SQLite 伪装成不可变介质。长期归档仍可由日志平台或 SIEM 拉取签名检查点。

## 生命周期

Runtime Coordinator 使用独立 start order 与 stop order。HTTP 已开始监听但首次 Outbox、receipt、Auth 对账和 Audit 验证尚未完成时，业务请求返回 `runtime_not_ready`。SIGTERM 后立即 `readiness=false`，随后在同一 30 秒总 deadline 内分两阶段关闭：

```text
阶段一（并行）
  -> HTTP 停止接收并排空已接受请求
  -> background workers / bot / cognition / embedding producer 停止产出
阶段二（阶段一完成后）
  -> MCP/外部子进程有界退出，超时 SIGKILL
  -> Auth 对账 / Audit 维护 / receipt sweeper
  -> Outbox final drain
  -> durable broadcast drain
  -> APNs pending/active delivery drain
  -> OpenTelemetry flush
  -> Prisma disconnect
```

Reader Worker、Background Worker 和 Realtime Gateway 复用相同有界停机帮助器；超时强制关闭连接并以非零状态退出。

## 可观测性

- `/metrics` 使用 Prometheus exposition format，包含 Node 默认指标、HTTP RED、Outbox、receipt、cursor lag、Auth 对账、实时消息、插件策略、安全审计和停机结果。
- 生产默认拒绝无凭据 scrape，包括反向代理后的 loopback 来源；必须提供 `ATHENA_METRICS_TOKEN`。仅在显式设置 `ATHENA_METRICS_ALLOW_LOOPBACK=true` 时允许本机无令牌抓取。
- `ATHENA_OTEL_ENABLED` 或标准 OTLP endpoint 开启 OpenTelemetry exporter。
- W3C traceparent 从 HTTP mutation 传播到 Outbox 和实时事件；结构化日志自动附加 request/trace/span ID。
- Prometheus/OTLP 后端负责跨重启的长期保留，进程内最近事件只保留调试用途。

## 回滚

- 数据库迁移全为 additive；旧代码可忽略新列和表。
- `ATHENA_PLUGIN_SECURITY_V2=warn|off` 可分阶段回退插件强制策略。
- 不启用 OTLP 不影响请求；Prometheus 指标仍可按需拉取。
- Sync V2 总开关关闭时 Outbox dispatcher 不运行，但 mutation receipt、安全审计和 Auth 对账维护器仍保持各自正确语义。
- 本轮没有生成、轮换、覆盖或输出任何现有密钥。

## 静态完善性判定

进入测试前，P1 七个目标的代码边界均已闭合：Realtime Gateway 不再伪就绪；Outbox 有 lease、重试、lane、DLQ 和持久确认；receipt 有抢占、续租、CAS sweeper 与旧入口 fail-closed；Auth 跨库副链路有来源指纹和独立周期对账；Runtime 有启动首检、两阶段 drain 和子进程监督；插件有服务身份、最小环境、Secret 引用、capability 与隔离基线；审计和可观测性形成可验证链路。

以下内容明确不作为 P1“伪完成”：Redis/NATS 共享 transport、外部 Prometheus/OTLP/SIEM 的部署、非受信任容器的受控网络代理、美元级实时成本计量。代码已经为它们保留接口，但在实际基础设施和可靠计量源到位前不启用占位实现。

## 最终验证结论

仓库内 P1 能力已经闭环：最终 221 个测试套件、1,217 个测试全部通过；全栈 lint、Web/worker 构建、模块边界、数据库完整性、Sync shadow audit、真实安全审计链和开发运行态 readiness 均通过。真实 SIGTERM 验证了两阶段 drain 与 supervisor 恢复。

性能基线未因 P1 稳定性控制面回退：活跃账户暖启动仍保持请求 -85.19%、正文载荷 -99.74%、gzip -98.81%；聊天增量 Hash Chain 在 1,000 条历史下相对 10 条历史的 append p95 增长 19.176%，保持在 20% 门槛内，且链完整性为 0 错误。

本机无法执行的 Docker runtime smoke、iOS Simulator 测试和认证态 Web storage audit 已记录为外部发布门禁，不计作通过，也不改变“P1 仓库内实现完整”的结论。整个过程中没有生成、轮换、覆盖或输出现有 Secret/私钥。
