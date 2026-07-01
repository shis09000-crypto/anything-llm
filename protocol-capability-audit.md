# Protocol Capability Audit：现代 VPN Gateway 协议能力审计

- 生成时间：2026-06-29T15:38:12+08:00
- 审计对象：`athenallm.online` / `43.133.177.153`
- 审计边界：只读检测；未安装 VPN；未启动长期服务；未修改系统配置。
- 原始证据目录：`/tmp/protocol-audit-raw.ROt3dn`

## 执行摘要

- 系统为 Ubuntu 24.04 / Linux 6.8，现代内核能力充足；OpenSSL 3.0.13 30 Jan 2024 (Library: OpenSSL 3.0.13 30 Jan 2024)，TLS 1.2/1.3 基础能力满足现代部署。
- BBR/FQ 当前状态：未完全满足；SO_REUSEPORT：支持；TUN/TAP：可用；WireGuard 内核模块：可用。
- HTTP/2：可用；HTTP/3/QUIC：系统具备 UDP/Caddy 基础，服务器侧已监听 UDP `*:443`，但当前 curl 不支持 `--http3`，未完成客户端级 HTTP/3 验证。
- IPv6：内核启用但未形成公网 IPv6 默认路由，当前只有 link-local IPv6；如果目标是 2026-2030 长期网关，建议补齐公网 IPv6。
- 指纹风险结论：服务器系统能力适合部署现代 VPN，但“伪装浏览器 TLS 指纹”主要取决于 VPN 软件的 TLS/uTLS/REALITY 实现，而不是 Linux 内核本身。Go/Caddy 默认 TLS 指纹不能天然等同 Chrome/Safari/Firefox/Edge。

## 第一部分：基础能力

| 能力 | 状态 | 证据摘要 | 对 VPN 部署的意义 |
|---|---:|---|---|
| Linux 内核 | ✅ | Linux 6.8.0-124-generic / Ubuntu 24.04.4 LTS | 6.8 LTS 级别，满足现代 VPN、eBPF、nftables、WireGuard 基础。 |
| OpenSSL | ✅ | OpenSSL 3.0.13 30 Jan 2024 (Library: OpenSSL 3.0.13 30 Jan 2024) | OpenSSL 3.x 能满足 TLS 1.2/1.3；ECH 仍不是主流稳定服务端路径。 |
| LibreSSL/BoringSSL | ⚠️ | 未发现 libressl/bssl/boringssl 可执行或动态库 | 一般不需要全局安装；Chrome 指纹常由应用内 uTLS/BoringSSL 风格实现。 |
| QUIC 支持 | ⚠️ | 检测到 UDP `*:443` 监听；curl 不支持 `--http3`，未完成 HTTP/3 客户端验证 | Caddy/Go 可作为 QUIC 基础；需确认公网 UDP 443 与客户端 HTTP/3。 |
| UDP 性能 | ✅ | 公共 DNS UDP 查询成功；eth0 MTU 8500，Docker bridge MTU 1500；无内核层阻断证据 | 未做 iperf 压测，生产前应补充 UDP PPS/丢包测试。 |
| TCP Fast Open | ✅ | net.ipv4.tcp_fastopen = 1 | 客户端/服务端是否使用还取决于应用。 |
| BBR/FQ | ⚠️ | 当前 `tcp_congestion_control=cubic`，available=`reno cubic`，`default_qdisc=fq_codel`；未启用 BBR/FQ | 建议生产网关使用 bbr + fq；当前若不是 bbr/fq，可作为后续调优项。 |
| SO_REUSEPORT | ✅ | SO_REUSEPORT tcp bind: supported | 适合多进程 UDP/TCP 负载分摊。 |
| nftables | ✅ | 可用 | 建议长期维护优先 nftables。 |
| iptables | ✅ | 可用 | 兼容层仍可用，但新规则建议 nft。 |
| eBPF | ✅ | sysfs/config 显示基础能力 | 适合未来观测、限速、流量分类。 |
| XDP | ✅ | 内核/链路显示相关能力 | 需要网卡驱动与程序配合；当前只做能力判断。 |
| TUN/TAP | ✅ | /dev/net/tun 可用 | VPN 必备能力之一。 |
| WireGuard 内核支持 | ✅ | modinfo/模块可见 | Ubuntu 24.04 通常支持；未加载不等于不可用。 |
| IPv6 | ⚠️ | 内核 IPv6 开启，但只有 link-local 路由，无公网 IPv6 默认路由 | 长期网关建议启用 IPv6，但纯 IPv4 VPN 可运行。 |
| MTU | ✅ | eth0 MTU 8500，Docker bridge/veth MTU 1500；ICMP DF 1472/1200 测试通过 | QUIC/WireGuard/Reality 需要预留封装开销，建议生产 MTU 1280-1420 分场景调优。 |
| Docker | ✅ | 可用 | 适合隔离部署，但高性能 UDP 网关可考虑 host network。 |
| systemd | ✅ | 可用 | 适合长期维护、日志、自动恢复。 |

## 第二部分：TLS 能力分析

### TLS 1.2 / TLS 1.3

- TLS 1.2：通过 `openssl s_client -tls1_2` 对当前域名端点完成握手，适合作为兼容层。
- TLS 1.3：通过 `openssl s_client -tls1_3` 对当前域名端点完成握手，满足现代 TLS 基础。
- Cipher Suites：OpenSSL 3.x 提供 TLS_AES_128_GCM_SHA256、TLS_AES_256_GCM_SHA384、CHACHA20_POLY1305 等现代套件；Caddy/Go TLS 会按自身策略选择安全套件。
- ALPN：当前端点可协商 `h2/http/1.1`；HTTP/3 需要 QUIC 客户端进一步验证。
- SNI：当前域名证书路径依赖 SNI，符合真实 HTTPS 站点行为。
- Session Resumption / TLS Ticket：OpenSSL 复用测试已采集，具体是否复用取决于 Caddy ticket 策略与 TLS 1.3 ticket 下发。
- OCSP Stapling：`s_client -status` 已检测；若输出无 OCSP Response，说明当前端点可能未装订。
- Early Data / 0-RTT：当前没有证据显示端点启用 0-RTT。对 VPN 来说，不启用通常更安全，启用会带来重放风险。

### 浏览器 TLS 指纹模拟评估

| 目标指纹 | 服务器当前能力 | 结论 |
|---|---|---|
| Chrome | Linux/Caddy 本身不能让任意 VPN 流量自动变成 Chrome ClientHello；需 VPN 客户端/代理实现 uTLS Chrome 指纹。 | ⚠️ 可实现，但依赖 Xray/sing-box/naive 等应用层。 |
| Safari | Safari TLS/HTTP2 参数与 Apple 栈相关，纯 Go TLS 不等同。 | ⚠️ 可模拟一部分，完整模拟难度高。 |
| Firefox | Firefox ClientHello/扩展顺序/ALPN 有特征。 | ⚠️ 需 uTLS fingerprint 支持。 |
| Edge | 接近 Chromium，但仍受版本、平台、扩展顺序影响。 | ⚠️ 可通过 Chrome 类指纹近似。 |

JA3/JA4 风险：JA3 主要固定 ClientHello 的版本、Cipher、Extensions、Curves、Point Formats；JA4 进一步关注协议族、SNI/ALPN、扩展结构、时序与连接行为。若使用普通 Go TLS 或固定代理客户端，指纹容易稳定且可聚类。要降低固定性，需要应用层支持多浏览器 uTLS、版本轮换、合理 ALPN、HTTP/2 SETTINGS、连接生命周期和包长行为。

## 第三部分：HTTP 协议能力

- HTTP/1.1：当前端点支持，基础兼容良好。
- HTTP/2：当前端点支持 h2/ALPN；HPACK、stream multiplexing、header ordering 等由 Caddy/Go 实现。
- HTTP/3/QUIC：系统具备 UDP 与 Caddy 基础；当前是否对外稳定支持 HTTP/3 需依赖 UDP 443 放通、Alt-Svc、客户端 curl/ngtcp2 支持。
- Header Compression：HTTP/2 使用 HPACK；HTTP/3 使用 QPACK。伪装真实浏览器时，HTTP/2 SETTINGS、pseudo-header 顺序、priority 行为比“是否支持 h2”更关键。
- Connection Coalescing：Caddy 支持标准 TLS/HTTP 多域名能力，但是否接近浏览器行为取决于证书 SAN、DNS、ALPN 与客户端实现。

现代浏览器伪装评价：作为普通 HTTPS 站点，当前 Caddy 表现健康；作为 VPN 伪装层，必须让客户端侧 HTTP/TLS 行为接近浏览器，否则仅服务器支持 h2/h3 不足以抵抗指纹聚类。

## 第四部分：QUIC 能力

