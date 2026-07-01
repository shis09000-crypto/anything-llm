# Linux 服务器外网连接能力测试报告

- 生成时间：2026-06-29T13:59:37+08:00
- 主机名：VM-0-2-ubuntu
- 系统：Ubuntu 24.04.4 LTS
- 内核：Linux VM-0-2-ubuntu 6.8.0-124-generic #124-Ubuntu SMP PREEMPT_DYNAMIC Tue May 26 13:00:45 UTC 2026 x86_64 x86_64 x86_64 GNU/Linux
- 报告路径：/home/deploy/network-report.md

## 关键结论

- 服务器公网出口为 `43.133.177.153`，地区 `Tokyo, JP`，ASN `AS132203 Tencent Building, Kejizhongyi Avenue`。
- IPv4 外网能力正常：公共 DNS、Ping、HTTP/HTTPS、GitHub clone、Docker Hub、npm、PyPI、apt 均通过。
- IPv6 未形成公网出口：系统只有 link-local IPv6 路由，没有 IPv6 默认路由；如果业务不需要 IPv6，可以忽略。
- OpenAI 返回 HTTP 401、Anthropic 返回 HTTP 404，说明 TLS/HTTPS 可达；这是未认证或根路径状态，不是网络阻断。
- speedtest-cli 成功，但测速结果较低：Download `1.06 Mbit/s`，Upload `1.32 Mbit/s`，这会影响大模型依赖下载、Docker 镜像拉取和大文件同步体验。
- Traceroute 对 GitHub/OpenAI 部分 hop 星号，属于中间路由过滤 ICMP/UDP 的常见现象；目标站点实际 HTTP 与 ping 均可用。

## 总览

| 测试项 | 状态 | 结果摘要 |
|---|---:|---|
| 公网 IP / 地区 / ASN | ✅ 成功 | 已从 ipinfo/ifconfig 获取 |
| IPv4 连通性 | ✅ 成功 | IPv4 出口正常 |
| IPv6 连通性 | ❌ 失败 | curl -6 失败，常见原因是实例未分配 IPv6 或无 IPv6 默认路由 |
| DNS 解析 @8.8.8.8 | ✅ 成功 | github.com/openai.com A 记录可解析 |
| DNS 解析 @1.1.1.1 | ✅ 成功 | github.com/openai.com A 记录可解析 |
| DNS 解析 @208.67.222.222 | ✅ 成功 | github.com/openai.com A 记录可解析 |
| DNS 综合 | ✅ 成功 | 3/3 个公共 DNS 可用 |
| Ping: 1.1.1.1 | ✅ 成功 | avg=2.232 ms |
| Ping: 8.8.8.8 | ✅ 成功 | avg=2.676 ms |
| Ping: github.com | ✅ 成功 | avg=3.528 ms |
| Ping: openai.com | ✅ 成功 | avg=1.443 ms |
| Traceroute: github.com | ⚠️ 部分成功 | 链路有响应，但部分 hop 过滤 ICMP/UDP |
| Traceroute: openai.com | ⚠️ 部分成功 | 链路有响应，但部分 hop 过滤 ICMP/UDP |
| HTTP/HTTPS: GitHub | ✅ 成功 | HTTP 200 |
| HTTP/HTTPS: Google | ✅ 成功 | HTTP 200 |
| HTTP/HTTPS: OpenAI | ⚠️ 部分成功 | HTTP 401，可连通但返回客户端/权限类状态 |
| HTTP/HTTPS: Anthropic | ⚠️ 部分成功 | HTTP 404，可连通但返回客户端/权限类状态 |
| HTTP/HTTPS: HuggingFace | ✅ 成功 | HTTP 200 |
| HTTP/HTTPS: DockerHubRegistry | ✅ 成功 | HTTP 401，Docker Registry 未认证挑战正常，连通性正常 |
| HTTP/HTTPS: npm | ✅ 成功 | HTTP 200 |
| HTTP/HTTPS: PyPI | ✅ 成功 | HTTP 200 |
| git clone | ✅ 成功 | GitHub HTTPS clone 成功 |
| Docker Hub 拉取 hello-world | ✅ 成功 | docker pull 成功 |
| npm 官方源 | ✅ 成功 | npm ping 成功 |
| pip / PyPI 官方源 | ✅ 成功 | pip index 成功 |
| apt 软件源 | ✅ 成功 | apt-get update 成功 |
| 下载/上传速度测试 | ✅ 成功 | speedtest-cli 成功 |

