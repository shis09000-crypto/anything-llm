# Athena P2 架构与维护性优化

## 结论

P2 在不改变 REST、Sync V2、WS/SSE/APNs、领域表和缓存语义的前提下，完成七项结构性优化。实现继续以领域 Repository 和现有事务为边界，未把 Sync V2 扩展为业务总线。

## 性能链路

### WorkspaceChats 关联投影

- 改造前：一次聊天查询后，每条记录分别读取 Workspace 和 User，SQL 数量为 `1 + 2N`。
- 改造后：聊天、Workspace 批量、User 批量共最多 3 次查询，复杂度为固定 `O(1)` 次 SQL 加 `O(N)` 内存映射。
- 删除的 Workspace、API 会话和未知用户标签保持原语义。

### Thread Fingerprint Manifest

- 改造前：按 workspace 逐个鉴权，再按 workspace 逐个查询 thread，之后聚合聊天活动，查询量随 workspace 数增长。
- 改造后：一次授权 Workspace 查询、一次 Thread 查询、一次聊天活动 groupBy，最多 3 次数据库查询。
- 多用户模式仍通过 `workspace_users` 关系进行授权；无法访问的 scope 继续返回 `unavailable`，数据库异常则返回可观测的 503，不再伪装为 unavailable。

### Mutation Batch

- 同一 `nodeKey` 的 mutation 严格顺序执行。
- 不同节点使用有界 worker pool，默认最多 4 路，最大 8 路。
- 输出保持原始请求顺序，一个 lane 失败不会中断其他 lane。
- `ATHENA_SYNC_MUTATION_BATCH_CONCURRENCY=1` 可立即退回串行路径。

### Web 加密 Archive

- Archive 从 owner 级单一密文升级为 `user:profile`、`user:preferences`、`user:navigation` 和 `workspace:{id}` 分片。
- Thread metadata 有 workspace 投影时并入 workspace 分片；缺少投影时才使用 thread fallback shard。
- 一个 Sync 批次先完成最多 4 路加密，再在单一 IndexedDB transaction 内原子提交所有变更分片。
- 任一加密或 IndexedDB 写失败都不替换内存镜像、不应用 descriptor、不推进 cursor。
- V1 owner-wide Archive 首次恢复时自动迁移；迁移提交前保留旧记录。

## 故障语义

新增 `ModelDataAccessError`，核心 User、Workspace、WorkspaceThread 和 WorkspaceChats 读取在数据库异常时抛出 `database_operation_failed`/503。正常的空结果和 not-found 仍使用 `[]` 或 `null`，但系统故障不再伪装成没有数据。

仓库现有 model 中仍有历史静默 fallback。P2 不一次性改变全部调用契约，而是：

1. 先修复账户、工作区、线程和聊天关键读取路径；
2. 建立 AST 维护性门禁，将剩余静默 fallback 上限冻结为当前基线 112；
3. 后续领域迁移必须只减不增，并在 Repository 边界补充故障测试。

## God File 治理

本轮从入口文件抽取：

- Thread fingerprint 批量投影进入 WorkspaceThreadRepository；
- mutation lane 调度进入独立 Sync V2 utility；
- Electron 子进程生命周期进入独立 supervisor；
- Electron 浏览器隔离与 URL 信任策略进入独立 security policy。

维护性门禁登记九个超过 3,000 行的既有文件、领域 owner、当前最大行数和下一抽取边界。既有文件不得继续增长；新增超过阈值的文件直接阻断 CI。

## Electron 安全与运行治理

- BrowserWindow 显式使用 `contextIsolation=true`、`nodeIntegration=false`、`sandbox=true`、`webSecurity=true`、`webviewTag=false`。
- Renderer 只能导航到当前绑定的 `127.0.0.1:{serverPort}` 或固定 recovery 文件。
- 新窗口一律不在 Electron 内打开；仅 HTTPS 链接可交给系统浏览器。
- IPC 仅允许固定 recovery renderer 调用，普通本地 Web 页面也不能调用恢复权限接口。
- 权限请求只对白名单本地 renderer 开放 media、notification 和安全剪贴板写入。
- Server/Collector 使用独立进程组、SIGTERM 排空、超时强杀、有限指数退避和 crash-loop recovery。
- Windows Builder 显式保留 `verifyUpdateCodeSignature` 和 `signAndEditExecutable`；没有证书或更新源时不伪造自动更新能力，也不修改任何密钥。

## Broadcast 生命周期闭环

- Jest worker 是测试运行时的权威信号，production 分支测试不会误向测试数据库持久化 Broadcast 事件；需要验证持久化时仍可用显式测试开关开启。
- Runtime Coordinator 在 Outbox、Cognition、后台任务和 Push/Bot 停止后执行 `broadcast-durable-commits`，先刷新 coalesced 事件，再等待 durable queue，最后才断开 Prisma。
- 这关闭了 fire-and-forget 事件跨越测试 teardown 或进程 shutdown 的窗口，不改变现有 REST、WS/SSE/APNs 消息协议。

## 验证结果与实测收益

- 全量 Jest 的 215 个 suites、1192 个 tests 断言全部通过；发现的 Broadcast teardown 缺陷修复后，相关 3 suites、41 tests 在 `detectOpenHandles` 下以 0 退出。
- Frontend Node tests 394/394、iOS Simulator 99/99、Desktop 5/5 通过；Server、Frontend、Collector lint、Frontend production build 与 Crypto output audit 通过。
- Sync shadow 审计覆盖 263 个节点，missing payload、Hash mismatch、projection conflict 均为 0。
- 活跃账户相对 legacy 的暖启动请求下降 85.19%，业务载荷下降 99.74%，gzip 载荷下降 98.81%；该收益在 P2 后未回退。
- 聊天增量链在 10/100/1000 条历史下 p95 为 0.265/0.236/0.261 ms，1000 条历史相对 10 条没有劣化，完整性检查为 0 断链。
- P2 新查询路径把 `WorkspaceChats` 从 `1+2N` 次 SQL 收敛到最多 3 次，把 thread fingerprint manifest 收敛到最多 3 次；mutation 具备默认 4 路独立节点并发。Archive 分片和 mutation 并发尚未声明端到端 p95 数字，后续应以生产 telemetry 验证，而不是用理论值冒充实测。
- 唯一未闭合门禁是本机 Playwright/Chrome 启动后被 SIGKILL；服务健康、静态加密覆盖和 Node 持久化故障注入均已通过，此项作为测试环境阻塞保留。

## 回滚

- mutation 并发度可设为 1。
- Web Sync durability 总开关仍可关闭 Archive 持久化。
- V1 Archive 在 V2 分片事务成功前不会删除。
- Electron 进程监督是本地桌面边界，不影响 Web/Server 部署。
- 数据库无新增表或迁移；所有变更均可通过代码回滚。
