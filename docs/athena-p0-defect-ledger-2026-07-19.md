# Athena P0 首轮完整测试缺陷台账（2026-07-19）

本台账记录 P0 三批实现完成后的**第一遍完整矩阵**。按照既定测试策略，以下缺陷先统一登记，再集中修复；修复阶段只执行对应缺陷和直接相关 smoke，全部关闭后再执行一次最终完整门禁。

## 首轮结论

- Server/Jest：212 个套件，197 通过、15 失败；1146 个测试，1125 通过、21 失败。
- Frontend Node：377 个测试，366 通过、11 失败。
- Frontend production build：通过，未重新打包 `xlsx` 解析依赖。
- Sync V2 shadow audit：186 个领域投影，0 缺失、0 Hash 不一致、0 投影冲突。
- Sync V2 benchmark：暖启动请求下降 72.41%（活跃用户 85.19%），业务载荷下降 99.47%（活跃用户 99.74%）。
- Chat Hash Chain benchmark：1000 条历史相对 10 条历史 p95 仅增加 10.53%，360 次全部走增量追加，0 rebuild、0 断链。
- 数据库：主库/Auth DB `quick_check=ok`、`foreign_key_check=0`。
- 本地真实运行：Server、Collector、Frontend 均 ready；SIGTERM 排空与退出耗时 2 秒，无监听端口残留。
- Docker：YAML 语法及 Actions SHA 固定检查通过；本机没有 Docker CLI，无法执行本地容器 smoke。
- iOS：通用 Simulator build 已通过；测试执行被本机 CoreSimulatorService 反复中断阻塞，未进入 XCTest 断言。

## 缺陷清单

| ID | 级别 | 范围 | 首轮现象 | 修复要求 | 状态 |
| --- | --- | --- | --- | --- | --- |
| P0-T01 | P0 | Server 数据访问边界 | `runtimeCoordinator` 直接引用 Prisma，违反统一 DataAccess 门禁 | 通过生命周期 Repository/DataAccessCenter 断开数据库，并补直接测试 | 已关闭 |
| P0-T02 | P0 | Collector Docker | read-only Collector 容器没有挂载 `/app/server/storage`，但启动路径需要该目录 | 增加最小读写 storage volume，不扩大主服务权限 | 已关闭 |
| P0-T03 | P0 | 功能开关 | `ATHENA_GRACEFUL_SHUTDOWN_V2` 等开关存在于示例，但部分运行路径未实际读取 | 让开关控制对应 V2 路径，默认保持安全行为，禁止生产静默降级 | 已关闭 |
| P0-T04 | P0 | 供应链 | Yarn 审计报告 Server 40、Collector 4、Frontend 1 个 Critical 路径（含重复/传递路径），尚未完成可达性归类 | 升级当前主版本内可修依赖；对剩余项生成可达性门禁和所有者/到期策略 | 已关闭 |
| P0-T05 | P1 | Server tests | 15 个套件失败，其中 13 个为既有测试/环境漂移，2 个为本批新增 URL 与 Reader 测试 | 修复真实环境路径或更新已过期断言，不削弱安全行为 | 已关闭 |
| P0-T06 | P1 | STORAGE_DIR | 多个 Jest 套件在 test 环境模块加载期因 `STORAGE_DIR` 未定义失败 | 使用统一环境路径解析，禁止每个测试单独注入脆弱全局变量 | 已关闭 |
| P0-T07 | P1 | Collector URL | Guard V2 已拒绝纯数字主机 `http://123`，旧测试仍期望允许 | 更新为 fail-closed 断言并覆盖解析结果 | 已关闭 |
| P0-T08 | P1 | Lint | Server 有 1 个既有 unused import 与 1 个新 DataAccess 违规；Frontend 有 6 个 Prettier 红灯 | 精准修复，不做全仓格式化 | 已关闭 |
| P0-T09 | P1 | Collector lint | `eslint .` 被 SIGKILL；扫描范围包含不应进入 lint 的运行/大目录 | 增加明确 ignore，仅检查源码与测试 | 已关闭 |
| P0-T10 | P1 | Frontend Node tests | 11 个断言失败，集中在 Apple/Passkey UI 契约、API host rewrite、敏感状态清理和 task alias | 对照当前公开契约修复实现或过期测试 | 已关闭 |
| P0-T11 | P1 | iOS test infra | 两台模拟器均在测试克隆准备阶段收到 CoreSimulatorService connection interrupted；Mac 兼容运行因无签名无法安装 | 保留无密钥修改约束；优先恢复 Simulator 服务，至少完成 build-for-testing，并在可用环境执行 XCTest | 环境受限；test build 已通过，XCTest 交由 CI |
| P0-T12 | P1 | Docker smoke infra | 本机 `docker` 命令不可用 | 以静态 compose 解析和 CI Docker smoke 作为本机替代证据，不伪造本地通过 | 环境受限；静态门禁已通过，容器 smoke 交由 CI |
| P0-T13 | P2 | Jest native handle | 完整 Jest 报告 Lance/CustomGC open handle | 将原生 Lance 依赖延迟到真正执行路径，测试不应仅因 import 保留句柄 | 已关闭 |
| P0-T14 | P2 | Repository test drift | Workspace history、Agent 默认提示词、文件写入路径、Knowledge Graph 文案、User 模型断言与当前架构不一致 | 区分回归与契约演进，更新最小断言或修复实现 | 已关闭 |
| P0-T15 | P2 | FFmpeg test | Collector FFmpeg 套件依赖外部下载/动态 import，产生超时与不稳定 | 改为确定性本地夹具或显式 mock | 已关闭 |
| P0-T16 | P1 | Motion CI | 最终 `lint:ci` 的 Motion System 检查发现 50 处既有/当前非 token 动效 | 将当前明确接受的存量加入基线；本轮触达文件改用统一 motion token，新增违规继续 fail-closed | 已关闭 |
| P0-T17 | P1 | 客户端加密审计 | `prompt-draft-local-legacy-cleared` 静态契约未匹配当前草稿清理实现 | 核对真实清理路径，修复实现或审计规则，不得放宽敏感明文检测 | 已关闭 |
| P0-T18 | P1 | Chat Hash Chain benchmark | 与其他审计并行时亚毫秒 p95 噪声使 1000/10 增幅达到 22.16%，超过 20% 门槛；360 次仍全为增量、0 rebuild、0 断链 | 保留 20% 性能门槛，改进基准隔离/采样稳定性后定向复测 | 已关闭 |
| P0-T19 | P1 | Web 开发路由 | `frontend/public/login` 与 SPA `/login` 冲突，Vite 开发环境的无尾斜杠 `/login` 返回 500 | 在开发服务器入口消除目录冲突，保持生产资源 URL 与路由语义不变 | 已关闭 |