## 1. 公网 IP、地区、ASN
```text
$ curl -4 -sS https://ipinfo.io/json || curl -4 -sS https://ifconfig.co/json
---
{
  "ip": "43.133.177.153",
  "city": "Tokyo",
  "region": "Tokyo",
  "country": "JP",
  "loc": "35.6895,139.6917",
  "org": "AS132203 Tencent Building, Kejizhongyi Avenue",
  "postal": "101-8656",
  "timezone": "Asia/Tokyo",
  "readme": "https://ipinfo.io/missingauth"
}--- exit=0
```

## 2. IPv4 / IPv6 连通性
### IPv4
```text
$ curl -4 -sS --connect-timeout 8 https://api.ipify.org && echo
---
43.133.177.153
--- exit=0
```
### IPv6
```text
$ curl -6 -sS --connect-timeout 8 https://api64.ipify.org && echo
---
curl: (7) Failed to connect to api64.ipify.org port 443 after 0 ms: Couldn't connect to server
--- exit=7
```

## 3. DNS 解析
### @8.8.8.8
```text
$ dig @8.8.8.8 github.com A +time=3 +tries=1 +short; dig @8.8.8.8 openai.com A +time=3 +tries=1 +short
---
20.27.177.113
104.18.33.45
172.64.154.211
--- exit=0
```
### @1.1.1.1
```text
$ dig @1.1.1.1 github.com A +time=3 +tries=1 +short; dig @1.1.1.1 openai.com A +time=3 +tries=1 +short
---
20.27.177.113
172.64.154.211
104.18.33.45
--- exit=0
```
### @208.67.222.222
```text
$ dig @208.67.222.222 github.com A +time=3 +tries=1 +short; dig @208.67.222.222 openai.com A +time=3 +tries=1 +short
---
20.27.177.113
104.18.33.45
172.64.154.211
--- exit=0
```

## 4. Ping
### 1.1.1.1
```text
$ ping -c 4 -W 3 1.1.1.1
---
PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.
64 bytes from 1.1.1.1: icmp_seq=1 ttl=58 time=2.24 ms
64 bytes from 1.1.1.1: icmp_seq=2 ttl=58 time=2.24 ms
64 bytes from 1.1.1.1: icmp_seq=3 ttl=58 time=2.22 ms
64 bytes from 1.1.1.1: icmp_seq=4 ttl=58 time=2.23 ms

--- 1.1.1.1 ping statistics ---
4 packets transmitted, 4 received, 0% packet loss, time 3004ms
rtt min/avg/max/mdev = 2.219/2.232/2.244/0.010 ms
--- exit=0
```
### 8.8.8.8
```text
$ ping -c 4 -W 3 8.8.8.8
---
PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.
64 bytes from 8.8.8.8: icmp_seq=1 ttl=119 time=2.69 ms
64 bytes from 8.8.8.8: icmp_seq=2 ttl=119 time=2.69 ms
64 bytes from 8.8.8.8: icmp_seq=3 ttl=119 time=2.67 ms
64 bytes from 8.8.8.8: icmp_seq=4 ttl=119 time=2.65 ms

--- 8.8.8.8 ping statistics ---
4 packets transmitted, 4 received, 0% packet loss, time 3006ms
rtt min/avg/max/mdev = 2.653/2.676/2.690/0.014 ms
--- exit=0
```
### github.com
```text
$ ping -c 4 -W 3 github.com
---
PING github.com (20.27.177.113) 56(84) bytes of data.
64 bytes from 20.27.177.113: icmp_seq=1 ttl=117 time=3.57 ms
64 bytes from 20.27.177.113: icmp_seq=2 ttl=117 time=3.53 ms
64 bytes from 20.27.177.113: icmp_seq=3 ttl=117 time=3.54 ms
64 bytes from 20.27.177.113: icmp_seq=4 ttl=117 time=3.47 ms

--- github.com ping statistics ---
4 packets transmitted, 4 received, 0% packet loss, time 3004ms
rtt min/avg/max/mdev = 3.474/3.528/3.568/0.034 ms
--- exit=0
```
### openai.com
```text
$ ping -c 4 -W 3 openai.com
---
PING openai.com (172.64.154.211) 56(84) bytes of data.
64 bytes from 172.64.154.211: icmp_seq=1 ttl=58 time=1.43 ms
64 bytes from 172.64.154.211: icmp_seq=2 ttl=58 time=1.47 ms
64 bytes from 172.64.154.211: icmp_seq=3 ttl=58 time=1.40 ms
64 bytes from 172.64.154.211: icmp_seq=4 ttl=58 time=1.47 ms

--- openai.com ping statistics ---
4 packets transmitted, 4 received, 0% packet loss, time 3004ms
rtt min/avg/max/mdev = 1.397/1.443/1.473/0.031 ms
--- exit=0
```

