# Athena 3D Center 与 Character Memory v2 测试门禁

状态：实施版 1.0

## 分层

| 门禁    | 命令                          | 要求                                  |
| ------- | ----------------------------- | ------------------------------------- |
| PR      | `yarn test:3d-center:pr`      | 合约、Mock、SQLite、性能和Playwright  |
| Nightly | `yarn test:3d-center:nightly` | PR核心、PostgreSQL、压力、真实Gateway |
| Release | `yarn test:3d-center:release` | 全量覆盖、完整实测、浏览器和人工签字  |

Nightly与Release缺少真实服务、隔离数据库、认证状态或DeepSeek配置时必须失败，不能把关键套件标记为跳过。

## 环境

- `ATHENA_3D_TEST_BASE_URL`：已启动的Athena API地址。
- `ATHENA_3D_TEST_AUTH_TOKEN`：合成开发者账号Token。
- `ATHENA_3D_TEST_WORKSPACE_ID`、`ATHENA_3D_TEST_THREAD_ID`：隔离测试范围。
- `ATHENA_3D_TEST_POSTGRES_URL`：名称包含`athena_3d_test`的临时PostgreSQL数据库。
- `ATHENA_3D_TEST_POSTGRES_APPLY_MIGRATIONS=true`：允许在上述隔离库执行Migration。
- `ATHENA_3D_E2E_BASE_URL`：浏览器测试地址。
- `ATHENA_3D_E2E_STORAGE_STATE`：合成开发者账号的Playwright storage state。
- `ATHENA_3D_STRESS_MINUTES=30`：Release压力测试时长。

真实链路必须由3D Center API进入Responses Runtime和Model Gateway。测试脚本不实例化DeepSeek Provider，不允许通过多次生成挑选结果。

## 硬门禁

- Gateway热槽准备p95不超过25ms。
- 完整13轨计划编译p95不超过50ms。
- 固定CI机器上的Memory prepare/commit、WebSocket和浏览器调度指标由外部集成环境报告，并与同版本基线比较；回退超过20%阻断。
- 覆盖率只统计会直接改变角色长期认知或时间区块编排的纯策略内核：`formationPolicy`与`presentationCompiler`。它们必须达到行覆盖率90%、分支覆盖率85%；API、数据库、Gateway与Adapter由独立集成/故障注入门禁验收。
- 普通成功场景不允许未声明warning。专门场景仅允许`resynced`、等待时长默认值、optional fallback、时长解析和`first_wins`。

## 人工阻断式验收

产品验收者和工程/动画验收者独立为人设语言、五官连续性、注视可实现性、头身四肢自然度、时序自然度、同Session连续性和跨Session记忆打1至5分。每项平均分必须至少4分。

以下任一问题直接阻断发布：不可能动作、同时注视多个目标、严重人设破坏、危险场景错误反应、虚假记忆、旧姿势或接触跨Session继续执行。

人工结果填写`docs/examples/athena-3d-center/testing/manual-acceptance-template.json`，并通过`ATHENA_3D_MANUAL_ACCEPTANCE_FILE`传给Release门禁。Release要求产品与工程/动画两位独立验收者、七项平均分均不低于4、无致命问题且明确批准。
