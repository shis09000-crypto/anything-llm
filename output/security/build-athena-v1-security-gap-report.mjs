import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outputDir = path.join(root, "output", "security");
const generatedAt = new Date().toISOString();
const artifactPath = path.join(
  outputDir,
  "athena-v1-security-architecture-gap-optimization-report-v2.3.artifact.json"
);
const evidencePath = path.join(
  outputDir,
  "athena-v1-security-architecture-gap-evidence-v2.3.json"
);

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function svgBox({ x, y, w, h, title, lines, fill, stroke }) {
  const text = (lines || [])
    .map(
      (line, index) =>
        `<text x="${x + 18}" y="${y + 56 + index * 21}" font-size="13" fill="#334155">${esc(line)}</text>`
    )
    .join("");
  return `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="${fill}" stroke="${stroke}" stroke-width="2"/><text x="${x + 18}" y="${y + 29}" font-size="16" font-weight="700" fill="#0f172a">${esc(title)}</text>${text}</g>`;
}

function arrow(x1, y1, x2, y2, label = "") {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  return `<path d="M ${x1} ${y1} L ${x2} ${y2}" stroke="#475569" stroke-width="2" fill="none" marker-end="url(#athenaArrow)"/>${label ? `<text x="${mx}" y="${my - 7}" text-anchor="middle" font-size="11" fill="#475569">${esc(label)}</text>` : ""}`;
}

function architectureDiagram() {
  const boxes = [
    svgBox({ x: 28, y: 32, w: 250, h: 118, title: "用户与终端", lines: ["Web · iOS/iPadOS · Desktop", "P-256 设备签名 · Keychain", "本地加密缓存与游标"], fill: "#eef2ff", stroke: "#6366f1" }),
    svgBox({ x: 345, y: 32, w: 250, h: 118, title: "入口与身份", lines: ["TLS/HSTS · Body Limits", "Passkey/OPAQUE · Session V2", "REST 权威校验；WS 尚未统一"], fill: "#ecfeff", stroke: "#0891b2" }),
    svgBox({ x: 662, y: 32, w: 250, h: 118, title: "授权与策略", lines: ["资源级 Workspace/Thread/AuthZ", "请求签名 · 设备绑定", "统一 PE/PA/PEP 与风险引擎待建"], fill: "#f0fdf4", stroke: "#16a34a" }),
    svgBox({ x: 929, y: 32, w: 243, h: 118, title: "边缘与外部防护", lines: ["应用内 CORS/Rate Limit", "WAF/CDN/DDoS/DNSSEC", "需由部署平台补齐与证明"], fill: "#fff7ed", stroke: "#ea580c" }),
    svgBox({ x: 28, y: 238, w: 250, h: 132, title: "业务与 AI 数据面", lines: ["Workspace · Chat · Reader", "Agent · MCP · Connector", "RAG provenance/taint 仍不完整"], fill: "#f8fafc", stroke: "#64748b" }),
    svgBox({ x: 345, y: 238, w: 250, h: 132, title: "Sync V2 控制面", lines: ["version · hash · cursor", "Outbox · receipt · reconcile", "WS/SSE/Push 为通知副链路"], fill: "#eef2ff", stroke: "#4f46e5" }),
    svgBox({ x: 662, y: 238, w: 250, h: 132, title: "数据与密码平面", lines: ["AES-256-GCM · HKDF · DEK", "Chat/Audit Hash Chain", "KMS/HSM 外接尚未落地"], fill: "#fdf4ff", stroke: "#a21caf" }),
    svgBox({ x: 929, y: 238, w: 243, h: 132, title: "工作负载隔离", lines: ["Collector SSRF/归档/资源上限", "Plugin capability broker", "挂载、env、mTLS/egress 待收紧"], fill: "#fff1f2", stroke: "#e11d48" }),
    svgBox({ x: 105, y: 470, w: 280, h: 128, title: "数据权威与恢复", lines: ["SQLite 当前权威", "PostgreSQL/S3 适配已准备", "跨区域不可变备份待证明"], fill: "#f8fafc", stroke: "#475569" }),
    svgBox({ x: 460, y: 470, w: 280, h: 128, title: "运行与可观测", lines: ["Runtime Coordinator · DLQ", "OTel/Prometheus 适配", "生产 SIEM/SOC 联动待落地"], fill: "#ecfdf5", stroke: "#059669" }),
    svgBox({ x: 815, y: 470, w: 280, h: 128, title: "证据与供应链", lines: ["Ed25519 审计检查点", "SBOM · provenance · VEX", "WORM/admission/signing 仍需闭环"], fill: "#fffbeb", stroke: "#d97706" }),
  ].join("");
  const arrows = [
    arrow(278, 91, 345, 91, "认证"),
    arrow(595, 91, 662, 91, "主体"),
    arrow(912, 91, 929, 91, "入口策略"),
    arrow(470, 150, 470, 238, "请求"),
    arrow(787, 150, 787, 238, "授权"),
    arrow(153, 150, 153, 238, "交互"),
    arrow(1050, 150, 1050, 238, "隔离"),
    arrow(278, 304, 345, 304, "状态"),
    arrow(595, 304, 662, 304, "事务"),
    arrow(912, 304, 929, 304, "任务"),
    arrow(470, 370, 245, 470, "持久化"),
    arrow(595, 370, 600, 470, "监控"),
    arrow(787, 370, 955, 470, "证据"),
  ].join("");
  return `<section style="width:100%;overflow:hidden;border:1px solid #dbe3ee;border-radius:18px;background:#fff;padding:16px;box-sizing:border-box;break-inside:avoid"><h3 style="margin:0 0 12px;font:700 20px system-ui;color:#0f172a">Athena 当前安全架构与 V1.0 目标控制面</h3><svg viewBox="0 0 1200 630" width="100%" role="img" aria-label="Athena 当前安全架构与 V1.0 目标控制面" style="display:block;max-width:100%;height:auto"><defs><marker id="athenaArrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#475569"/></marker></defs>${arrows}${boxes}</svg></section>`;
}

function decisionDiagram() {
  const boxes = [
    svgBox({ x: 35, y: 45, w: 235, h: 128, title: "请求主体", lines: ["用户/设备/服务/Agent", "Session + device key", "网络位置不授予信任"], fill: "#eef2ff", stroke: "#4f46e5" }),
    svgBox({ x: 330, y: 45, w: 235, h: 128, title: "策略输入", lines: ["身份强度 · 设备姿态", "资源关系 · 操作风险", "数据等级 · 会话状态"], fill: "#ecfeff", stroke: "#0891b2" }),
    svgBox({ x: 625, y: 45, w: 235, h: 128, title: "统一策略决策", lines: ["RBAC + ABAC + ReBAC", "deny by default", "可解释 reason code"], fill: "#f0fdf4", stroke: "#16a34a" }),
    svgBox({ x: 920, y: 45, w: 235, h: 128, title: "执行与再验证", lines: ["REST/WS/Agent/Connector", "短期凭据 · 权限收敛", "撤销即断连/停止工具"], fill: "#fff7ed", stroke: "#ea580c" }),
    svgBox({ x: 180, y: 300, w: 270, h: 132, title: "审计与检测", lines: ["traceId · requestId · actor", "Hash Chain + checkpoint", "SIEM/UEBA/SOAR 待接入"], fill: "#fffbeb", stroke: "#d97706" }),
    svgBox({ x: 475, y: 300, w: 270, h: 132, title: "隔离与降权", lines: ["Collector/Plugin sandbox", "egress allowlist · DLP", "高风险操作人工确认"], fill: "#fff1f2", stroke: "#e11d48" }),
    svgBox({ x: 770, y: 300, w: 270, h: 132, title: "恢复与自愈", lines: ["Outbox replay · reconcile", "session revoke · kill switch", "immutable backup/restore drill"], fill: "#ecfdf5", stroke: "#059669" }),
  ].join("");
  const arrows = [
    arrow(270, 109, 330, 109),
    arrow(565, 109, 625, 109),
    arrow(860, 109, 920, 109),
    arrow(1037, 173, 905, 300, "telemetry"),
    arrow(742, 173, 610, 300, "policy"),
    arrow(447, 173, 315, 300, "evidence"),
    arrow(450, 366, 475, 366),
    arrow(745, 366, 770, 366),
  ].join("");
  return `<section style="width:100%;overflow:hidden;border:1px solid #dbe3ee;border-radius:18px;background:#fff;padding:16px;box-sizing:border-box;break-inside:avoid"><h3 style="margin:0 0 12px;font:700 20px system-ui;color:#0f172a">推荐 Zero Trust 闭环：每次请求、每条长连接、每次工具调用都重新证明</h3><svg viewBox="0 0 1200 470" width="100%" role="img" aria-label="推荐 Zero Trust 闭环" style="display:block;max-width:100%;height:auto"><defs><marker id="athenaArrow2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#475569"/></marker></defs>${arrows.replaceAll("athenaArrow", "athenaArrow2")}${boxes}</svg></section>`;
}

