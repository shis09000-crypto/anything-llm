# Athena Performance Mapping Center v1

状态：Implemented Draft  
协议版本：`1.0`  
首个 Adapter：`mock.anatomy.v1`

## 1. 目的

Performance Mapping Center 是 Character Responses v2 与未来 3D 客户端之间的稳定编译边界。Character 模型只生成语言、神态、动作和时间语义；本模块把已经通过 Character Validator 与 Manifest Resolver 的 cue 编译成前端可执行命令。模型输出、Character v2 wire format 和引擎底层资产参数互不渗透。

## 2. 固定数据流

```text
Character Conversation Turn
→ Character Response v2（语义计划）
→ Manifest resolved sequence（语义解析）
→ Performance Pack selection（精确版本与摘要）
→ character.performance.plan（前端命令）
→ SSE / WebSocket Session events
→ Adapter execution
→ character.execution.* feedback（实际证据）
```

Responses Runtime 是模型生成、Character 语义校验和 Character Manifest resolution 的唯一所有者。Character Performance Runtime 是 Pack、编译计划、执行会话和 actual evidence 的唯一所有者。前端不解析模型输出、不自行选择 fallback，也不把引擎字段写回 Character Response。

## 3. API

内部接口：

- `GET /internal/v1/character-performance/packs/:packId`
- `POST /internal/v1/character-performance/sessions`
- `GET /internal/v1/character-performance/sessions/:sessionId`
- `POST /internal/v1/character-performance/sessions/:sessionId/link`
- `POST /internal/v1/character-performance/sessions/:sessionId/plans`
- `GET /internal/v1/character-performance/sessions/:sessionId/events`
- `POST /internal/v1/character-performance/sessions/:sessionId/execution-feedback`
- `POST /internal/v1/character-performance/sessions/:sessionId/cancel`
- `WS /internal/v1/character-performance/sessions/:sessionId`

认证后的 Athena facade：

- `POST /api/character-performance/sessions`
- `GET /api/character-performance/sessions/:sessionId`
- `POST /api/character-performance/sessions/:sessionId/turns`
- `POST /api/character-performance/sessions/:sessionId/replay`
- `WS /api/character-performance/sessions/:sessionId/stream`

Facade 只接受适配器能力、runtime version、已安装资产摘要和当前输入。用户、Workspace、Thread 与 client identity 由认证上下文绑定；Manifest、Pack 和权限不能由浏览器提交。

## 4. Performance Pack

Pack 使用 Draft 2020-12 Schema `athena-character-performance-pack-v1.schema.json`，包括：

- Pack `id/version/adapter/character_id/minimum_runtime_version`；
- Character Manifest 的精确 `id/version/sha256`；
- `asset_ref/media_type/sha256`；
- 按固定顺序声明的 13 条轨道；
- capability pattern 到 adapter binding 的映射；
- primitive、target template、资源、时长、blend、reduced-motion 和 fallback 策略；
- Pack SHA-256、Ed25519 key ID 与签名。

`asset_ref` 只允许 `asset:` 或 `builtin:`，不允许远程 URL 或绝对路径。开发可以加载 unsigned Pack；生产必须由受信任 Ed25519 key 验签。Pack JSON 是版本控制中的权威来源，数据库只保存精确引用。

fallback 最多四层；循环与超深链在加载阶段拒绝。required cue 无绑定使 Plan 失败，optional cue 无绑定产生 warning 并跳过。Manifest fallback 和 Pack binding fallback 分属两个生命周期，证据分别保存。

## 5. 编译计划

编译结果为 `character.performance.plan`。每个 command 固定包含：

- `command_id/cue_id/track`；
- 编译后的 `start_ms/duration_ms`；
- planned、resolved 和 nullable actual 时间证据；
- `easing/intensity`；
- `binding_id/primitive/target/parameters`。

v1 primitive：

- `face.region_state`
- `gaze.target`
- `body.motion`
- `limb.motion`
- `world.action`
- `speech.text`

编译器只使用 resolved cue，不二次解释情绪或动作。跨轨并行原样保留；同一资源冲突沿用 Character Resolver 的 `first_wins` suppression。模型 planned 值不可覆盖，Pack 校正只形成 resolved/compiled 证据，前端执行结果只形成 actual 证据。

## 6. 会话与事件

Performance Session 绑定 Character instance、Workspace、可选 Thread、用户、Adapter、Pack 与 Character Conversation。事件序号在 Session 内严格递增，支持 `after_sequence` 恢复。执行反馈以 `event_id` 幂等去重，且 command ID 必须存在于当前 Plan；伪造 ID 返回权限错误。

核心事件：

- `character.performance.session.created/cancelled`
- `character.performance.plan.compiled`
- `character.execution.started/completed/failed/cancelled`

生成完成、计划编译完成和实际播放完成仍是三个独立生命周期。

## 7. 存储与安全

模块拥有四类表：Session、Compiled Plan、Session Event、Execution Feedback。为保证 Character Response → 3D Center 的最低延迟，client profile、Plan、事件和反馈 payload 直接保存 JSON，不经过 Key Custody、密文 envelope 或远程解密；hash 在读取时本地复核。SQLite 与 PostgreSQL 使用同构迁移。旧 `athena.character-performance.ciphertext.v1` Session 不再兼容，升级后必须重新创建。

独立服务身份为 `spiffe://athena/{environment}/character-performance-runtime`，只允许 `responses-runtime` 与 `athena-api` 调用。WebSocket 使用一次性 `character-performance` ticket，绑定 Session resource 和当前 client identity。实验页只允许开发者、管理员和 owner；单用户模式继续遵循现有认证策略。

## 8. Web Mock

`/settings/character-performance-lab` 是 DeveloperRoute 页面。默认只回放本地 Fixture，不调用模型；用户显式点击后才创建真实 Performance Session 与 Character Conversation Turn。

页面提供：

- 13 轨时间轴及并行区块；
- 八个五官区域和头、肩、躯干、左右臂、手、腿图；
- planned/resolved/actual 三层证据；
- Pack digest、binding、warning 和 suppressed cue；
- Play、Pause、Scrub、Replay、0.5x/1x/2x；
- Mock Adapter started/completed feedback。

Speech 只显示文字，不接 TTS 或 Viseme。

## 9. 兼容与切换

`ATHENA_CHARACTER_PERFORMANCE_RUNTIME_CUTOVER=true` 时，Character Conversation Runtime 在每轮 materialize 后把 Response 与 resolved event 交给新模块。未设置 Performance Session 或 cutover 未启用时，旧 Character v2 请求继续使用现有 Mock Performance Client，不改变 v1/v2、普通 Chat、Agent 或旧客户端 wire format。

未来接 UE5、Unity、Web 3D 或 VRM 时，只新增 Adapter 与 Performance Pack。Character Responses v2、Performance Plan 外层和生成/编译/执行生命周期不改变。

## 10. 明确非目标

v1 不接真实 UE5、Three.js、Unity、VRM、GLTF、骨骼、Morph Target、Control Rig、Montage、TTS、Viseme、动画资产上传、CDN 或对象存储。`mock.anatomy.v1` 的视觉执行仅用于验证时间、绑定、恢复、反馈和冲突证据。
