# Athena P2 测试缺陷记录

状态：架构复核 PASS；首轮完整测试矩阵已结束；代码缺陷已集中修复并通过定向复测。P2-E01 保留为本机浏览器工具环境阻塞。

执行规则：首轮矩阵只登记缺陷，不在中途修改代码；完整轮结束后集中修复，后续只复测缺陷与直接相关 smoke，不重复整套完整矩阵。

| ID | 测试域 | 严重级别 | 现象 | 根因 | 修复 | 复测 |
| --- | --- | --- | --- | --- | --- | --- |
| P2-T01 | 全量 lint | P2 | `yarn lint:ci` 因 3 处 Prettier 规则失败退出 | P2 新增代码未按仓库 Prettier 规则换行 | 已按仓库格式修正，不改变语义 | Server `yarn lint:check` 通过；DataAccess/Key Custody 同步通过 |
| P2-T02 | Server/Collector 全量 Jest | P1 | 215/215 套件、1192/1192 断言通过，但进程以 1 退出；Reader 测试结束后仍有 Broadcast 持久化 Promise 写日志并在 Jest teardown 后加载 repository | production 分支测试覆盖了 `NODE_ENV`，使 Broadcast 误走持久化；生产 Runtime Coordinator 也缺少数据库断开前的 Broadcast drain | Jest 以 `JEST_WORKER_ID` 为权威测试信号；生产新增 `broadcast-durable-commits` stop component，先刷新 coalesced 事件再等待 durable queue | Reader/Broadcast/Runtime Coordinator 3 suites、41 tests 通过，`detectOpenHandles` 退出码 0 |
| P2-T03 | Frontend lint | P2 | Archive 分片实现有 7 处 Prettier 换行错误 | 根级 `lint:ci` 首次在 Server 阶段短路，Frontend 阶段未执行；补齐门禁时发现 | 已按仓库格式调整，不改变 Archive 语义 | Frontend `yarn lint:check` 通过；Archive 5/5 tests 与 Crypto build output audit 通过 |
| P2-E01 | 浏览器运行态存储审计 | 环境阻塞 | `/api/ping` 正常，Playwright 启动系统 Chrome 后进程立即收到 SIGKILL | 本机 Chrome/Playwright 启动环境故障；不是已确认的产品代码回归 | 不改产品代码；保留静态加密审计与 Node 故障注入证据 | 阻塞，需可用浏览器运行环境 |

## 首轮矩阵

- Server/Collector 全量 Jest 与 open-handle 检查。
- Frontend 全量 Node tests、lint 和 production build。
- P2 定向：N+1 查询数、指纹查询数、mutation lane 顺序/并发、Archive 分片/迁移/故障注入。
- 安全与架构：DataAccess、Key Custody、安全路由、数据库完整性、维护性门禁和 Desktop security audit。
- Sync 回归：shadow audit、benchmark、聊天 Hash Chain benchmark。
- Desktop：Node tests、配置审计、main/preload/runtime 静态检查；Windows installer 由 CI smoke 覆盖。
- iOS/iPadOS：本轮未修改 Native 代码，但执行既有 Simulator 测试确认协议未回退。

## 首轮结果摘要

- Jest：215/215 suites、1192/1192 tests 断言通过；因 P2-T02 生命周期缺陷最终退出码为 1。
- Frontend Node tests：394/394 通过。
- Frontend production build：通过，Crypto build output 检查通过。
- iOS Simulator：99/99 通过。
- Desktop：5/5 通过；security audit 0 finding。
- DataAccess、Key Custody、安全路由、模块边界、维护性门禁：全部通过。
- Server、Frontend、Collector lint：缺陷集中修复后分别通过。
- 主库/Auth DB：`quick_check=ok`，`foreign_key_check=0`。
- Sync shadow：263 nodes，0 missing payload、0 hash mismatch、0 projection conflict。
- Sync benchmark：活跃账户暖启动请求下降 85.19%，载荷下降 99.74%，gzip 下降 98.81%。
- Chat Hash Chain：10/100/1000 历史下 p95 分别 0.265/0.236/0.261 ms，1000 相对 10 条未劣化；0 rebuild、0 invalid chain。
- Supply chain：reachable Critical=0；High 保持在既有治理清单内。
