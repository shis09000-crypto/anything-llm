# Athena Character Continuous Conversations v2

> 3D Center 持续会话从 Session Memory v1 起不再使用固定最近轮数。语言上下文由 Chat Runtime 的 Active Checkpoint 与其后完整 Turn 提供，人物持续表现由完整 `previous_state / transition / current_state` 窗口提供。详见 `athena-3d-center-session-memory-v1.md`。

状态：Internal RFC / Implemented MVP  
协议：Character Conversation v2，内嵌 Character Responses v2

## 1. 目的与边界

Character Response 是一次语义表演生成；Character Conversation 是由多个 Turn、Response、Handoff 和跨轮 CharacterState 组成的持久会话。`character.response.completed` 只表示本轮表演计划生成完成，不代表 Conversation 结束。

本协议复用 Responses Runtime 的 Model Gateway、Response 链和维护任务。Character Conversation Session 内部使用低延迟直接 JSON 存储；普通 Chat、Agent、普通 Responses 及 Character v1/v2 单次 Response 的 wire format 和既有存储策略不变。本阶段不包含 UE5、TTS、Viseme、本地反应模型或长期 Memory consolidation。

## 2. 对象关系

```text
Character Conversation
├── CharacterState revision 0..N
├── Turn 1
│   ├── User Input
│   ├── Character Response v2
│   ├── Conversation Horizon
│   └── Handoff
├── Turn 2
└── Conversation event stream
```

客户端每轮只发送当前输入。Runtime 从持久化 conversation head、最近 Turn 和 CharacterState 构造模型上下文，模型看不到 UE、Provider、密钥或客户端所有权字段。

## 3. API

| 方法 | 路由                                                                | 语义                 |
| ---- | ------------------------------------------------------------------- | -------------------- |
| POST | `/internal/v2/character/conversations`                              | 创建持久会话         |
| GET  | `/internal/v2/character/conversations/:conversationId`              | 获取会话和当前状态   |
| POST | `/internal/v2/character/conversations/:conversationId/turns`        | 创建非流式 Turn      |
| POST | `/internal/v2/character/conversations/:conversationId/turns/stream` | 创建 Turn 并返回 SSE |
| GET  | `/internal/v2/character/conversations/:conversationId/events`       | 按序列恢复 SSE       |
| POST | `/internal/v2/character/conversations/:conversationId/suspend`      | 暂停会话             |
| POST | `/internal/v2/character/conversations/:conversationId/resume`       | 恢复会话             |
| POST | `/internal/v2/character/conversations/:conversationId/end`          | UI 明确结束          |
| WS   | `/internal/v2/character/conversations/:conversationId`              | 同一语义的双向传输   |

创建 Turn 必须提供幂等键。用户、Workspace、Thread 和 Agent scope 由内部调用上下文提供；跨 scope 查询统一返回 not found。

## 4. 单次模型输出

Conversation Turn 仍通过 Model Gateway 调用 `deepseek-v4-flash`，并强制：

```json
{ "response_format": { "type": "json_object" } }
```

模型在同一个 JSON object 中输出 Performance Intent、Performance Sequence、CharacterState transition、Conversation Horizon、Handoff 和 End Intent。Performance output 编译后仍严格保持两个 item，不把 Conversation 控制对象塞入旧 Response output。

```json
{
  "conversation_horizon": {
    "depth": "brief",
    "continuation_probability": 0.15,
    "closure_readiness": 0.9,
    "soft_close_wait_ms": 8000,
    "basis": "answer_complete"
  },
  "handoff": { "target": "user", "mode": "close_ready" },
  "end_intent": { "detected": false, "confidence": 0, "kind": "none" }
}
```

`depth` 是每轮重新估计的剩余交流深度，而不是创建会话时固定的标签。Handoff mode 为 `question | open | passive | close_ready`。

## 5. 软结束解析

模型不能直接结束 Conversation。`close_ready` 只有同时满足以下条件才生效：