## 5. Traceroute
### github.com
```text
$ traceroute -n -w 3 -q 1 -m 20 github.com
---
traceroute to github.com (20.27.177.113), 20 hops max, 60 byte packets
 1  *
 2  29.4.49.40  6.007 ms
 3  *
 4  30.245.26.177  1.321 ms
 5  *
 6  104.44.235.98  1.813 ms
 7  *
 8  *
 9  *
10  *
11  *
12  *
13  *
14  *
15  *
16  *
17  *
18  *
19  *
20  *
--- exit=0
```
### openai.com
```text
$ traceroute -n -w 3 -q 1 -m 20 openai.com
---
traceroute to openai.com (172.64.154.211), 20 hops max, 60 byte packets
 1  *
 2  *
 3  *
 4  *
 5  101.203.90.97  2.795 ms
 6  103.22.201.87  3.247 ms
 7  172.64.154.211  2.851 ms
--- exit=0
```

## 6. HTTP/HTTPS 连通性
### Anthropic
```text
$ curl -L -sS -o /dev/null -w ... https://api.anthropic.com/
http_code=404
time_connect=0.004082
time_appconnect=0.023629
time_total=0.029588
remote_ip=160.79.104.10
curl_exit=0
```
### DockerHubRegistry
```text
$ curl -L -sS -o /dev/null -w ... https://registry-1.docker.io/v2/
http_code=401
time_connect=0.177449
time_appconnect=0.358997
time_total=0.537872
remote_ip=54.173.59.97
curl_exit=0
```
### GitHub
```text
$ curl -L -sS -o /dev/null -w ... https://github.com/
http_code=200
time_connect=0.004019
time_appconnect=0.024161
time_total=0.043637
remote_ip=20.27.177.113
curl_exit=0
```
### Google
```text
$ curl -L -sS -o /dev/null -w ... https://www.google.com/
http_code=200
time_connect=0.006476
time_appconnect=0.026081
time_total=0.226351
remote_ip=142.251.156.119
curl_exit=0
```
### HuggingFace
```text
$ curl -L -sS -o /dev/null -w ... https://huggingface.co/
http_code=200
time_connect=0.008923
time_appconnect=0.027861
time_total=0.041302
remote_ip=3.164.110.114
curl_exit=0
```
### OpenAI
```text
$ curl -L -sS -o /dev/null -w ... https://api.openai.com/v1/models
http_code=401
time_connect=0.002720
time_appconnect=0.022046
time_total=0.202833
remote_ip=162.159.140.245
curl_exit=0
```
### PyPI
```text
$ curl -L -sS -o /dev/null -w ... https://pypi.org/simple/
http_code=200
time_connect=0.006245
time_appconnect=0.027545
time_total=2.688605
remote_ip=151.101.64.223
curl_exit=0
```
### npm
```text
$ curl -L -sS -o /dev/null -w ... https://registry.npmjs.org/
http_code=200
time_connect=0.005211
time_appconnect=0.029056
time_total=0.038217
remote_ip=104.16.6.34
curl_exit=0
```

