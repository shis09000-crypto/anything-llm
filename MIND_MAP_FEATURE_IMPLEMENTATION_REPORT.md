# AI Mind Map Feature Implementation Report

## Architecture Overview

The Mind Map feature adds a workspace-scoped generation pipeline and a right-side interactive panel in chat.

- Backend routes live at `/api/workspace/:slug/mind-maps`.
- `workspace_mind_maps` stores normalized schema JSON, markdown export text, source metadata, cache hash, prompt/schema versions, generation model, suitability result, and viewport state.
- `server/utils/mindMap` resolves source content, checks document index health, runs deterministic suitability, checks cache, generates schema JSON with the active workspace LLM, repairs malformed JSON, validates and normalizes the schema, and persists the result.
- `frontend/src/components/WorkspaceChat/ChatContainer/MindMapPanel` renders maps with `@xyflow/react`, computes layouts with `elkjs`, supports collapse/expand, export, saved-map reopen, document generation, and node-to-chat follow-up.

Visual layout and theme switching is frontend-only. It recomputes React Flow positions and styles without calling the model again.

## Modified Files List

- `server/prisma/schema.prisma`
- `server/prisma/migrations/20260520000000_add_workspace_mind_maps/migration.sql`
- `server/models/workspaceMindMaps.js`
- `server/utils/mindMap/index.js`
- `server/utils/mindMap/schema.js`
- `server/utils/mindMap/suitability.js`
- `server/endpoints/mindMaps.js`
- `server/index.js`
- `server/__tests__/utils/mindMap/schema.test.js`
- `server/__tests__/utils/mindMap/generate.test.js`
- `frontend/package.json`
- `frontend/yarn.lock`
- `frontend/src/models/mindMap.js`
- `frontend/src/components/WorkspaceChat/ChatContainer/index.jsx`
- `frontend/src/components/WorkspaceChat/ChatContainer/ChatHistory/index.jsx`
- `frontend/src/components/WorkspaceChat/ChatContainer/ChatHistory/AssistantTurn/index.jsx`
- `frontend/src/components/WorkspaceChat/ChatContainer/ChatHistory/HistoricalMessage/Actions/index.jsx`
- `frontend/src/components/WorkspaceChat/ChatContainer/PromptInput/ToolsMenu/Tabs/SlashCommands/index.jsx`
- `frontend/src/components/WorkspaceChat/ChatContainer/MindMapPanel/index.jsx`
- `frontend/src/components/WorkspaceChat/ChatContainer/MindMapPanel/layout.js`
- `frontend/src/components/WorkspaceChat/ChatContainer/MindMapPanel/MindMapNode.jsx`

## JSON Schema Specification

```json
{
  "title": "string",
  "layout": "radial | tree | timeline | flow | comparison",
  "recommendedLayout": "radial | tree | timeline | flow | comparison",
  "theme": "napkin | ocean | forest | sunset | mono",
  "summary": "optional string",
  "nodes": [
    {
      "id": "stable-kebab-id",
      "label": "short concept label",
      "description": "one sentence explanation",
      "icon": "short icon or symbol",
      "level": 0,
      "color": "#RRGGBB",
      "parentId": "optional-parent-id"
    }
  ],
  "edges": [
    {
      "id": "stable-edge-id",
      "source": "source-node-id",
      "target": "target-node-id",
      "label": "optional relationship",
      "type": "parent | related | sequence | contrast | cause"
    }
  ]
}
```

Constants:

- `schemaVersion`: `1.0.0`
- `promptVersion`: `mind-map-v1`
- Maximum nodes: `500`

## Example Prompt And Output

Prompt intent:

```text
Convert the source material into strict MindMapSchema JSON. Prefer 8-30 nodes, use hierarchy via parentId, add relationship edges, use the requested layout/theme unless the source clearly fits another layout, and return JSON only.
```

Example output:

```json
{
  "title": "Mind Map Generation Pipeline",
  "layout": "flow",
  "recommendedLayout": "flow",
  "theme": "napkin",
  "summary": "The system resolves source content, validates suitability, checks cache, generates JSON, and renders an interactive map.",
  "nodes": [
    {
      "id": "source-resolution",
      "label": "Source Resolution",
      "description": "Loads chat text, selected text, document content, parsed uploads, or raw text.",
      "icon": "S",
      "level": 0,
      "color": "#DBEAFE"
    }
  ],
  "edges": []
}
```

## Testing And Validation Steps

Run:

```bash
cd /Users/shijie/Desktop/anything-llm/server && npx jest __tests__/utils/mindMap --runInBand
cd /Users/shijie/Desktop/anything-llm/server && yarn lint:check
cd /Users/shijie/Desktop/anything-llm/frontend && yarn lint:check
cd /Users/shijie/Desktop/anything-llm/frontend && NODE_OPTIONS=--max-old-space-size=4096 yarn build
cd /Users/shijie/Desktop/anything-llm && git diff --check
```

Manual QA:

- Generate from an assistant response action.
- Generate from selected assistant text.
- Run `/mindmap` with no extra text and with explicit text.
- Generate from a workspace document.
- Confirm simple content returns a recommendation before generation.
- Force generation from that recommendation.
- Switch layout/theme and verify no generation API call is made.
- Export PNG, Markdown, and JSON.
- Click a node and use both chat follow-up actions.
