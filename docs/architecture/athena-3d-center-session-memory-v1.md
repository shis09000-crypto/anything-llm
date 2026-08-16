# Athena 3D Center Session Memory v1

## 状态

内部协议，wire version `1.0`，storage revision `1.1`。该能力属于 Chat Runtime 的数据记忆领域；Character Conversation 只通过 3D Memory Fast Lane 访问。它不是新的数据库、微模块或前端协议。

## 数据边界

- 语言记忆保存完整 User/Assistant 文本，并由 Active Checkpoint 加后续完整 Turn 构建上下文。
- Character Performance 只保存固定的 `previous_state / transition / current_state`。
- 三态覆盖完整五官、注视、头身、四肢、持续 Action、Voice Delivery、情绪、注意、活动与衰减。
- 已执行 cue、13轨时间线和 execution feedback 留在 Responses/Performance 数据中，不进入语言压缩。
- 前端特殊 API、Memory Fast Lane 与同一 3D Character Session 的持久化内容都使用直接 JSON，不使用应用层加密、密文 envelope 或 Key Custody 往返。
- 旧 `athena.3d-session-memory.ciphertext.v1` Session 不读取、不迁移；升级后重新创建，保证热路径没有任何解密兼容分支。
- 明文范围仅限四张 `athena_3d_*` Session Memory 表；普通 Chat Memory、Responses 审计、账号数据及其他安全域不受影响。

## 所有权与存储

Chat Schema 拥有：

- `athena_3d_session_memories`
- `athena_3d_session_memory_turns`
- `athena_3d_session_memory_checkpoints`
- `athena_3d_character_state_windows`

Responses Schema 只在 Character Turn 上保存 Memory Commit 状态与重放证据。同一 Character Session 产生的 state、input、control、event，以及 Character Response 的 item、event、checkpoint，均使用直接 JSON；普通 Responses 审计数据继续采用其原有存储策略。

数据库字段明确使用内容语义命名：

- Turn：`userJson / assistantJson`
- Checkpoint：`summaryJson`
- State Window：`previousStateJson / transitionJson / currentStateJson`

明文策略以低延迟为第一优先级：写入只做 JSON 序列化、token 计数、hash 和 CAS，不发起远程密钥服务调用。Performance Plan、Session Event 与 Execution Feedback 同样直接 JSON，使 Memory/Responses/Performance 三段之间不存在密钥服务等待。Fast Lane 不做签名、鉴权协商或 capability registry 查询，只能绑定本机回环或容器私有网络；数据隔离由 Workspace/Thread/User scope、数据库角色与会话生命周期删除承担。

## 3D Memory Fast Lane

记忆仍由 Chat Runtime 的 `3d-center` namespace 唯一拥有；Fast Lane 只是访问路径，不是第二份 Memory，也不允许 Performance Runtime保存或解释人物历史。

- 热路径为 `Responses Runtime → http://chat-runtime:3116/v1/dispatch → 3D Session Memory Repository`。
- Fast Lane 采用固定 `athena.3d-fast-lane.v1` envelope 和普通 JSON；不执行 AICP negotiation、签名、加密、Key Custody 或 capability registry 查询。
- 单一 dispatch 支持 `memory.session.create / memory.context.resolve / memory.turn.commit / memory.status / memory.session.delete / memory.maintenance`。
- 稳定记忆点仍由 `memory_revision + state_revision + CAS` 定义；失败的模型 Turn 可以造成 Conversation ordinal 间隙，但不会造成 Memory revision 间隙。
- 本地开发默认绑定 `127.0.0.1:3116`；容器环境绑定私有 service network。该端口不得发布到宿主机或公网。
- Fast Lane 失败时直接返回可重试错误，不回落 AICP，避免任何签名、协商和不可预测的额外延迟。

## Turn 提交流程

1. Turn 开始前解析 Active Checkpoint、其后所有完整语言 Turn 和完整三态。
2. 若前序 Turn 为 `memory_pending`，必须先从 Response Checkpoint 幂等重放提交。
3. Planner 强制 JSON 输出表演、Conversation Control 和完整 `persistent_state_transition.next_state`。
4. Responses Runtime 生成完整 from/to 状态窗口并先持久化 Response。
5. Chat Runtime 通过 ordinal、memory revision 和 state revision CAS 提交语言与三态。
6. 提交成功才产生 `character.turn.completed`；失败产生 `character.turn.memory_pending` 并阻止下一轮。

## 缓存友好的记忆点布局

传给模型的完整 Memory Point 必须保持以下物理顺序，不允许按字段名重新排序：

```text
memory_point
├── dialogue                    稳定前缀
│   ├── checkpoint
│   └── turns                   完整连续聊天文本
└── performance_state           高频变化尾部
    └── state_window
        ├── previous_state
        ├── transition
        └── current_state
```

完整 Planner Prompt 的固定协议说明、JSON Schema 和格式样例全部位于动态上下文之前；动态上下文内部则是 Checkpoint 与历史聊天在上、神态动作三态在下。新的模型输入通常只会追加一轮文本并替换末尾状态，因此固定协议、Checkpoint 和大部分聊天历史保持相同前缀，提高 Provider prompt cache 命中率。状态仍是完整128k上限语义，不因缓存优化而压缩或省略。

## 压缩

- 完整预计输入达到850,000 tokens或未压缩 Turn 达到512时创建固定范围任务。
- 达到920,000 tokens且任务未完成时阻止新一轮生成。
- 上下文预算为950,000 tokens；920,000硬门为当前输入和协议指令保留安全空间，不会通过裁剪三态释放额度。
- 压缩任务只读取语言，使用 Model Gateway 的 refined-tier `3d_center_session_compaction` 强制 JSON Output。
- Checkpoint 最大24,000 tokens；三态窗口最大128,000 tokens且永不压缩、截断或降级。
- Worker 使用120秒持久 lease和最多5次尝试，服务重启后可重新领取。

## 生命周期

- `soft_closed`、`suspended` 和 `resuming` 保留记忆。
- 正式 `ended` 或显式立即结束在最终提交后删除四张 Session Memory 表的数据。
- `failed` 保留用于恢复和诊断。
- 本协议本身仍只负责单 Session 短期窗口；跨 Session 的原话、关系、情绪与权威末态由独立的 [Athena 3D Center Long-Term Character Memory v1](./athena-3d-center-long-term-character-memory-v1.md) 在同一 Chat Runtime `3d-center` 数据领域接管。