## 7. git clone 测试
```text
$ rm -rf '/tmp/network-test.7o8z7U/Hello-World'; git clone --depth=1 https://github.com/octocat/Hello-World.git '/tmp/network-test.7o8z7U/Hello-World' && test -d '/tmp/network-test.7o8z7U/Hello-World/.git'
---
Cloning into '/tmp/network-test.7o8z7U/Hello-World'...
--- exit=0
```

## 8. Docker Hub 拉取测试
```text
$ sudo -n docker pull hello-world:latest
---
latest: Pulling from library/hello-world
4f55086f7dd0: Pulling fs layer
4f55086f7dd0: Download complete
4f55086f7dd0: Pull complete
d5e71e642bf5: Download complete
Digest: sha256:96498ffd522e70807ab6384a5c0485a79b9c7c08ca79ba08623edcad1054e62d
Status: Downloaded newer image for hello-world:latest
docker.io/library/hello-world:latest
--- exit=0
```

## 9. npm / pip / apt 官方源测试
### npm
```text
$ npm ping --registry=https://registry.npmjs.org --fetch-timeout=15000
---
npm notice PING https://registry.npmjs.org/
npm notice PONG 187ms
--- exit=0
```
### pip
```text
$ python3 -m pip index versions pip -i https://pypi.org/simple --timeout 15
---
WARNING: pip index is currently an experimental command. It may be removed/changed in a future release without prior warning.
pip (26.1.2)
Available versions: 26.1.2, 26.1.1, 26.1, 26.0.1, 26.0, 25.3, 25.2, 25.1.1, 25.1, 25.0.1, 25.0, 24.3.1, 24.3, 24.2, 24.1.2, 24.1.1, 24.1, 24.0, 23.3.2, 23.3.1, 23.3, 23.2.1, 23.2, 23.1.2, 23.1.1, 23.1, 23.0.1, 23.0, 22.3.1, 22.3, 22.2.2, 22.2.1, 22.2, 22.1.2, 22.1.1, 22.1, 22.0.4, 22.0.3, 22.0.2, 22.0.1, 22.0, 21.3.1, 21.3, 21.2.4, 21.2.3, 21.2.2, 21.2.1, 21.1.3, 21.1.2, 21.1.1, 21.1, 21.0.1, 21.0, 20.3.4, 20.3.3, 20.3.1, 20.3, 20.2.4, 20.2.3, 20.2.2, 20.2.1, 20.2, 20.1.1, 20.1, 20.0.2, 20.0.1, 19.3.1, 19.3, 19.2.3, 19.2.2, 19.2.1, 19.2, 19.1.1, 19.1, 19.0.3, 19.0.2, 19.0.1, 19.0, 18.1, 18.0, 10.0.1, 10.0.0, 9.0.3, 9.0.2, 9.0.1, 9.0.0, 8.1.2, 8.1.1, 8.1.0, 8.0.3, 8.0.2, 8.0.1, 8.0.0, 7.1.2, 7.1.1, 7.1.0, 7.0.3, 7.0.2, 7.0.1, 7.0.0, 6.1.1, 6.1.0, 6.0.8, 6.0.7, 6.0.6, 6.0.5, 6.0.4, 6.0.3, 6.0.2, 6.0.1, 6.0, 1.5.6, 1.5.5, 1.5.4, 1.5.3, 1.5.2, 1.5.1, 1.5, 1.4.1, 1.4, 1.3.1, 1.3, 1.2.1, 1.2, 1.1, 1.0.2, 1.0.1, 1.0, 0.8.3, 0.8.2, 0.8.1, 0.8, 0.7.2, 0.7.1, 0.7, 0.6.3, 0.6.2, 0.6.1, 0.6, 0.5.1, 0.5, 0.4, 0.3.1, 0.3, 0.2.1, 0.2
  INSTALLED: 24.0
  LATEST:    26.1.2
--- exit=0
```
### apt
```text
$ sudo -n apt-get update -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15
---
Hit:1 https://download.docker.com/linux/ubuntu noble InRelease
Get:2 https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version InRelease [14.8 kB]
Hit:3 http://mirrors.tencentyun.com/ubuntu noble InRelease
Hit:4 http://mirrors.tencentyun.com/ubuntu noble-updates InRelease
Hit:5 http://mirrors.tencentyun.com/ubuntu noble-backports InRelease
Hit:6 http://mirrors.tencentyun.com/ubuntu noble-security InRelease
Fetched 14.8 kB in 1s (27.4 kB/s)
Reading package lists...
--- exit=0
```

