# Athena 3D Center Long-Term Character Memory v1

> 后台模型策略：本协议的归档提炼、重新提炼和会话压缩统一使用 `deepseek-v4-flash`。Athena 的统一后台 LLM Task Registry 同样强制使用 Flash；`refined` 只表示任务提示、预算和回退策略，不再代表 Pro 模型。主 Chat/Agent 的前台模型选择不受此策略影响。

状态：Implemented  
协议版本：1.0  
归属：Chat Runtime 的 `3d-center` 数据记忆领域

## 目标

本协议让稳定的角色实例在多个 3D Session 之间保留完整原话、关系变化、情绪延续和权威末态证据。它不复用账号级 Memory Block，也不把旧动作带到新场景继续执行。

隔离键固定为：

```text
owner_user_id + character_id + character_instance_id
```

`character_instance_id` 缺失时 Session 降级为临时记忆，并返回 `character_memory_ephemeral` warning。

## 权威数据

每次归档必须先保存：

1. Session 内全部 User/Character 原话，按 `conversation_id + ordinal` 幂等去重。
2. 最后一轮已经通过 Character Validator 的 `persistent_state_window.current_state`。
3. state revision、turn、response、context ref 与 SHA-256 证据。

模型不重新生成五官、四肢或动作状态。它只输出会话摘要、带 Turn 引用的事实/承诺、关系增量、最终心情和对权威状态的解释。

所有长期记忆表使用普通 JSON 明文，不走 Key Custody、签名或应用层加密。访问控制仍由登录用户、角色实例与数据库边界执行。

## 生命周期

```text
每轮短期提交
  -> soft_closed / ended / cancelled
  -> 同步归档原话和权威末态
  -> 创建持久 consolidation job
  -> 前端立即完成结束流程
  -> 后台 DeepSeek Flash JSON Output 提炼
  -> Schema/关系数学/Turn 引用校验
  -> Profile revision CAS
```

正式结束或取消只有在原始归档成功后才能删除短期四表。提炼失败不会影响原话与末态；任务最多尝试三次，之后进入 `needs_reconsolidation`。并发画像冲突会刷新 expected revision，再用最新画像重新提炼。

软关闭采用递增 `finalization_epoch`。恢复后只有出现新 Turn 或权威末态变化才产生新 epoch；重复归档返回 replay。

## Flash 与缓存路径

3D Session compaction、长期 consolidation 与 reconsolidation 全部固定使用：

```json
{
  "provider": "deepseek",
  "model": "deepseek-v4-flash",
  "response_format": { "type": "json_object" }
}
```

Model Gateway 热槽保存最后一次真实 Provider input 和模型原始 JSON。归档任务通过 `context.finalize` 在完全相同的消息前缀后追加一条内部 `memory_finalize` 指令，并记录 `prefix_sha256`、cache hit/miss tokens 与命中率。热槽缺失时，后台从明文原始归档重建完整输入，标记 `durable_rebuild`。

## 新 Session 召回

上下文顺序固定为：

```text
固定角色协议与 JSON Schema
-> 长期关系画像
-> 衰减后的情绪延续
-> 最近会话摘要与末态情感证据
-> 首轮输入选出的相关原话
-> 当前 Session 聊天
-> 当前 Session 三态
-> 当前输入
```

创建 Session 时装入画像、情绪和最近摘要。首条输入到达时按文本相关性选最多 3 个 Session、6 组原话并冻结，之后不再改变长期前缀。默认上限 32,000 tokens，先移除最旧相关原话，再缩减旧摘要；画像与当前情绪不裁剪。

历史末态只抽取 affect、attention、voice delivery、activity 与 performance intent 作为情感证据。旧 gaze target、接触、未完成 Action、姿势和肢体状态不得跨 Session 恢复。

## 接口

认证后的 3D Center API：

- `GET /api/3d-center/characters/:instanceId/memory`
- `GET /api/3d-center/characters/:instanceId/memory/sessions`
- `GET /api/3d-center/characters/:instanceId/memory/sessions/:memorySessionId`
- `DELETE /api/3d-center/characters/:instanceId/memory/sessions/:memorySessionId`
- `DELETE /api/3d-center/characters/:instanceId/memory`
- `POST /api/3d-center/characters/:instanceId/memory/reconsolidate`

Chat Runtime Fast Lane 增加 archive、finalize、context、recall freeze、status、delete、reset、reconsolidate 与 maintenance 操作。普通 Chat、Character v1/v2 wire format 和账号级长期记忆保持不变。

## 数据表

- `athena_3d_character_memory_profiles`
- `athena_3d_character_memory_sessions`
- `athena_3d_character_memory_turns`
- `athena_3d_character_memory_revisions`
- `athena_3d_character_memory_jobs`

SQLite 与 PostgreSQL 使用同一语义迁移。Profile Reset 会先解除仍存活短期 Session 的长期画像引用，再删除全部长期数据。删除单个 Session 后按剩余 revision delta 重新投影画像，不采用被删会话之后的旧绝对快照。
