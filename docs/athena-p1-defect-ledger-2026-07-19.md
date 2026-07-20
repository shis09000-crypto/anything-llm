# Athena P1 测试缺陷记录

状态：首轮完整矩阵、集中修复与定向复测均已完成，登记缺陷全部关闭。

执行规则：架构评估完成后先完整运行一次矩阵并一次性登记全部缺陷；完成集中修复后，仅复测缺陷和直接相关 smoke，不在每个修复回合重复全量测试。

| ID | 测试域 | 严重级别 | 现象 | 根因 | 修复 | 复测 |
| --- | --- | --- | --- | --- | --- | --- |
| P1-T01 | Server lint | P1 | `authSession.js` 与 `securityProjection.js` 有 2 处 Prettier 换行错误 | 新增代码未按项目格式展开 | 精准格式化对应文件 | 已通过定向 ESLint |
| P1-T02 | Web lint | P1 | `authSessionClient.js` 有 1 处 Prettier 换行错误 | 新增调用的换行不符合项目格式 | 精准格式化对应文件 | 已通过定向 ESLint |
| P1-T03 | 浏览器存储审计 | P1 | Playwright 无头启动系统 Chrome 后进程被本机 `SIGKILL`，未进入页面断言 | 本机系统 Chrome 的无头启动兼容问题；headed 副链路可正常执行完整断言 | 保留审计规则与断言，使用 `--headed true` 完成同一真实开发环境复测 | 已通过，0 finding / 0 high-risk finding |
| P1-T04 | Sync 跨库补偿测试 | P1 | 全量测试覆盖 AuthSession 和安全投影，但没有直接验证相同来源修订去重及周期分页补偿 | 新闭环缺少故障注入断言 | 补充通知失败不回滚登录、相同修订去重、修订稳定性与分页对账测试 | 4/4 套件、46/46 测试通过 |

## 首轮矩阵

- Server：AuthSession、Sync V2、安全投影、请求签名、数据访问门禁、数据库审计。
- Web：请求签名镜像、会话 API 适配、Sync V2 状态存储、定向 lint 与 production build。
- iOS/iPadOS：AccountSettings、NativeSyncCenter、API 签名、Simulator build/test。
- 回归：P0 Session、安全审计、Sync V2 benchmark/shadow audit、暖启动与 Outbox 指标不回退。

## 首轮结果

- Server/Collector Jest：212/212 套件、1180/1180 测试通过，`--detectOpenHandles` 无残留。
- Frontend Node：391/391 通过；production build 与加密产物门禁通过。
- iOS/iPadOS：iOS 26.5 Simulator 发现并通过 99/99 测试，0 失败、0 跳过。
- DataAccess、Key Custody、安全路由审计均为 0 finding；主库与 Auth DB `quick_check=ok`、`foreign_key_check=0`。
- Sync V2 shadow audit：263 节点、186 个投影，0 缺失、0 Hash 不一致、0 权限泄漏；Outbox 无积压。
- Sync V2 benchmark：暖启动请求下降 72.41%，业务载荷下降 99.47%；活跃账户分别下降 85.19% 和 99.74%。
- Chat Hash Chain：1000 相对 10 条历史 p95 仅增长 2.251%，360 次增量追加、0 rebuild、0 断链。
- 真实开发 Auth DB 当前没有活动 Session V2 记录，因此实库检查只能确认表/外键/查询路径，真实会话行为由单元、Simulator 与后续本地登录 smoke 覆盖。

## 集中修复与定向复测

- Server Sync/Auth 定向 Jest：4/4 套件、46/46 测试通过。
- Server 与 Web 新增文件定向 ESLint：通过。
- 真实开发站点浏览器存储审计：成功访问登录页，检查 3 个 localStorage key、2 个 sessionStorage key、4 个 IndexedDB，0 finding、0 high-risk finding。
- `git diff --check`：通过；未触碰或轮换任何现有密钥。