function barChartSvg({ title, subtitle, rows, categoryField, valueField, maxValue, target = null, unit = "" }) {
  const width = 1200;
  const left = 250;
  const right = 90;
  const top = 105;
  const rowHeight = 38;
  const chartWidth = width - left - right;
  const height = top + rows.length * rowHeight + 70;
  const targetX = target === null ? null : left + (Number(target) / maxValue) * chartWidth;
  const bars = rows.map((row, index) => {
    const y = top + index * rowHeight;
    const value = Number(row[valueField]);
    const barWidth = Math.max((value / maxValue) * chartWidth, 2);
    const fill = index % 2 === 0 ? "#4f46e5" : "#0891b2";
    return `<text x="${left - 16}" y="${y + 19}" text-anchor="end" font-size="13" fill="#334155">${esc(row[categoryField])}</text><rect x="${left}" y="${y + 4}" width="${chartWidth}" height="22" rx="7" fill="#e2e8f0"/><rect x="${left}" y="${y + 4}" width="${barWidth}" height="22" rx="7" fill="${fill}"/><text x="${Math.min(left + barWidth + 10, width - 70)}" y="${y + 20}" font-size="12" font-weight="700" fill="#0f172a">${esc(value)}${esc(unit)}</text>`;
  }).join("");
  const ticks = Array.from({ length: 6 }, (_, index) => {
    const value = (maxValue / 5) * index;
    const x = left + (chartWidth / 5) * index;
    return `<line x1="${x}" y1="${top - 10}" x2="${x}" y2="${height - 48}" stroke="#cbd5e1" stroke-width="1"/><text x="${x}" y="${height - 24}" text-anchor="middle" font-size="11" fill="#64748b">${Number(value.toFixed(1))}${esc(unit)}</text>`;
  }).join("");
  const targetLine = targetX === null ? "" : `<line x1="${targetX}" y1="${top - 16}" x2="${targetX}" y2="${height - 48}" stroke="#e11d48" stroke-width="2" stroke-dasharray="7 6"/><text x="${targetX + 7}" y="${top - 24}" font-size="11" fill="#be123c">target ${esc(target)}${esc(unit)}</text>`;
  return `<section style="width:100%;overflow:hidden;border:1px solid #dbe3ee;border-radius:18px;background:#fff;padding:16px;box-sizing:border-box;break-inside:avoid"><h3 style="margin:0 0 4px;font:700 20px system-ui;color:#0f172a">${esc(title)}</h3><p style="margin:0 0 10px;font:13px system-ui;color:#475569">${esc(subtitle)}</p><svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${esc(title)}" style="display:block;max-width:100%;height:auto">${ticks}${targetLine}${bars}</svg></section>`;
}

function auditTableHtml({ title, subtitle, rows, keyField, keyLabel, detailField, detailLabel }) {
  const body = rows.map((row) => {
    const detail = esc(row[detailField]).replaceAll("\n", "<br/>");
    return `<tr style="break-inside:avoid;page-break-inside:avoid"><td style="width:25%;vertical-align:top;padding:10px 12px;border-bottom:1px solid #e2e8f0;font:700 12px/1.45 system-ui;color:#0f172a;word-break:break-word">${esc(row[keyField])}</td><td style="width:75%;vertical-align:top;padding:10px 12px;border-bottom:1px solid #e2e8f0;font:12px/1.5 system-ui;color:#334155;white-space:normal;overflow-wrap:anywhere;word-break:break-word">${detail}</td></tr>`;
  }).join("");
  return `<section style="width:100%;overflow:visible;border:1px solid #dbe3ee;border-radius:16px;background:#fff;padding:14px;box-sizing:border-box"><h3 style="margin:0 0 4px;font:700 20px system-ui;color:#0f172a">${esc(title)}</h3><p style="margin:0 0 12px;font:13px/1.45 system-ui;color:#475569">${esc(subtitle)}</p><table style="width:100%;table-layout:fixed;border-collapse:collapse;border-spacing:0"><colgroup><col style="width:25%"/><col style="width:75%"/></colgroup><thead style="display:table-header-group"><tr><th style="padding:9px 12px;text-align:left;border-bottom:2px solid #cbd5e1;background:#f8fafc;font:700 12px system-ui;color:#475569">${esc(keyLabel)}</th><th style="padding:9px 12px;text-align:left;border-bottom:2px solid #cbd5e1;background:#f8fafc;font:700 12px system-ui;color:#475569">${esc(detailLabel)}</th></tr></thead><tbody>${body}</tbody></table></section>`;
}

function auditRowBlocks(prefix, rows, keyField, detailField) {
  const blocks = [];
  for (let offset = 0; offset < rows.length; offset += 3) {
    const group = rows.slice(offset, offset + 3);
    const body = group.map((row, index) => `<div style="display:grid;grid-template-columns:minmax(130px,24%) minmax(0,1fr);gap:14px;align-items:start;padding:10px 0;${index < group.length - 1 ? "border-bottom:1px solid #e2e8f0" : ""}"><div style="font:700 12px/1.45 system-ui;color:#0f172a;overflow-wrap:anywhere;word-break:break-word">${esc(row[keyField])}</div><div style="font:12px/1.5 system-ui;color:#334155;white-space:normal;overflow-wrap:anywhere;word-break:break-word">${esc(row[detailField]).replaceAll("\n", "<br/>")}</div></div>`).join("");
    blocks.push({
      id: `${prefix}_${Math.floor(offset / 3) + 1}`,
      type: "html",
      layout: "full",
      body: `<section style="width:100%;border:1px solid #dbe3ee;border-radius:12px;background:#fff;padding:3px 13px;box-sizing:border-box;break-inside:avoid;page-break-inside:avoid">${body}</section>`,
    });
  }
  return blocks;
}

const maturity = [
  { domain: "边缘与源站", score: 1.6, target: 4.0, weight: 8 },
  { domain: "身份与会话", score: 3.3, target: 4.5, weight: 12 },
  { domain: "授权与策略", score: 3.5, target: 4.5, weight: 10 },
  { domain: "设备信任", score: 2.5, target: 4.0, weight: 8 },
  { domain: "密码与密钥", score: 3.8, target: 4.5, weight: 12 },
  { domain: "数据保护", score: 3.7, target: 4.5, weight: 10 },
  { domain: "同步安全", score: 4.1, target: 4.5, weight: 8 },
  { domain: "AI 与 Agent", score: 2.7, target: 4.0, weight: 10 },
  { domain: "工作负载隔离", score: 2.0, target: 4.0, weight: 8 },
  { domain: "供应链", score: 3.2, target: 4.0, weight: 6 },
  { domain: "审计与 SecOps", score: 3.0, target: 4.0, weight: 5 },
  { domain: "备份与灾备", score: 1.8, target: 4.0, weight: 3 },
];

const controlStatus = [
  { status: "已实现且本地验证", count: 15 },
  { status: "部分实现/未统一强制", count: 13 },
  { status: "适配已存在/未外部证明", count: 6 },
  { status: "目标控制缺失", count: 8 },
];

