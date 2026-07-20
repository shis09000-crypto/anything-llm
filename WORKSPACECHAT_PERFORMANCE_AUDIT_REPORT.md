# WorkspaceChat Performance Audit Report

Generated: 2026-07-18T02:03:35.212Z

## Summary

This report compares a deterministic local stress baseline that models the previous full-history path against the optimized progressive path implemented in this workspace.

## Before / After

| Metric | Unit | Baseline | Optimized | Improvement |
| --- | ---: | ---: | ---: | ---: |
| Thread shell | ms | 0.77 | 0.03 | 95.6% |
| First visible messages | ms | 0.77 | 0.04 | 94.2% |
| Route switch latency | ms | 0.77 | 0.04 | 94.2% |
| Message merge latency | ms | 0.38 | 0.03 | 91.0% |
| Longest task | ms | 0.39 | 0.03 | 91.2% |
| Render count under stream | renders | 480000.00 | 24.00 | 100.0% |
| Mounted message DOM nodes | nodes | 2000.00 | 40.00 | 98.0% |

## Bottleneck Sources

- Baseline blocks route/thread switching on full history fetch and full markdown normalization.
- Baseline streaming updates can invalidate the whole chat draft context for every token.
- Baseline mounts every message row in long threads and pays DOM/layout cost upfront.
- Heavy sources, quiz cards, outputs, and markdown code blocks compete with the first visible chat render.

## Optimizations Implemented

- Progressive first page: latest 20 rows, with the last 5 loaded as full readable priority content.
- Abortable history and hydration requests when switching thread/workspace.
- P0/P1/P2/P3 request queue with low-priority warmup and hydration.
- Variable-height virtual list with dynamic remeasurement.
- Keyed chat draft subscriptions and frame-batched assistant deltas.
- Memory/session/IndexedDB cache with version, TTL, max size, and invalidation hooks.

## Remaining Bottlenecks

- Extremely large markdown code blocks still parse on the main thread when enhanced.
- Dynamic card hydration can still cause localized remeasure work, though scroll anchoring prevents large jumps.
- IndexedDB write throughput varies by browser/Electron version and should be watched on very large source payloads.

## Automatic Degradation

- If thread shell, last-five readable time, long task, or route budget exceeds thresholds, chat motion is marked degraded.
- Degraded mode pauses P3 work, lowers visual motion cost, and lets P0/P1 complete first.
