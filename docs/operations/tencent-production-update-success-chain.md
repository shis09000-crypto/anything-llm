# 腾讯云生产更新成功链路

最后验证：2026-08-02（UTC）  
适用范围：Athena production micro-module Compose

## 不变量

- 先从运行中容器的 Compose labels 解析真实 project、Compose 文件和 env 文件，禁止套用旧单体命令。
- 当前权威 project 为 `athena-production-micro`，Compose 文件为
  `/data/anythingllm/compose/micro-modular/docker-compose.production-micro.json`，env 为
  `/data/anythingllm/micro-modular/secrets/compose.env`。
- 不使用 `--remove-orphans`，不重建 PostgreSQL、MinIO、NATS、ClickHouse 或密钥卷。
- 普通微模块使用 `scripts/production/roll-micro-module.sh` 单服务滚动；API 使用既有蓝绿发布链路。
- 发布完成不能只看脚本返回值；必须继续检查目标容器健康、重启次数、公共 HTTPS、Operations ACK 和 Prometheus target。
- Compose 重建期间要持续观察 `api-tls` 与 `web` 的过渡状态；不得把短暂 `created/removing` 当成完成。
- Prometheus 配置和规则是单文件 bind mount。对宿主文件做原子 rename 后，运行容器仍可能持有旧 inode；完成 `promtool` 校验后必须只重建 Prometheus 容器，再从规则 API 验证实际加载版本。

## Browser Egress 发布证据

Browser Egress 控制面、Browser Plane 适配、桌面本机代理运行时、Managed Chrome
兼容模式、AICP 能力、数据库迁移和 Operations 指标已经部署。海外数据平面仍保持关闭。

| 对象 | 生产状态 |
| --- | --- |
| 基础 Browser Egress 应用镜像 | `anythingllm-v2-anythingllm:v2.5.44-browser-egress-r3` |
| 基础镜像摘要 | `sha256:ea9763152ded1a32925ef2a5b361609f8803de5b3df9f4053e66797ea9d738a4` |
| Operations Plane 镜像 | `anythingllm-v2-anythingllm:v2.5.44-browser-egress-r4` |
| Operations 镜像摘要 | `sha256:17694980d662c5e24f442ee66c6ed206b12c912fca5457410b8815642ec410a0` |
| Browser Egress 观测镜像 | `anythingllm-v2-anythingllm:v2.5.44-browser-egress-r5` |
| Browser Egress 观测镜像摘要 | `sha256:b1954c2dba00a392152f54aaf99279147c382d3b13989a1756eb46cfae30bbd8` |
| 前端入口资源 | `/assets/index-db6d27c2.js`、`/assets/index-113a108d.css` |
| Browser Center chunk | `BrowserCenter-ce3aaf68.js` |
| 功能开关 | `ATHENA_PROD_BROWSER_EGRESS_ENABLED=false` |
| Gateway | 候选镜像已暂存，容器未启动 |

本次验收结果：

- Browser Egress、Browser Plane、Identity、Key Custody、Crypto Forecast、API 蓝绿槽均健康，重启次数为零。
- `/api/ping`、`/api/ready`、`/browser` 连续返回 HTTP 200；未认证出口状态接口返回预期 HTTP 401。
- Operations Plane `lastError=null`、retry queue 为零；JetStream stream sequence 与 ACK floor
  追平，lag、ack-pending、redelivery、pending、DLQ 均为零，ClickHouse circuit closed。
- Prometheus 的 `athena-browser-egress` target 为 `up`，不存在 down target。
- `AthenaBrowserEgressGatewayUnavailable` 与 `AthenaBrowserEgressGrantFailures`
  已加载。禁用态由 `athena_browser_egress_enabled=0` 明确区分，不产生未启用误报。
- 网关候选没有启动，现有 ASG 用户、凭证和配置未被修改。

## 激活门禁

不得仅把功能开关改成 `true`。启用海外出口前必须同时满足：

1. `browser-egress.athenallm.online` 已指向批准的海外主机。
2. 云安全组与主机防火墙只开放预定 TCP 8443。
3. 独立 Reality 密钥、设备身份和 Gateway 配置通过 `sing-box check`、隔离握手与原子切换。
4. macOS/Windows 签名桌面候选实际包含经 SHA 与 ML-DSA-65 验证的 sing-box core。
5. Profile 端到端探测确认 `requestedRoute=effectiveRoute=athena_egress`，失败时无 DNS 或直连泄漏。
6. Google Search 与 YouTube 匿名访问通过；Google 登录只由用户在 Managed Chrome 中人工验收。

当前 DNS 和 TCP 8443 尚未具备，因此生产保持 fail-closed 是正确状态，不能宣称海外出口已经可用。