- UDP：公共 DNS UDP 成功，系统无明显 UDP 出站限制。
- UDP 443 监听：已检测到 `*:443` UDP 监听；但当前 `curl` 不支持 `--http3`，因此未完成 HTTP/3 客户端验证。
- UDP Fragment / MTU：网卡 MTU 多为 1500，但 VPN/QUIC 封装应主动控制包长，避免依赖 IP 分片。建议 QUIC UDP payload 保守控制在 1200-1350 区间，并针对移动网络降低 MTU。
- UDP Rate Limit / QoS：未发现系统级限速规则；但云厂商公网带宽和清洗策略可能限制长期高 PPS UDP。生产前应做 iperf3 双向 UDP、丢包和 jitter 测试。
- 长期运行 QUIC：适合，但建议监控 UDP 丢包、conntrack、Caddy/应用日志、带宽上限和突发限速。

## 第五部分：Reality / XTLS 能力

- Reality：系统层面可部署，关键依赖 Xray/sing-box 版本、目标站点选择、uTLS 指纹、时间同步和证书链伪装策略。当前 Linux 6.8、systemd、Docker/TUN 能力满足。
- Vision / XTLS / TLS Vision：系统层面没有明显限制。注意 XTLS 类技术与具体客户端生态强绑定，且被动识别重点会从 TLS 转向流量时序、包长、连接生命周期。
- 不建议把 Reality 当作“万能隐身”。它提高主动探测抗性，但长期稳定性取决于目标站点、SNI/ALPN、客户端指纹和真实业务流量相似度。

## 第六部分：ECH 能力

- 当前结论：不建议认为这台服务器已经具备可生产的 ECH Gateway 能力。ECH 需要 DNS HTTPS/SVCB 记录发布 ECHConfig、支持 ECH 的 TLS 终端、客户端浏览器支持，以及证书/域名体系配合。
- OpenSSL：当前 OpenSSL 3.x 适合 TLS 1.3，但主流发行版 OpenSSL 对服务端 ECH 仍不是开箱即用的稳定路线。
- Caddy/Nginx：常规稳定版本对 ECH 的生产支持仍有限，通常需要实验分支、特定 TLS 库或 CDN 代管。
- Kernel：ECH 不依赖内核升级，主要是应用层 TLS 与 DNS。
- Cloudflare/CDN：如果未来要快速获得 ECH，最现实路径是使用支持 ECH 的 CDN/TLS 终端，并正确发布 HTTPS RR。
- DNS：需要支持 HTTPS/SVCB 记录和 ECHConfig 管理。
- 浏览器：Chrome/Firefox/Safari 的 ECH 支持受版本、DNS over HTTPS/系统 DNS、地区策略影响。
- 未来升级路径：先保持标准 TLS 1.3 + h2/h3；关注 Caddy/Nginx 主线 ECH 支持；DNS 切到支持 HTTPS/SVCB 的权威服务；最后再灰度 ECH，不建议现在把 ECH 作为核心生产能力。

## 第七部分：流量伪装能力

| 方案 | 成熟度 | 当前服务器适配度 | 备注 |
|---|---|---:|---|
| HTTPS Traffic Mimic | 成熟 | 高 | 用真实 HTTPS 站点承载外观；关键是客户端 TLS/HTTP 指纹。 |
| HTTP/2 Mimic | 成熟 | 高 | h2 可用；需匹配浏览器 SETTINGS、header ordering、流控行为。 |
| HTTP/3 / QUIC Mimic | 成熟但运维要求高 | 中高 | 需要确认 UDP 443、Alt-Svc、客户端 h3 能力和带宽质量。 |
| WebSocket over TLS | 成熟 | 高 | 兼容性好，但长期固定 WS 流模式容易被行为识别。 |
| gRPC over HTTP/2 | 成熟 | 中高 | 企业流量常见，但长连接与消息节奏要处理。 |
| Reality | 成熟/主流 | 高 | 适合抗主动探测；依赖实现和目标站点策略。 |
| CDN Fronting | 条件可行 | 中 | 很多 CDN 限制代理/VPN，需遵守服务条款。 |
| Domain Fronting | 基本淘汰 | 低 | 主流云/CDN 大多封堵或不支持，不建议作为核心方案。 |

## 第八部分：反识别能力

- JA3/JA4：最容易固定的是客户端 TLS 指纹。若客户端库固定、版本少、扩展顺序异常，很容易被聚类。
- SNI：未使用 ECH 时 SNI 明文可见。Reality 可以改变主动探测面，但不等于隐藏所有元数据。
- ALPN：浏览器常见 h2/http/1.1/h3 组合有版本特征；异常 ALPN 或只支持冷门协议会暴露。
- Timing Fingerprint：VPN 流量的连续长连接、固定心跳、上下行节奏与普通网页不同，是长期识别重点。
- Packet Size：固定包长、固定 burst、长期满速下载会暴露；需要拥塞控制、padding、分块策略和应用层节奏控制。
- Flow Pattern：真实浏览器通常多连接、多域名、短 burst；VPN 通常单/少数长连接。伪装重点应从“握手像浏览器”扩展到“会话生命周期像真实业务”。
- Connection Lifetime / Idle Timeout：过长连接、稳定 idle ping 容易被识别。建议应用层支持合理重连、空闲策略和随机化。

可模拟真实浏览器的部分：TLS ClientHello、ALPN、HTTP/2 SETTINGS、header 顺序、部分时序。难以完全模拟的部分：用户行为驱动的多域名资源加载、缓存命中、JS/CDN 资源瀑布、复杂连接生命周期。

## 第九部分：综合评分

| 维度 | 分数 | 解释 |
|---|---:|---|
| Modern TLS Readiness | 81 | OpenSSL/Caddy/TLS 1.3 基础好，但 ECH/浏览器级指纹不由系统默认提供。 |
| HTTP/3 Readiness | 72 | 具备基础，但需要确认公网 UDP 443、客户端 h3 工具与长期 UDP 质量。 |
| QUIC Readiness | 62 | UDP 与内核基础可用，生产前需 PPS/丢包/MTU 压测。 |
| Reality Readiness | 82 | 系统层面适合，主要风险在实现选择与指纹策略。 |
| ECH Future Readiness | 28 | 当前不适合直接生产 ECH，未来要靠 TLS 终端/CDN/DNS 升级。 |
| Traffic Camouflage Potential | 70 | HTTPS/h2/h3/WS/gRPC/Reality 都可选，但需要应用层策略。 |
| Anti-DPI Potential | 74 | 现代协议可部署，但长期抗 DPI 取决于行为层模拟。 |
| Anti-Fingerprint Potential | 55 | 默认 Go/Caddy 指纹不够，需 uTLS/REALITY 等专门实现。 |
| Long-term Maintainability | 86 | Ubuntu LTS + systemd + Docker + Caddy，维护基础好。 |

## 最终建议

### 1. 适合部署的现代 VPN 技术

- WireGuard：适合自用、高性能、低维护，但隐蔽性一般，容易被协议特征识别。
- VLESS + Reality + Vision/XTLS：适合强调抗主动探测和现代 TLS 伪装的场景。
- Hysteria2 / TUIC：适合 QUIC/UDP 高延迟网络优化，但需要确认云带宽和 UDP 稳定性。
- Trojan/WS/gRPC over TLS：成熟、易维护，适合作为兼容方案。

### 2. 推荐优先级

1. `VLESS Reality Vision` 或 `sing-box Reality`：作为主力抗识别入口。
2. `WireGuard`：作为管理/备用隧道，不作为高隐蔽主入口。
3. `gRPC over TLS` 或 `WebSocket over TLS`：作为兼容备用入口。
4. `Hysteria2/TUIC`：在确认 UDP 质量后作为高速/移动网络入口。

### 3. 建议暂缓

- ECH 自建生产：生态仍不够稳，建议等 Caddy/Nginx/CDN/DNS 支持成熟。
- Domain Fronting：主流云/CDN 已基本限制，不适合作为长期方案。
- 单纯 WebSocket 长连接伪装：可用但行为特征明显，不宜单独承担高抗识别目标。

### 4. 未来需要升级的能力

- 启用 IPv6 公网能力，并同步安全组/防火墙策略。
- 对 UDP 443 做长期质量测试：丢包、jitter、PPS、峰值带宽。
- 引入支持 uTLS/浏览器指纹轮换的代理实现。
- 若追求 ECH，升级路径应包括支持 HTTPS/SVCB 的 DNS、支持 ECH 的 TLS 终端或 CDN。
- 建立观测：连接数、UDP 丢包、重传、RTT、会话时长分布、包长分布。

### 5. 2026-2030 推荐技术栈

