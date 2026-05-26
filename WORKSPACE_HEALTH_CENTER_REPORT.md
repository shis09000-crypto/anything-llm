# Workspace Health Center + Health Beacon Implementation Report

## Overview

This implementation adds a lightweight Workspace Health Beacon and a first Health Center view for workspace observability. The Beacon replaces the old floating chat text-size control in the top-right chat action area, remains always visible on desktop workspace chat surfaces, and exposes a compact health summary without triggering expensive graph, vector, embedding, or repair work.

The text-size reading preference was moved into Workspace Settings under the new `阅读工具` tab. It continues to use the existing browser-local `anythingllm_text_size` localStorage key and `textSizeChange` event.

## Backend Interfaces

- `GET /api/workspace/:slug/health/beacon`
  - Returns compact health score, status, top issues, processing messages, mini activity timeline, source timestamps, and advanced diagnostics.
  - Failures return `unknown: true` instead of a misleading `score: 0`.

- `POST /api/workspace/:slug/health/refresh`
  - Refreshes only the health aggregation cache.
  - Applies a per-workspace/user 30 second cooldown.
  - Does not trigger embedding, vector rebuild, KG extraction, graph repair, or metric recompute.

## Health Architecture

The health aggregation reads existing system state from:

- `KnowledgeGraph.graphStats()`
- `KnowledgeGraph.repairStatus()`
- `KnowledgeNodeMetrics`
- `KnowledgeNodeMetricsRecomputeRun`
- `GraphRetrievalCache`
- `GraphExtractionJob`
- `KnowledgeGraphRepairRun`

The health score is deterministic and rule-based. It never calls an LLM. Deductions currently account for:

- failed KG extraction jobs
- pending or processing KG backlog
- partial or sparse KG coverage
- missing graph-readable source text
- open repair issues
- quarantine
- needs-reembed issues
- recent provider failures
- stale metrics
- metric drift warnings
- stale traversal cache entries

Legacy vector-cache fallback-only documents are not surfaced as a warning and do not affect the health score.

## Beacon UX

The new `WorkspaceHealthBeacon`:

- is a real `button`
- exposes an `aria-label` with score and status
- supports Tab focus
- opens Health Center on Enter/Space/native button activation
- closes the popover on Escape
- stays visible at all times
- displays `unknown` in gray if the API is unavailable
- displays processing state in blue with an animated tone
- uses four score bands:
  - 90-100 green
  - 70-89 yellow
  - 50-69 orange
  - 0-49 red

The hover/focus popover includes:

- friendly summary
- last updated time
- source times for summary cache, latest activity, and worker heartbeat
- top issues
- processing messages
- mini activity timeline
- advanced diagnostics disclosure
- manual refresh with cooldown
- Health Center entry
- Reading Tools entry

The popover has a delayed close so users can move from the Beacon to the popover actions without it disappearing.

## Action Zone Changes

`TopRightActionZone` now separates:

- `WorkspaceHealthBeacon`: always visible and outside hover-hide behavior.
- `MindMapQuickEntry`: still uses the existing chat-local hover reveal and MindMap-open intentional delay.

The old floating `TextSizeMenu` was removed from the chat action zone.

## Health Center

`/workspace/:slug/settings/health-center` provides:

- score and status
- data source timestamps
- top issues
- processing messages
- mini activity timeline
- advanced diagnostic JSON
- manual refresh with cooldown

This is the first compact diagnostic surface and uses the same `WorkspaceHealthProvider` state source as the Beacon.

## Reading Tools

`/workspace/:slug/settings/reading-tools` provides:

- small / normal / large font-size controls
- live preview of user message and assistant Markdown
- browser-local persistence via `anythingllm_text_size`
- immediate propagation via `textSizeChange`

The setting remains a local reading preference and is not written to workspace storage.

## Modified Files

- `server/index.js`
- `server/endpoints/workspaceHealth.js`
- `server/utils/workspaceHealth/beacon.js`
- `frontend/src/models/workspaceHealth.js`
- `frontend/src/contexts/WorkspaceHealthProvider.jsx`
- `frontend/src/components/WorkspaceHealthBeacon/index.jsx`
- `frontend/src/components/WorkspaceChat/ChatContainer/TopRightActionZone/index.jsx`
- `frontend/src/components/WorkspaceChat/ChatContainer/index.jsx`
- `frontend/src/pages/Main/Home/index.jsx`
- `frontend/src/pages/WorkspaceSettings/index.jsx`
- `frontend/src/pages/WorkspaceSettings/HealthCenter/index.jsx`
- `frontend/src/pages/WorkspaceSettings/ReadingTools/index.jsx`
- `frontend/src/utils/paths.js`

## Validation Notes

Recommended validation:

- Beacon remains visible on empty chat, active chat, and workspace home.
- MindMap button still uses hover reveal and does not become permanently visible.
- Beacon popover remains open long enough to click actions after pointer leave.
- Refresh cooldown blocks repeated refresh attempts.
- API failure renders `unknown` instead of `0`.
- Reading Tools preview changes chat text size through the existing event path.
- Health Center opens from Beacon and from settings tab.

## Known Limits

- The Health Center currently presents compact health diagnostics from existing KG/repair/metrics/cache state. It does not yet implement separate detailed document timeline, queue browser, worker heartbeat registry, or paginated repair center APIs.
- Worker heartbeat time is inferred from recent metrics/repair/activity timestamps until a dedicated worker heartbeat table is added.
- Activity feed is synthesized from existing job/run records rather than a dedicated append-only event table.

## Future Work

- Add dedicated health summary cache persistence.
- Add full document pipeline timeline API.
- Add paginated repair/error center.
- Add first-class worker heartbeat/run registry.
- Add health event table for durable activity feed.
- Add stale lock cleanup and dead worker recovery visibility.
