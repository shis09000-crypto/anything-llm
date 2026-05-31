const TASK_REGISTRY = {
  thread_title_generation: {
    tier: "rough",
  },
  reader_document_classification: {
    tier: "rough",
  },
  quiz_plan: {
    tier: "rough",
  },
  quiz_generation: {
    tier: "refined",
    fallbackTier: "rough",
  },
  quiz_generation_fallback: {
    tier: "rough",
  },
  quiz_analysis: {
    tier: "refined",
  },
  knowledge_graph_extract: {
    tier: "rough",
    legacyModelEnv: "KNOWLEDGE_GRAPH_DEEPSEEK_MODEL",
  },
  knowledge_graph_bilingual_labels: {
    tier: "rough",
    legacyModelEnv: "KNOWLEDGE_GRAPH_DEEPSEEK_MODEL",
  },
  knowledge_graph_chinese_backfill: {
    tier: "rough",
    legacyModelEnv: "KNOWLEDGE_GRAPH_CHINESE_BACKFILL_MODEL",
  },
  thread_compaction: {
    tier: "rough",
    legacyProviderEnv: "THREAD_COMPACTION_PROVIDER",
    legacyModelEnv: "THREAD_COMPACTION_MODEL",
    fallbackToWorkspace: true,
  },
  workspace_overview_narrative: {
    dynamic: "workspace_chat_or_system",
  },
  mindmap_generation: {
    dynamic: "workspace_chat",
  },
  agent_task: {
    dynamic: "agent_provider",
  },
  ephemeral_agent_task: {
    dynamic: "agent_provider",
  },
};

module.exports = { TASK_REGISTRY };