- 基础系统：Ubuntu LTS + Linux 6.8/更新 LTS kernel + nftables + systemd。
- 主入口：sing-box 或 Xray，使用 Reality/Vision，启用多浏览器 uTLS 指纹策略。
- 兼容入口：gRPC over TLS/h2，前置 Caddy/Nginx 作为真实站点。
- 高速入口：Hysteria2/TUIC over QUIC，仅在 UDP 质量验证后启用。
- 备用管理：WireGuard，仅限管理面或私有访问。
- 未来增强：CDN/ECH/HTTP3 根据生态成熟度灰度，不作为当前唯一核心。

## 关键原始证据

### Kernel / OS
```text
$ uname -a; cat /etc/os-release
---
Linux VM-0-2-ubuntu 6.8.0-124-generic #124-Ubuntu SMP PREEMPT_DYNAMIC Tue May 26 13:00:45 UTC 2026 x86_64 x86_64 x86_64 GNU/Linux
PRETTY_NAME="Ubuntu 24.04.4 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.4 LTS (Noble Numbat)"
VERSION_CODENAME=noble
ID=ubuntu
ID_LIKE=debian
HOME_URL="https://www.ubuntu.com/"
SUPPORT_URL="https://help.ubuntu.com/"
BUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"
PRIVACY_POLICY_URL="https://www.ubuntu.com/legal/terms-and-policies/privacy-policy"
UBUNTU_CODENAME=noble
LOGO=ubuntu-logo
--- exit=0
```

### OpenSSL
```text
$ openssl version -a; echo; openssl ciphers -v 'TLSv1.2:TLSv1.3' | head -80
---
OpenSSL 3.0.13 30 Jan 2024 (Library: OpenSSL 3.0.13 30 Jan 2024)
built on: Tue Apr  7 12:05:56 2026 UTC
platform: debian-amd64
options:  bn(64,64)
compiler: gcc -fPIC -pthread -m64 -Wa,--noexecstack -Wall -fzero-call-used-regs=used-gpr -DOPENSSL_TLS_SECURITY_LEVEL=2 -Wa,--noexecstack -g -O2 -fno-omit-frame-pointer -mno-omit-leaf-frame-pointer -ffile-prefix-map=/build/openssl-a6Kur2/openssl-3.0.13=. -fstack-protector-strong -fstack-clash-protection -Wformat -Werror=format-security -fcf-protection -fdebug-prefix-map=/build/openssl-a6Kur2/openssl-3.0.13=/usr/src/openssl-3.0.13-0ubuntu3.9 -DOPENSSL_USE_NODELETE -DL_ENDIAN -DOPENSSL_PIC -DOPENSSL_BUILDING_OPENSSL -DNDEBUG -Wdate-time -D_FORTIFY_SOURCE=3
OPENSSLDIR: "/usr/lib/ssl"
ENGINESDIR: "/usr/lib/x86_64-linux-gnu/engines-3"
MODULESDIR: "/usr/lib/x86_64-linux-gnu/ossl-modules"
Seeding source: os-specific
CPUINFO: OPENSSL_ia32cap=0xfffa3203078bffff:0x405e46f1bf07ab

TLS_AES_256_GCM_SHA384         TLSv1.3 Kx=any      Au=any   Enc=AESGCM(256)            Mac=AEAD
TLS_CHACHA20_POLY1305_SHA256   TLSv1.3 Kx=any      Au=any   Enc=CHACHA20/POLY1305(256) Mac=AEAD
TLS_AES_128_GCM_SHA256         TLSv1.3 Kx=any      Au=any   Enc=AESGCM(128)            Mac=AEAD
ECDHE-ECDSA-AES256-GCM-SHA384  TLSv1.2 Kx=ECDH     Au=ECDSA Enc=AESGCM(256)            Mac=AEAD
ECDHE-RSA-AES256-GCM-SHA384    TLSv1.2 Kx=ECDH     Au=RSA   Enc=AESGCM(256)            Mac=AEAD
DHE-DSS-AES256-GCM-SHA384      TLSv1.2 Kx=DH       Au=DSS   Enc=AESGCM(256)            Mac=AEAD
DHE-RSA-AES256-GCM-SHA384      TLSv1.2 Kx=DH       Au=RSA   Enc=AESGCM(256)            Mac=AEAD
ECDHE-ECDSA-CHACHA20-POLY1305  TLSv1.2 Kx=ECDH     Au=ECDSA Enc=CHACHA20/POLY1305(256) Mac=AEAD
ECDHE-RSA-CHACHA20-POLY1305    TLSv1.2 Kx=ECDH     Au=RSA   Enc=CHACHA20/POLY1305(256) Mac=AEAD
DHE-RSA-CHACHA20-POLY1305      TLSv1.2 Kx=DH       Au=RSA   Enc=CHACHA20/POLY1305(256) Mac=AEAD
ECDHE-ECDSA-AES256-CCM8        TLSv1.2 Kx=ECDH     Au=ECDSA Enc=AESCCM8(256)           Mac=AEAD
ECDHE-ECDSA-AES256-CCM         TLSv1.2 Kx=ECDH     Au=ECDSA Enc=AESCCM(256)            Mac=AEAD
DHE-RSA-AES256-CCM8            TLSv1.2 Kx=DH       Au=RSA   Enc=AESCCM8(256)           Mac=AEAD
DHE-RSA-AES256-CCM             TLSv1.2 Kx=DH       Au=RSA   Enc=AESCCM(256)            Mac=AEAD
ECDHE-ECDSA-ARIA256-GCM-SHA384 TLSv1.2 Kx=ECDH     Au=ECDSA Enc=ARIAGCM(256)           Mac=AEAD
ECDHE-ARIA256-GCM-SHA384       TLSv1.2 Kx=ECDH     Au=RSA   Enc=ARIAGCM(256)           Mac=AEAD
DHE-DSS-ARIA256-GCM-SHA384     TLSv1.2 Kx=DH       Au=DSS   Enc=ARIAGCM(256)           Mac=AEAD
DHE-RSA-ARIA256-GCM-SHA384     TLSv1.2 Kx=DH       Au=RSA   Enc=ARIAGCM(256)           Mac=AEAD
ADH-AES256-GCM-SHA384          TLSv1.2 Kx=DH       Au=None  Enc=AESGCM(256)            Mac=AEAD
ECDHE-ECDSA-AES128-GCM-SHA256  TLSv1.2 Kx=ECDH     Au=ECDSA Enc=AESGCM(128)            Mac=AEAD
ECDHE-RSA-AES128-GCM-SHA256    TLSv1.2 Kx=ECDH     Au=RSA   Enc=AESGCM(128)            Mac=AEAD
DHE-DSS-AES128-GCM-SHA256      TLSv1.2 Kx=DH       Au=DSS   Enc=AESGCM(128)            Mac=AEAD
DHE-RSA-AES128-GCM-SHA256      TLSv1.2 Kx=DH       Au=RSA   Enc=AESGCM(128)            Mac=AEAD
ECDHE-ECDSA-AES128-CCM8        TLSv1.2 Kx=ECDH     Au=ECDSA Enc=AESCCM8(128)           Mac=AEAD
ECDHE-ECDSA-AES128-CCM         TLSv1.2 Kx=ECDH     Au=ECDSA Enc=AESCCM(128)            Mac=AEAD
DHE-RSA-AES128-CCM8            TLSv1.2 Kx=DH       Au=RSA   Enc=AESCCM8(128)           Mac=AEAD
DHE-RSA-AES128-CCM             TLSv1.2 Kx=DH       Au=RSA   Enc=AESCCM(128)            Mac=AEAD
ECDHE-ECDSA-ARIA128-GCM-SHA256 TLSv1.2 Kx=ECDH     Au=ECDSA Enc=ARIAGCM(128)           Mac=AEAD
ECDHE-ARIA128-GCM-SHA256       TLSv1.2 Kx=ECDH     Au=RSA   Enc=ARIAGCM(128)           Mac=AEAD
DHE-DSS-ARIA128-GCM-SHA256     TLSv1.2 Kx=DH       Au=DSS   Enc=ARIAGCM(128)           Mac=AEAD
DHE-RSA-ARIA128-GCM-SHA256     TLSv1.2 Kx=DH       Au=RSA   Enc=ARIAGCM(128)           Mac=AEAD
ADH-AES128-GCM-SHA256          TLSv1.2 Kx=DH       Au=None  Enc=AESGCM(128)            Mac=AEAD
ECDHE-ECDSA-AES256-SHA384      TLSv1.2 Kx=ECDH     Au=ECDSA Enc=AES(256)               Mac=SHA384
ECDHE-RSA-AES256-SHA384        TLSv1.2 Kx=ECDH     Au=RSA   Enc=AES(256)               Mac=SHA384
DHE-RSA-AES256-SHA256          TLSv1.2 Kx=DH       Au=RSA   Enc=AES(256)               Mac=SHA256
DHE-DSS-AES256-SHA256          TLSv1.2 Kx=DH       Au=DSS   Enc=AES(256)               Mac=SHA256
ECDHE-ECDSA-CAMELLIA256-SHA384 TLSv1.2 Kx=ECDH     Au=ECDSA Enc=Camellia(256)          Mac=SHA384
ECDHE-RSA-CAMELLIA256-SHA384   TLSv1.2 Kx=ECDH     Au=RSA   Enc=Camellia(256)          Mac=SHA384
DHE-RSA-CAMELLIA256-SHA256     TLSv1.2 Kx=DH       Au=RSA   Enc=Camellia(256)          Mac=SHA256
DHE-DSS-CAMELLIA256-SHA256     TLSv1.2 Kx=DH       Au=DSS   Enc=Camellia(256)          Mac=SHA256
ADH-AES256-SHA256              TLSv1.2 Kx=DH       Au=None  Enc=AES(256)               Mac=SHA256
ADH-CAMELLIA256-SHA256         TLSv1.2 Kx=DH       Au=None  Enc=Camellia(256)          Mac=SHA256
ECDHE-ECDSA-AES128-SHA256      TLSv1.2 Kx=ECDH     Au=ECDSA Enc=AES(128)               Mac=SHA256
ECDHE-RSA-AES128-SHA256        TLSv1.2 Kx=ECDH     Au=RSA   Enc=AES(128)               Mac=SHA256
DHE-RSA-AES128-SHA256          TLSv1.2 Kx=DH       Au=RSA   Enc=AES(128)               Mac=SHA256
DHE-DSS-AES128-SHA256          TLSv1.2 Kx=DH       Au=DSS   Enc=AES(128)               Mac=SHA256
ECDHE-ECDSA-CAMELLIA128-SHA256 TLSv1.2 Kx=ECDH     Au=ECDSA Enc=Camellia(128)          Mac=SHA256
ECDHE-RSA-CAMELLIA128-SHA256   TLSv1.2 Kx=ECDH     Au=RSA   Enc=Camellia(128)          Mac=SHA256
DHE-RSA-CAMELLIA128-SHA256     TLSv1.2 Kx=DH       Au=RSA   Enc=Camellia(128)          Mac=SHA256
DHE-DSS-CAMELLIA128-SHA256     TLSv1.2 Kx=DH       Au=DSS   Enc=Camellia(128)          Mac=SHA256
ADH-AES128-SHA256              TLSv1.2 Kx=DH       Au=None  Enc=AES(128)               Mac=SHA256
ADH-CAMELLIA128-SHA256         TLSv1.2 Kx=DH       Au=None  Enc=Camellia(128)          Mac=SHA256
RSA-PSK-AES256-GCM-SHA384      TLSv1.2 Kx=RSAPSK   Au=RSA   Enc=AESGCM(256)            Mac=AEAD
DHE-PSK-AES256-GCM-SHA384      TLSv1.2 Kx=DHEPSK   Au=PSK   Enc=AESGCM(256)            Mac=AEAD
RSA-PSK-CHACHA20-POLY1305      TLSv1.2 Kx=RSAPSK   Au=RSA   Enc=CHACHA20/POLY1305(256) Mac=AEAD
DHE-PSK-CHACHA20-POLY1305      TLSv1.2 Kx=DHEPSK   Au=PSK   Enc=CHACHA20/POLY1305(256) Mac=AEAD
ECDHE-PSK-CHACHA20-POLY1305    TLSv1.2 Kx=ECDHEPSK Au=PSK   Enc=CHACHA20/POLY1305(256) Mac=AEAD
DHE-PSK-AES256-CCM8            TLSv1.2 Kx=DHEPSK   Au=PSK   Enc=AESCCM8(256)           Mac=AEAD
DHE-PSK-AES256-CCM             TLSv1.2 Kx=DHEPSK   Au=PSK   Enc=AESCCM(256)            Mac=AEAD
RSA-PSK-ARIA256-GCM-SHA384     TLSv1.2 Kx=RSAPSK   Au=RSA   Enc=ARIAGCM(256)           Mac=AEAD
DHE-PSK-ARIA256-GCM-SHA384     TLSv1.2 Kx=DHEPSK   Au=PSK   Enc=ARIAGCM(256)           Mac=AEAD
AES256-GCM-SHA384              TLSv1.2 Kx=RSA      Au=RSA   Enc=AESGCM(256)            Mac=AEAD
AES256-CCM8                    TLSv1.2 Kx=RSA      Au=RSA   Enc=AESCCM8(256)           Mac=AEAD
AES256-CCM                     TLSv1.2 Kx=RSA      Au=RSA   Enc=AESCCM(256)            Mac=AEAD
ARIA256-GCM-SHA384             TLSv1.2 Kx=RSA      Au=RSA   Enc=ARIAGCM(256)           Mac=AEAD
PSK-AES256-GCM-SHA384          TLSv1.2 Kx=PSK      Au=PSK   Enc=AESGCM(256)            Mac=AEAD
PSK-CHACHA20-POLY1305          TLSv1.2 Kx=PSK      Au=PSK   Enc=CHACHA20/POLY1305(256) Mac=AEAD
PSK-AES256-CCM8                TLSv1.2 Kx=PSK      Au=PSK   Enc=AESCCM8(256)           Mac=AEAD
PSK-AES256-CCM                 TLSv1.2 Kx=PSK      Au=PSK   Enc=AESCCM(256)            Mac=AEAD
PSK-ARIA256-GCM-SHA384         TLSv1.2 Kx=PSK      Au=PSK   Enc=ARIAGCM(256)           Mac=AEAD
RSA-PSK-AES128-GCM-SHA256      TLSv1.2 Kx=RSAPSK   Au=RSA   Enc=AESGCM(128)            Mac=AEAD
DHE-PSK-AES128-GCM-SHA256      TLSv1.2 Kx=DHEPSK   Au=PSK   Enc=AESGCM(128)            Mac=AEAD
DHE-PSK-AES128-CCM8            TLSv1.2 Kx=DHEPSK   Au=PSK   Enc=AESCCM8(128)           Mac=AEAD
DHE-PSK-AES128-CCM             TLSv1.2 Kx=DHEPSK   Au=PSK   Enc=AESCCM(128)            Mac=AEAD
RSA-PSK-ARIA128-GCM-SHA256     TLSv1.2 Kx=RSAPSK   Au=RSA   Enc=ARIAGCM(128)           Mac=AEAD
DHE-PSK-ARIA128-GCM-SHA256     TLSv1.2 Kx=DHEPSK   Au=PSK   Enc=ARIAGCM(128)           Mac=AEAD
AES128-GCM-SHA256              TLSv1.2 Kx=RSA      Au=RSA   Enc=AESGCM(128)            Mac=AEAD
AES128-CCM8                    TLSv1.2 Kx=RSA      Au=RSA   Enc=AESCCM8(128)           Mac=AEAD
AES128-CCM                     TLSv1.2 Kx=RSA      Au=RSA   Enc=AESCCM(128)            Mac=AEAD
ARIA128-GCM-SHA256             TLSv1.2 Kx=RSA      Au=RSA   Enc=ARIAGCM(128)           Mac=AEAD
--- exit=0
```