## 10. 下载速度测试
```text
$ speedtest-cli --simple --secure
---
Ping: 216.049 ms
Download: 1.06 Mbit/s
Upload: 1.32 Mbit/s
--- exit=0
```

## 11. 系统网络信息
### 网卡地址
```text
$ ip -brief addr
---
lo               UNKNOWN        127.0.0.1/8 ::1/128
eth0             UP             10.7.0.2/22 metric 100 fe80::5054:ff:fe2e:e971/64
docker0          DOWN           172.17.0.1/16 fe80::9033:35ff:febe:d8e9/64
br-a3f6756bc94f  UP             172.18.0.1/16 fe80::7024:95ff:fed1:ad46/64
veth62cb68b@if2  UP             fe80::cc81:57ff:fe20:1311/64
--- exit=0
```
### IPv4 路由
```text
$ ip route show
---
default via 10.7.0.1 dev eth0 proto dhcp src 10.7.0.2 metric 100
10.7.0.0/22 dev eth0 proto kernel scope link src 10.7.0.2 metric 100
10.7.0.1 dev eth0 proto dhcp scope link src 10.7.0.2 metric 100
172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1 linkdown
172.18.0.0/16 dev br-a3f6756bc94f proto kernel scope link src 172.18.0.1
183.60.82.98 via 10.7.0.1 dev eth0 proto dhcp src 10.7.0.2 metric 100
183.60.83.19 via 10.7.0.1 dev eth0 proto dhcp src 10.7.0.2 metric 100
--- exit=0
```
### IPv6 路由
```text
$ ip -6 route show
---
fe80::/64 dev eth0 proto kernel metric 256 pref medium
fe80::/64 dev docker0 proto kernel metric 256 linkdown pref medium
fe80::/64 dev br-a3f6756bc94f proto kernel metric 256 pref medium
fe80::/64 dev veth62cb68b proto kernel metric 256 pref medium
--- exit=0
```
### DNS 配置
```text
$ (resolvectl dns 2>/dev/null || true); echo ---; cat /etc/resolv.conf
---
Global:
Link 2 (eth0): 183.60.83.19 183.60.82.98
Link 3 (docker0):
Link 28 (br-a3f6756bc94f):
Link 199 (veth62cb68b):
---
# This is /run/systemd/resolve/stub-resolv.conf managed by man:systemd-resolved(8).
# Do not edit.
#
# This file might be symlinked as /etc/resolv.conf. If you're looking at
# /etc/resolv.conf and seeing this text, you have followed the symlink.
#
# This is a dynamic resolv.conf file for connecting local clients to the
# internal DNS stub resolver of systemd-resolved. This file lists all
# configured search domains.
#
# Run "resolvectl status" to see details about the uplink DNS servers
# currently in use.
#
# Third party programs should typically not access this file directly, but only
# through the symlink at /etc/resolv.conf. To manage man:resolv.conf(5) in a
# different way, replace this symlink by a static file or a different symlink.
#
# See man:systemd-resolved.service(8) for details about the supported modes of
# operation for /etc/resolv.conf.

nameserver 127.0.0.53
options edns0 trust-ad
search .
--- exit=0
```
### 网卡 / MTU
```text
$ ip -d link show
---
1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000
    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00 promiscuity 0  allmulti 0 minmtu 0 maxmtu 0 addrgenmode eui64 numtxqueues 1 numrxqueues 1 gso_max_size 65536 gso_max_segs 65535 tso_max_size 524280 tso_max_segs 65535 gro_max_size 65536
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 8500 qdisc mq state UP mode DEFAULT group default qlen 1000
    link/ether 52:54:00:2e:e9:71 brd ff:ff:ff:ff:ff:ff promiscuity 0  allmulti 0 minmtu 68 maxmtu 8500 addrgenmode eui64 numtxqueues 2 numrxqueues 2 gso_max_size 65536 gso_max_segs 65535 tso_max_size 65536 tso_max_segs 65535 gro_max_size 65536 parentbus virtio parentdev virtio0
    altname enp0s5
    altname ens5
3: docker0: <NO-CARRIER,BROADCAST,MULTICAST,UP> mtu 1500 qdisc noqueue state DOWN mode DEFAULT group default
    link/ether 92:33:35:be:d8:e9 brd ff:ff:ff:ff:ff:ff promiscuity 0  allmulti 0 minmtu 68 maxmtu 65535
    bridge forward_delay 1500 hello_time 200 max_age 2000 ageing_time 30000 stp_state 0 priority 32768 vlan_filtering 0 vlan_protocol 802.1Q bridge_id 8000.92:33:35:be:d8:e9 designated_root 8000.92:33:35:be:d8:e9 root_port 0 root_path_cost 0 topology_change 0 topology_change_detected 0 hello_timer    0.00 tcn_timer    0.00 topology_change_timer    0.00 gc_timer  208.95 vlan_default_pvid 1 vlan_stats_enabled 0 vlan_stats_per_port 0 group_fwd_mask 0 group_address 01:80:c2:00:00:00 mcast_snooping 1 no_linklocal_learn 0 mcast_vlan_snooping 0 mcast_router 1 mcast_query_use_ifaddr 0 mcast_querier 0 mcast_hash_elasticity 16 mcast_hash_max 4096 mcast_last_member_count 2 mcast_startup_query_count 2 mcast_last_member_interval 100 mcast_membership_interval 26000 mcast_querier_interval 25500 mcast_query_interval 12500 mcast_query_response_interval 1000 mcast_startup_query_interval 3125 mcast_stats_enabled 0 mcast_igmp_version 2 mcast_mld_version 1 nf_call_iptables 0 nf_call_ip6tables 0 nf_call_arptables 0 addrgenmode eui64 numtxqueues 1 numrxqueues 1 gso_max_size 65536 gso_max_segs 65535 tso_max_size 524280 tso_max_segs 65535 gro_max_size 65536
28: br-a3f6756bc94f: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT group default
    link/ether 72:24:95:d1:ad:46 brd ff:ff:ff:ff:ff:ff promiscuity 0  allmulti 0 minmtu 68 maxmtu 65535
    bridge forward_delay 1500 hello_time 200 max_age 2000 ageing_time 30000 stp_state 0 priority 32768 vlan_filtering 0 vlan_protocol 802.1Q bridge_id 8000.72:24:95:d1:ad:46 designated_root 8000.72:24:95:d1:ad:46 root_port 0 root_path_cost 0 topology_change 0 topology_change_detected 0 hello_timer    0.00 tcn_timer    0.00 topology_change_timer    0.00 gc_timer  208.06 vlan_default_pvid 1 vlan_stats_enabled 0 vlan_stats_per_port 0 group_fwd_mask 0 group_address 01:80:c2:00:00:00 mcast_snooping 1 no_linklocal_learn 0 mcast_vlan_snooping 0 mcast_router 1 mcast_query_use_ifaddr 0 mcast_querier 0 mcast_hash_elasticity 16 mcast_hash_max 4096 mcast_last_member_count 2 mcast_startup_query_count 2 mcast_last_member_interval 100 mcast_membership_interval 26000 mcast_querier_interval 25500 mcast_query_interval 12500 mcast_query_response_interval 1000 mcast_startup_query_interval 3125 mcast_stats_enabled 0 mcast_igmp_version 2 mcast_mld_version 1 nf_call_iptables 0 nf_call_ip6tables 0 nf_call_arptables 0 addrgenmode eui64 numtxqueues 1 numrxqueues 1 gso_max_size 65536 gso_max_segs 65535 tso_max_size 524280 tso_max_segs 65535 gro_max_size 65536
199: veth62cb68b@if2: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue master br-a3f6756bc94f state UP mode DEFAULT group default
    link/ether ce:81:57:20:13:11 brd ff:ff:ff:ff:ff:ff link-netnsid 0 promiscuity 1  allmulti 1 minmtu 68 maxmtu 65535
    veth
    bridge_slave state forwarding priority 32 cost 2 hairpin off guard off root_block off fastleave off learning on flood on port_id 0x8001 port_no 0x1 designated_port 32769 designated_cost 0 designated_bridge 8000.72:24:95:d1:ad:46 designated_root 8000.72:24:95:d1:ad:46 hold_timer    0.00 message_age_timer    0.00 forward_delay_timer    0.00 topology_change_ack 0 config_pending 0 proxy_arp off proxy_arp_wifi off mcast_router 1 mcast_fast_leave off mcast_flood on bcast_flood on mcast_to_unicast off neigh_suppress off group_fwd_mask 0 group_fwd_mask_str 0x0 vlan_tunnel off isolated off locked off addrgenmode eui64 numtxqueues 2 numrxqueues 2 gso_max_size 65536 gso_max_segs 65535 tso_max_size 524280 tso_max_segs 65535 gro_max_size 65536
--- exit=0
```
### MTU 摘要
```text
$ for dev in /sys/class/net/*; do d=$(basename "$dev"); printf '%s ' "$d"; cat "$dev/mtu" 2>/dev/null || true; done
---
br-a3f6756bc94f 1500
docker0 1500
eth0 8500
lo 65536
veth62cb68b 1500
--- exit=0
```