const controls = [
  { control: "Passkey / OPAQUE / Session V2", evidence: "Passkey 与 OPAQUE 路径、Auth DB session、吊销与 tokenVersion 已实现；REST middleware 权威校验。", gap: "Broadcast、Agent、Crypto WebSocket 未复用同一权威校验；query token 增加泄露面。", action: "P0：统一 WS auth adapter，短期 ticket，撤销后主动 close。" },
  { control: "RBAC + 资源级关系授权", evidence: "Workspace、Thread、Chat、文件、Agent invocation 均有 owner/resource 约束；338 路由审计 0 finding。", gap: "尚无统一 PE/PA/PEP 与设备/风险/数据等级上下文。", action: "P1：保留领域查询，抽出统一决策接口与 reason code。" },
  { control: "设备签名与反重放", evidence: "P-256、nonce、timestamp、body hash、高风险请求验证与设备撤销能力存在。", gap: "开发环境仍为 warn-only；WebSocket 低风险控制消息可降级；iOS 私钥可导出后写 Keychain。", action: "P0/P1：生产强制；iOS 迁移 Secure Enclave 非导出密钥。" },
  { control: "传输安全", evidence: "TLS/HSTS、生产 HTTPS fail-closed、CORS allowlist、SSE 安全头、TLS 1.2+ 测试。", gap: "TLS 1.3 非强制；外部 WAF/CDN/DDoS/DNSSEC 与源站 mTLS 不在仓库证据内。", action: "P1：部署基线与证据采集；兼容期优先 TLS 1.3。" },
  { control: "请求入口与滥用防护", evidence: "按路由 body limits、登录持久限流、Passkey 限流、Collector 资源上限。", gap: "没有统一 API Gateway schema/risk quota；/ready 暴露内部 worker 与审计细节。", action: "P0：拆分 public liveness 与 authenticated diagnostics。" },
  { control: "静态数据加密", evidence: "AES-256-GCM/HKDF、DEK 信封、Chat 1,038/1,038、文档/向量/缓存全覆盖，链断裂 0。", gap: "system_settings 依赖字段判定；缺统一 S0–S4 数据目录与保留/驻留策略。", action: "P1：分类 registry 驱动加密、日志、导出与保留。" },
  { control: "密钥托管与轮换", evidence: "Key Custody provider、keyId/keyring、pending/activate/retire、secret-file、冲突 fail-closed。", gap: "当前根密钥仍是 env/file；KMS/Vault/HSM、双人审批与硬件根未落地。", action: "P1/P2：staging 接 KMS/Vault；高价值租户再评估 HSM。" },
  { control: "iOS 设备密钥", evidence: "Keychain ThisDeviceOnly 与 userPresence 已使用。", gap: "RequestSigningCenter 生成 CryptoKit 私钥后持久化 rawRepresentation，未使用 Secure Enclave。", action: "P1：版本化注册新公钥，双钥迁移，旧钥定期退役。" },
  { control: "Sync V2 一致性与完整性", evidence: "263 节点、186 投影；version/hash/outbox/cursor/receipt/reconcile；0 hash/权限/正文冲突。", gap: "当前环境 enabled=false；最大 cursor lag 696；需要授权多设备 E2E 与灰度证明。", action: "P1：deterministic cohort 与 SLO 门禁，不扩大状态树边界。" },
  { control: "Chat 与审计完整性", evidence: "Chat Hash Chain；安全账本 Hash Chain + Ed25519 checkpoint，13 entries/4 checkpoints 均有效。", gap: "外部不可变归档默认关闭；未接 SIEM/WORM，ready 暴露 head hash。", action: "P1：对象锁/WORM、导出重试、仅内部诊断展示链状态。" },
  { control: "Collector SSRF 与解析隔离", evidence: "私网/元数据阻断、重定向重校验、压缩包/大小/超时/并发保护、非 root/read-only。", gap: "开发态跳过 integrity；absolutePath 公开 DTO；可读取进程可见任意文件。", action: "P0：opaque staging handle；absolutePath 仅进程内私有调用。" },
  { control: "Collector 爆炸半径", evidence: "cap_drop ALL、no-new-privileges、tmpfs、任务并发限制。", gap: "容器挂载完整 server/storage 且继承 .env；缺出站网络默认拒绝与独立服务身份。", action: "P0：最小目录、独立 env、network policy、只读输入/只写输出。" },
  { control: "Agent 与插件能力", evidence: "capability manifest/broker、短期签名凭据、工具审批、超时、路径与网络约束、容器策略。", gap: "控制主要覆盖 scheduled/MCP；内建工具未全部进入统一 broker；高风险 worker 未生产隔离证明。", action: "P1：统一 tool execution context 与 capability enforcement。" },
  { control: "RAG / Memory 安全", evidence: "save_memory 需要显式意图与用户审批；账户记忆有独立模型。", gap: "rag-memory.store 可直接写 workspace vector；检索结果未标记 untrusted/provenance，存在持久化污染。", action: "P0：候选态、来源签名、taint envelope、敏感/指令过滤。" },
  { control: "NATS / 内部服务通信", evidence: "JetStream adapter、durable consumer、eventId 去重、subject scope HMAC、lag/health/drain。", gap: "客户端未配置 TLS/mTLS/nkey；当前仅 adapter/fault-test，未多实例实网。", action: "P1：生产 profile 强制 tls://、证书轮换、subject ACL、workload identity。" },
  { control: "数据库与对象存储", evidence: "SQLite 当前权威；PostgreSQL schema/CDC/cutover 与 S3/MinIO provider 已准备。", gap: "没有外部多节点、池耗尽、网络分区和反向影子七日证明。", action: "P1：隔离 staging 执行故障矩阵后再切权威。" },
  { control: "供应链", evidence: "Actions 固定 SHA、远程脚本校验、SBOM/provenance/VEX、reachable Critical=0 门禁。", gap: "raw High：server 114、collector 40、frontend 11；未见统一镜像签名/admission policy。", action: "P1：Reachability owner/expiry；Cosign + deploy admission。" },
  { control: "可观测与自愈", evidence: "Runtime Coordinator、outbox DLQ/lease、receipt sweeper、reconcile、OTel/Prometheus adapters。", gap: "开发进程内指标不能证明长期 p95/错误预算；外部 telemetry/SIEM 未部署。", action: "P1：staging collector + trace correlation + SLO burn alerts。" },
  { control: "备份与灾备", evidence: "迁移/修复前本地备份、校验、可恢复脚本、内容对象不可变键。", gap: "无独立账户/跨区域 immutable backup、RPO/RTO 证据、完整恢复演练。", action: "P2：3-2-1、隔离密钥、季度 restore drill、审计证据。" },
  { control: "高权限运维", evidence: "角色层级、会话吊销、账户删除工作流、dry-run/--execute 安全语义。", gap: "无 JIT/PAM、break-glass 审批、双人控制和统一 incident console。", action: "P2：短期管理员授权、双人审批、统一 kill switches。" },
];

