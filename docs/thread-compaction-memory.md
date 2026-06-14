# Thread Compaction Memory

AnythingLLM already has three memory-like inputs:

- Chat history: recent `workspace_chats` rows selected by workspace, user, thread, and API session.
- RAG context: pinned documents, parsed files, graph context, and vector search chunks injected into prompt context.
- Agent rag-memory: the `rag-memory` tool searches workspace vectors and only stores long-term memory when the user explicitly asks to remember or save something.

Thread compaction adds a fourth layer: deterministic per-thread state. Older chat history is folded into a structured Conversation State Capsule stored in `workspace_chat_compactions.capsule_json`, then injected as its own context layer before RAG context and recent raw messages.

## Boundaries

Thread compaction is not RAG. It is not written to the workspace document library, not embedded into the vector database, and not returned as a source citation. This keeps current thread state stable instead of relying on similarity search to rediscover it.

Thread compaction also does not replace `messageArrayCompressor`. Compaction reduces long-running history before prompt assembly; `messageArrayCompressor` remains the final token safety fallback.

## Conversation State Capsule

The capsule stores current state, not long-form knowledge:

```json
{
  "topic": "",
  "currentGoal": "",
  "confirmedFacts": [],
  "confirmedDecisions": [],
  "openQuestions": [],
  "temporaryContext": [],
  "recentDirection": "",
  "architectureDecisions": [],
  "generatedAt": "",
  "coveredToChatId": ""
}
```

Compaction must not preserve AI guesses, rejected approaches, failed attempts, wrong conclusions, verbose explanations, or raw chat transcripts. Precise numbers are preserved only when they are confirmed and important to the current goal, such as ports, versions, IDs, TTLs, token budgets, ratios, dates, limits, config values, database field values, thresholds, and user-stated numeric requirements.

`temporaryContext` entries include `expiresAfterCompactions` and are removed after their TTL reaches zero.

The injected block is:

```xml
<athena_conversation_capsule>
...
</athena_conversation_capsule>
```

Legacy Markdown `summary` rows remain readable during migration, but `capsule_json` takes priority when present. Legacy summaries are injected as context-layer fallback only; compaction no longer appends state to the system prompt.

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
THREAD_COMPACTION_MANUAL_TARGET_RATIO=0.2
THREAD_COMPACTION_AUTO_TARGET_RATIO=0.2
THREAD_COMPACTION_TARGET_MIN_SUMMARY_TOKENS=12000
THREAD_COMPACTION_TARGET_MAX_SUMMARY_TOKENS=60000
THREAD_COMPACTION_TARGET_SUMMARY_BUDGET_RATIO=0.5
THREAD_COMPACTION_MIN_KEEP_RECENT_MESSAGES=1
```

Target mode uses `THREAD_COMPACTION_CONTEXT_WINDOW_TOKENS` as the thread memory ceiling and derives manual/auto targets from that ceiling. The default manual and auto target ratio is `0.2`, meaning compaction aims to keep the injected thread-state layer at or below 20% of the configured thread-memory budget, roughly an 80% compression target. This is an upper bound, not a requirement to fill the budget; a concise Conversation State Capsule can be much smaller when the durable state is small. The visible thread memory limit is intentionally independent of the active chat model context window, so switching workspace models does not shrink an existing thread from a long-memory budget back to a small model window. If the configured compaction provider/model is unavailable, AnythingLLM falls back to the workspace chat provider/model and records the actual provider/model in compaction metadata.

When auto mode is enabled, AnythingLLM estimates prompt pressure from compact capsule context, recent history, the current user message, and context inputs where possible. If a full provider-specific estimate is not available, it falls back to history pressure and still relies on `messageArrayCompressor`.

## Fallback

If summary generation or storage fails, the chat request continues with the normal recent-history flow. A failed compaction must never block normal chat or Agent execution.

## Known Limits

- Capsule quality depends on the workspace chat model.
- `token_before` counts only the raw chat rows folded in the current compaction.
- `token_after` counts only the generated capsule JSON.
- RAG context, pinned docs, graph context, the current user message, and retained recent raw messages are not included in those two fields.
