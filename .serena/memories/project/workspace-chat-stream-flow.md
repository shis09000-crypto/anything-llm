# WorkspaceChat → stream-chat API 完整调用链

## WorkspaceChat 组件结构

```
pages/WorkspaceChat/index.jsx                    (路由: /workspace/:slug[/t/:threadSlug])
  └─ components/WorkspaceChat/index.jsx           (WorkspaceChat - 数据加载层)
      └─ components/WorkspaceChat/ChatContainer/index.jsx  (ChatContainer - 核心编排)
          ├─ ChatHistory/
          │   ├─ HistoricalMessage/               (历史消息 - 编辑/删除/TTS/指标)
          │   ├─ AssistantTurn/                    (AI回复 - 含Markdown/Thought/ToolEvent)
          │   ├─ PromptReply/                      (用户消息气泡)
          │   ├─ ThoughtContainer/                 (思考过程)
          │   ├─ StatusResponse/                   (状态响应)
          │   ├─ ToolApprovalRequest/              (工具审批请求)
          │   └─ Chartable/                        (图表渲染)
          ├─ PromptInput/                          (核心输入组件)
          │   ├─ ToolsMenu/                        (快捷工具/斜杠命令)
          │   │   ├─ SlashCommands/                (斜杠预设)
          │   │   └─ AgentSkills/                  (Agent技能选择)
          │   ├─ Attachments/                      (附件管理器)
          │   ├─ AgentMenu/                        (@agent 菜单)
          │   ├─ SpeechToText/                     (语音输入)
          │   ├─ StopGenerationButton/             (停止生成)
          │   └─ LLMSelector/                      (模型切换)
          ├─ SourcesSidebar/                       (引用来源侧栏)
          ├─ DnDWrapper/                           (拖拽上传)
          └─ WorkspaceModelPicker/                 (工作区模型选择)
```

## 调用链（6 层）

### 第1层 — PromptInput (frontend/src/components/WorkspaceChat/ChatContainer/PromptInput/index.jsx)
- 用户在 textarea 输入消息，按 Enter 触发 `handleSubmit`
- `submit(e)` 调用父组件传入的 prop，不直接持有 API 逻辑
- 通过 `PROMPT_INPUT_EVENT` 自定义事件从父组件接收内容变更，避免 prop 重渲染

### 第2层 — ChatContainer (frontend/src/components/WorkspaceChat/ChatContainer/index.jsx)
- `handleSubmit` 从 DOM 读取 `#primary-prompt-input` 的 value
- 清空 localStorage draft（`clearPromptInputDraft`）
- 调用 `startStream({workspaceSlug, threadSlug, prompt, attachments, fileAccessMode, history, parseAttachments, sendToExistingAgent})`
- `sendCommand()` 支持 autoSubmit / writeMode (replace/append/prepend) 多种插入方式
- Agent 模式下如果已有活跃 WebSocket，设置 `sendToExistingAgent=true`

### 第3层 — ChatThreadDraftProvider (frontend/src/contexts/ChatThreadDraftProvider.jsx)
- `startStream()` 核心方法：
  1. `ensureDraft()` — 从 sessionStorage 恢复或创建 draft
  2. `createTurn()` — 生成 `turnId` + 用户消息项
  3. `updateDraft()` — 更新 sessionStorage 状态（用户消息、activeTurnId、isStreaming flag）
  4. `markThreadRunning()` — 标记活跃运行线程（含 6 分钟超时保护）
  5. 若 `sendToExistingAgent=true` 且有 WebSocket → 直接通过 socket 发送 `awaitingFeedback`
  6. 否则 → `Workspace.multiplexStream()` 发起流式 HTTP 请求
- 收到事件后通过 `applyTurnEvent()` 处理多种事件类型
- 流结束后通过 `confirmPersisted()` 轮询后端确认消息已持久化

### 第4层 — Workspace Model (frontend/src/models/workspace.js)
- `multiplexStream()` 根据有无 threadSlug 路由到 `streamChat()` 或 `threads.streamChat()`
- `streamChat()` 使用 `@microsoft/fetch-event-source` 库（非原生 EventSource）
  - 支持 `AbortController` 中断
  - `openWhenHidden: true` 保持后台连接
  - 每条 SSE 消息通过 `onmessage` 回调 `handleChat()`

### 第5层 — handleChat 事件规范化 (frontend/src/utils/chat/index.js)
- `textResponseChunk` (非close) → `assistant_delta`（增量内容）
- `textResponseChunk` (close) → `assistant_final`（最终回复完成）
- `textResponse` / `finalizeResponseStream` → `assistant_final`
- `statusResponse` → `timeline_event`（思考过程/状态更新）
- `agentInitWebsocketConnection` → `agent_socket_start`（启动 Agent WebSocket）
- `abort` → `assistant_error`
- `stopGeneration` → `stop_generation`
- `action: "rename_thread"` → 触发线程重命名 UI
- `action: "reset_chat"` → 重置聊天

### 第6层 — 后端 API (server/endpoints/chat.js)
- `POST /workspace/:slug/stream-chat`
- `POST /workspace/:slug/thread/:threadSlug/stream-chat`
- 设置 SSE headers（`text/event-stream`）
- 多用户模式检查配额
- 委托 `streamChatWithWorkspace()`（`utils/chats/stream`）处理实际流式逻辑
- 后端根据 `workspace.chatMode` 选择模式：普通 / agent / query
- 调用对应 LLM Provider 的流式处理方法
- 通过 `writeResponseChunk()` 写入 SSE 数据块
- 发送 telemetry、写入 event logs

## 流式事件处理机制（前端接收循环）
```
ChatThreadDraftProvider.startStream()
  ↓ Workspace.multiplexStream()
  ↓ fetchEventSource(POST /workspace/:slug/stream-chat)
  ↓ SSE onmessage(msg)
  ↓ handleChat(normalize)
  ↓ applyTurnEvent(chatKey, turnId, event)
     ├── assistant_delta → updateDraft(追加 finalContent + sources + metrics)
     ├── timeline_event  → appendTimelineEvent(thought/tool_call/tool_result/approval/error)
     ├── assistant_final → completeAssistantTurn(标记完成 + 释放流状态)
     ├── agent_socket_start → openAgentSocket(建立 WebSocket 接管)
     ├── assistant_error → failAssistantTurn + 错误提示
     └── stop_generation → failAssistantTurn
  ↓ confirmPersisted() 轮询后端确认消息已持久化
```

## 关键文件索引
- PromptInput: `frontend/src/components/WorkspaceChat/ChatContainer/PromptInput/index.jsx`
- ChatContainer: `frontend/src/components/WorkspaceChat/ChatContainer/index.jsx`
- WorkspaceChat page: `frontend/src/components/WorkspaceChat/index.jsx`
- ChatThreadDraftProvider: `frontend/src/contexts/ChatThreadDraftProvider.jsx`
- Workspace model: `frontend/src/models/workspace.js`
- handleChat: `frontend/src/utils/chat/index.js`
- Backend chat endpoint: `server/endpoints/chat.js`
- Backend stream logic: `server/utils/chats/stream`
