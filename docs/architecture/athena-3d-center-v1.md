# Athena 3D Center v1

3D Center 的持续会话记忆由 Chat Runtime 内的 `3d-center` 数据记忆 namespace 托管；前端特殊 API 与单个 3D Character Session 内的语言、Checkpoint、完整三态、Character Response 和 Performance Plan/Events 均保持直接 JSON，不经过 Key Custody。该明文例外不扩展到普通 Chat、普通 Responses 审计或其他系统数据。协议见 `athena-3d-center-session-memory-v1.md`。

3D Center 通过专用 Memory Fast Lane 读取和提交稳定记忆点。该通道允许绕过微模块统一 AICP 通行协议，但不会绕过 Memory Repository 本身，也不会改变 Memory 的唯一所有权；因此不会产生 Chat Memory、3D Center Memory 和 Performance Memory 三份互相冲突的语义状态。

## 定位

Athena 3D Center 是与现有 Web 前端同级的应用中心，不是微模块。它拥有前端交互面和一层位于 Athena API 内的专属 Gateway 逻辑，但不拥有独立进程、模块 Manifest、数据库或模型执行器。

中心使用两个既有微模块：

- `responses-runtime`：Character Responses v2、多轮 Conversation、CharacterState、Horizon 和 Handoff。
- `character-performance-runtime`：Performance Pack 解析、13轨命令编译、Session Event 和执行反馈持久化。

3D Center Gateway 负责身份与范围注入、调用编排、格式投影、时间区块生成和 WebSocket 事件桥接。前端不得直接调用两个微模块或解析其内部 envelope。

## 低延迟 Wire 策略

3D Center Frame 和实时事件采用可直接解析的普通 JSON，不做应用层 payload 加密、不生成密文字段、不压缩 Frame，也不引入 Key Custody 往返。前端收到数据后可以立即定位 `time_blocks` 并分发模块命令。

这一策略只适用于 3D Center 的前端 wire。现有 HTTPS/mTLS、一次性实时票据和权限校验继续作为传输与访问边界；底层微模块如何保护自己的持久化数据不属于 3D Center wire contract。

## 专属 API

Canonical API：

- `GET /api/3d-center`
- `POST /api/3d-center/sessions`
- `GET /api/3d-center/sessions/:sessionId`
- `POST /api/3d-center/sessions/:sessionId/turns`
- `POST /api/3d-center/sessions/:sessionId/replay`
- `WS /api/3d-center/sessions/:sessionId/stream`

旧 `/api/character-performance/...` 路径保留为兼容接口，不再作为新前端的调用入口。

WebSocket 使用一次性 `athena-3d-center` ticket。它仍绑定用户、Workspace、Thread、Session 和客户端身份，不扩大微模块权限。

## 3D Center Frame

每个 Turn 对前端只输出一个 `athena.3d_center.frame`：

```text
Frame
├── conversation / turn
├── character
│   ├── performance_intent
│   ├── conversation_horizon
│   ├── handoff
│   └── state
├── timeline
│   └── time_blocks[]
│       ├── face[]
│       ├── gaze[]
│       ├── body[]
│       ├── action[]
│       └── speech[]
├── performance_plan
└── warnings
```

时间区块由 resolved command 的所有开始和结束边界确定，不强制语言、注视或动作的固定先后关系。同一区块可以同时存在多个模块；例如角色可以一边注视用户、一边转身并说话。

`body` 模块保留原始13轨中的 `head_neck`、`shoulders`、`torso`、左右手臂、手和腿的 `track`，前端仍能精确分发到部位 Adapter。`performance_plan` 保留 Pack、binding、fallback 和 planned/resolved/actual 证据，但前端播放调度以 `timeline.time_blocks` 为统一入口。

机器格式由 `athena-3d-center-frame-v1.schema.json` 定义，核心字段拒绝未知属性。

## 实时事件

服务器事件统一封装为：

```json
{
  "object": "athena.3d_center.event",
  "protocol_version": "1.0",
  "type": "athena.3d_center.event",
  "event_type": "character.execution.started",
  "sequence_number": 12,
  "session_id": "chr_perf_session_01",
  "payload": {}
}
```

前端回传：

```json
{
  "type": "athena.3d_center.execution_feedback",
  "feedback": {
    "plan_id": "chr_perf_plan_01",
    "events": []
  }
}
```

Gateway 解包后才调用 Performance Runtime 的内部 feedback contract，两个 wire format 不互相泄漏。

## 前端位置

Canonical 页面为 `/3d-center`，与 `/browser` 等应用中心处于同一路由层级。旧 `/settings/character-performance-lab` 继续指向同一界面，作为历史书签兼容入口。

页面同时展示 Character API、Conversation Logic、3D Mapping 三个领域，以及13轨时间轴、人体/五官图、planned/resolved/actual 证据和真实执行反馈。默认使用本地 Fixture；只有显式操作才调用 Flash。

## 固定边界

- 3D Center 不是微模块，不创建 `athena-3d-center` 模块 Manifest。
- 3D Center wire 固定为未加密、未压缩的直接 JSON；不得添加应用层密文 envelope。
- 中心专属逻辑位于 Athena API facade 和前端模块中，不复制模型生成、状态持久化或 Pack 编译。
- Character Responses v2 和 Performance Runtime 内部协议保持不变。
- 未来接入 UE5、Unity 或 Web 3D 时，只增加 Adapter、Pack 和前端执行器，不改变 Frame 的层级结构。
