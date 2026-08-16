# Athena Character Memory System v2

状态：Implemented Draft，协议版本 2.0。

## 系统边界

Character Memory v2 继续位于 Chat Runtime 的 `3d-center` 记忆领域。普通账号 `user_memory_blocks`、Personalization Memory 与 Character Memory 不互相读取或复制。Session 原话和最终 `persistent_state_window.current_state` 是事实权威；Reflection 只能形成角色对事实的第一人称理解。

```text
Versioned Character Registry (Core, read-only)
  + Adaptive Self
  + Character User Model
  + Relationship v2
  + Frozen hybrid recall
→ Character Responses v2 / 3D Center
→ raw Session archive + authoritative final state
→ DeepSeek Flash JSON Reflection v2
→ evidence/hash validator
→ sparse Formation Policy + runtime delta caps
→ relational authority + rebuildable vector index
```

## 权威层级

1. Character Core 由服务端 Registry 版本化，以 `core_id/version/sha256/snapshot` 固定到 Profile。升级 Core 必须显式迁移。
2. 原始 Session Turn 与最终状态快照不可由 Reflection 修改。
3. Candidate 是模型建议，不是持久记忆。
4. Runtime 验证 `turn ordinal + languageHash`、Formation Policy、关系数学和限幅后，才写入 User Model、自传记忆、Growth Node 或 Milestone。
5. 关系数据库是权威；向量仅保存无身份 metadata 的可重建召回索引。

## Formation 与变化限幅

普通 Candidate 要求 confidence 至少 0.75、至少两个价值维度达到 0.55、至少一个关键维度达门槛，并具备 uniqueness 或 repetition。`promise/conflict/repair/shared_goal` 仍必须有真实 Evidence。无接受记忆时，Relationship v2 与 Adaptive Self 的有效变化强制为零。

普通 Relationship 单维最多变化 0.03，高影响最多 0.08；Adaptive Self 分别为 0.02 与 0.05。Runtime 保存模型原始 delta，但独立计算并提交有效 before/delta/after。Core 永远不在变化集合中。

## Reflection 与后台模型

所有 Reflection、重放、重新提炼和画像重投影中的文本生成固定经过 Model Gateway，使用 `provider=deepseek`、`model=deepseek-v4-flash` 和 `response_format={"type":"json_object"}`。热槽存在时使用 `context.finalize` 保持最后一轮逐字节前缀；槽丢失时从原始归档重建。Embedding Engine 只执行非生成式向量化。

## Recall

首轮输入执行一次混合召回，并将结果冻结在该 Session 的 `longTermContextJson`。排名权重为 semantic 45%、relationship 20%、importance 15%、recency 10%、future relevance 10%。向量失败时降级关键词、重要度与时间排序并返回 warning。上下文顺序固定为 Core、Adaptive Self、User Model、Relationship、Autobiographical Memory、Growth/Milestone、最近摘要/原话、当前 Session、当前状态、当前输入。

32k 长期上下文超预算时从最低排名的召回对象开始删除；Core、Adaptive Self 与 Relationship 不裁剪。历史最终状态仅作为情绪和社交证据，绝不跨 Session 恢复旧姿势、注视、接触、动作或移动。

## 删除与兼容

旧五维由 Relationship v2 投影，旧 `summaryJson` 保留审计。旧 Session 标记 `legacy_reflection_pending` 后由 maintenance 分批重放。删除单个 Session 会先删除其 Evidence，仅由该 Session 支撑的对象随之删除并重投影 Profile；Profile Reset 删除所有 v2 对象并清理派生向量。

开发者/管理员只读 API：

- `GET /api/3d-center/characters/:instanceId/memory`
- `GET /api/3d-center/characters/:instanceId/memory/memories`
- `GET /api/3d-center/characters/:instanceId/memory/growth-nodes`
- `GET /api/3d-center/characters/:instanceId/memory/milestones`

普通用户界面不展示内部数值或 Growth 数据。