### TCP/UDP sysctl
```text
$ sysctl net.ipv4.tcp_fastopen net.ipv4.tcp_congestion_control net.ipv4.tcp_available_congestion_control net.ipv4.tcp_available_ulp net.core.default_qdisc net.core.rmem_max net.core.wmem_max net.ipv4.udp_mem net.ipv4.udp_rmem_min net.ipv4.udp_wmem_min net.ipv6.conf.all.disable_ipv6 net.ipv6.conf.default.disable_ipv6 2>&1
---
net.ipv4.tcp_fastopen = 1
net.ipv4.tcp_congestion_control = cubic
net.ipv4.tcp_available_congestion_control = reno cubic
net.ipv4.tcp_available_ulp = espintcp mptcp tls
net.core.default_qdisc = fq_codel
net.core.rmem_max = 212992
net.core.wmem_max = 212992
net.ipv4.udp_mem = 83505	111340	167010
net.ipv4.udp_rmem_min = 4096
net.ipv4.udp_wmem_min = 4096
net.ipv6.conf.all.disable_ipv6 = 0
net.ipv6.conf.default.disable_ipv6 = 0
--- exit=0
```

### TUN / WireGuard
```text
$ ls -l /dev/net/tun 2>/dev/null || true; lsmod | grep -E '(^tun|wireguard)' || true; modinfo tun 2>/dev/null | head -20 || true; modinfo wireguard 2>/dev/null | head -40 || true; grep -E 'CONFIG_(TUN|WIREGUARD)=' /boot/config-6.8.0-124-generic 2>/dev/null || true
---
crw-rw-rw- 1 root root 10, 200 Jun 28 14:54 /dev/net/tun
name:           tun
filename:       (builtin)
alias:          devname:net/tun
alias:          char-major-10-200
license:        GPL
file:           drivers/net/tun
author:         (C) 1999-2004 Max Krasnyansky <maxk@qualcomm.com>
description:    Universal TUN/TAP device driver
filename:       /lib/modules/6.8.0-124-generic/kernel/drivers/net/wireguard/wireguard.ko.zst
alias:          net-pf-16-proto-16-family-wireguard
alias:          rtnl-link-wireguard
version:        1.0.0
author:         Jason A. Donenfeld <Jason@zx2c4.com>
description:    WireGuard secure network tunnel
license:        GPL v2
srcversion:     F313F304285174386DD1A27
depends:        libcurve25519-generic,udp_tunnel,ip6_udp_tunnel,libchacha20poly1305,curve25519-x86_64
retpoline:      Y
intree:         Y
name:           wireguard
vermagic:       6.8.0-124-generic SMP preempt mod_unload modversions
sig_id:         PKCS#7
signer:         Build time autogenerated kernel key
sig_key:        52:C8:5D:A1:6E:10:83:FF:2A:CF:96:CB:FE:D8:62:D5:AF:46:85:0E
sig_hashalgo:   sha512
signature:      02:2F:EB:B1:46:C4:77:6E:E3:14:43:F1:A1:6E:7F:5F:2C:05:F5:02:
		4D:84:13:B6:8A:86:E3:6D:D6:46:86:6D:B5:9A:C4:55:11:D9:86:D4:
		69:15:EE:15:4F:6C:22:A0:51:CD:28:06:39:E7:66:61:63:A0:88:AE:
		57:D3:C6:AF:03:F9:F6:CA:95:16:BB:6C:96:C2:4F:46:63:03:F2:7E:
		01:A0:F0:87:14:68:DD:87:5D:E0:3D:EE:E7:00:40:3E:69:D4:4F:0F:
		52:B5:09:22:49:AD:38:DD:3E:33:70:DE:09:51:0F:66:9C:F8:63:34:
		76:12:7A:AD:38:9F:07:33:87:CF:42:8E:62:3A:ED:D3:8A:96:1A:6F:
		DB:E3:A3:D5:7F:9A:5C:DD:1E:FD:92:11:C6:B9:BE:40:87:90:32:AB:
		44:0E:B2:79:79:19:F8:AE:F9:4B:BE:3B:75:72:82:A9:47:52:13:96:
		4E:3F:8F:96:80:9F:E4:A8:D2:A5:C9:0A:06:DF:B1:25:03:E4:7C:3E:
		DA:BC:3E:1E:F5:94:BE:98:6B:3B:7D:2A:AA:A2:68:B8:39:F7:2B:09:
		3D:34:64:5B:15:DD:C8:43:8A:53:E9:89:45:2B:29:14:0F:D8:09:AE:
		6B:11:14:76:EA:7F:8A:04:FB:88:CF:3F:15:B2:BF:19:C9:B5:70:5D:
		89:6B:87:68:57:04:5D:EE:9F:A3:F0:C3:31:B1:32:CC:75:3E:22:9F:
		DB:C8:0F:F1:CF:3B:B5:29:0C:DA:F5:FF:A8:7F:5C:54:AE:B9:CB:E6:
		43:EF:98:43:0D:A3:07:D1:23:00:E0:65:52:06:DF:C0:38:79:3F:44:
		1F:D4:DB:8E:21:47:01:47:5C:13:9A:06:E1:45:EF:F3:0E:37:53:F1:
		B8:69:B4:FE:AB:5A:B1:4E:75:32:07:4B:F7:B5:9B:A0:9D:11:D6:A0:
		8E:6A:DC:75:D9:F7:59:AC:36:0F:6D:DF:1C:12:FF:E8:64:C0:0D:57:
		2A:6C:E6:86:8B:7A:90:E4:6A:7A:CE:40:DC:D2:28:E9:43:7A:A4:79:
		B9:B6:85:D0:52:16:A8:74:AD:5F:E6:5B:0A:5F:2F:DC:EC:B8:88:45:
		53:C8:0F:CD:55:37:6C:CC:F4:B4:71:63:5D:0E:C4:B7:2F:D3:77:C1:
		FD:7B:5C:88:7F:88:92:0C:B0:1A:8D:2E:3D:70:FA:FB:0A:82:CF:D5:
CONFIG_WIREGUARD=m
CONFIG_TUN=y
--- exit=0
```