- `closure_readiness >= 0.8`
- `continuation_probability <= 0.35`
- 当前 Response 安全评估为 normal
- Handoff 不是 question，且没有 Runtime 已知的待执行工作

未通过时，Runtime 保留 `model_handoff`，把 `effective_handoff` 解析为 passive，并产生 `close_ready_gate_rejected` warning。

Handoff 还要经过 Speech 语用一致性复核。若最终 Speech 明确以待用户回答的问句结束，而模型却给出 `open | passive | close_ready`，Runtime 必须保留原始 `model_handoff`，将 `effective_handoff` 规范化为 `question`，并产生 `handoff_question_normalized` warning。该规则只修正 Conversation 控制状态，不修改模型生成的台词、五官、动作或时间 cue；仅出现在句中、随后已自行回答或收束的反问不触发规范化。

模型合法等待时长为 3000–120000ms。模型缺失、输出非整数或越界时，Turn 不失败，而是产生 `soft_close_wait_defaulted` warning，并按深度使用：brief 8000ms、normal 20000ms、extended 45000ms。原始值、有效值和来源必须同时保存。

## 6. 生命周期

```text
created → active → awaiting_user
awaiting_user + input → active
active + accepted close_ready → close_ready
close_ready + input → active
close_ready + deadline → soft_closing → soft_closed → Ambient
soft_closed + input → resuming → active
active/awaiting_user + explicit end → closing → ended
```

`soft_closed` 可恢复，不等于 ended。只有 UI End、明确结束语言或取消形成正式终态。普通沉默不会启动计时；只有已通过复核的 close_ready 才设置持久化 deadline。

Deadline 存储在数据库中，由 Responses maintenance/Scheduler 认领。新输入、Suspend、End 和 Cancel 原子清除 deadline；进程重启不会丢失软结束任务。

## 7. CharacterState

CharacterState 保存 affect、attention、gaze、posture、activity、performance state、decay、source turn 和 revision。模型每轮声明 `from_revision`，Runtime 通过乐观并发更新到下一 revision。失败 Turn 不覆盖上一状态。

- brief：倾向快速恢复 previous activity
- normal：保持 Conversation Idle
- extended：保持稳定注意与交谈姿态

该差异通过模型表演计划和语义状态表达；Runtime 不事后补写或篡改五官、动作和毫秒 cue。

## 8. Streaming

Conversation SSE/WS 使用 Conversation 内严格递增的 `sequence_number`。嵌入的 Response/Performance event 保留 `response_sequence_number`，因此 Response reducer 与 Conversation reducer可以独立工作。

事件分层：

- `character.conversation.*`
- `character.turn.*`
- `character.response.*`
- `character.performance.*`
- `character.execution.*`
- `character.activity.*`

SSE 使用 `Last-Event-ID`，WebSocket 使用 `after_sequence` 恢复。完整示例见 `docs/examples/character-conversations/v2/`。

## 9. 持久化与安全

通用 `responses_conversations` 增加角色会话字段；每个 Character Response 继续写入 `responses`、`response_items` 和 checkpoint。属于 Character Conversation 的记录以 `storageMode=plaintext_json` 写入直接 JSON；Turn 和 Conversation event 同样直接 JSON，不经过 Key Custody。

Session 与长期 Memory 分离。最近 Turn 仅向模型投影用户文本、角色 speech、Handoff、Horizon 和语义 CharacterState，不传递完整 Performance JSON 或底层动画信息。

## 10. 客户端消费

UE5/Unity 客户端应：

1. 按 `character.performance.*` 执行已验证的语义时间轴。
2. 按 `character.turn.handoff` 切换到用户输入状态。
3. 在 `close_ready` 期间允许用户继续输入并取消软结束。
4. 收到 `character.activity.ambient.requested` 后回到 Ambient。
5. 收到 `character.activity.resume.requested` 后恢复 Conversation 前的活动。

执行完成仍通过 `character.execution.*` 回传，不与 Conversation 生成生命周期混合。
