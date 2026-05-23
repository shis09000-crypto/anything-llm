# Tool Events In Thought Container Report

## Modified files

- `frontend/src/components/WorkspaceChat/ChatContainer/ChatHistory/AssistantTurn/index.jsx`
- `frontend/src/components/WorkspaceChat/ChatContainer/ChatHistory/AssistantTurn/ThoughtTimeline.jsx`
- `frontend/src/components/WorkspaceChat/ChatContainer/ChatHistory/AssistantTurn/ToolEvent.jsx`
- `TOOL_EVENTS_IN_THOUGHT_CONTAINER_REPORT.md`

## Event-to-component mapping

### Before

| Event                              | Source normalization              | Render location                                      |
| ---------------------------------- | --------------------------------- | ---------------------------------------------------- |
| `statusResponse` / `agent_thought` | `thought` timeline event          | `AssistantTurn/ThoughtTimeline.jsx`                  |
| `toolCallInvocation`               | `tool_call` timeline event        | Standalone `AssistantTurn/ToolEvent.jsx` card        |
| `toolCallResult`                   | `tool_result` timeline event      | Standalone `AssistantTurn/ToolEvent.jsx` card        |
| file/chart tool result events      | `tool_result` timeline event      | Standalone `AssistantTurn/ToolEvent.jsx` card        |
| `toolApprovalRequest`              | `approval_request` timeline event | Standalone `ToolApprovalRequest` via `ToolEvent.jsx` |
| `approval_result`                  | `approval_result` timeline event  | Not rendered directly; used to update approval state |
| `error`                            | `error` timeline event            | Standalone small error block via `ToolEvent.jsx`     |

### After

| Event                              | Source normalization              | Render location                                                      |
| ---------------------------------- | --------------------------------- | -------------------------------------------------------------------- |
| `statusResponse` / `agent_thought` | `thought` timeline event          | `AssistantTurn/ThoughtTimeline.jsx`                                  |
| `toolCallInvocation`               | `tool_call` timeline event        | Compact chronological row inside `AssistantTurn/ThoughtTimeline.jsx` |
| `toolCallResult`                   | `tool_result` timeline event      | Compact chronological row inside `AssistantTurn/ThoughtTimeline.jsx` |
| file/chart tool result events      | `tool_result` timeline event      | Compact chronological row inside `AssistantTurn/ThoughtTimeline.jsx` |
| `toolApprovalRequest`              | `approval_request` timeline event | Standalone `ToolApprovalRequest` via `ToolEvent.jsx`                 |
| `approval_result`                  | `approval_result` timeline event  | Not rendered directly; used to update approval state                 |
| `error`                            | `error` timeline event            | Standalone small error block via `ToolEvent.jsx`                     |

## Verification

- `cd frontend && yarn lint:check` - passed.
- `cd frontend && yarn build` - passed. Vite emitted existing dependency/chunk-size warnings for browser-externalized Piper TTS modules, `onnxruntime-web` eval usage, mixed dynamic/static imports, and large chunks.
- `cd frontend && yarn dev --host 127.0.0.1` plus browser smoke check at `http://127.0.0.1:3000/` - passed page-load check; app shell rendered with title `向量知识库`.

Manual checks:

- Start a normal tool-using chat and confirm `tool_call` and `tool_result` rows appear inside the existing thought box, not as separate message cards.
- Expand the thought box and confirm tool name, input arguments or payload preview, returned output preview, error details, status, and timestamp display when present.
- Confirm live streaming appends tool rows into the active assistant turn without creating standalone timeline blocks.
- Trigger an approval-required tool and confirm the approval prompt remains a separate, actionable `ToolApprovalRequest`.
- Reopen a historical chat with stored `assistant.agentEvents` and confirm old normal tool events render inside the thought box without migration.