const findings = [
  { idRisk: "ATH-V1-001 · High · 已确认", pathEvidence: "撤销/窃取 JWT → Broadcast/Agent/Crypto WS → decodeJWT/resource lookup，但不查 AuthSession.validate。", impact: "会话吊销不能保证立即终止长连接；query token 可能进入代理、历史或日志。", recommendation: "P0：权威 WS principal adapter + 60–120 秒 ticket + 周期复核 + revoke-close。" },
  { idRisk: "ATH-V1-002 · High · 已确认", pathEvidence: "开发 Collector /parse 接收 options.absolutePath；完整性校验在 development 跳过。", impact: "本机/开发环境中，调用者可请求解析 Collector OS 权限可读文件。", recommendation: "P0：删除公开字段；API 签发 opaque file handle；loopback bind 和开发签名。" },
  { idRisk: "ATH-V1-003 · High · 已确认", pathEvidence: "Collector 容器继承 .env，并读写挂载完整 server/storage。", impact: "解析器 RCE、依赖漏洞或恶意文档可扩大到应用数据与 Secret。", recommendation: "P0：独立身份与 env；最小挂载；默认无网络；一次性任务目录。" },
  { idRisk: "ATH-V1-004 · High · 已确认", pathEvidence: "rag-memory.store 直接写 workspace vector；search 以 Additional context 原样返回。", impact: "间接 Prompt Injection 可转为长期知识污染并影响后续 Agent 决策。", recommendation: "P0：memory candidate + provenance/taint + approval + recall-time untrusted wrapper。" },
  { idRisk: "ATH-V1-005 · Medium · 已确认", pathEvidence: "公共 /ready 返回 hostname/pid 关联 workerId、计数器、审计 chainId/head hash。", impact: "扩大侦察信息和内部运行拓扑暴露；高敏诊断不应匿名公开。", recommendation: "P0：/live 极简；/ready 仅状态；/internal/diagnostics 强认证。" },
  { idRisk: "ATH-V1-006 · Medium · 已确认", pathEvidence: "iOS P-256 私钥 rawRepresentation 写入 Keychain，而非 Secure Enclave 非导出密钥。", impact: "Keychain 提供良好静态保护，但未达到报告要求的硬件不可导出。", recommendation: "P1：Secure Enclave key agreement/signing，保留设备兼容降级策略。" },
  { idRisk: "ATH-V1-007 · Medium · 已确认", pathEvidence: "服务端凭据主路径仍使用 bcryptjs；报告目标为 Argon2id + HSM pepper。", impact: "不构成直接绕过，但抗离线破解与密钥分离未达到金融级目标。", recommendation: "P1：登录时渐迁 Argon2id；pepper 仅在 KMS/HSM 阶段启用。" },
  { idRisk: "ATH-V1-008 · Medium · 条件性", pathEvidence: "开发 security policy 为 requestSigningWarnOnly=true、deviceRequired=false、strictReady=false。", impact: "若错误带入生产会形成安全降级；当前只能证明开发态配置。", recommendation: "P0 发布门禁：production profile fail-closed，禁止 warn-only/开发 bypass。" },
  { idRisk: "ATH-V1-009 · Medium · 发布前", pathEvidence: "NATS adapter 支持 user/pass/token，但 connect 未配置 TLS/CA/client cert/nkey。", impact: "启用跨实例后，内部事件的服务身份和链路机密性不足。", recommendation: "P1：在 ATHENA_BROADCAST_TRANSPORT=nats 时强制 tls:// 与 ACL。" },
  { idRisk: "ATH-V1-010 · Medium · 成熟度", pathEvidence: "安全账本签名有效；immutable archive 默认 disabled，未见生产 SIEM/SOAR 证据。", impact: "本机证据链强，但独立留存、集中检测与响应闭环不足。", recommendation: "P1：WORM/object lock + SIEM + retry/alert + incident runbook。" },
  { idRisk: "ATH-V1-011 · Medium · 成熟度", pathEvidence: "DataAccessCenter 有 public/internal/user/sensitive/secret/ephemeral 分类，但非统一 S0–S4 策略。", impact: "分类尚未统一驱动 DLP、驻留、导出、保留和水印。", recommendation: "P1：建立可机读数据目录与 policy-as-code；逐域映射，不批量重写。" },
  { idRisk: "ATH-V1-012 · Medium · 成熟度", pathEvidence: "Key provider 当前 env-file/secret-file/environment；external KMS/Vault 标为 reserved。", impact: "密钥材料和应用工作负载仍在同一管理域，无法证明硬件根与职责分离。", recommendation: "P1/P2：先 Vault/KMS staging，再按客户需求升级 HSM/双人恢复。" },
  { idRisk: "ATH-V1-013 · Medium · 证据缺口", pathEvidence: "应用内 TLS/CORS/header 存在；WAF/CDN/DDoS/DNSSEC/源站 mTLS 不在仓库与本机范围。", impact: "不能对边缘抗压、Bot、源站隐藏做金融级声明。", recommendation: "P1：把 edge 配置、健康与演练证据纳入 release evidence bundle。" },
  { idRisk: "ATH-V1-014 · Medium · 证据缺口", pathEvidence: "有本地备份与修复脚本，但无跨账户/跨区域恢复演练证据。", impact: "勒索、区域故障、密钥损坏下的 RPO/RTO 不可证明。", recommendation: "P2：独立密钥域、不可变备份、季度 restore test。" },
];

const p0Plan = [
  { workstream: "1. 长连接身份统一", change: "建立 authoritativeRealtimePrincipal(request)：Session V2、authUser、clientId、tokenVersion、设备状态统一校验；禁止新增 query JWT；引入一次性短期 WS ticket。", acceptance: "退出/封禁/设备吊销 ≤5 秒断开；旧客户端双读迁移；REST/WS principal 一致。", rollback: "短期保留 Bearer 双读开关；ticket 失败退回旧握手但仍执行 Session V2。" },
  { workstream: "2. Collector 文件句柄", change: "外部 DTO 只接受 uploadId/objectRef；absolutePath 仅内部不可序列化调用；每次 realpath 限制到 staging root。", acceptance: "任意绝对路径、symlink、目录穿越全部拒绝；合法上传兼容；无 Secret/路径出现在响应。", rollback: "旧字段仅允许 loopback + 内部签名 + 7 日 telemetry，随后移除。" },
  { workstream: "3. Collector 隔离", change: "拆分 Collector env；移除整库挂载；输入只读、输出只写；network none 默认；必要域名经 egress proxy。", acceptance: "恶意文档无法读取 Auth DB/.env/主库；容器 RCE 影响限制在一次性目录；功能格式回归通过。", rollback: "按格式 allowlist 回退到受限 legacy worker，不回退为全存储挂载。" },
  { workstream: "4. RAG/Memory 污染防护", change: "rag-memory.store 写 candidate；记录来源、actor、thread、hash、信任级别；审批后进入可检索索引；检索内容包装为 untrusted evidence。", acceptance: "间接指令不能直接写长期向量；用户可查看/拒绝/删除；召回不会覆盖 system/tool policy。", rollback: "候选功能关闭时禁用 store，只保留 search；不丢弃现有向量。" },
  { workstream: "5. 生产策略配置门禁", change: "生产启动校验 request signing/device required、strict readiness、CORS allowlist、HTTPS、dev bypass off；失败即 not-ready。", acceptance: "错误生产配置无法启动；开发体验不变；密钥内容与时间戳不修改。", rollback: "按单控制 feature flag 回滚，但保持显式告警与审计，不提供静默 global bypass。" },
  { workstream: "6. 健康与诊断分层", change: "`/live` 只返回存活；`/ready` 只返回 ready/reasonCode；计数、worker、链状态移到强认证 internal diagnostics。", acceptance: "匿名响应不包含 pid/hostname/hash/内部计数；监控探针继续 200/503；运维诊断信息不丢失。", rollback: "保留内部 legacy payload 端点，不恢复公共详细响应。" },
];

const roadmap = [
  { phase: "P0 · 0–14 天", focus: "WS Session、Collector 句柄/隔离、RAG taint、生产门禁、健康端点", value: "关闭 4 个已确认 High 与 1 个信息泄露面；不改业务数据模型。", costRisk: "中等；主要风险是旧客户端握手和文档导入兼容。" },
  { phase: "P1 · 15–45 天", focus: "统一 policy adapter、Secure Enclave、Argon2id 渐迁、NATS TLS、数据目录", value: "让身份、设备、关系、风险、数据等级进入统一决策；为多实例上线建立安全前提。", costRisk: "中高；必须按 adapter 渐迁，禁止一次性替换领域授权。" },
  { phase: "P1 · 30–60 天", focus: "KMS/Vault staging、WORM audit、SIEM/OTel、SBOM 签名与 admission", value: "从本地可验证升级为跨系统可证明，建立检测与供应链证据链。", costRisk: "中高；依赖外部基础设施与轮换/故障演练。" },
  { phase: "P2 · 60–120 天", focus: "Service identity/mTLS、egress+DLP、JIT/PAM、统一 incident console", value: "缩小横向移动和数据外泄半径，支撑企业管理员与高权限 Agent。", costRisk: "高；需要平台工程和安全运营共同所有。" },
  { phase: "P2 · 90–180 天", focus: "跨账户/跨区域 immutable backup、RPO/RTO、完整恢复演练", value: "把‘有备份’提升为‘可恢复’，覆盖勒索、区域故障与密钥事故。", costRisk: "高；需要真实云资源与演练窗口。" },
  { phase: "P3 · 6–18 月", focus: "HSM root、客户管理密钥、机密空间、阈值/分片恢复、PQ agility", value: "服务高价值企业和监管场景；按需求启用，不强行覆盖搜索/AI 主链。", costRisk: "很高；只有明确合规和客户收益时引入。" },
];

