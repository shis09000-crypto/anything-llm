# Graph MindMap Edge Readability Audit Report

## 结论摘要

本次只做调查，没有改动 Graph MindMap 功能代码。

当前 Graph MindMap 的关系线混乱，主要不是单一 bug，而是 **数据层边数量较多 + 转换层缺少关系分层 + UI 层默认展示英文技术 label + layout 层把所有关系边都参与 ELK 布局 + 交互层缺少 edge hover/过滤控制** 共同造成的。

最关键的问题：

- `graph -> MindMapSchema` 已经带了 `relationType / relationLabelZh / confidence / weight / evidenceCount / color`，但 **线条默认 label 用的是英文 `relationType` 或原始 `relationLabel`**，中文 label 没有用于边标签。
- 后端会为节点选择一个 `parentId` 来形成层级，但所有 traversal relation edges 仍然完整进入 schema；如果方向不一致，还会额外生成 blank `parent` edge，导致同一组节点之间可能同时存在关系边和层级边。
- 当前没有显式 `isPrimaryEdge / isSecondaryEdge / isWeakRelation / isConflictEdge / isCycleEdge` 等分层字段。
- ReactFlow 使用默认 `smoothstep` edge，没有自定义 edge 组件、hover tooltip、箭头、选中高亮、关系图例。
- `confidence` 参与线宽/透明度，`relationType` 参与颜色，但 `weight / evidenceCount / conflict / primary` 没有参与视觉表达。
- “Hide Weak Relations” 只按 `confidence < 0.55` 过滤关系边，不能只看主关系、按 relation type 过滤、隐藏 `related_to`、或控制标签显示策略。

本地 workspace 观察：

- KnowledgeEdge 总数：452。
- `related_to`：85 条，约 18.8%。
- `Chromatin` 查询生成 59 个节点、120 条边，其中 78 条 graph edge、42 条 parent edge。
- `HP1` 查询生成 19 个节点、28 条边。
- `Gene duplication` 查询生成 19 个节点、28 条边。

这说明在默认 `maxDepth=2 / maxExpandedNodes=60 / confidenceCutoff=0.45` 下，高度节点很容易产生“蜘蛛网”。

## 当前 Edge 数据流

### 1. KnowledgeEdge / Traversal Result

入口：

- `GET /api/workspace/:slug/mind-maps/graph`
- 实现位置：`server/endpoints/mindMaps.js`
- 调用：`graphMindMapFromConcept()`

Traversal 逻辑：

- 文件：`server/utils/knowledgeGraph/traversal.js`
- 默认限制：`maxDepth=2`, `maxExpandedNodes=40`, `confidenceCutoff=0.45`, `perNodeFanout=12`。
- Graph MindMap 调用时前端传 `maxExpandedNodes=60`。
- 服务端 hard cap：`maxDepth <= 3`, `maxExpandedNodes <= 100`, `perNodeFanout <= 20`。
- 每个 frontier node 查询 incident edges：
  - `confidence >= cutoff`
  - 按 `weight * confidence DESC`
  - `LIMIT perNodeFanout`

Traversal edge 输出字段：

```js
{
  id,
  sourceNodeId,
  targetNodeId,
  relationType,
  relationLabel,
  relationLabelZh,
  relationLabelEn,
  confidence,
  weight
}
```

证据：

- 如果 `includeEvidence=true`，额外查 `EdgeEvidence`。
- 目前证据全局 `LIMIT 50`，不是每条 edge 保证有 evidence。

风险：

- traversal 只按 `weight * confidence` 排序，不按“主干关系 / 层级关系 / evidence count / relation type 质量”做二次筛选。
- 高度节点二跳后 edge 数很容易超过视觉可读范围。

### 2. Traversal -> MindMapSchema

文件：

- `server/utils/mindMap/graph.js`

已有能力：

- `RELATION_STYLES` 将 ontology relationType 映射到颜色。
- `RELATION_LABELS_ZH` 内置中文 label。
- `buildDepths()` 使用无向 adjacency 给节点分层。
- `chooseParentEdges()` 按 `confidence * weight` 为每个非 root 节点选一个 parent edge。
- node 会写入 `parentId`、`level`、`collapsedByDefault`、importance/evidence/topChunks 等。
- edge 会写入：

