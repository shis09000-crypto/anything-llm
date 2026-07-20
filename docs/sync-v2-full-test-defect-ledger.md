# Athena Sync V2 完整测试缺陷台账

测试日期：2026-07-18

## 执行规则

- 架构门禁：PASS，见 `docs/sync-v2-system-closure-evaluation.md`。
- 完整测试轮开始后冻结代码；即使发现缺陷，也先登记并继续剩余矩阵。
- 完整轮结束后一次性修复全部可复现缺陷。
- 修复后只运行缺陷定向测试、受影响邻接回归与轻量最终证据检查，不重复整套完整/压力/极限测试。
- 每条缺陷记录首次证据、影响范围、根因、修复文件、定向回归和最终状态。

## 完整轮矩阵

| ID  | 范围                                                       | 状态     | 证据/缺陷引用                                                                                                                                                                                            |
| --- | ---------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 | Git diff、语法、Prisma schema/migration、canonical vectors | 通过     | `git diff --check`、关键文件 `node --check`、Prisma validate、module boundary、canonical Jest 向量均完成；Xcode 工程和 destination 可解析。                                                              |
| F02 | Sync V2/Outbox/mutation/权限/领域投影服务端测试            | 失败     | 根 Jest 执行 294 suites/1264 tests：207 suites、1227 tests 通过；见 D01、D02。                                                                                                                           |
| F03 | 聊天增量 Hash Chain、事务回滚、审计修复与长线程基准        | 部分通过 | 加密审计：1038/1038 正文加密、1038 metadata、`chainInvalid=0`；增量/批量/后缀重建单测进入完整 Jest。缺少 10/100/1000 真 SQL p95 证据，见 D11。                                                           |
| F04 | Web Sync V2 state store/runtime/mutation queue 定向测试    | 失败     | state store 批量 descriptor 单次提交通过；runtime 3 项与通信测试装载器共 15 项失败，见 D03。                                                                                                             |
| F05 | Web ESLint、production build、构建产物安全检查             | 部分通过 | Vite production build、postbuild、Crypto build output、客户端加密覆盖均通过；lint 失败，见 D04。                                                                                                         |
| F06 | iOS/iPadOS unit tests 与 Simulator build                   | 失败     | iPhone 17 / iOS 26.5 Simulator 编译中止，测试未开始，见 D05。                                                                                                                                            |
| F07 | Shadow audit、加密/权限/密钥托管安全审计                   | 失败     | key custody 与加密覆盖通过；Shadow 68 项 Hash 漂移、resource audit 4 项、hardening audit 8 项，见 D06-D08。                                                                                              |
| F08 | Sync V2 冷/暖启动与事件突发性能基准                        | 通过     | 全用户暖启动请求 -72.41%、业务字节 -99.49%；活跃用户暖启动请求 -85.19%、字节 -99.74%。WorkspaceChat 确定性压力模型也通过。                                                                               |
| F09 | 本地真实开发/生产 HTTPS、登录、REST、WS、SSE 链路          | 部分通过 | 开发前后端 HTTPS ping=200；鉴权 REST manifest/batch/events=200，SSE ready、WSS ready/replaceSubscriptions/pong 均通过。生产因安全配置拒绝启动，见 D09；真实密码登录/浏览器鉴权审计缺少测试凭据，见 D10。 |
| F10 | 乱序/重复/断线/游标过期/Hash 漂移/权限撤销故障注入         | 部分通过 | unit fault cases 已纳入完整 Jest；真实游标对低值不回退、对超大值钳制 checkpoint，100 节点 warm batch 全部 unchanged 且无 payload。无可登录的非管理员开发身份用于真实撤权验证，见 D10。                   |
| F11 | 并发、压力、极限数据量、Outbox 积压与回滚开关              | 部分通过 | SQLite integrity=ok；无 orphan、重复 event/mutation、版本回退、pending outbox 或越界 cursor；真实极限 p95/积压恢复证据不足，见 D11。                                                                     |

## 缺陷记录

### D01 — 根 Jest 扫描发布产物