## 失败与优化建议

### IPv6 连通性

- 状态：❌ 失败
- 现象：curl -6 失败，常见原因是实例未分配 IPv6 或无 IPv6 默认路由
- 建议：如果业务需要 IPv6，在腾讯云 VPC/轻量应用服务器控制台启用 IPv6，给实例分配 IPv6 地址，并确认系统存在 IPv6 默认路由与安全组放通。若业务只走 IPv4，可忽略。

### Traceroute: github.com

- 状态：⚠️ 部分成功
- 现象：链路有响应，但部分 hop 过滤 ICMP/UDP
- 建议：traceroute 部分星号通常是中间 hop 过滤 ICMP/UDP，不一定影响业务；如果目标 HTTP 也慢或失败，再进一步排查跨境路由。

### Traceroute: openai.com

- 状态：⚠️ 部分成功
- 现象：链路有响应，但部分 hop 过滤 ICMP/UDP
- 建议：traceroute 部分星号通常是中间 hop 过滤 ICMP/UDP，不一定影响业务；如果目标 HTTP 也慢或失败，再进一步排查跨境路由。

### HTTP/HTTPS: OpenAI

- 状态：⚠️ 部分成功
- 现象：HTTP 401，可连通但返回客户端/权限类状态
- 建议：用 curl 详情中的 HTTP code、TLS 错误和 remote_ip 判断是 DNS、TLS、代理、认证还是区域网络问题；必要时配置稳定代理或镜像源。

### HTTP/HTTPS: Anthropic

- 状态：⚠️ 部分成功
- 现象：HTTP 404，可连通但返回客户端/权限类状态
- 建议：用 curl 详情中的 HTTP code、TLS 错误和 remote_ip 判断是 DNS、TLS、代理、认证还是区域网络问题；必要时配置稳定代理或镜像源。

## 临时文件

- 原始输出目录：/tmp/network-test-raw.s6p3Yg
- 工作临时目录：/tmp/network-test.7o8z7U