```js
{
  id: `kg-edge-${edge.id}`,
  source,
  target,
  label,
  type: "graph",
  relationType,
  relationLabelZh,
  relationLabelEn,
  confidence,
  weight,
  evidenceCount,
  documentIds,
  chunkIds,
  evidence,
  color
}
```

核心问题：

- `relationLabel(edge)` 当前返回 `edge.relationLabel || edge.relationType || ""`，没有优先使用 `relationLabelZh`。
- 所以 edge label 默认是 `part_of / causes / related_to` 等英文技术字段。
- parent 选择结果只写入 node 的 `parentId`，但没有在原 relation edge 上标记 `isPrimaryEdge=true`。
- traversal 中所有 edges 都进入 schema，没有只保留主干边，也没有 cycle/secondary 边分类。
- 如果 parent edge 的方向与原始 relation edge 方向一致，normalize 阶段不会额外加 parent edge；如果方向相反，会额外生成一个 blank `parent` edge。

### 3. MindMapSchema Normalization

文件：

- `server/utils/mindMap/schema.js`

已有字段保留：

- edge metadata 保留 `relationType / relationLabelZh / relationLabelEn / confidence / weight / evidenceCount / documentIds / chunkIds / evidence / color`。

parent edge 逻辑：

- 如果 node 有 `parentId`，但没有现成 `source=parentId,target=node.id` 的 edge，则自动新增：

```js
{
  id,
  source: node.parentId,
  target: node.id,
  label: "",
  type: "parent"
}
```

问题：

- 自动 parent edge 没有 KG edge id，点击后不能打开 edge EvidencePanel。
- parent edge 没有 relationType/confidence/weight/evidenceCount/color。
- graph relation edge 和 parent edge 在 UI 上没有足够明确的视觉差异。

### 4. Schema -> ReactFlow Edge

文件：

- `frontend/src/components/WorkspaceChat/ChatContainer/MindMapPanel/layout.js`

布局：

- tree/timeline/flow/comparison 使用 ELK layered。
- radial 使用按 level 圆周分布。
- ELK graph 中所有 visible edges 都作为 layout edges 输入。

ReactFlow edge 输出：

```js
{
  id,
  source,
  target,
  label: edge.label || "",
  type: "smoothstep",
  animated: schema.layout === "flow",
  data: { ...edge },
  style: {
    stroke: color,
    strokeWidth: 1.2 + confidence * 3,
    opacity: 0.35 + confidence * 0.6
  },
  labelStyle,
  labelBgStyle
}
```

已有视觉表达：

- `relationType -> color`：后端提供 color。
- `confidence -> strokeWidth`。
- `confidence -> opacity`。
- `confidence -> label fontWeight`。

缺失：

- 没有自定义 edge component。
- 没有箭头。
- 没有 dashed/solid 分层。
- 没有 label 显示模式。
- 没有 hover tooltip。
- 没有 selected edge 高亮。
- `weight` 和 `evidenceCount` 没有参与线宽/透明度/标签。
- parent/graph/cycle/secondary/weak/conflict 没有视觉系统。

### 5. Edge Click / Hover -> EvidencePanel

文件：

- `frontend/src/components/WorkspaceChat/ChatContainer/MindMapPanel/index.jsx`

点击 edge：

- `onEdgeClick` 取 `edge.data || edge`。
- 用 `parseGraphEdgeId(data.id)` 解析 `kg-edge-<id>`。
- 成功后设置：

```js
setEvidenceTarget({
  type: "edge",
  id: graphEdgeId,
  label: data.label || data.relationType
});
```

EvidencePanel：

- 会调用 `/knowledge/evidence/edge?edgeId=<id>`。
- header 内会显示 `relationLabelZh · relationType`，但这只有点击后才可见。

稳定性：

- graph relation edge id 稳定，因为 schema id 是 `kg-edge-${KnowledgeEdge.id}`。
- 自动生成的 parent edge id 不是 KG edge id，`parseGraphEdgeId()` 失败，不能打开 edge evidence。
- 当前没有 edge hover 逻辑，只有 node hover preview。

## 逐项问题回答

### 1. 目前 graph edge 是如何生成的？

`relatedConcepts()` 从 `KnowledgeEdge` 中按当前 concept 做 bounded traversal，返回 incident edges。`graphMindMapFromConcept()` 将每条 traversal edge 转成 MindMapSchema edge，id 为 `kg-edge-${edge.id}`，type 为 `"graph"`。

