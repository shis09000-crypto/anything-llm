# Thread Message Persistence Bug Report

## 摘要

坏线程：

- Workspace slug: `1cd3992d-e83f-44dd-a760-28e267b224ba`
- Thread slug: `392c1d79-50d7-4639-95a8-6845461546a7`

好线程对照：

- Thread slug: `442cbbb2-e5ba-4aab-853f-9ae723892b8c`

用户侧消息消失不是数据库丢失。坏线程的 `workspace_chats.prompt` 仍然存在且非空；问题发生在前端 `sessionStorage` 草稿持久化和恢复合并阶段。

## 复现现象

1. 打开坏线程。
2. 切换到其他线程，或等待一段时间后再回来。
3. 历史 assistant 输出仍然显示，但 user 输入消息变为空白或像是消失。
4. 其他普通线程不复现，说明不是全局 chat history API 或数据库读写失败。

## 数据库证据

本地 SQLite 检查结果：

```text
392c1d79-50d7-4639-95a8-6845461546a7|23|0|0|9655|12931208|5659319
442cbbb2-e5ba-4aab-853f-9ae723892b8c|20|0|0|45072|32834758|6358111
```

字段含义依次为：

- `thread_slug`
- `chat_count`
- `null_prompt_count`
- `blank_prompt_count`
- `prompt_chars`
- `response_chars`
- `max_response_chars`

坏线程共有 23 条 chat，`null_prompt_count = 0`，`blank_prompt_count = 0`，说明用户 prompt 在 DB 中没有丢。

进一步检查 `response` JSON 中的大字段：

```text
392c1d79-50d7-4639-95a8-6845461546a7|2077387|4890|10818901
442cbbb2-e5ba-4aab-853f-9ae723892b8c|44005|4236|32768468
```

字段含义依次为：

- `thread_slug`
- `sources_json_chars`
- `metrics_json_chars`
- `agent_events_json_chars`

坏线程的 assistant `sources` 聚合约 2.08MB，单条最大 `sources` 约 1.45MB。这会把前端草稿序列化内容推过 `MAX_DRAFT_STORAGE_CHARS = 450_000`。

## 根因

涉及生命周期：

1. 后端 DB/API 层：`workspace_chats.prompt` 正常保存，用户消息可恢复。
2. 前端草稿持久化层：`ChatThreadDraftProvider` 会把线程草稿写入 `sessionStorage`。
3. 大 payload 触发：坏线程的 completed assistant turn 携带了非常大的 `sources`，导致草稿 JSON 超过 450k 限制。
4. fallback bug：原来的 minimal fallback 会把 user item 的 `content` 写成 `""`。
5. hydration gap：已有本地 draft 时，UI 会先用 draft 渲染；且 server history merge 对已匹配 chatId 的 local turn 只补 `chatId`，没有补回 blank user `content`。

最终表现为：DB 里 prompt 还在，但恢复后的本地草稿中 user item 为空，渲染路径显示空白用户消息。

## 修复内容

### 1. 控制草稿存储体积

文件：`frontend/src/contexts/ChatThreadDraftProvider.jsx`

- completed 且已有 `chatId` 的 assistant turn 不再把完整 `sources` 写入草稿。
- running / incomplete turn 只保存压缩后的 source metadata，并限制数量与字段长度。
- minimal fallback 不再清空 user `content`，而是保留最多 2,000 字符。

### 2. 识别不可信草稿

文件：`frontend/src/contexts/ChatThreadDraftProvider.jsx`

新增：

- `draftHistoryIntegrity(draft)`
- `draftNeedsServerHistoryRefresh(draft)`

当存在 server-backed user item 且 `content` 为空时，标记该 draft 必须重新合并 server history。

### 3. 强制重新合并 server history

文件：`frontend/src/components/WorkspaceChat/index.jsx`

- 如果 draft 存在但 `draftNeedsServerHistoryRefresh(draft)` 为 true，即使该线程 key 曾经被标记为 restored，也重新调用 `mergeServerHistory(...)`。
- 调试日志通过现有 `chatTurnDebug` 开关输出，不影响默认用户体验。

### 4. 修复 server/local turn 合并

文件：`frontend/src/utils/chat/turns.js`

- `patchLocalTurnWithServer(...)` 现在会在 local user `content` 为空时，用 server user `content` 补回。
- 同时补回缺失 attachments，避免只补 assistant 而不补 user 的半合并状态。

## 修改文件

- `frontend/src/contexts/ChatThreadDraftProvider.jsx`
- `frontend/src/components/WorkspaceChat/index.jsx`
- `frontend/src/utils/chat/turns.js`
- `THREAD_MESSAGE_PERSISTENCE_BUG_REPORT.md`

## 调试方式

如需在浏览器中观察恢复过程，可在控制台开启：

```js
localStorage.setItem("chatTurnDebug", "true");
```

然后刷新坏线程，观察：

- `persistDraft:storageSize`
- `persistDraft:storageFallback`
- `WorkspaceChat:needsServerHistoryRefresh`
- `WorkspaceChat:mergeServerHistory`
- `mergeServerHistory:before`
- `mergeServerHistory:after`

## 验证步骤

建议手动验证：

1. 打开坏线程 `392c1d79-50d7-4639-95a8-6845461546a7`，确认用户消息可见。
2. 切到好线程 `442cbbb2-e5ba-4aab-853f-9ae723892b8c` 再切回坏线程，确认用户消息不消失。
3. 刷新页面后重新打开坏线程，确认用户消息仍然可见。
4. 等待 idle 一段时间后再切回，确认用户消息仍然可见。
5. 在坏线程和好线程各发送一条新消息，确认 streaming / final merge 不产生重复 turn。

命令验证：

```bash
cd /Users/shijie/Desktop/anything-llm/frontend && yarn lint:check
cd /Users/shijie/Desktop/anything-llm/frontend && NODE_OPTIONS=--max-old-space-size=4096 yarn build
cd /Users/shijie/Desktop/anything-llm && git diff --check
```

本次执行结果：

- `yarn lint:check`：通过。
- `NODE_OPTIONS=--max-old-space-size=4096 yarn build`：通过；仅保留既有 Vite/Browserslist/chunk size 警告。
- `git diff --check`：通过。
