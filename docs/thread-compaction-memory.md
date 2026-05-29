# Thread Compaction Memory

AnythingLLM already has three memory-like inputs:

- Chat history: recent `workspace_chats` rows selected by workspace, user, thread, and API session.
- RAG context: pinned documents, parsed files, graph context, and vector search chunks injected into prompt context.
- Agent rag-memory: the `rag-memory` tool searches workspace vectors and only stores long-term memory when the user explicitly asks to remember or save something.

Thread compaction adds a fourth layer: deterministic per-thread state. Older chat history can be folded into a structured handoff summary stored in `workspace_chat_compactions`, then injected on later turns before the recent raw messages.

## Boundaries

Thread compaction is not RAG. It is not written to the workspace document library, not embedded into the vector database, and not returned as a source citation. This keeps current thread state stable instead of relying on similarity search to rediscover it.

Thread compaction also does not replace `messageArrayCompressor`. Compaction reduces long-running history before prompt assembly; `messageArrayCompressor` remains the final token safety fallback.

## Triggering

Manual compaction is available at:

- `POST /api/workspace/:slug/thread/:threadSlug/compact`
- `POST /v1/workspace/:slug/thread/:threadSlug/compact`

The body may include:

```json
{
  "userId": 1,
  "apiSessionId": "external-session",
  "force": true
}
```

Automatic compaction is implemented but disabled by default in MVP:

```env
THREAD_COMPACTION_ENABLED=true
THREAD_COMPACTION_AUTO_ENABLED=false
THREAD_COMPACTION_TRIGGER_RATIO=0.65
THREAD_COMPACTION_KEEP_RECENT_MESSAGES=10
THREAD_COMPACTION_MAX_SUMMARY_TOKENS=2500
THREAD_COMPACTION_PROVIDER=deepseek
THREAD_COMPACTION_MODEL=deepseek-v4-flash
THREAD_COMPACTION_CONTEXT_WINDOW_TOKENS=1000000
THREAD_COMPACTION_TARGET_BASE=
THREAD_COMPACTION_TARGET_ABSOLUTE_TOKENS=150000
THREAD_COMPACTION_MANUAL_TARGET_RATIO=0.15
THREAD_COMPACTION_AUTO_TARGET_RATIO=0.2
THREAD_COMPACTION_TARGET_MIN_SUMMARY_TOKENS=12000
THREAD_COMPACTION_TARGET_MAX_SUMMARY_TOKENS=60000
THREAD_COMPACTION_TARGET_SUMMARY_BUDGET_RATIO=0.5
THREAD_COMPACTION_MIN_KEEP_RECENT_MESSAGES=1
```

Target mode separates the compaction input window from the chat injection budget. The compaction model can read up to `THREAD_COMPACTION_CONTEXT_WINDOW_TOKENS`, while `THREAD_COMPACTION_TARGET_BASE` decides whether the post-compact target is based on the current chat model window, the compaction window, or an absolute token value. Leave `THREAD_COMPACTION_TARGET_BASE` blank to auto-select: if the workspace chat model matches the configured compaction Flash model, AnythingLLM uses `compaction_window`; otherwise it uses `chat_window`. If the configured compaction provider/model is unavailable, AnythingLLM falls back to the workspace chat provider/model and records the actual provider/model in compaction metadata.

When auto mode is enabled, AnythingLLM estimates prompt pressure from compact memory, recent history, the current user message, and context inputs where possible. If a full provider-specific estimate is not available, it falls back to history pressure and still relies on `messageArrayCompressor`.

## Fallback

If summary generation or storage fails, the chat request continues with the normal recent-history flow. A failed compaction must never block normal chat or Agent execution.

## Known Limits

- Summary quality depends on the workspace chat model.
- `token_before` counts only the raw chat rows folded in the current compaction.
- `token_after` counts only the generated summary.
- RAG context, pinned docs, graph context, the current user message, and retained recent raw messages are not included in those two fields.