### 2. parent edge、relation edge、cycle edge 是否有区分？

部分有，且不完整：

- relation edge：type=`graph`。
- parent edge：normalize 时可能自动生成 type=`parent`。
- cycle edge：没有显式标记。cycle 只是在 `chooseParentEdges()` 中不会重复成为 parent，但额外关系仍以普通 `graph` edge 存在。

### 3. 现在是否有 primary / secondary / weak / conflict edge 概念？

没有完整概念：

- primary：隐含在 `parentId`，但 edge 本身没有 `isPrimaryEdge`。
- secondary：没有。
- weak：没有字段；前端临时用 `confidence < 0.55` 判断。
- conflict：Evidence API 有 conflict detection，但 graph schema edge 没有 conflict 信息。

### 4. relationType 是否有中文 label？

后端有中文映射 `RELATION_LABELS_ZH`，schema edge 也带 `relationLabelZh`。

但 edge 的 `label` 不是中文，而是 `relationLabel || relationType`。所以画布上默认看到的是英文/技术字段。

### 5. relation label 是默认显示、hover 显示，还是完全没有显示？

ReactFlow edge 默认显示 `edge.label`。当前 label 通常是英文 relationType。

没有 edge hover tooltip。点击 edge 后 EvidencePanel 才显示中文 label。

### 6. edge 视觉样式如何决定？

- 颜色：后端 `relationType -> color`。
- 粗细：前端 `confidence -> strokeWidth`。
- 透明度：前端 `confidence -> opacity`。
- 虚线/实线：没有区分，都是实线。
- 箭头：没有。
- 动画：仅 `layout === "flow"` 时 animated。

### 7. edge confidence / weight / evidenceCount 有没有参与视觉表达？

- confidence：有，影响线宽、透明度、label fontWeight。
- weight：没有参与前端视觉，只在后端 parent edge 选择和 traversal 排序中使用。
- evidenceCount：schema 有字段，但没有参与视觉表达。

### 8. 为什么现在用户看起来会“飘”和“乱”？

主要原因：

- 所有 relation edges 都参与 ELK 布局，辅助关系也会拉扯布局。
- parent 层级和 relation 网络没有分层，结构边和语义边混在一起。
- label 多为英文短码，用户难以快速理解。
- label 默认都显示，数量多时污染画面；但又没有 tooltip 替代。
- 没有箭头和方向解释，因果/先后/part_of 等方向关系不清楚。
- 没有主关系突出，用户不知道该先看哪条线。
- high-degree concept 二跳展开后 edge 数过多。

### 9. 哪些是数据问题、UI 问题、layout 问题？

数据层：

- `related_to` 占比不低，且语义较弱。
- 部分 edge evidenceCount 为 0，画布上仍与有证据 edge 同等显示。
- conflict/stability/trust 没有进入 graph edge schema。

转换层：

- 没有 primary/secondary/weak/conflict/cycle 分层字段。
- 中文 label 没有成为 edge.label。
- parentId 与 relation edge 分离，可能额外生成无 evidence linkage 的 parent edge。

UI 层：

- 无自定义 edge。
- 无 hover tooltip。
- 无图例。
- 无标签显示模式。
- 无选中高亮。
- Hide Weak Relations 文案英文，过滤能力也太单一。

layout 层：

- 所有 visible edges 都作为 ELK layout edges。
- 没有“只用 primary edges 布局、secondary edges 仅 overlay”的策略。
- radial layout 对多 edge/多 cycle 没有防交叉能力。

交互层：

- graph relation edge click 基本稳定。
- parent edge click 不会打开 EvidencePanel。
- hover 只支持 node，不支持 edge。
- Focus Node 以 node label 重新查图，但不是局部展开，会整图重排。

### 10. 当前实现是否会因为边太多导致蜘蛛网？

会。尤其是高连接节点：

- `Chromatin` 当前实测：59 nodes / 120 edges。
- `HP1`：19 nodes / 28 edges。
- `Gene duplication`：19 nodes / 28 edges。

对用户来说，超过 40-60 条关系线已经很难读；`Chromatin` 这种 120 edge 的视图会明显蜘蛛网化。

### 11. 关系过滤器是否存在？

只有一个很轻量的 `Hide Weak Relations`：