- 首次证据：`yarn test --runInBand` 扫描 `dist-desktop/win-unpacked` 与 `win-arm64-unpacked`，在打包树中重复运行服务端测试并因 `dotenv`、`uuid`、`@prisma/client` 等运行时依赖不可解析而失败。
- 影响：真实源代码测试结果被 80+ 个发布产物 suite 噪声污染，CI 不能作为可靠门禁。
- 计划：在根 Jest 配置中排除构建、桌面打包和原生 target 目录，不缩小真实源码测试范围。

### D02 — Sync V2 批量投影缓存重复查询

- 首次证据：`server/__tests__/models/syncV2.test.js` 两项失败；角色查询本应 0 次却发生 1 次，同一用户投影本应 1 次却发生 2 次。
- 影响：批量 hydration 仍有重复用户/角色读取，冷启动数据库请求未完全达到批量化设计。
- 计划：统一 visibility context 与 projection cache 的用户记录/角色来源，避免二次查询。

### D03 — Web Node 测试装载器与新增依赖不兼容

- 首次证据：82 项 Node tests 中 67 通过、15 失败。通信测试 data-URL 装载器无法解析新 `@/utils/tasks/taskRequestMetadata` 等依赖；Sync V2 runtime fixture 未注入 `syncV2NodeArchive`，导致事件微批次 3 项失败。
- 影响：浏览器 production build 可通过，但快速单元门禁失真，无法验证 200→20 去重、200→2 batchGet、25ms 微批 ACK。
- 计划：扩展测试 fixture/stub 边界，不在生产代码中为测试降级。

### D04 — 全仓 lint/Prettier 失败

- 首次证据：`yarn lint:ci` 在 Sync V2 改动文件及既有同批文件中报告 Prettier 错误；构建本身通过。
- 影响：CI 质量门禁失败，部分格式噪声掩盖真实 lint 问题。
- 计划：仅格式化台账中实际报错文件，不批量改动无关目录；随后执行定向 ESLint 与根 lint 相邻回归。

### D05 — iOS Sync 事件模型缺少 Hash

- 首次证据：`NativeSyncV2.swift:792` 访问 `NativeSyncV2Event.hash`，但模型无该属性，Simulator test build exit 65。
- 影响：iOS/iPadOS Sync V2 无法编译，Hash 差异补拉路径不可用。
- 计划：协议模型补齐可选 `hash` 并验证 JSON decoding、replay、微批与 Hash repair。

### D06 — 68 个线程元数据节点 Hash 漂移

- 首次证据：read-only shadow audit：261 nodes、186 projections、68 `threads/{id}/metadata` hash mismatch，其他 inaccessible/missing/conflict 为 0。
- 影响：现存节点会触发一次修复补拉；若写路径仍产生漂移，会增加冷启动 reconcile 与异常率。
- 计划：区分历史 schema/projection 漂移与持续写入缺陷；修正投影一致性后通过既有 repair 副链路一次性修复并复审。

### D07 — thread ID-only 权限审计命中

- 首次证据：resource communication audit 在 `syncCenter.js`、`workspaces.js` 两处及 `chatTurnMutations.js` 共 4 处命中 `WorkspaceThread.get({id})`。
- 影响：若后续作用域校验被改动或遗漏，存在跨工作区对象引用风险；当前审计门禁失败。
- 计划：查询本身绑定 workspace/user scope，或在已具备同等强度的调用点提供精确、可审计的安全适配器。

### D08 — 安全硬化路由与静态扫描边界缺口

- 首次证据：3 条 native passkey POST 路由未纳入签名策略；5 条 scheduler/network audit 自扫描或适配层被误判为绕行通信。
- 影响：高风险设备注册边界不完整，且误报使 hardening audit 无法作为发布门禁。
- 计划：把已认证的 native passkey mutation 纳入签名策略；对扫描器自身和唯一受控 fetch 适配层建立窄范围、带理由的规则，不扩大通用 allowlist。

### D09 — 本地生产运行缺少强安全配置

