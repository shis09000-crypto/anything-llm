# Workspace Overview Recommendation Report

## Architecture

Dynamic Workspace Overview now uses a deterministic recommendation pipeline at:

- Backend API: `GET /api/workspace/:slug/overview`
- Feedback API: `POST /api/workspace/:slug/overview/recommendation-usage`
- Backend builder: `server/utils/workspaceOverview`
- Frontend model: `frontend/src/models/workspaceOverview.js`
- Frontend UI: `WorkspaceChat/ChatContainer/WorkspaceOverview`

The system reads existing Knowledge Graph nodes, edges, evidence, usage events,
recent chats, recent documents, Health Beacon status, repair runs, metrics runs,
and extraction jobs. It does not call an LLM and does not modify retrieval,
embedding, KG extraction, or vector data.

## User Cognitive State

The overview response includes `userCognitiveState` with:

- current focus concepts
- active topics inferred from recent thread messages by matching existing KG concepts
- recent graph/path candidates
- unfinished explorations
- interest signals from evidence/node/edge usage

When no authenticated user exists, the backend uses user id `0` as the local
single-user profile so desktop/local installs still get stable feedback behavior.

## Recommendation Formula

Formula version: `overview-rec-v1`

```text
recommendationScore =
  workspaceImportance * 0.20 +
  personalFocus * 0.25 +
  recentInterest * 0.20 +
  unfinishedExploration * 0.15 +
  novelty * 0.10 +
  curiosity * 0.10
```

Every recommendation returns:

- `recommendationId`
- `formulaVersion`
- `score`
- `confidence`
- `reasonCodes`
- `reasonZh`
- `normalizedInputs`
- `refs`

The stable id is:

```text
SHA256(type + targetType + targetId + workspaceId + formulaVersion)
```

Score, rank, and explanation text are intentionally excluded from the id so
feedback remains attached to the same target even when ranking changes.

## Time Decay

Behavior signals use deterministic time decay:

- graph/evidence/document style usage: 7 day half-life
- recent chat topic relevance: 3 day intent window
- recommendation feedback observation: 14 day intent window

This prevents old concepts from permanently dominating the overview.

## Diversity Balancing

The final recommendation list tries to include:

- continue research
- current focus
- recent change
- evidence gap
- conflict/metric warning
- hidden bridge / curiosity item

If a category has no real data, it is not fabricated.

## Feedback Loop

`WorkspaceOverviewRecommendationUsage` records:

- impressions
- clicks
- dismissals
- continue actions
- cooldowns
- page session impression ids

Frontend de-duplicates impressions per page session using a local
`Set<recommendationId>`. Backend also protects impression counting using
`pageSessionId` stored in recommendation metadata, so rerenders and scroll
events do not inflate exposure counts.

Dismissed recommendations are hidden for a short cooldown window.

## UI

The empty workspace chat state now renders a research navigation homepage:

- hero with focus concept and health summary
- continue research section
- personalized recommendation cards
- knowledge gap cards
- today's knowledge changes
- recent activity
- development-only recommendation debug data

Recommendation actions open the existing Graph MindMap, Path View, EvidencePanel,
or document/source entry without creating a separate renderer.

## Display Rules And Input Animation

The overview is only a passive knowledge navigation layer for empty threads and
workspace home. Existing message threads never show it passively.

- `ChatContainer` treats server history, restored draft turns, optimistic user
  turns, and streaming assistant turns as chat history; those states switch
  immediately to the normal chat history view.
- Empty-thread input state is reported by `PromptInput` through a read-only
  compose-state callback. Draft text, IME composition, slash command tools,
  attachments, drag/drop, voice input, and streaming all hide the overview.
- IME composition is conservative: `compositionstart` hides the overview, and an
  empty input does not show it again until `compositionend` has fired and the
  final input value is re-evaluated.
- Hide is immediate and animates for 700ms with opacity, downward translate,
  blur, and slight scale. Show uses a 300ms debounce, then reverses the same
  700ms motion from below.
- If a message is submitted while the hide animation is running, optimistic
  chat/streaming state takes over immediately; the UI does not wait for the
  animation to complete.
- The overview remains mounted during empty-thread input hiding, so recommendation
  cards are not rebuilt and page-session impression de-duplication remains
  stable.
- Recommendation impressions are recorded only while the overview is actually
  visible. Hiding due to typing, thread changes, or streaming is not recorded as
  dismiss and does not lower recommendation weight.

## Known Limits

- Long dwell-time tracking is not yet a browser-level timer; v1 relies on click,
  view, continue, and evidence usage signals.
- Recent path history is derived from graph usage and deterministic path
  recommendations unless a future dedicated path usage table is added.
- Document clicks currently route to the existing workspace document/vector
  management surface when no source reader route is available.

## Validation

Recommended validation:

```bash
cd /Users/shijie/Desktop/anything-llm/server && yarn lint:check
cd /Users/shijie/Desktop/anything-llm/frontend && yarn lint:check
cd /Users/shijie/Desktop/anything-llm/frontend && NODE_OPTIONS=--max-old-space-size=4096 yarn build
cd /Users/shijie/Desktop/anything-llm && git diff --check
```