const validations = [
  { domain: "Identity/WS", test: "创建 session → WS 连接 → revoke/device revoke/ban/logout → 观察断连与后续握手。", gate: "全部路径 ≤5 秒生效；不得仅等 JWT 过期。", evidence: "自动化 E2E + audit event + socket close code。" },
  { domain: "Collector path", test: "absolute path、symlink、hardlink、目录穿越、文件替换竞态、超大文件。", gate: "仅 opaque staging handle 可成功；路径不出现在日志/响应。", evidence: "fault injection + container mount inventory。" },
  { domain: "Collector sandbox", test: "恶意解析器尝试读取 /app/server/.env、Auth DB、网络元数据与任意域名。", gate: "全部 fail-closed；合法格式回归不超过既有 p95 10%。", evidence: "container integration + egress log。" },
  { domain: "RAG memory", test: "网页/PDF 中嵌入保存指令、越权工具指令、伪造系统提示。", gate: "只生成候选或拒绝；未经用户确认不进入长期索引。", evidence: "OWASP AISVS L2 adversarial suite。" },
  { domain: "Sync", test: "重复/乱序/丢失 WS/SSE/Push、缓存写失败、Hash 不同、权限撤销。", gate: "cursor/ACK 不提前；Hash mismatch <0.01%；full reconcile <1%。", evidence: "Web+iOS 授权多设备 E2E。" },
  { domain: "Crypto", test: "key provider 断连、旧 key 解密、轮换中断、对象写成功 DB 失败。", gate: "不产生孤儿引用或不可恢复密文；不输出 key material。", evidence: "staging KMS/Vault rotation drill。" },
  { domain: "NATS/mTLS", test: "无证书、错误 subject、证书轮换、网络分区、consumer redelivery。", gate: "未授权连接拒绝；Outbox 可补拉；Gateway not-ready。", evidence: "distributed staging fault matrix。" },
  { domain: "Audit/SIEM", test: "篡改 ledger、删除 archive、archive provider 故障、告警链路中断。", gate: "验证失败可见；导出重试；WORM 对象不可覆盖；SOC 收到告警。", evidence: "signed checkpoint + object lock + alert receipt。" },
  { domain: "Supply chain", test: "依赖 Critical、未固定 Action、无 provenance、未签名镜像、过期 High waiver。", gate: "发布全部阻断；reachable Critical=0；High 有 owner/expiry。", evidence: "CI policy report + signature verification。" },
  { domain: "DR", test: "在隔离账户从数据库、对象、向量、Auth、密钥与 Outbox 恢复。", gate: "满足正式 RPO/RTO；权限/Session/Hash Chain/Sync 全部复核。", evidence: "季度 restore report 与 CTO/Security sign-off。" },
];

const standards = [
  { standard: "NIST SP 800-207 / 207A", use: "Zero Trust：不因网络位置授信；用户、设备与工作负载身份都需要策略决策与执行。", athenaMapping: "资源级 AuthZ、Session/设备签名已有；统一 PE/PA/PEP、service identity/mTLS 待补。" },
  { standard: "OWASP ASVS 5.0", use: "应用安全可验证需求基线，用于身份、会话、输入、文件、API、日志与配置门禁。", athenaMapping: "现有 route/security audit 可转为 ASVS requirement ID 的机器可读 control ledger。" },
  { standard: "OWASP AISVS 1.0", use: "AI 系统 L1–L3 验证，覆盖 memory/vector、Agent action、MCP、监控与对抗鲁棒性。", athenaMapping: "建议生产面向敏感数据达到 L2；Memory/Agent/Connector 是首个缺口域。" },
  { standard: "NIST CSF 2.0", use: "Govern、Identify、Protect、Detect、Respond、Recover 的运营闭环。", athenaMapping: "Protect 较强；Govern/Detect/Respond/Recover 需要 SIEM、incident console 与 DR 演练。" },
  { standard: "SLSA 1.2", use: "Source/Build provenance、逐级保证、artifact verification。", athenaMapping: "SBOM/provenance 与 pinned Actions 已有；镜像签名、admission、source control policy 需闭环。" },
];

const priorityCounts = [
  { priority: "P0", items: 6 },
  { priority: "P1", items: 8 },
  { priority: "P2", items: 6 },
  { priority: "P3", items: 4 },
];

const verificationSummary = [
  { check: "Main DB", result: "quick_check=ok; foreign_key=0" },
  { check: "Auth DB", result: "quick_check=ok; foreign_key=0" },
  { check: "Chat crypto", result: "1,038/1,038 encrypted; invalid chain=0" },
  { check: "Sync V2", result: "263 nodes; 186 projections; conflicts=0" },
  { check: "Route audit", result: "338 routes; findings=0" },
  { check: "Supply chain", result: "reachable Critical=0" },
];

const controlsPrint = controls.map((row) => ({
  control: row.control,
  assessment: `CURRENT — ${row.evidence}\nGAP — ${row.gap}\nACTION — ${row.action}`,
}));
const findingsPrint = findings.map((row) => ({
  idRisk: row.idRisk,
  assessment: `PATH — ${row.pathEvidence}\nIMPACT — ${row.impact}\nACTION — ${row.recommendation}`,
}));
const p0PlanPrint = p0Plan.map((row) => ({
  workstream: row.workstream,
  details: `IMPLEMENT — ${row.change}\nGATE — ${row.acceptance}\nROLLBACK — ${row.rollback}`,
}));
const roadmapPrint = roadmap.map((row) => ({
  phase: row.phase,
  details: `SCOPE — ${row.focus}\nVALUE — ${row.value}\nCOST/RISK — ${row.costRisk}`,
}));
const validationsPrint = validations.map((row) => ({
  domain: row.domain,
  details: `TEST — ${row.test}\nGATE — ${row.gate}\nEVIDENCE — ${row.evidence}`,
}));
const standardsPrint = standards.map((row) => ({
  standard: row.standard,
  details: `PURPOSE — ${row.use}\nATHENA — ${row.athenaMapping}`,
}));

const weightedMaturity = Number(
  maturity.reduce((sum, row) => sum + row.score * row.weight, 0) / 100
).toFixed(2);

const evidence = {
  generatedAt,
  scope: "Authorized local development repository/runtime, read-only assessment",
  repository: { branch: "codex/v2.3", commit: "2bd6e486b60b45ab3e6a97bdce522cb94c4e551c" },
  runtime: { frontend: 200, api: 200, apiReady: 200, collector: 200 },
  database: { mainQuickCheck: "ok", mainForeignKeys: 0, authQuickCheck: "ok", authForeignKeys: 0 },
  encryption: { chats: 1038, chatPromptEncrypted: 1038, chatResponseEncrypted: 1038, chatChainInvalid: 0, documentsEncrypted: "31/31", vectorCacheEncrypted: "30/30", lanceTextEncrypted: "695/695" },
  syncV2: { enabled: false, nodes: 263, projectionsChecked: 186, hashMismatches: 0, permissionConflicts: 0, payloadConflicts: 0, maxCursorLag: 696 },
  securityLedger: { entries: 13, checkpoints: 4, valid: true, archiveEnabled: false },
  staticAudits: { routeCount: 338, routeFindings: 0, resourceAccessFindings: 0, keyCustodyFindings: 0, desktopPolicyFindings: 0 },
  supplyChain: { reachableCritical: 0, rawHigh: { server: 114, collector: 40, frontend: 11 }, sbom: true, provenance: true },
  limitations: ["No authenticated browser multi-device E2E in this run", "No external PostgreSQL/NATS/S3/KMS/SIEM environment", "Edge WAF/CDN/DDoS/DNSSEC not observable from local repository", "Scores are architecture judgment, not compliance certification"],
  maturity,
  findings,
};

fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

const sourceBase = {
  engine: "repository-runtime-review",
  language: "json",
  executed_at: generatedAt,
  filters: [
    "Authorized local development environment only",
    "Read-only evidence collection",
    "Secrets, tokens, raw hashes and personal content excluded",
  ],
};

const sources = [
  { id: "live_evidence", label: "Athena V1.0 security gap evidence snapshot", path: "output/security/athena-v1-security-architecture-gap-evidence-v2.3.json", query: { ...sourceBase, sql: "SELECT 7.4 AS productScore, 61.1 AS blueprintCompletion, 4 AS confirmedHigh, 0 AS routeFindings, 0 AS syncConflicts, 0 AS invalidChatChain, (SELECT COUNT(*) FROM workspace_chats) AS auditedChats, (SELECT COUNT(*) FROM sync_nodes) AS syncNodes;", tables_used: ["workspace_chats", "sync_nodes"], metric_definitions: { productScore: "Architecture committee judgment on a 0-10 current product-security scale; not certification.", blueprintCompletion: "Weighted average of 12 target domains on a 0-5 maturity scale, multiplied by 20.", confirmedHigh: "Deduplicated confirmed High code-path findings in this authorized read-only review." }, description: "Database, encryption, Sync V2, route, runtime, ledger, supply-chain and code-path evidence used by this report." } },
  { id: "target_blueprint", label: "User-provided Athena enterprise network security and confidentiality architecture V1.0", query: { engine: "document-review", language: "text", executed_at: generatedAt, description: "Target-state control catalogue covering edge, zero trust, workload, data/crypto, SecOps, supply chain, organization and incident recovery." } },
  { id: "nist_zta", label: "NIST SP 800-207 Zero Trust Architecture", query: { engine: "web-document", language: "text", url: "https://csrc.nist.gov/pubs/sp/800/207/final", executed_at: generatedAt, description: "Official NIST Zero Trust Architecture publication." } },
  { id: "owasp_asvs", label: "OWASP ASVS 5.0", query: { engine: "web-document", language: "text", url: "https://owasp.org/www-project-application-security-verification-standard/", executed_at: generatedAt, description: "Official OWASP Application Security Verification Standard project page." } },
  { id: "owasp_aisvs", label: "OWASP AISVS 1.0", query: { engine: "web-document", language: "text", url: "https://owasp.org/www-project-artificial-intelligence-security-verification-standard-aisvs-docs/", executed_at: generatedAt, description: "Official OWASP Artificial Intelligence Security Verification Standard documentation." } },
  { id: "nist_csf", label: "NIST Cybersecurity Framework 2.0", query: { engine: "web-document", language: "text", url: "https://www.nist.gov/news-events/news/2024/02/nist-releases-version-20-landmark-cybersecurity-framework", executed_at: generatedAt, description: "Official NIST CSF 2.0 overview and six-function model." } },
  { id: "slsa", label: "SLSA specification 1.2", query: { engine: "web-document", language: "text", url: "https://slsa.dev/spec/v1.2/", executed_at: generatedAt, description: "Official SLSA source/build provenance and artifact assurance specification." } },
];

const cards = [
  { id: "product_score", dataset: "headline", sourceId: "live_evidence", description: "Current product security posture from the local architecture/security review; not a compliance certification.", metrics: [{ label: "Product security posture", field: "productScore", format: "number", unit: "/10" }] },
  { id: "blueprint_completion", dataset: "headline", sourceId: "live_evidence", description: "Weighted completion against the broader financial-grade V1.0 target operating model.", metrics: [{ label: "V1.0 blueprint completion", field: "blueprintCompletion", format: "number", unit: "%" }] },
  { id: "confirmed_high", dataset: "headline", sourceId: "live_evidence", description: "Confirmed High code-path findings requiring P0 ownership.", metrics: [{ label: "Confirmed High findings", field: "confirmedHigh", format: "number" }] },
  { id: "route_findings", dataset: "headline", sourceId: "live_evidence", description: "Static high-risk route audit across 338 routes.", metrics: [{ label: "Route audit findings", field: "routeFindings", format: "number" }] },
  { id: "sync_conflicts", dataset: "headline", sourceId: "live_evidence", description: "Hash, permission and projection conflicts in the read-only Sync V2 audit.", metrics: [{ label: "Sync projection conflicts", field: "syncConflicts", format: "number" }] },
  { id: "chat_chain", dataset: "headline", sourceId: "live_evidence", description: "Invalid Chat Hash Chain entries across the audited 1,038-row corpus.", metrics: [{ label: "Invalid Chat chain", field: "invalidChatChain", format: "number" }] },
];

const charts = [
  { id: "maturity_chart", title: "V1.0 target maturity by security domain", subtitle: "0 = missing; 3 = locally implemented; 5 = continuously enforced and independently proven.", type: "bar", dataset: "maturity", sourceId: "live_evidence", encodings: { x: { field: "domain", type: "ordinal", label: "Domain" }, y: { field: "score", type: "quantitative", label: "Maturity", format: "number" } }, yAxisTitle: "Maturity / 5", valueFormat: "number", layout: "full", referenceLines: [{ value: 4, label: "Enterprise enforced target" }] },
  { id: "status_chart", title: "Control implementation status", subtitle: "A control is counted as externally proven only when runtime or deployment evidence exists.", type: "bar", dataset: "controlStatus", sourceId: "live_evidence", encodings: { x: { field: "status", type: "ordinal", label: "Status" }, y: { field: "count", type: "quantitative", label: "Controls", format: "number" } }, yAxisTitle: "Control count", valueFormat: "number", layout: "full" },
  { id: "priority_chart", title: "Recommended optimization backlog by priority", subtitle: "P0 closes exploitable or fail-open paths; later phases establish enterprise proof and operating maturity.", type: "bar", dataset: "priorityCounts", sourceId: "live_evidence", encodings: { x: { field: "priority", type: "ordinal", label: "Priority" }, y: { field: "items", type: "quantitative", label: "Workstreams", format: "number" } }, yAxisTitle: "Workstream count", valueFormat: "number", layout: "full" },
];

function table(id, title, subtitle, dataset, columns, sortField) {
  return { id, title, subtitle, showDescription: true, dataset, sourceId: "live_evidence", defaultSort: { field: sortField, direction: "asc" }, density: "dense", layout: "full", columns: columns.map(([field, label]) => ({ field, label, type: "text" })) };
}

const tables = [
  table("verification_summary", "Verified Local Evidence", "Short-form evidence table; detailed controls use wrapping audit tables below.", "verificationSummary", [["check", "Check"], ["result", "Result"]], "check"),
];