- 首次证据：`run-production` 完成构建和迁移后，server 因 `JWT_SECRET < 32`、缺少 `AUTH_TOKEN` 正确拒绝启动；3001 无监听并进入 supervisor crash-loop cooldown。
- 影响：无法完成生产 REST/WS/SSE 和本地 production perf 验收。
- 计划：保留 fail-closed；用不落日志的强随机运行时配置启动本地生产验收，不弱化 production validator。

### D10 — 鉴权浏览器测试身份缺口

- 首次证据：`security:runtime-storage-audit` 与 `perf:local-production` 缺少 `ATHENA_TEST_EMAIL/PASSWORD`；开发库无可登录的非管理员 development 用户，真实撤权测试无法建立最小权限对照。
- 影响：公开页存储审计通过，但鉴权缓存隔离、真实登录和撤权只能由 unit/direct protocol 证据覆盖。
- 计划：测试工具支持短期 `ATHENA_TEST_TOKEN`，或通过隔离 QA 身份执行后清理；禁止在产品中加入测试后门。

### D11 — 极限性能证据缺口

- 首次证据：功能单测覆盖增量链尾、批量一次查询和后缀重建，但没有以真实 SQLite 分别对 10/100/1000 历史长度追加并输出 p95；Outbox 极端积压只由模型/故障单测覆盖。
- 影响：复杂度设计正确，但首批验收中的“1000 对 10 最多劣化 20%”缺少可重复量化证据。
- 计划：新增隔离临时数据库/事务 benchmark，不接触用户业务数据；作为定向性能验收运行一次。

## 修复后定向回归

完整轮结束后已一次性完成修复；以下结果来自缺陷定向测试与必要邻接回归，没有重新执行完整矩阵。

| 缺陷 | 修复与定向证据                                                                                                                                                                                                  | 最终状态 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| D01  | 根 `jest.config.js` 排除 `dist-desktop`、前端构建产物、服务端 public 与原生 target；`jest --listTests` 只列出 202 个源码测试文件，0 条桌面发布产物路径。                                                        | 已关闭   |
| D02  | 合并 Sync V2 visibility/projection 的 user 与 role 查询来源；`server/__tests__/models/syncV2.test.js` 14/14 通过。                                                                                              | 已关闭   |
| D03  | 补齐 Web data-URL loader stub 与 Sync V2 archive fixture；原 15 项失败连同邻接用例共 23/23 通过。                                                                                                               | 已关闭   |
| D04  | 只修正本轮涉及文件；服务端和前端目标 ESLint/Prettier 均为 0 错误，production build 保持通过。                                                                                                                   | 已关闭   |
| D05  | `NativeSyncV2Event` 增加可选 `hash`；iPhone 17 Simulator 编译成功，`NativeSyncV2ProjectionTests` 4/4 通过。                                                                                                     | 已关闭   |
| D06  | 修正线程投影一致性，并给历史 repair 增加 SQLite write-lock 短暂重试；修复后只读审计为 261 nodes、186 projections、0 mismatch、0 missing、0 conflict、0 pending Outbox。                                         | 已关闭   |
| D07  | thread 查询绑定 workspace/user scope；resource communication audit 为 0 新增、0 blocked。                                                                                                                       | 已关闭   |
| D08  | native registration、provider settings/custom models 纳入签名匹配，扫描器误报边界收窄；security hardening audit 扫描 331 条路由，0 findings。                                                                   | 已关闭   |
| D09  | 保留生产 fail-closed，以短期强随机密钥完成本地 HTTPS 3001/collector 8888 验收；补齐 direct HTTPS 的 `PUBLIC_APP_URL`，带 Origin 的静态资源为 200。生产验收后已停止。                                            | 已关闭   |
| D10  | 测试脚本支持短期 token；隔离 QA 用户完成鉴权存储审计，localStorage 0、IndexedDB 0、仅 sessionStorage 认证态，0 findings。QA 用户/工作区已删除，`multi_user_mode=false`。                                        | 已关闭   |
| D11  | 新增隔离 SQLite 增量链基准：10/100/1000 历史的 append p95 分别为 0.800/0.679/0.897 ms；1000 相对 10 的 p95 劣化 12.125%，低于 20% 门槛；360 次 append 无 rebuild fallback，2508 条 chat/metadata 完整，0 断链。 | 已关闭   |