- 保留 `edge.type === "parent"`。
- 过滤 `confidence < 0.55` 的非 parent edge。

没有 relationType filter、主关系 filter、标签模式 filter、evidenceCount filter、related_to filter。

### 12. “只看主关系”“隐藏弱关系”“显示关系标签”这些控制是否已有基础？

已有部分基础：

- “隐藏弱关系”：已有简单 confidence 过滤。
- “只看主关系”：后端已经知道 parentId，可扩展出 `isPrimaryEdge`。
- “显示关系标签”：ReactFlow 已能显示 label，但缺少显示模式控制和中文 label。

### 13. 点击 edge 是否能稳定打开对应 EvidencePanel？

对 `kg-edge-<KnowledgeEdge.id>` 的 graph relation edge 是稳定的。

对自动生成的 `parent` edge 不稳定，因为 id 不是 `kg-edge-*`，无法解析出 KnowledgeEdge id，因此不能打开 edge evidence。

### 14. 是否存在 edge id 不稳定、edge data 丢失、edge label 无法映射等问题？

- graph relation edge id 稳定。
- parent edge id 由 normalize 生成，不绑定 KG edge。
- edge data 在 `layoutMindMap()` 中通过 `data: { ...edge }` 保留，基本没有丢。
- edge label 映射问题存在：中文 label 有字段，但默认 label 不使用中文。

## 当前问题清单

### 数据层问题

- `related_to` 较多，弱语义关系可能稀释图谱表达。
- evidenceCount 为 0 的 edge 没有被视觉降级。
- conflict/stability/trust 未进入 graph schema。
- relation ontology 是英文 key，用户看到的是技术字段。

### 转换层问题

- 缺少 edge role：primary / secondary / weak / conflict / cycle。
- 中文 relation label 没有用于 `edge.label`。
- parent edge 与 KG evidence linkage 不一致。
- traversal edge 全量进入 schema，缺少 edge budget。

### UI 层问题

- 没有 custom edge renderer。
- 没有 hover tooltip。
- 没有 arrow marker。
- 没有 selected edge 高亮。
- 没有 relation legend。
- 标签默认策略不适合大图。

### Layout 层问题

- 所有 edge 参与布局，辅助关系干扰主干结构。
- radial layout 更容易交叉。
- 没有 edge bundling / cluster collapse / secondary overlay。

### 交互层问题

- edge hover 缺失。
- edge click 只对 graph edge 稳定，parent edge 不可追溯。
- `Expand Related Concepts` 是整图重查，不是局部增量展开。
- Focus Node 也会整图重排，用户容易迷失位置。

## 当前缺失能力

- 中文 relation label 作为默认画布 label。
- primary / secondary / weak / conflict / cycle edge 分层。
- edge label 策略：always / hover / selected / hidden。
- relationType filter。
- “只看主关系”。
- “隐藏 related_to”。
- “隐藏无 evidence edge”。
- edge hover tooltip。
- edge selected state。
- edge evidence count badge。
- edge direction arrow。
- conflict visual marker。
- parent edge evidence linkage。

## 风险说明

### 大 graph 下线条爆炸

默认二跳和 60 节点上限足以产生上百条 edge。所有 edge 同时渲染会快速进入蜘蛛网状态。

### 标签过多导致画面污染

如果所有 edge label 都显示，120 条 edge 意味着大量 label 叠加；如果不显示，用户又看不懂线的意义。因此需要标签显示模式，而不是单一默认。

### weak relation 误导用户

`related_to`、低 evidence、低 confidence 或无 evidence edge 如果与强证据 edge 同样显示，会让用户误以为关系同等可靠。

### related_to 占比过高导致图谱无意义

`related_to` 是必要 fallback，但如果画布上大量出现，会让图谱退化为“都有关联”，丧失解释力。

## 建议修复方案

### 第一阶段：中文 Label + Edge 分层

目标：先让用户知道线是什么意思，并知道哪条是主线。

涉及文件：

- `server/utils/mindMap/graph.js`
- `server/utils/mindMap/schema.js`
- `frontend/src/components/WorkspaceChat/ChatContainer/MindMapPanel/layout.js`
- `frontend/src/components/WorkspaceChat/ChatContainer/MindMapPanel/index.jsx`

建议：