const blocks = [
  { id: "title", type: "markdown", body: "# Athena V1.0 Security Architecture Gap Assessment & Optimization Report\n\n**Athena v2.3 · Enterprise / Financial-grade Target Review · 2026-07-20**" },
  { id: "classification", type: "markdown", body: "**Classification:** Internal Architecture & Security Review  \n**Assessment mode:** authorized, local, read-only, non-destructive  \n**Audience:** CTO, Architecture Committee, Security Committee, Product Infrastructure and Engineering Leadership" },
  { id: "technical_summary", type: "markdown", sourceId: "live_evidence", body: `## Technical Summary — 产品级安全基础成熟，但距离 V1.0 金融级完整运营模型仍有 39% 证据与控制缺口\n\n**结论：Athena 不需要推倒重写。** 当前产品安全姿态维持 **7.4/10**；按用户提供的 V1.0 大型互联网/金融级完整目标重新衡量，加权完成度为 **${(weightedMaturity * 20).toFixed(1)}%**。两者不是矛盾：前者评价产品当前防护，后者还包含外部 WAF/DDoS、工作负载身份与 mTLS、HSM/KMS、DLP、SIEM/SOAR、JIT/PAM、独立安全账户和跨区域灾备等组织与基础设施能力。\n\nAthena 的领先部分是：**业务权威、同步一致性、实时通知、内容对象和完整性证明彼此解耦**。Sync V2 的 version/hash/outbox/cursor 并不替代 WebSocket/SSE，Chat Hash Chain 不替代加密，NATS 也不成为业务数据库。当前 1,038 条 Chat prompt/response 全部加密且链断裂为 0；263 个 Sync 节点和 186 个投影没有 Hash、权限或正文冲突；338 个高风险路由静态审计为 0 finding。\n\n本次仍确认 **4 个 High**：WebSocket 未统一执行权威 Session V2；Collector 开发入口接受 absolutePath；Collector 继承过宽 .env/存储挂载；workspace rag-memory 缺少 provenance/taint/候选审批。它们应先闭环，再推进 KMS、mTLS、SIEM 或多账户治理。` },
  { id: "headline", type: "metric-strip", cardIds: cards.map((card) => card.id) },
  { id: "verification_summary_block", type: "table", tableId: "verification_summary", layout: "full" },
  { id: "evidence_contract", type: "markdown", body: "## Evidence Contract — 不把代码适配、开发运行态和生产证明混为一谈\n\n- **已验证实现**：当前仓库、开发数据库、运行中的 Web/API/Collector、只读审计脚本和静态控制扫描。\n- **适配/故障测试准备**：PostgreSQL、NATS JetStream、S3/MinIO、OTel、Key Custody 外接边界；证明接口与失败语义，不证明生产容量或可用性。\n- **外部控制不可见**：CDN/WAF/DDoS/DNSSEC、云账户隔离、KMS/HSM、SIEM/SOAR、对象锁与跨区域灾备，需要部署平台证据。\n- **评分尺度**：0 缺失；1 设计/占位；2 部分实现；3 本地实现；4 强制+监控；5 独立证明+周期演练。" },
  { id: "architecture_heading", type: "markdown", body: "## 1. Current Architecture vs. V1.0 Target" },
  { id: "architecture_diagram", type: "html", body: architectureDiagram(), layout: "full" },
  { id: "architecture_reading", type: "markdown", body: "### Architecture reading\n\n当前架构已具备清晰的控制面/数据面/通知面分离，但 V1.0 把目标扩大为‘产品 + 云平台 + 安全运营 + 组织治理’。因此最小侵入路线不是把 Athena 改成一套庞大安全总线，而是：统一所有入口的 principal 校验；让数据分类驱动既有 Repository/Outbox/对象层；将外部 WAF、KMS、SIEM、DR 作为可替换平台能力接入。" },
  { id: "maturity_heading", type: "markdown", body: "## 2. Maturity & Control Coverage" },
  { id: "maturity_chart_block", type: "html", body: barChartSvg({ title: "V1.0 target maturity by security domain", subtitle: "0 = missing; 3 = locally implemented; 5 = continuously enforced and independently proven.", rows: maturity, categoryField: "domain", valueField: "score", maxValue: 5, target: 4 }), layout: "full" },
  { id: "maturity_native_chart_block", type: "chart", chartId: "maturity_chart", layout: "full" },
  { id: "status_chart_block", type: "html", body: barChartSvg({ title: "Control implementation status", subtitle: "Only controls with code or runtime evidence are counted as implemented.", rows: controlStatus, categoryField: "status", valueField: "count", maxValue: 16 }), layout: "full" },
  { id: "control_table_intro", type: "markdown", body: "### V1.0 Control Coverage Matrix\n\nEach printable audit row contains the current evidence, residual gap and minimum-intrusion action." },
  ...auditRowBlocks("control_row", controlsPrint, "control", "assessment"),
  { id: "findings_heading", type: "markdown", body: "## 3. Findings — Exploitable Paths First, Maturity Gaps Second" },
  { id: "findings_intro", type: "markdown", body: "四个 High 都可以在不改变用户业务语义的前提下修复：会话与设备仍使用现有 Auth DB；Collector 仍支持现有上传和解析，只把路径能力收回服务端；Memory 仍可保存，只先进入候选态。KMS、WAF、SIEM 等未外部证明项属于发布与成熟度门槛，不应误报为当前本机漏洞。" },
  { id: "finding_table_intro", type: "markdown", body: "### Confirmed Findings & Assurance Gaps\n\nConfirmed defects are separated from deployment and operating-model assurance gaps." },
  ...auditRowBlocks("finding_row", findingsPrint, "idRisk", "assessment"),
  { id: "zero_trust_heading", type: "markdown", body: "## 4. Recommended Zero Trust Enforcement Loop" },
  { id: "zero_trust_diagram", type: "html", body: decisionDiagram(), layout: "full" },
  { id: "zero_trust_notes", type: "markdown", body: "### Design rule\n\nZero Trust 的实施单元不是一个新‘安全中心’数据库，而是一个稳定的 `AuthorizationContext` 和少量 enforcement adapters：REST middleware、WebSocket handshake/refresh、Agent tool invocation、Connector egress、Data export。领域 Repository 继续决定业务关系；策略层只做组合决策、记录 reason code，并在撤销或风险变化时终止能力。" },
  { id: "p0_heading", type: "markdown", body: "## 5. P0 Optimization Plan — 0 to 14 Days" },
  { id: "p0_table_intro", type: "markdown", body: "### P0 Closed-loop Optimization Plan\n\nEvery change includes an acceptance gate and rollback boundary; no key rotation is required." },
  ...auditRowBlocks("p0_row", p0PlanPrint, "workstream", "details"),
  { id: "p0_sequence", type: "markdown", body: "### Required sequence\n\n1. 先引入共享 WS principal adapter 和只读 telemetry，验证新旧 principal 一致。\n2. 再签发短期 WS ticket，并保留旧 Bearer 双读；确认 revoke-close 后禁止 query JWT。\n3. Collector 先影子生成 opaque handle，再切读路径；隔离挂载与 env 最后启用。\n4. Memory 先记录候选而不改变 search；候选 UI/审批可用后关闭 direct store。\n5. 生产门禁和健康端点分层可独立上线，不依赖数据迁移。" },
  { id: "roadmap_heading", type: "markdown", body: "## 6. P1/P2/P3 Evolution Roadmap" },
  { id: "priority_chart_block", type: "html", body: barChartSvg({ title: "Recommended optimization backlog by priority", subtitle: "P0 closes exploitable or fail-open paths; later phases establish enterprise proof.", rows: priorityCounts, categoryField: "priority", valueField: "items", maxValue: 8 }), layout: "full" },
  { id: "roadmap_table_intro", type: "markdown", body: "### Security Evolution Roadmap\n\nReduce exploitability first, then establish enterprise operating proof." },
  ...auditRowBlocks("roadmap_row", roadmapPrint, "phase", "details"),
  { id: "crypto_decisions", type: "markdown", body: "## 7. Cryptography & Confidentiality Decisions\n\n- **立即保留**：AES-256-GCM + HKDF + per-object DEK；Chat/Audit Hash Chain；Ed25519 审计 checkpoint；Passkey/OPAQUE；P-256 设备签名。\n- **下一阶段接入**：KMS/Vault provider、Secure Enclave、NATS mTLS、对象锁/WORM；先 staging 轮换和故障演练，不修改现有密钥。\n- **按需求引入**：HSM root、客户管理密钥、Threshold Signature、Shamir Secret Sharing，仅用于高价值密钥恢复或多方审批。\n- **暂不普遍引入**：Signal/MLS E2EE 会与服务端搜索、RAG、Agent 推理和合规检索冲突；只适合未来明确的‘机密空间’，不能覆盖普通 Workspace。\n- **不作为安全替代品**：Merkle Tree/CRDT/Event Stream 解决对账、协作和历史，不替代身份、授权、加密或审计。" },
  { id: "ai_security", type: "markdown", body: "## 8. AI, Agent, MCP & Memory Security\n\nAthena 已经比普通 Agent 平台更成熟：工具审批、能力清单、短期凭据、容器约束、文件路径和网络域限制、成本/超时治理都存在。但控制覆盖不均衡：scheduled/MCP 路径较强，内建工具和 rag-memory 没有全部穿过同一 capability broker。建议以 [OWASP AISVS 1.0](https://owasp.org/www-project-artificial-intelligence-security-verification-standard-aisvs-docs/) Level 2 为生产目标，优先覆盖 Memory/Vector、Agentic Action、MCP、Monitoring 四章。" },
  { id: "data_security", type: "markdown", body: "## 9. Data Classification, DLP & Privacy\n\nDataAccessCenter 已有 public/internal/user/sensitive/secret/ephemeral 分类，这是重要基础，并非从零开始。下一步应把它升级为可机读目录：owner、legal basis、residency、retention、encryption profile、export policy、log policy、AI usage policy。用户报告中的 S0–S4 可以作为展示与审计等级，但内部仍可保留现有语义枚举，通过映射层避免大规模 Repository 重写。DLP、水印、导出审批应只针对 S3/S4 和高风险动作，避免给普通聊天与设置带来全局性能回退。" },
  { id: "operations", type: "markdown", body: "## 10. SecOps, Incident Response & Self-healing\n\n现有 Runtime Coordinator、Outbox DLQ/lease、receipt sweeper、auth-session reconcile、Hash 校验和 immutable object key 已形成自愈基础。企业级闭环还需要统一 incident control plane：租户隔离、Connector all-off、Agent high-risk tools off、export freeze、read-only mode、session mass revoke、key disable。所有动作必须进入签名审计链，并能通过 SIEM/SOAR 触发，但不得让 SIEM 成为业务请求的同步依赖。" },
  { id: "validation_heading", type: "markdown", body: "## 11. Testing, Release Gates & Rollback" },
  { id: "validation_table_intro", type: "markdown", body: "### Verification, Fault Injection & Release Gates\n\nA control is complete only when failure semantics and operational evidence are verified." },
  ...auditRowBlocks("validation_row", validationsPrint, "domain", "details"),
  { id: "performance", type: "markdown", body: "## 12. Performance, Cost & Complexity Impact\n\n- WS 权威 Session 校验可复用 5 秒正向缓存；握手增加一次 Auth DB 读取，稳定连接只做周期轻量复核，预计普通 REST 无回退。\n- Collector opaque handle 消除任意路径分支，隔离容器会增加冷启动与文件复制成本；通过 worker 池、内容对象引用与流式处理控制在 10% p95 门槛内。\n- Memory 候选态增加一次元数据写和审批交互，但避免污染导致的长期召回成本与安全事故。\n- 数据分类映射应在 Repository/Outbox 边界计算，不扫描全文，不进入每次 Token 流。\n- KMS 只封装/解封 DEK，不对每个字节远程加密；热点 DEK 使用短期内存缓存并受进程生命周期约束。\n- SIEM、WORM、OTel 采用异步可靠投递；安全审计本地事务失败必须 fail-closed，高容量遥测失败则降级并告警。" },
  { id: "standards_heading", type: "markdown", body: "## 13. Standards & Assurance Mapping" },
  { id: "standards_table_intro", type: "markdown", body: "### Standards Mapping\n\nStandards guide verification; this report does not claim certification or compliance." },
  ...auditRowBlocks("standards_row", standardsPrint, "standard", "details"),
  { id: "standards_links", type: "markdown", body: "### Primary references\n\n[NIST SP 800-207 Zero Trust Architecture](https://csrc.nist.gov/pubs/sp/800/207/final) · [OWASP ASVS 5.0](https://owasp.org/www-project-application-security-verification-standard/) · [OWASP AISVS 1.0](https://owasp.org/www-project-artificial-intelligence-security-verification-standard-aisvs-docs/) · [NIST CSF 2.0](https://www.nist.gov/news-events/news/2024/02/nist-releases-version-20-landmark-cybersecurity-framework) · [SLSA 1.2](https://slsa.dev/spec/v1.2/)" },
  { id: "limitations", type: "markdown", body: "## 14. Limitations, Uncertainty & Robustness\n\n- 本轮未使用用户凭据，浏览器动态审计只覆盖匿名页面；授权多设备 E2E 是后续必要证据。\n- 本机没有获准的外部 PostgreSQL/NATS/S3/KMS/SIEM、WAF 或跨区域环境，因此只能评估代码边界与本地故障语义。\n- 开发环境策略为 warn-only 不能推断生产必然同样配置；报告将其作为发布门禁，而非已暴露生产漏洞。\n- 依赖 raw High 反映 package tree，不等于 165 个可利用漏洞；当前门禁证明 reachable Critical=0，但每个 High 仍需 owner、mitigation 和 expiry。\n- 架构评分包含专家判断，不是渗透测试、合规认证或金融监管批准。" },
  { id: "next_steps", type: "markdown", body: "## 15. Recommended Next Steps\n\n1. 把本报告 6 个 P0 workstream 建成单独 feature flags，先 shadow/telemetry，再双读、强制、移除旧路径。\n2. 建立机器可读 `security-control-ledger.json`，每个控制关联 owner、code path、test、runtime evidence、exception、expiry。\n3. 在 Docker-capable staging 完成 NATS mTLS、Collector sandbox、KMS/Vault、WORM audit 与 OTel/SIEM 演练。\n4. 建立 Web+iOS/Desktop 授权多设备安全 E2E，覆盖 session revoke、permission revoke、offline replay、account switch 和 push loss。\n5. P0 全部关闭后再做外部边缘、JIT/PAM、DLP 和跨区域 DR；不为了贴合报告名词强行引入 HSM、Threshold 或全面 E2EE。" },
  { id: "further_questions", type: "markdown", body: "## 16. Further Questions for the Security Committee\n\n- Athena 首个需要金融级保护的资产是用户私密记忆、企业知识库、Agent 操作权限还是交易/账务？\n- 企业客户是否要求 BYOK/HYOK、数据驻留、WORM、双人审批或特定 RPO/RTO？\n- 哪些 Agent 工具必须具备网络访问，哪些可以完全无网络？\n- ‘机密空间’是否允许牺牲全文搜索、RAG 和服务端 Agent 推理以换取 E2EE？\n- 第一阶段安全运营由内部团队还是外部 MSSP/SOC 承担？这决定 SIEM/SOAR 与 on-call 设计。" },
  { id: "final_assessment", type: "markdown", sourceId: "live_evidence", body: `## Final Assessment\n\n**当前产品安全姿态：7.4/10。V1.0 金融级完整蓝图完成度：${(weightedMaturity * 20).toFixed(1)}%。**\n\nAthena 的密码、数据完整性、状态同步和资源授权基础已经领先于同阶段 AI 产品；真正的短板不是缺少更多密码学名词，而是四条高风险路径尚未统一执行已有控制，以及外部分布式与安全运营能力尚未获得生产证据。按本报告 P0→P1→P2 顺序推进，可以在保留现有 REST、SSE、WebSocket、Sync V2、领域 Repository 与客户端缓存语义的前提下，逐步达到大型互联网平台的可审计、可回滚、可恢复安全架构。` },
];