### HTTP versions
```text
$ echo HTTP11; curl -I --http1.1 -sS -o /dev/null -w 'code=%{http_code} version=%{http_version} connect=%{time_connect} tls=%{time_appconnect} total=%{time_total} ip=%{remote_ip}\n' https://athenallm.online/; echo HTTP2; curl -I --http2 -sS -o /dev/null -w 'code=%{http_code} version=%{http_version} connect=%{time_connect} tls=%{time_appconnect} total=%{time_total} ip=%{remote_ip}\n' https://athenallm.online/ 2>&1; echo HTTP3; curl -I --http3 -sS -o /dev/null -w 'code=%{http_code} version=%{http_version} connect=%{time_connect} tls=%{time_appconnect} total=%{time_total} ip=%{remote_ip}\n' https://athenallm.online/ 2>&1 || true
---
HTTP11
code=200 version=1.1 connect=0.000999 tls=0.022413 total=0.027152 ip=43.133.177.153
HTTP2
code=200 version=2 connect=0.001003 tls=0.022327 total=0.025517 ip=43.133.177.153
HTTP3
curl: option --http3: the installed libcurl version doesn't support this
curl: try 'curl --help' or 'curl --manual' for more information
--- exit=0
```

### TLS 1.3
```text
$ echo | openssl s_client -connect athenallm.online:443 -servername athenallm.online -tls1_3 -alpn 'h2,http/1.1' -status 2>&1 | sed -n '1,140p'
---
depth=3 C = US, O = Internet Security Research Group, CN = ISRG Root X2
verify return:1
depth=2 C = US, O = ISRG, CN = Root YE
verify return:1
depth=1 C = US, O = Let's Encrypt, CN = YE2
verify return:1
depth=0 CN = athenallm.online
verify return:1
CONNECTED(00000003)
OCSP response: no response sent
---
Certificate chain
 0 s:CN = athenallm.online
   i:C = US, O = Let's Encrypt, CN = YE2
   a:PKEY: id-ecPublicKey, 256 (bit); sigalg: ecdsa-with-SHA384
   v:NotBefore: Jun 28 11:04:59 2026 GMT; NotAfter: Sep 26 11:04:58 2026 GMT
 1 s:C = US, O = Let's Encrypt, CN = YE2
   i:C = US, O = ISRG, CN = Root YE
   a:PKEY: id-ecPublicKey, 384 (bit); sigalg: ecdsa-with-SHA384
   v:NotBefore: Sep  3 00:00:00 2025 GMT; NotAfter: Sep  2 23:59:59 2028 GMT
 2 s:C = US, O = ISRG, CN = Root YE
   i:C = US, O = Internet Security Research Group, CN = ISRG Root X2
   a:PKEY: id-ecPublicKey, 384 (bit); sigalg: ecdsa-with-SHA384
   v:NotBefore: May 13 00:00:00 2026 GMT; NotAfter: Sep  2 23:59:59 2032 GMT
 3 s:C = US, O = Internet Security Research Group, CN = ISRG Root X2
   i:C = US, O = Internet Security Research Group, CN = ISRG Root X1
   a:PKEY: id-ecPublicKey, 384 (bit); sigalg: RSA-SHA256
   v:NotBefore: May 13 00:00:00 2026 GMT; NotAfter: Sep  2 23:59:59 2032 GMT
---
Server certificate
-----BEGIN CERTIFICATE-----
MIIDjTCCAxOgAwIBAgISBVA5BlZYKS37Sc5jPmOARr0hMAoGCCqGSM49BAMDMDMx
CzAJBgNVBAYTAlVTMRYwFAYDVQQKEw1MZXQncyBFbmNyeXB0MQwwCgYDVQQDEwNZ
RTIwHhcNMjYwNjI4MTEwNDU5WhcNMjYwOTI2MTEwNDU4WjAbMRkwFwYDVQQDExBh
dGhlbmFsbG0ub25saW5lMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEpSJm8HI0
HVE7cgOrGPy9dpx1p5d56gAZTS9vxomDCHIr2bais0e85OGG3GRQ1RpS6CDY1YRg
hoLO0J8+hMaxQqOCAh0wggIZMA4GA1UdDwEB/wQEAwIHgDATBgNVHSUEDDAKBggr
BgEFBQcDATAMBgNVHRMBAf8EAjAAMB0GA1UdDgQWBBQQh1SC96uph6M8P9XYGdbJ
Pk9CCzAfBgNVHSMEGDAWgBS5WfKOzyLwhtM3SP92FBi6gthVhzAzBggrBgEFBQcB
AQQnMCUwIwYIKwYBBQUHMAKGF2h0dHA6Ly95ZTIuaS5sZW5jci5vcmcvMBsGA1Ud
EQQUMBKCEGF0aGVuYWxsbS5vbmxpbmUwEwYDVR0gBAwwCjAIBgZngQwBAgEwLgYD
VR0fBCcwJTAjoCGgH4YdaHR0cDovL3llMi5jLmxlbmNyLm9yZy8zNC5jcmwwggEL
BgorBgEEAdZ5AgQCBIH8BIH5APcAdgDIo8R/x7OtuTVrAT9qehJt4zpOQ6XGRvmX
rTl1mR3PmgAAAZ8OHQDuAAAEAwBHMEUCIQCd1y52S19QUZroY0fshSViheU/95SA
p3TAGiiU67DMAAIgXpikn59RUKw7/gUtdIhNoFZYZSbT4wRYNZqCU9+S4u8AfQCo
JsvjCsY1EkZTP+Bl8U8Z2W4ZCBPEHdlteQCzEjxVJwAAAZ8OHQF1AAgAAAUAEWhV
4QQDAEYwRAIgaKveiY1i1AJLX2NwYd1dtQndNj2yOLZxON9Mpr00gtgCIA+Rbobd
Mq3ZlHiFXPVvcqP6kQEAjqNfl/e9g5rBIAqZMAoGCCqGSM49BAMDA2gAMGUCMQCj
d0Flpsrb6jY3rlF9g8vHweAavUhFD6+2G0PC4fJ8uSvMhH8sn46xvpBNOVTWXCEC
MFwK0ttGDEyFdipKMtbaiYSEiyhAI3+vn1NgUQEKaETQaG75EDhSFZnxEXOpkqF9
vw==
-----END CERTIFICATE-----
subject=CN = athenallm.online
issuer=C = US, O = Let's Encrypt, CN = YE2
---
No client certificate CA names sent
Peer signing digest: SHA256
Peer signature type: ECDSA
Server Temp Key: X25519, 253 bits
---
SSL handshake has read 3774 bytes and written 341 bytes
Verification: OK
---
New, TLSv1.3, Cipher is TLS_AES_128_GCM_SHA256
Server public key is 256 bit
Secure Renegotiation IS NOT supported
Compression: NONE
Expansion: NONE
ALPN protocol: h2
Early data was not sent
Verify return code: 0 (ok)
---
DONE
---
Post-Handshake New Session Ticket arrived:
SSL-Session:
    Protocol  : TLSv1.3
    Cipher    : TLS_AES_128_GCM_SHA256
    Session-ID: AA16A4F2CFDB3DF2F0F977E28A0423CE2EBAC5F2374D0321C9B8A38706E917AC
    Session-ID-ctx:
    Resumption PSK: FE45EC49479F47F609CCCF995DC9789661918FA4D7D32185A34A61A49EF5F05C
    PSK identity: None
    PSK identity hint: None
    SRP username: None
    TLS session ticket lifetime hint: 604800 (seconds)
    TLS session ticket:
    0000 - 25 5f cb 45 83 b0 6d c6-0b bc f3 ae 29 b2 0b 92   %_.E..m.....)...
    0010 - 96 74 6e bb c2 b1 e5 be-9e 9a 92 7d c5 c3 ba 59   .tn........}...Y
    0020 - 56 1b 3f 50 89 26 e2 d1-5c 6d b0 50 c1 1a 56 f0   V.?P.&..\m.P..V.
    0030 - 0e de 47 28 6b 28 2a dd-18 39 fe 61 c3 45 07 cb   ..G(k(*..9.a.E..
    0040 - 01 55 94 4a 31 67 22 e0-42 70 f6 f6 a7 f3 d3 91   .U.J1g".Bp......
    0050 - 87 76 af 2f 0c d1 56 59-57 a8 fe cd fa e8 8d fc   .v./..VYW.......
    0060 - 62 e2 d4 34 df 3a 0b 60-4a                        b..4.:.`J

    Start Time: 1782718692
    Timeout   : 7200 (sec)
    Verify return code: 0 (ok)
    Extended master secret: no