## 缺陷修复复测结论

- 定向 Server/Jest、Frontend Node、Collector 测试以及 `--detectOpenHandles` 均通过；LanceDB 的测试进程不再遗留原生句柄。
- Server、Frontend、Collector ESLint 均通过；DataAccess、Key Custody、安全路由审计均为 0 finding。
- Server 与 Collector 供应链可达 Critical 从首轮非零降为 0；所有剩余 High 已进入带负责人、隔离措施和到期日的门禁策略。
- 主库和共享 Auth DB 复测仍为 `quick_check=ok`、`foreign_key_check=0`。
- iOS App 与测试目标完成通用 Simulator `build-for-testing`；本机 `simctl` 仍由 CoreSimulatorService 异常终止，未把基础设施失败伪报为 XCTest 通过。
- 本机无 Docker CLI；Compose 结构解析、Shell 语法和 GitHub Actions SHA 固定均通过，真实容器 smoke 已固化到 CI。

## 最终门禁与缺陷定向收口

- 最终完整门禁：Server/Jest 212/212 套件、1176/1176 测试通过且 `--detectOpenHandles` 无残留；Frontend Node 391/391 通过；Collector 8/8 套件、67/67 测试通过；Frontend production build 通过。
- P0-T16：本轮触达组件全部改用集中式 motion token；36 条未触达存量以“文件 + 违规类型 + token + 数量”精确基线化，新增或数量回升立即失败。定向 Motion、Prettier、ESLint 均通过。
- P0-T17：删除已失效的“跨设备草稿必须使用浏览器本地密钥”静态假设；门禁改为同时验证旧明文草稿清理、服务端受保护投影、Sync V2 离线队列 AES-GCM 封装与 IndexedDB 持久化。静态审计 14/14、0 finding；真实浏览器存储审计 0 finding、0 high-risk。
- P0-T18：链尾业务查询新增 `workspace_chats_scope_tail_idx`，消除旧索引中 `include` 阻断 `id` 排序导致的临时 B-Tree。交错采样复测中 1000/10 历史 p95 增幅为 1.00%（门槛 20%），360 次均为增量追加、0 rebuild、0 断链；相关 11 个 Jest 测试通过。
- P0-T19：Vite 开发入口仅将精确 SPA 路由 `/login` 重写给 React Router，`/login/` 静态资产路径保持不变。`/`、`/login`、`/login?nt=1`、`/login/`、API readiness 与 Collector health 全部返回 200。
- 最终生命周期 smoke：开发环境三进程均 ready；SIGTERM 排空退出 2 秒；3000、3002、8889 均无残留监听。

## 非缺陷但保留的约束

- 已从 Git 索引移除的 `server/storage/embedding-batches` 与 `server/storage/tool-runs` 文件仍保留在本地磁盘，不删除真实运行数据。
- iOS 源码/工程当前仍是未跟踪目录；本轮只验证和修改必要源码，不提交 DerivedData、运行缓存或密钥。
- 未修改、轮换或重写任何现有密钥、Passkey 公钥、恢复凭据和 Git 历史。