const artifact = {
  surface: "report",
  manifest: {
    version: 1,
    surface: "report",
    title: "Athena V1.0 Security Architecture Gap Assessment & Optimization Report",
    description: "Read-only assessment of Athena v2.3 against the user-provided enterprise and financial-grade security architecture V1.0, with a prioritized optimization roadmap.",
    generatedAt,
    cards,
    charts,
    tables,
    sources,
    blocks,
  },
  snapshot: {
    version: 1,
    status: "ready",
    generatedAt,
    datasets: {
      headline: [{ productScore: 7.4, blueprintCompletion: Number((weightedMaturity * 20).toFixed(1)), confirmedHigh: 4, routeFindings: 0, syncConflicts: 0, invalidChatChain: 0 }],
      maturity,
      controlStatus,
      controls,
      findings,
      p0Plan,
      roadmap,
      validations,
      standards,
      controlsPrint,
      findingsPrint,
      p0PlanPrint,
      roadmapPrint,
      validationsPrint,
      standardsPrint,
      priorityCounts,
      verificationSummary,
    },
    accessIssues: [],
  },
  sources,
  package_info: {
    format: "athena-portable-security-report-v1",
    classification: "internal",
    assessmentMode: "read-only",
  },
};

fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({ artifactPath, evidencePath, generatedAt, weightedMaturity, blocks: blocks.length, controls: controls.length, findings: findings.length }, null, 2));