```

### QUIC/UDP sockets
```text
$ ss -lunp | grep -E ':443|:80' || true; ss -ltnp | grep -E ':443|:80|:3001' || true; command -v quiche-client || true; command -v h2load || true; command -v nghttp || true; command -v tcpdump || true
---
UNCONN 0      0                  *:443             *:*
LISTEN 0      4096       127.0.0.1:3001      0.0.0.0:*
LISTEN 0      4096               *:80              *:*
LISTEN 0      4096               *:443             *:*
/usr/bin/tcpdump
--- exit=0
```

### IPv6 / MTU
```text
$ ip -brief addr; ip route show; ip -6 route show; ip -o link show; for dev in /sys/class/net/*; do d=$(basename "$dev"); printf '%s mtu=' "$d"; cat "$dev/mtu" 2>/dev/null || true; done; ping -M do -s 1472 -c 2 -W 2 1.1.1.1 || true; ping -M do -s 1200 -c 2 -W 2 1.1.1.1 || true
---
lo               UNKNOWN        127.0.0.1/8 ::1/128
eth0             UP             10.7.0.2/22 metric 100 fe80::5054:ff:fe2e:e971/64
docker0          DOWN           172.17.0.1/16 fe80::9033:35ff:febe:d8e9/64
br-a3f6756bc94f  UP             172.18.0.1/16 fe80::7024:95ff:fed1:ad46/64
veth62cb68b@if2  UP             fe80::cc81:57ff:fe20:1311/64
default via 10.7.0.1 dev eth0 proto dhcp src 10.7.0.2 metric 100
10.7.0.0/22 dev eth0 proto kernel scope link src 10.7.0.2 metric 100
10.7.0.1 dev eth0 proto dhcp scope link src 10.7.0.2 metric 100
172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1 linkdown
172.18.0.0/16 dev br-a3f6756bc94f proto kernel scope link src 172.18.0.1
183.60.82.98 via 10.7.0.1 dev eth0 proto dhcp src 10.7.0.2 metric 100
183.60.83.19 via 10.7.0.1 dev eth0 proto dhcp src 10.7.0.2 metric 100
fe80::/64 dev eth0 proto kernel metric 256 pref medium
fe80::/64 dev docker0 proto kernel metric 256 linkdown pref medium
fe80::/64 dev br-a3f6756bc94f proto kernel metric 256 pref medium
fe80::/64 dev veth62cb68b proto kernel metric 256 pref medium
1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 8500 qdisc mq state UP mode DEFAULT group default qlen 1000\    link/ether 52:54:00:2e:e9:71 brd ff:ff:ff:ff:ff:ff\    altname enp0s5\    altname ens5
3: docker0: <NO-CARRIER,BROADCAST,MULTICAST,UP> mtu 1500 qdisc noqueue state DOWN mode DEFAULT group default \    link/ether 92:33:35:be:d8:e9 brd ff:ff:ff:ff:ff:ff
28: br-a3f6756bc94f: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT group default \    link/ether 72:24:95:d1:ad:46 brd ff:ff:ff:ff:ff:ff
199: veth62cb68b@if2: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue master br-a3f6756bc94f state UP mode DEFAULT group default \    link/ether ce:81:57:20:13:11 brd ff:ff:ff:ff:ff:ff link-netnsid 0
br-a3f6756bc94f mtu=1500
docker0 mtu=1500
eth0 mtu=8500
lo mtu=65536
veth62cb68b mtu=1500
PING 1.1.1.1 (1.1.1.1) 1472(1500) bytes of data.
1480 bytes from 1.1.1.1: icmp_seq=1 ttl=58 time=2.26 ms
1480 bytes from 1.1.1.1: icmp_seq=2 ttl=58 time=2.25 ms

--- 1.1.1.1 ping statistics ---
2 packets transmitted, 2 received, 0% packet loss, time 1001ms
rtt min/avg/max/mdev = 2.247/2.254/2.262/0.007 ms
PING 1.1.1.1 (1.1.1.1) 1200(1228) bytes of data.
1208 bytes from 1.1.1.1: icmp_seq=1 ttl=58 time=2.32 ms
1208 bytes from 1.1.1.1: icmp_seq=2 ttl=58 time=2.27 ms

--- 1.1.1.1 ping statistics ---
2 packets transmitted, 2 received, 0% packet loss, time 1002ms
rtt min/avg/max/mdev = 2.265/2.294/2.324/0.029 ms
--- exit=0
```

### Docker / systemd
```text
$ docker version 2>&1 || true; docker info --format '{{json .}}' 2>/dev/null || true; systemctl --version; systemctl is-system-running 2>&1 || true
---
Client: Docker Engine - Community
 Version:           29.6.1
 API version:       1.55
 Go version:        go1.26.4
 Git commit:        8900f1d
 Built:             Fri Jun 26 11:40:19 2026
 OS/Arch:           linux/amd64
 Context:           default

Server: Docker Engine - Community
 Engine:
  Version:          29.6.1
  API version:      1.55 (minimum version 1.40)
  Go version:       go1.26.4
  Git commit:       8ec5ab3
  Built:            Fri Jun 26 11:40:19 2026
  OS/Arch:          linux/amd64
  Experimental:     false
 containerd:
  Version:          v2.2.5
  GitCommit:        e53c7c1516c3b2bff98eb76f1f4117477e6f4e66
 runc:
  Version:          1.3.6
  GitCommit:        v1.3.6-0-g491b69ba
 docker-init:
  Version:          0.19.0
  GitCommit:        de40ad0
{"ID":"c9333904-301b-4b54-adab-74c83d7c0569","Containers":1,"ContainersRunning":1,"ContainersPaused":0,"ContainersStopped":0,"Images":2,"Driver":"overlayfs","DriverStatus":[["driver-type","io.containerd.snapshotter.v1"]],"Plugins":{"Volume":["local"],"Network":["bridge","host","ipvlan","macvlan","null","overlay"],"Authorization":null,"Log":["awslogs","fluentd","gcplogs","gelf","journald","json-file","local","splunk","syslog"]},"MemoryLimit":true,"SwapLimit":true,"CpuCfsPeriod":true,"CpuCfsQuota":true,"CPUShares":true,"CPUSet":true,"PidsLimit":true,"IPv4Forwarding":true,"Debug":false,"NFd":35,"OomKillDisable":false,"NGoroutines":63,"SystemTime":"2026-06-29T15:38:12.001200309+08:00","LoggingDriver":"json-file","CgroupDriver":"systemd","CgroupVersion":"2","NEventsListener":0,"KernelVersion":"6.8.0-124-generic","OperatingSystem":"Ubuntu 24.04.4 LTS","OSVersion":"24.04","OSType":"linux","Architecture":"x86_64","IndexServerAddress":"https://index.docker.io/v1/","RegistryConfig":{"InsecureRegistryCIDRs":["::1/128","127.0.0.0/8"],"IndexConfigs":{"docker.io":{"Name":"docker.io","Mirrors":[],"Secure":true,"Official":true}},"Mirrors":[]},"NCPU":2,"MemTotal":3837677568,"GenericResources":null,"DockerRootDir":"/var/lib/docker","HttpProxy":"","HttpsProxy":"","NoProxy":"","Name":"VM-0-2-ubuntu","Labels":[],"ExperimentalBuild":false,"ServerVersion":"29.6.1","Runtimes":{"io.containerd.runc.v2":{"path":"runc","status":{"org.opencontainers.runtime-spec.features":"{\"ociVersionMin\":\"1.0.0\",\"ociVersionMax\":\"1.2.1\",\"hooks\":[\"prestart\",\"createRuntime\",\"createContainer\",\"startContainer\",\"poststart\",\"poststop\"],\"mountOptions\":[\"async\",\"atime\",\"bind\",\"defaults\",\"dev\",\"diratime\",\"dirsync\",\"exec\",\"iversion\",\"lazytime\",\"loud\",\"mand\",\"noatime\",\"nodev\",\"nodiratime\",\"noexec\",\"noiversion\",\"nolazytime\",\"nomand\",\"norelatime\",\"nostrictatime\",\"nosuid\",\"nosymfollow\",\"private\",\"ratime\",\"rbind\",\"rdev\",\"rdiratime\",\"relatime\",\"remount\",\"rexec\",\"rnoatime\",\"rnodev\",\"rnodiratime\",\"rnoexec\",\"rnorelatime\",\"rnostrictatime\",\"rnosuid\",\"rnosymfollow\",\"ro\",\"rprivate\",\"rrelatime\",\"rro\",\"rrw\",\"rshared\",\"rslave\",\"rstrictatime\",\"rsuid\",\"rsymfollow\",\"runbindable\",\"rw\",\"shared\",\"silent\",\"slave\",\"strictatime\",\"suid\",\"symfollow\",\"sync\",\"tmpcopyup\",\"unbindable\"],\"linux\":{\"namespaces\":[\"cgroup\",\"ipc\",\"mount\",\"network\",\"pid\",\"time\",\"user\",\"uts\"],\"capabilities\":[\"CAP_CHOWN\",\"CAP_DAC_OVERRIDE\",\"CAP_DAC_READ_SEARCH\",\"CAP_FOWNER\",\"CAP_FSETID\",\"CAP_KILL\",\"CAP_SETGID\",\"CAP_SETUID\",\"CAP_SETPCAP\",\"CAP_LINUX_IMMUTABLE\",\"CAP_NET_BIND_SERVICE\",\"CAP_NET_BROADCAST\",\"CAP_NET_ADMIN\",\"CAP_NET_RAW\",\"CAP_IPC_LOCK\",\"CAP_IPC_OWNER\",\"CAP_SYS_MODULE\",\"CAP_SYS_RAWIO\",\"CAP_SYS_CHROOT\",\"CAP_SYS_PTRACE\",\"CAP_SYS_PACCT\",\"CAP_SYS_ADMIN\",\"CAP_SYS_BOOT\",\"CAP_SYS_NICE\",\"CAP_SYS_RESOURCE\",\"CAP_SYS_TIME\",\"CAP_SYS_TTY_CONFIG\",\"CAP_MKNOD\",\"CAP_LEASE\",\"CAP_AUDIT_WRITE\",\"CAP_AUDIT_CONTROL\",\"CAP_SETFCAP\",\"CAP_MAC_OVERRIDE\",\"CAP_MAC_ADMIN\",\"CAP_SYSLOG\",\"CAP_WAKE_ALARM\",\"CAP_BLOCK_SUSPEND\",\"CAP_AUDIT_READ\",\"CAP_PERFMON\",\"CAP_BPF\",\"CAP_CHECKPOINT_RESTORE\"],\"cgroup\":{\"v1\":true,\"v2\":true,\"systemd\":true,\"systemdUser\":true,\"rdma\":true},\"seccomp\":{\"enabled\":true,\"actions\":[\"SCMP_ACT_ALLOW\",\"SCMP_ACT_ERRNO\",\"SCMP_ACT_KILL\",\"SCMP_ACT_KILL_PROCESS\",\"SCMP_ACT_KILL_THREAD\",\"SCMP_ACT_LOG\",\"SCMP_ACT_NOTIFY\",\"SCMP_ACT_TRACE\",\"SCMP_ACT_TRAP\"],\"operators\":[\"SCMP_CMP_EQ\",\"SCMP_CMP_GE\",\"SCMP_CMP_GT\",\"SCMP_CMP_LE\",\"SCMP_CMP_LT\",\"SCMP_CMP_MASKED_EQ\",\"SCMP_CMP_NE\"],\"archs\":[\"SCMP_ARCH_AARCH64\",\"SCMP_ARCH_ARM\",\"SCMP_ARCH_MIPS\",\"SCMP_ARCH_MIPS64\",\"SCMP_ARCH_MIPS64N32\",\"SCMP_ARCH_MIPSEL\",\"SCMP_ARCH_MIPSEL64\",\"SCMP_ARCH_MIPSEL64N32\",\"SCMP_ARCH_PPC\",\"SCMP_ARCH_PPC64\",\"SCMP_ARCH_PPC64LE\",\"SCMP_ARCH_RISCV64\",\"SCMP_ARCH_S390\",\"SCMP_ARCH_S390X\",\"SCMP_ARCH_X32\",\"SCMP_ARCH_X86\",\"SCMP_ARCH_X86_64\"],\"knownFlags\":[\"SECCOMP_FILTER_FLAG_TSYNC\",\"SECCOMP_FILTER_FLAG_SPEC_ALLOW\",\"SECCOMP_FILTER_FLAG_LOG\"],\"supportedFlags\":[\"SECCOMP_FILTER_FLAG_TSYNC\",\"SECCOMP_FILTER_FLAG_SPEC_ALLOW\",\"SECCOMP_FILTER_FLAG_LOG\"]},\"apparmor\":{\"enabled\":true},\"selinux\":{\"enabled\":true},\"intelRdt\":{\"enabled\":true},\"mountExtensions\":{\"idmap\":{\"enabled\":true}}},\"annotations\":{\"io.github.seccomp.libseccomp.version\":\"2.5.5\",\"org.opencontainers.runc.checkpoint.enabled\":\"true\",\"org.opencontainers.runc.commit\":\"v1.3.6-0-g491b69ba\",\"org.opencontainers.runc.version\":\"1.3.6\\n\"},\"potentiallyUnsafeConfigAnnotations\":[\"bundle\",\"org.systemd.property.\",\"org.criu.config\"]}"}},"runc":{"path":"runc","status":{"org.opencontainers.runtime-spec.features":"{\"ociVersionMin\":\"1.0.0\",\"ociVersionMax\":\"1.2.1\",\"hooks\":[\"prestart\",\"createRuntime\",\"createContainer\",\"startContainer\",\"poststart\",\"poststop\"],\"mountOptions\":[\"async\",\"atime\",\"bind\",\"defaults\",\"dev\",\"diratime\",\"dirsync\",\"exec\",\"iversion\",\"lazytime\",\"loud\",\"mand\",\"noatime\",\"nodev\",\"nodiratime\",\"noexec\",\"noiversion\",\"nolazytime\",\"nomand\",\"norelatime\",\"nostrictatime\",\"nosuid\",\"nosymfollow\",\"private\",\"ratime\",\"rbind\",\"rdev\",\"rdiratime\",\"relatime\",\"remount\",\"rexec\",\"rnoatime\",\"rnodev\",\"rnodiratime\",\"rnoexec\",\"rnorelatime\",\"rnostrictatime\",\"rnosuid\",\"rnosymfollow\",\"ro\",\"rprivate\",\"rrelatime\",\"rro\",\"rrw\",\"rshared\",\"rslave\",\"rstrictatime\",\"rsuid\",\"rsymfollow\",\"runbindable\",\"rw\",\"shared\",\"silent\",\"slave\",\"strictatime\",\"suid\",\"symfollow\",\"sync\",\"tmpcopyup\",\"unbindable\"],\"linux\":{\"namespaces\":[\"cgroup\",\"ipc\",\"mount\",\"network\",\"pid\",\"time\",\"user\",\"uts\"],\"capabilities\":[\"CAP_CHOWN\",\"CAP_DAC_OVERRIDE\",\"CAP_DAC_READ_SEARCH\",\"CAP_FOWNER\",\"CAP_FSETID\",\"CAP_KILL\",\"CAP_SETGID\",\"CAP_SETUID\",\"CAP_SETPCAP\",\"CAP_LINUX_IMMUTABLE\",\"CAP_NET_BIND_SERVICE\",\"CAP_NET_BROADCAST\",\"CAP_NET_ADMIN\",\"CAP_NET_RAW\",\"CAP_IPC_LOCK\",\"CAP_IPC_OWNER\",\"CAP_SYS_MODULE\",\"CAP_SYS_RAWIO\",\"CAP_SYS_CHROOT\",\"CAP_SYS_PTRACE\",\"CAP_SYS_PACCT\",\"CAP_SYS_ADMIN\",\"CAP_SYS_BOOT\",\"CAP_SYS_NICE\",\"CAP_SYS_RESOURCE\",\"CAP_SYS_TIME\",\"CAP_SYS_TTY_CONFIG\",\"CAP_MKNOD\",\"CAP_LEASE\",\"CAP_AUDIT_WRITE\",\"CAP_AUDIT_CONTROL\",\"CAP_SETFCAP\",\"CAP_MAC_OVERRIDE\",\"CAP_MAC_ADMIN\",\"CAP_SYSLOG\",\"CAP_WAKE_ALARM\",\"CAP_BLOCK_SUSPEND\",\"CAP_AUDIT_READ\",\"CAP_PERFMON\",\"CAP_BPF\",\"CAP_CHECKPOINT_RESTORE\"],\"cgroup\":{\"v1\":true,\"v2\":true,\"systemd\":true,\"systemdUser\":true,\"rdma\":true},\"seccomp\":{\"enabled\":true,\"actions\":[\"SCMP_ACT_ALLOW\",\"SCMP_ACT_ERRNO\",\"SCMP_ACT_KILL\",\"SCMP_ACT_KILL_PROCESS\",\"SCMP_ACT_KILL_THREAD\",\"SCMP_ACT_LOG\",\"SCMP_ACT_NOTIFY\",\"SCMP_ACT_TRACE\",\"SCMP_ACT_TRAP\"],\"operators\":[\"SCMP_CMP_EQ\",\"SCMP_CMP_GE\",\"SCMP_CMP_GT\",\"SCMP_CMP_LE\",\"SCMP_CMP_LT\",\"SCMP_CMP_MASKED_EQ\",\"SCMP_CMP_NE\"],\"archs\":[\"SCMP_ARCH_AARCH64\",\"SCMP_ARCH_ARM\",\"SCMP_ARCH_MIPS\",\"SCMP_ARCH_MIPS64\",\"SCMP_ARCH_MIPS64N32\",\"SCMP_ARCH_MIPSEL\",\"SCMP_ARCH_MIPSEL64\",\"SCMP_ARCH_MIPSEL64N32\",\"SCMP_ARCH_PPC\",\"SCMP_ARCH_PPC64\",\"SCMP_ARCH_PPC64LE\",\"SCMP_ARCH_RISCV64\",\"SCMP_ARCH_S390\",\"SCMP_ARCH_S390X\",\"SCMP_ARCH_X32\",\"SCMP_ARCH_X86\",\"SCMP_ARCH_X86_64\"],\"knownFlags\":[\"SECCOMP_FILTER_FLAG_TSYNC\",\"SECCOMP_FILTER_FLAG_SPEC_ALLOW\",\"SECCOMP_FILTER_FLAG_LOG\"],\"supportedFlags\":[\"SECCOMP_FILTER_FLAG_TSYNC\",\"SECCOMP_FILTER_FLAG_SPEC_ALLOW\",\"SECCOMP_FILTER_FLAG_LOG\"]},\"apparmor\":{\"enabled\":true},\"selinux\":{\"enabled\":true},\"intelRdt\":{\"enabled\":true},\"mountExtensions\":{\"idmap\":{\"enabled\":true}}},\"annotations\":{\"io.github.seccomp.libseccomp.version\":\"2.5.5\",\"org.opencontainers.runc.checkpoint.enabled\":\"true\",\"org.opencontainers.runc.commit\":\"v1.3.6-0-g491b69ba\",\"org.opencontainers.runc.version\":\"1.3.6\\n\"},\"potentiallyUnsafeConfigAnnotations\":[\"bundle\",\"org.systemd.property.\",\"org.criu.config\"]}"}}},"DefaultRuntime":"runc","Swarm":{"NodeID":"","NodeAddr":"","LocalNodeState":"inactive","ControlAvailable":false,"Error":"","RemoteManagers":null},"LiveRestoreEnabled":false,"Isolation":"","InitBinary":"docker-init","ContainerdCommit":{"ID":"e53c7c1516c3b2bff98eb76f1f4117477e6f4e66"},"RuncCommit":{"ID":"v1.3.6-0-g491b69ba"},"InitCommit":{"ID":"de40ad0"},"SecurityOptions":["name=apparmor","name=seccomp,profile=builtin","name=cgroupns"],"FirewallBackend":{"Driver":"iptables","Info":[["EnableUserlandProxy","true"],["UserlandProxyPath","/usr/bin/docker-proxy"]]},"CDISpecDirs":["/etc/cdi","/var/run/cdi"],"Containerd":{"Address":"/run/containerd/containerd.sock","Namespaces":{"Containers":"moby","Plugins":"plugins.moby"}},"Warnings":null,"ClientInfo":{"Debug":false,"Platform":{"Name":"Docker Engine - Community"},"Version":"29.6.1","DefaultAPIVersion":"1.55","GitCommit":"8900f1d","GoVersion":"go1.26.4","Os":"linux","Arch":"amd64","BuildTime":"Fri Jun 26 11:40:19 2026","Context":"default","Plugins":[{"SchemaVersion":"0.1.0","Vendor":"Docker Inc.","Version":"v0.35.0","ShortDescription":"Docker Buildx","Name":"buildx","Path":"/usr/libexec/docker/cli-plugins/docker-buildx"},{"SchemaVersion":"0.1.0","Vendor":"Docker Inc.","Version":"v5.2.0","ShortDescription":"Docker Compose","Name":"compose","Path":"/usr/libexec/docker/cli-plugins/docker-compose"}],"Warnings":null}}
systemd 255 (255.4-1ubuntu8.15)
+PAM +AUDIT +SELINUX +APPARMOR +IMA +SMACK +SECCOMP +GCRYPT -GNUTLS +OPENSSL +ACL +BLKID +CURL +ELFUTILS +FIDO2 +IDN2 -IDN +IPTC +KMOD +LIBCRYPTSETUP +LIBFDISK +PCRE2 -PWQUALITY +P11KIT +QRENCODE +TPM2 +BZIP2 +LZ4 +XZ +ZLIB +ZSTD -BPF_FRAMEWORK -XKBCOMMON +UTMP +SYSVINIT default-hierarchy=unified
running
--- exit=0
```
