# Knowledge Graph Bilingual Labels Report

## Summary

This change adds display-only bilingual labels to the Knowledge Graph and Graph MindMap UI. It does not change canonical graph identity, canonical keys, relation ontology, vector retrieval, embeddings, or traversal behavior.

## Backend

- `KnowledgeNode` now supports optional `displayNameZh` and `displayNameEn`.
- `KnowledgeEdge` now supports optional `relationLabelZh` and `relationLabelEn`.
- `GraphLabelTranslationCache` stores translated labels by workspace and cache key so repeated concepts are not translated again.
- Alias storage remains JSON text but now accepts both legacy string aliases and bilingual alias objects such as:

```json
[{ "en": "heterochromatin", "zh": "异染色质" }]
```

## Translation Flow

- After graph extraction and canonical merge, untranslated nodes are queued for lightweight label translation.
- The translation prompt uses the configured Knowledge Graph DeepSeek Flash model.
- Only node labels and aliases are translated.
- Evidence snippets, chunk text, canonical names, canonical keys, and embeddings are not translated or regenerated.
- If translation fails, the node gracefully falls back to the English canonical name.

## Search And Autocomplete

Concept autocomplete searches:

- `canonicalName`
- `canonicalKey`
- legacy string aliases
- bilingual alias `en` / `zh` values
- `displayNameZh`
- `displayNameEn`

This enables searches such as `异染色质` to resolve to `heterochromatin` when the alias or display label exists.

## Graph MindMap UI

Graph nodes render Chinese display labels first and keep English as the canonical reference below:

```text
染色质重塑
Chromatin remodeling
```

Relation details can show ontology labels with Chinese display text, for example:

```text
part_of
属于
```

Hover previews show bilingual aliases, evidence count, and importance scores.

## Constraints Preserved

- No graph merge logic changes.
- No vector retrieval changes.
- No re-embedding translated text.
- No evidence or chunk body translation.
- Existing traversal/cache behavior remains canonical-key based.

## Validation

- Added unit coverage for bilingual label JSON repair and alias normalization.
- Existing graph traversal remains keyed by canonical concept identity.
- Graph MindMap schema preserves bilingual display metadata for stable rendering.