定向回归还覆盖：mutation 幂等与事务 merge 4/4、聊天加密链、data access、passkey、thread move、client identity；Prisma schema 校验通过。生产浏览器性能脚本的 HTTP 失败判定也已收紧，避免把关键请求失败误报为成功。

## 最终环境确认

- 开发环境：HTTPS `3000/3002` ping 均为 200，supervisor 与 server/collector/frontend 正常运行。
- 生产测试环境：验收后停止，`3001/8888` 无残留 supervisor。
- 生产测试数据：`syncv2-qa` 用户 0、工作区 0；`multi_user_mode=false`。
- 最终轻量门禁：`git diff --check`、关键脚本语法、shell 语法与 Prisma validate 通过。

因此，本台账中 D01-D11 已全部关闭。这里的“关闭”表示首次完整轮记录的问题均通过定向证据验证；不等同于重新跑过一次全量套件，也不把尚未灰度验证的真实用户 p95 当作已完成。

## 完整轮后的真实文档定向闭环

本节是用户授权后的本地真实文档专项验证，不是第二次完整测试轮。测试直接使用开发库中“金钱心理学”工作区的 3 份现有解析文档；未改写源文档，也未选择或覆盖冲突中心中的本地/服务端值。

| ID  | 首次证据                                                                                                                                                                                         | 修复                                                                                                                    | 定向结果                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01 | Sync V2 工作区 metadata 投影不含 `documents`，Reader 把该轻量投影当完整 workspace 使用，数据库有 3 份文档但选择器显示 0。                                                                        | Reader 进入“工作区文档”时通过现有 `Workspace.bySlug` 懒加载领域详情；状态树仍只承担节点版本与失效，不复制文档列表正文。 | 进入选择器只产生 1 次工作区详情请求，3/3 真实文档均可见。                                                                                          |
| R02 | 持久化的 30% 分屏在当前窗口把 Reader 压到约 34 px，按钮视觉存在但点击中心落在视口边界。                                                                                                          | Reader 桌面面板增加 420 px 最小宽度。                                                                                   | 真实窗口中选择器、退出和引用控件可操作，未恢复全局 workspace 刷新。                                                                                |
| R03 | 同步冲突中心固定占据右下 420 px，完整覆盖 Reader 历史卡的“打开”按钮；点击实际落到冲突浮层。                                                                                                      | 冲突中心增加可折叠状态；新冲突到达仍自动展开，折叠后保留带数量的恢复入口。                                              | 未处理现有 2 条冲突的前提下，Reader 历史按钮可正常操作，冲突信息和决策入口均保留。                                                                 |
| R04 | `workspace_parsed` 历史先请求临时 Reader ID，产生 workspace/global 两次 404，再回退工作区路径；缓存恢复副链路又重复发起同一路径请求。一次历史重开记录到 2 次 404 加 7 次 `from-workspace` 尝试。 | 历史记录对 `workspace_parsed` 直接走工作区权威路径；当前文档 ref 阻止缓存恢复重复打开同一文档。                         | 历史重开为 1 次 `from-workspace` 200、0 次 Reader-ID 404、正文成功渲染；Reader 领域请求从 9 次降至 1 次（-88.9%）。普通选择器打开同样为 1 次请求。 |

专项测试遵循同一缺陷节奏：先完成真实交互和 45 项 Reader 单元测试，再统一修复首次静态检查记录的 2 个语言文件格式问题；随后只复测这 2 个失败文件，Prettier/ESLint 均通过，没有重跑已通过的 45 项测试。

为让本地 HTTPS 走系统信任而不使用 `-k`，仅把现有 `.dev-ssl/athena-dev-ca.crt` 加入当前用户 login keychain 的 SSL 信任；未生成、替换、修改或删除任何证书/私钥。操作前后 CA 证书、CA 私钥、叶证书和叶私钥的 SHA-256 分别保持 `da784c17…5b6`、`a3eb14c2…e13`、`70fea697…25d`、`d2a2b67c…ea7`，无字节变化；无 `-k` 的前后端 HTTPS 请求均为 200。
