# Athena P1 规模化稳定性测试缺陷记录

状态：仓库内缺陷已全部关闭，最终完整门禁通过；3 项宿主/基础设施门禁保持显式阻塞。

执行规则：先完整运行一次矩阵并登记全部缺陷，不在首轮中途修复；首轮结束后集中修复，后续只复测缺陷及直接相关 smoke；全部关闭后再运行一次最终完整门禁。

| ID | 测试域 | 严重级别 | 现象 | 根因 | 修复 | 复测 |
| --- | --- | --- | --- | --- | --- | --- |
| P1-001 | DataAccess migration guard | P1 | `dataAccessMigrationGuard.test` 报告 4 个维护脚本未分类 | `sync-v2-outbox-admin.js` 与 `verify-security-audit-ledger.js` 尚未进入脚本访问分类注册表 | 已按运维写入边界与只读诊断边界显式分类 | 通过：测试及 662 文件 enforce 扫描均为 0 新绕过 |
| P1-002 | 全仓 lint / DataAccess 门禁 | P1 | 并行 lint 及后续整体 Frontend lint 被系统以 SIGKILL 终止 | 首轮重型任务并行叠加；Frontend 单父进程扫描不适合当前宿主执行预算 | Server/Collector 串行执行；Frontend 按根文件、components/contexts/hooks、lib/models/modules/pages、utils 分片且保持全覆盖 | 通过：所有分片、motion gate、Server 与 Collector 均无 lint 错误 |
| P1-003 | iOS 单元测试 | 环境阻塞 | App 与测试包编译链接成功，但 Simulator 克隆机 60 秒内未启动，测试未执行 | CoreSimulatorService 在加载 Apple `SimRenderingServices.simdeviceio` 时自身 SIGABRT；重启服务后仍为 NSPOSIX 53 | 未修改系统 runtime 或项目；保留为修复 Xcode/CoreSimulator 后必须执行的发布门禁 | 阻塞：编译/链接通过，测试断言未执行 |
| P1-004 | Docker smoke | 环境阻塞 | 当前开发机没有 `docker` 命令，无法执行 Compose config/build/runtime smoke | 本机未安装或未暴露 Docker CLI/daemon | 不修改系统环境；保留为外部发布门禁，不伪报通过 | 阻塞 |
| P1-005 | 真实开发后端启动 | P0 | Runtime Coordinator 启动 Outbox 时抛出 `SyncV2.claimOutbox is not a function`，API 持续重启 | 新 Outbox/Receipt 生命周期方法已实现到 Model/Repository，但未加入 DataAccessCenter 显式 facade | 补齐 Sync V2 与 mutation receipt 的运维/read/write facade，并加入稳定性断言 | 通过：API ready；14 个组件启动；SIGTERM 后在 30 秒窗口内恢复 |
| P1-006 | Web 运行时存储审计 | 环境阻塞 | Playwright/Chrome 审计进程两次未完成；当前无测试账户凭据 | 宿主浏览器进程无法稳定启动；应用内浏览器的安全沙箱不暴露 Storage API | 静态 14 项加密覆盖全部通过；认证态浏览器存储检查保留为有凭据环境发布门禁 | 阻塞：静态通过，认证态运行检查未执行 |
| P1-007 | Server lint | P1 | 集中修复后的串行 lint 报告 5 个 Prettier 差异和 1 个未使用参数 | P1 跨文件实现未完成最终定向格式化，`buildMCPEnvironment` 保留了不再需要的 `name` 参数 | 定向 Prettier；移除未使用的形参而不改变调用兼容性 | 通过：Server 完整 lint、DataAccess 和 Key Custody 门禁全绿 |
| P1-008 | 完善性测试覆盖 | P1 | 静态复核发现真实 Broadcast durable commit 与 MCP 子进程 drain 只有间接测试 | Outbox 使用了 mock 边界，MCP shutdown 已接入 Runtime 但缺少进程信号契约测试 | 增加“持久化成功前不得 fanout / 失败不得 fanout”及“SIGTERM 超时升级 SIGKILL”测试 | 通过：新增 8 项契约测试及最终全量 Jest 均通过 |
| P1-009 | Transport security 测试隔离 | P1 | 最终全量 Jest 中 2 个 SSL boot 用例因 `fs.existsSync is not a function` 失败 | 测试将整个 `fs` 替换成只有 `readFileSync` 的桩；Runtime boot 新增 Broadcast/DataAccess 依赖后，Prisma 合法使用 `fs` | 真实 `fs` 保持不变，只对目标证书路径覆盖 `readFileSync` | 通过：定向 11 项及最终 1,217 项 Jest 全绿 |

## 首轮测试矩阵

- Prisma：schema format/generate、additive migration、主库与 Auth DB quick/foreign-key check。
- Outbox：lease 竞争、过期抢占、同节点顺序、跨节点并行、退避、DLQ、管理员 dry-run/requeue、停机 drain。
- Receipt：重复 reservation、活动 lease、过期 Sync replay、recoverable 重放、非 Sync fail-closed、旧 pending 实库修复。
- Auth 副链路：来源指纹去重、分页失败不推进、与 Outbox 故障隔离。
- Lifecycle：组件停机顺序、全局 deadline、HTTP drain、standalone worker、端口占用和重复信号。
- Plugin/MCP：最小环境、Secret allowlist、remote domain/redirect、untrusted container 硬化、path/url 参数、工具过滤、scheduled approval、MCP 子进程 drain、日志脱敏。
- Audit：链追加、并发 CAS、Hash 篡改、Ed25519 checkpoint、失败 spool、cursor 补录、权限模式和验链 readiness。
- Observability：Prometheus scrape 默认拒绝与 token 鉴权、指标标签基数、OTLP 开关、HTTP -> Outbox traceparent、WS/SSE/ACK correlation、结构化日志脱敏。
- 回归：Server/Collector/Frontend/iOS 全量测试、Sync benchmark/shadow audit、聊天 Hash Chain、DataAccess/Key Custody/security gates、Docker smoke。

## 最终门禁结果

- Jest：221 suites、1,217 tests 全部通过。
- Lint：Server、Collector、Frontend 全覆盖分片与 motion system 全部通过；DataAccess 662 文件、Key Custody 861 文件无发现。
- 构建：Web production build、Reader Worker、Background Worker、Realtime Gateway、Desktop security 全部通过。
- Sync V2：263 节点、186 个领域投影，missing/hash mismatch/conflict 均为 0；Outbox pending/retry/claimed/DLQ 均为 0。
- 数据库与审计：主库/Auth DB quick check 为 ok、外键违规 0；最终真实安全审计链 3 条、签名检查点 1 个、验链失败 0。
- 生命周期：真实开发 Frontend/API/Collector 均为 HTTP 200；受控 SIGTERM 完成优雅退出并由 supervisor 恢复，readiness 重新为 true。
- 性能：活跃账户暖启动请求减少 85.19%，字节减少 99.74%，gzip 减少 98.81%；聊天 10 -> 1,000 历史长度的 append p95 增长 19.176%，无 rebuild fallback、无断链。
- 外部阻塞：本机无 Docker CLI；Apple CoreSimulatorService 自身崩溃；无认证态浏览器测试凭据且 Playwright 进程未完成。这三项必须在对应基础设施恢复后补跑，不影响仓库内 P1 代码门禁结论。