- edge label 默认优先：
  - `relationLabelZh`
  - `RELATION_LABELS_ZH[relationType]`
  - `relationLabelEn`
  - `relationType`
- 在 `chooseParentEdges()` 后，将对应 KG edge 标记：
  - `isPrimaryEdge=true`
  - `edgeRole="primary"`
- 其它边标记：
  - `edgeRole="secondary"`
  - `isWeakRelation=confidence < 0.55 || evidenceCount === 0 || relationType === "related_to"`
  - `isCycleEdge=true` 如果不是 parent 但连接同层/回边。
- parent auto edge 如果必须保留，应标记 `edgeRole="layout-parent"`，且视觉上更淡，不能伪装成 evidence-backed relation。

### 第二阶段：Edge Visual Weight + Hover Tooltip

目标：让强弱、证据数量、方向和含义一眼可见。

涉及文件：

- `frontend/src/components/WorkspaceChat/ChatContainer/MindMapPanel/layout.js`
- 可新增：`GraphMindMapEdge.jsx`
- `MindMapPanel/index.jsx`

建议：

- 自定义 ReactFlow edge。
- primary edge：更粗、更高 opacity。
- secondary edge：细线。
- weak edge：虚线/低透明度。
- conflict edge：红/橙 warning marker。
- directional relation 加箭头：
  - `causes`
  - `depends_on`
  - `part_of`
  - `precedes`
  - `regulates`
- hover tooltip 显示：
  - 中文 relation label
  - English relationType
  - confidence
  - weight
  - evidenceCount
  - 点击查看证据提示
- selected edge 高亮，并同步 EvidencePanel。

### 第三阶段：关系过滤器 + 标签显示模式

目标：用户可以主动降低噪音。

涉及文件：

- `MindMapPanel/index.jsx`
- `layout.js`

建议新增控制：

- `只看主关系`
- `隐藏弱关系`
- `隐藏 related_to`
- `隐藏无证据关系`
- relation type 多选：
  - 因果
  - 属于
  - 依赖
  - 调控
  - 对比
  - 相关
- 标签模式：
  - `隐藏标签`
  - `仅主关系`
  - `hover 显示`
  - `全部显示`

### 第四阶段：Layout 防蜘蛛网策略

目标：结构布局只被主干影响，辅助关系作为 overlay。

涉及文件：

- `server/utils/mindMap/graph.js`
- `frontend/src/components/WorkspaceChat/ChatContainer/MindMapPanel/layout.js`

建议：

- ELK layout 只输入 primary/layout parent edges。
- secondary/cycle edges 不参与 ELK，只在节点定位后 overlay。
- 大图默认：
  - `maxDepth=1` 或 `maxExpandedNodes=30`
  - secondary edges 默认隐藏
  - `related_to` 默认折叠
- 对高连接节点启用：
  - top-N relation budget
  - relationType balance
  - evidence-backed priority
  - cluster/community collapse 预留。

## 推荐实施顺序

1. **中文 relation label + edge role 字段**
   - 低风险，收益立刻可见。
   - 文件：`server/utils/mindMap/graph.js`, `server/utils/mindMap/schema.js`。

2. **前端 edge 标签策略和视觉分层**
   - 先不用复杂 UI，只把 primary/weak/secondary/conflict 用线型区分。
   - 文件：`layout.js`，可新增 custom edge component。

3. **edge hover tooltip + selected edge 高亮**
   - 让 Evidence Jump 的入口更明确。
   - 文件：`MindMapPanel/index.jsx`, custom edge component。

4. **关系过滤器**
   - 加 `只看主关系 / 隐藏 related_to / 标签模式`。
   - 文件：`MindMapPanel/index.jsx`。

5. **layout 防蜘蛛网**
   - 改为 primary edges 参与布局、secondary edges overlay。
   - 文件：`layout.js`, `graph.js`。

## 最小修复建议

如果只做一次小修，建议先做：

- edge label 改成中文优先。
- schema 增加 `edgeRole`、`isPrimaryEdge`、`isWeakRelation`。
- layout 里 primary edge 粗实线，weak edge 细虚线。
- UI 增加 `只看主关系` 和 `隐藏 related_to`。
- edge hover 显示中文解释和 evidence count。

这组改动可以明显降低“线很多但不知道什么意思”的问题，同时不需要重写 GraphRAG 或 traversal。
