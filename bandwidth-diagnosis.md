# Bandwidth Bottleneck Diagnosis

- 生成时间：2026-06-29T15:44:18+08:00
- 主机名：VM-0-2-ubuntu
- 系统：Ubuntu 24.04.4 LTS
- 内核：Linux VM-0-2-ubuntu 6.8.0-124-generic #124-Ubuntu SMP PREEMPT_DYNAMIC Tue May 26 13:00:45 UTC 2026 x86_64 x86_64 x86_64 GNU/Linux
- 报告路径：/home/deploy/bandwidth-diagnosis.md
- 原始输出目录：/tmp/bandwidth-diagnosis-raw.6ZZ2uA

## 结论摘要

| 项目 | 判断 | 证据 |
|---|---|---|
| 套餐 30 Mbps 配置 | 无法从系统侧确认 | metadata 可取实例/IP信息，但未暴露公网带宽上限；需要腾讯云控制台或云 API 凭证确认 |
| 网卡/系统本地瓶颈 | 暂未发现明确瓶颈 | eth0 MTU/错误/丢包/TCP 参数见下文；虚拟网卡速率不等于公网计费带宽 |
| IPv4 出口 | 正常 | 多目标 HTTP、DNS、Ping 可用 |
| IPv6 出口 | 未启用公网出口 | 仅 link-local IPv6，无默认 IPv6 路由 |
| 低速主因初判 | 更像测速节点/工具问题 | 多源 curl 下载与 speedtest-cli 备用结果已明显超过 30 Mbps，说明服务器公网出口不是稳定 1 Mbps；Ookla 官方 CLI 当前未完成 |

## 多源测速总览

| 来源 | HTTP/状态 | 平均速度 | 下载量 | 总耗时 |
|---|---:|---:|---:|---:|
| Cloudflare_10MB | HTTP 200 | 418.26 Mbps | 10000000 bytes | 0.191270s |
| Cloudflare_50MB | HTTP 200 | 120.11 Mbps | 50000000 bytes | 3.330317s |
| Google_ChromeDeb_50MB | HTTP 206 | 113.32 Mbps | 50000000 bytes | 3.529980s |
| GitHub_Release_50MB | HTTP 206 | 10.34 Mbps | 13917837 bytes | 10.767589s |
| HuggingFace_50MB | HTTP 206 | 87.68 Mbps | 50000000 bytes | 4.562084s |

### Ookla 官方 CLI

> 注意：当前系统中的 `speedtest` 不支持 Ookla 官方 CLI 的 `--accept-license --accept-gdpr -f json-pretty` 参数，判断它不是 Ookla 官方 CLI，或版本不匹配。因此本项不能作为 Ookla 官方 CLI 成功结果；下方 `speedtest-cli` 备用结果有效。

```text
$ speedtest --accept-license --accept-gdpr -f json-pretty
---
usage: speedtest [-h] [--no-download] [--no-upload] [--single] [--bytes]
                 [--share] [--simple] [--csv] [--csv-delimiter CSV_DELIMITER]
                 [--csv-header] [--json] [--list] [--server SERVER]
                 [--exclude EXCLUDE] [--mini MINI] [--source SOURCE]
                 [--timeout TIMEOUT] [--secure] [--no-pre-allocate]
                 [--version]
speedtest: error: unrecognized arguments: --accept-license --accept-gdpr -f json-pretty
--- exit=0
```

### speedtest-cli 备用结果
```text
$ speedtest-cli --simple --secure
---
Ping: 177.929 ms
Download: 213.55 Mbit/s
Upload: 29.76 Mbit/s
--- exit=0
```

## 1. 腾讯云实例规格 / 公网带宽确认

系统 metadata 输出如下。当前系统侧没有拿到公网带宽字段，因此不能从 Linux 内部确认套餐是否为 30 Mbps。这个值需要腾讯云控制台实例详情/防火墙或 TencentCloud API 凭证确认。
```text
$ for base in http://metadata.tencentyun.com/latest/meta-data http://169.254.0.23/latest/meta-data http://169.254.169.254/latest/meta-data; do echo BASE=$base; for k in instance-id instance/instance-id instance-type placement/region placement/zone public-ipv4 local-ipv4; do printf '%s=' $k; curl -sS --connect-timeout 2 $base/$k 2>/dev/null || true; echo; done; done
---
BASE=http://metadata.tencentyun.com/latest/meta-data
instance-id=ins-420n72j0
instance/instance-id=
<html>
  <head>
    <title> 404 - Not Found </title>
    <body>
	  <h1> 404 - Not Found </h1>
    </body>
  </head>
</html>

instance-type=
<html>
  <head>
    <title> 404 - Not Found </title>
    <body>
	  <h1> 404 - Not Found </h1>
    </body>
  </head>
</html>

placement/region=ap-tokyo
placement/zone=ap-tokyo-2
public-ipv4=43.133.177.153
local-ipv4=10.7.0.2
BASE=http://169.254.0.23/latest/meta-data
instance-id=ins-420n72j0
instance/instance-id=
<html>
  <head>
    <title> 404 - Not Found </title>
    <body>
	  <h1> 404 - Not Found </h1>
    </body>
  </head>
</html>

instance-type=
<html>
  <head>
    <title> 404 - Not Found </title>
    <body>
	  <h1> 404 - Not Found </h1>
    </body>
  </head>
</html>

placement/region=ap-tokyo
placement/zone=ap-tokyo-2
public-ipv4=43.133.177.153
local-ipv4=10.7.0.2
BASE=http://169.254.169.254/latest/meta-data
instance-id=
instance/instance-id=
instance-type=
placement/region=
placement/zone=
public-ipv4=
local-ipv4=
--- exit=0
```
```text
$ curl -4 -sS https://ipinfo.io/json || true
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

## 2. 当前网络接口
### 地址 / 链路
```text
$ ip -brief addr; echo; ip -o link show
---
lo               UNKNOWN        127.0.0.1/8 ::1/128
eth0             UP             10.7.0.2/22 metric 100 fe80::5054:ff:fe2e:e971/64
docker0          DOWN           172.17.0.1/16 fe80::9033:35ff:febe:d8e9/64
br-a3f6756bc94f  UP             172.18.0.1/16 fe80::7024:95ff:fed1:ad46/64
veth62cb68b@if2  UP             fe80::cc81:57ff:fe20:1311/64

1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 8500 qdisc mq state UP mode DEFAULT group default qlen 1000\    link/ether 52:54:00:2e:e9:71 brd ff:ff:ff:ff:ff:ff\    altname enp0s5\    altname ens5
3: docker0: <NO-CARRIER,BROADCAST,MULTICAST,UP> mtu 1500 qdisc noqueue state DOWN mode DEFAULT group default \    link/ether 92:33:35:be:d8:e9 brd ff:ff:ff:ff:ff:ff
28: br-a3f6756bc94f: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT group default \    link/ether 72:24:95:d1:ad:46 brd ff:ff:ff:ff:ff:ff
199: veth62cb68b@if2: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue master br-a3f6756bc94f state UP mode DEFAULT group default \    link/ether ce:81:57:20:13:11 brd ff:ff:ff:ff:ff:ff link-netnsid 0
--- exit=0
```
### ethtool / 网卡速率 / Duplex / 统计
```text
$ sudo -n ethtool eth0; echo '--- stats'; sudo -n ethtool -S eth0 2>/dev/null | head -200
---
Settings for eth0:
	Supported ports: [  ]
	Supported link modes:   Not reported
	Supported pause frame use: No
	Supports auto-negotiation: No
	Supported FEC modes: Not reported
	Advertised link modes:  Not reported
	Advertised pause frame use: No
	Advertised auto-negotiation: No
	Advertised FEC modes: Not reported
	Speed: Unknown!
	Duplex: Unknown! (255)
	Auto-negotiation: off
	Port: Other
	PHYAD: 0
	Transceiver: internal
	Link detected: yes
--- stats
NIC statistics:
     rx_queue_0_packets: 7494586
     rx_queue_0_bytes: 10415646980
     rx_queue_0_drops: 0
     rx_queue_0_xdp_packets: 0
     rx_queue_0_xdp_tx: 0
     rx_queue_0_xdp_redirects: 0
     rx_queue_0_xdp_drops: 0
     rx_queue_0_kicks: 20
     rx_queue_1_packets: 9521476
     rx_queue_1_bytes: 13475325531
     rx_queue_1_drops: 0
     rx_queue_1_xdp_packets: 0
     rx_queue_1_xdp_tx: 0
     rx_queue_1_xdp_redirects: 0
     rx_queue_1_xdp_drops: 0
     rx_queue_1_kicks: 25
     tx_queue_0_packets: 1836806
     tx_queue_0_bytes: 785383054
     tx_queue_0_xdp_tx: 0
     tx_queue_0_xdp_tx_drops: 0
     tx_queue_0_kicks: 1768519
     tx_queue_0_tx_timeouts: 0
     tx_queue_1_packets: 1733432
     tx_queue_1_bytes: 773868808
     tx_queue_1_xdp_tx: 0
     tx_queue_1_xdp_tx_drops: 0
     tx_queue_1_kicks: 1654455
     tx_queue_1_tx_timeouts: 0
--- exit=0
```
### RX/TX Errors / Drops
```text
$ ip -s link show dev eth0; echo; cat /proc/net/dev
---
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 8500 qdisc mq state UP mode DEFAULT group default qlen 1000
    link/ether 52:54:00:2e:e9:71 brd ff:ff:ff:ff:ff:ff
    RX:   bytes  packets errors dropped  missed   mcast
    23890972511 17016062      0       0       0       0
    TX:   bytes  packets errors dropped carrier collsns
     1559251862  3570238      0       0       0       0
    altname enp0s5
    altname ens5

Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1766792725  172986    0    0    0     0          0         0 1766792725  172986    0    0    0     0       0          0
  eth0: 23890972511 17016062    0    0    0     0          0         0 1559251862 3570238    0    0    0     0       0          0
docker0: 67744171 1000712    0    0    0     0          0         0 17259668517 2122955    0    0    0     0       0          0
br-a3f6756bc94f: 1791256343  176623    0    0    0     0          0         0 91204509  160509    0    0    0     0       0          0
veth62cb68b: 199594776   54409    0    0    0     0          0         0 16546314   48250    0    0    0     0       0          0
--- exit=0
```
### Queue / qdisc / MTU
```text
$ tc qdisc show dev eth0; echo; ip -s -d link show dev eth0; echo; cat /sys/class/net/eth0/tx_queue_len; echo; ls -l /sys/class/net/eth0/queues; for q in /sys/class/net/eth0/queues/*; do echo ===$q; find $q -maxdepth 1 -type f -print -exec cat {} \; 2>/dev/null | head -80; done
---
qdisc mq 0: root
qdisc fq_codel 0: parent :2 limit 10240p flows 1024 quantum 8514 target 5ms interval 100ms memory_limit 32Mb ecn drop_batch 64
qdisc fq_codel 0: parent :1 limit 10240p flows 1024 quantum 8514 target 5ms interval 100ms memory_limit 32Mb ecn drop_batch 64

2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 8500 qdisc mq state UP mode DEFAULT group default qlen 1000
    link/ether 52:54:00:2e:e9:71 brd ff:ff:ff:ff:ff:ff promiscuity 0  allmulti 0 minmtu 68 maxmtu 8500 addrgenmode eui64 numtxqueues 2 numrxqueues 2 gso_max_size 65536 gso_max_segs 65535 tso_max_size 65536 tso_max_segs 65535 gro_max_size 65536 parentbus virtio parentdev virtio0
    RX:   bytes  packets errors dropped  missed   mcast
    23890972511 17016062      0       0       0       0
    TX:   bytes  packets errors dropped carrier collsns
     1559251862  3570238      0       0       0       0
    altname enp0s5
    altname ens5

1000

total 0
drwxr-xr-x 3 root root 0 Jun 28 14:54 rx-0
drwxr-xr-x 3 root root 0 Jun 28 14:54 rx-1
drwxr-xr-x 3 root root 0 Jun 28 14:54 tx-0
drwxr-xr-x 3 root root 0 Jun 28 14:54 tx-1
===/sys/class/net/eth0/queues/rx-0
/sys/class/net/eth0/queues/rx-0/rps_flow_cnt
0
/sys/class/net/eth0/queues/rx-0/rps_cpus
0
===/sys/class/net/eth0/queues/rx-1
/sys/class/net/eth0/queues/rx-1/rps_flow_cnt
0
/sys/class/net/eth0/queues/rx-1/rps_cpus
0
===/sys/class/net/eth0/queues/tx-0
/sys/class/net/eth0/queues/tx-0/tx_maxrate
0
/sys/class/net/eth0/queues/tx-0/xps_cpus
1
/sys/class/net/eth0/queues/tx-0/tx_timeout
0
/sys/class/net/eth0/queues/tx-0/xps_rxqs
0
/sys/class/net/eth0/queues/tx-0/traffic_class
0
===/sys/class/net/eth0/queues/tx-1
/sys/class/net/eth0/queues/tx-1/tx_maxrate
0
/sys/class/net/eth0/queues/tx-1/xps_cpus
2
/sys/class/net/eth0/queues/tx-1/tx_timeout
0
/sys/class/net/eth0/queues/tx-1/xps_rxqs
0
/sys/class/net/eth0/queues/tx-1/traffic_class
0
--- exit=0
```

## 3. Linux 网络优化参数
```text
$ sysctl net.ipv4.tcp_congestion_control net.ipv4.tcp_available_congestion_control net.ipv4.tcp_fastopen net.ipv4.tcp_rmem net.ipv4.tcp_wmem net.core.rmem_max net.core.wmem_max net.core.rmem_default net.core.wmem_default net.core.default_qdisc net.ipv4.tcp_mtu_probing net.ipv4.tcp_slow_start_after_idle net.ipv4.tcp_window_scaling net.ipv4.tcp_timestamps net.core.netdev_max_backlog 2>&1
---
net.ipv4.tcp_congestion_control = cubic
net.ipv4.tcp_available_congestion_control = reno cubic
net.ipv4.tcp_fastopen = 1
net.ipv4.tcp_rmem = 4096	131072	6291456
net.ipv4.tcp_wmem = 4096	16384	4194304
net.core.rmem_max = 212992
net.core.wmem_max = 212992
net.core.rmem_default = 212992
net.core.wmem_default = 212992
net.core.default_qdisc = fq_codel
net.ipv4.tcp_mtu_probing = 0
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.tcp_window_scaling = 1
net.ipv4.tcp_timestamps = 1
net.core.netdev_max_backlog = 1000
--- exit=0
```
### TCP Socket 摘要 / Window 观察
```text
$ ss -s; echo; ss -tin state established | head -120
---
Total: 221
TCP:   34 (estab 12, closed 15, orphaned 0, timewait 5)

Transport Total     IP        IPv6
RAW	  1         0         1
UDP	  6         4         2
TCP	  19        15        4
INET	  26        19        7
FRAG	  0         0         0


Recv-Q Send-Q     Local Address:Port             Peer Address:Port Process
0      0              127.0.0.1:55296               127.0.0.1:3001
	 cubic wscale:7,7 rto:203 rtt:2.161/4.262 ato:40 mss:41152 pmtu:65535 rcvmss:2254 advmss:65483 cwnd:10 bytes_sent:1909 bytes_acked:1910 bytes_received:4310 segs_out:125 segs_in:123 data_segs_out:2 data_segs_in:47 send 1523442851bps lastsnd:1112160 lastrcv:12123 lastack:12123 pacing_rate 3046004736bps delivery_rate 19365647056bps delivered:3 app_limited busy:17ms rcv_space:65495 rcv_ssthresh:90658 minrtt:0.017 snd_wnd:82304
0      0              127.0.0.1:3001                127.0.0.1:55296
	 cubic wscale:7,7 rto:201 rtt:0.015/0.002 ato:40 mss:45376 pmtu:65535 rcvmss:1736 advmss:65483 cwnd:10 bytes_sent:4310 bytes_acked:4310 bytes_received:1909 segs_out:122 segs_in:125 data_segs_out:47 data_segs_in:2 send 242005333333bps lastsnd:12124 lastrcv:1112161 lastack:12124 pacing_rate 480010578512bps delivery_rate 36300800000bps delivered:48 app_limited busy:1ms rcv_space:65483 rcv_ssthresh:82240 minrtt:0.01 snd_wnd:90752
0      0               10.7.0.2:35368           169.254.0.138:8186
	 cubic wscale:9,7 rto:203 rtt:2.534/0.133 ato:40 mss:1376 pmtu:8500 rcvmss:1376 advmss:8460 cwnd:18 bytes_sent:383431 bytes_acked:383432 bytes_received:504956 segs_out:10340 segs_in:10364 data_segs_out:1885 data_segs_in:5181 send 78194159bps lastsnd:4698 lastrcv:4696 lastack:4696 pacing_rate 156334336bps delivery_rate 76710800bps delivered:1886 app_limited busy:2486ms rcv_rtt:39381 rcv_space:70237 rcv_ssthresh:384160 minrtt:0.195 snd_wnd:6290432
0      0              127.0.0.1:55308               127.0.0.1:3001
	 cubic wscale:7,7 rto:201 rtt:0.027/0.015 ato:40 mss:40640 pmtu:65535 rcvmss:536 advmss:65483 cwnd:10 bytes_sent:1681 bytes_acked:1682 bytes_received:1993 segs_out:123 segs_in:122 data_segs_out:1 data_segs_in:46 send 120414814815bps lastsnd:1112161 lastrcv:12124 lastack:12124 pacing_rate 233269955152bps delivery_rate 25009230768bps delivered:2 app_limited rcv_space:65495 rcv_ssthresh:65495 minrtt:0.013 snd_wnd:81280
0      0             172.18.0.1:41484              172.18.0.2:3001
	 cubic wscale:7,7 rto:201 rtt:0.034/0.014 ato:40 mss:1448 pmtu:1500 rcvmss:1448 advmss:1448 cwnd:10 bytes_sent:1909 bytes_acked:1910 bytes_received:4310 segs_out:96 segs_in:95 data_segs_out:3 data_segs_in:48 send 3407058824bps lastsnd:1112161 lastrcv:12124 lastack:12124 pacing_rate 6764379560bps delivery_rate 772266664bps delivered:4 app_limited rcv_space:14480 rcv_ssthresh:71660 minrtt:0.015 snd_wnd:68608
0      0             172.18.0.1:41494              172.18.0.2:3001
	 cubic wscale:7,7 rto:201 rtt:0.032/0.017 ato:40 mss:1448 pmtu:1500 rcvmss:536 advmss:1448 cwnd:10 bytes_sent:1681 bytes_acked:1682 bytes_received:1993 segs_out:94 segs_in:92 data_segs_out:2 data_segs_in:46 send 3620000000bps lastsnd:1112161 lastrcv:12124 lastack:12124 pacing_rate 7128615384bps delivery_rate 1544533328bps delivered:3 app_limited rcv_space:14480 rcv_ssthresh:64088 minrtt:0.015 snd_wnd:68608
0      0               10.7.0.2:34888            169.254.0.55:5574
	 cubic wscale:9,2 rto:253 rtt:52.963/0.028 mss:1376 pmtu:8500 rcvmss:536 advmss:8460 cwnd:40 bytes_sent:11097516 bytes_acked:11097517 segs_out:17109 segs_in:14479 data_segs_out:14735 send 8313728bps lastsnd:4127 lastrcv:89358927 lastack:4075 pacing_rate 16627216bps delivery_rate 2281960bps delivered:14736 app_limited busy:605877ms rcv_space:65535 rcv_ssthresh:65535 minrtt:52.897 snd_wnd:8387072
0      0              127.0.0.1:3001                127.0.0.1:55308
	 cubic wscale:7,7 rto:201 rtt:0.027/0.005 ato:40 mss:32768 pmtu:65535 rcvmss:1681 advmss:65483 cwnd:10 bytes_sent:1993 bytes_acked:1993 bytes_received:1681 segs_out:121 segs_in:123 data_segs_out:46 data_segs_in:1 send 97090370370bps lastsnd:12124 lastrcv:1112161 lastack:12124 pacing_rate 193285898616bps delivery_rate 16384000000bps delivered:47 app_limited busy:2ms rcv_space:65483 rcv_ssthresh:81272 minrtt:0.016 snd_wnd:65536
0      0               10.7.0.2:34884            169.254.0.55:5574
	 cubic wscale:9,2 rto:263 rtt:62.322/4.362 ato:40 mss:1376 pmtu:8500 rcvmss:1376 advmss:8460 cwnd:26 bytes_sent:677396 bytes_acked:677397 bytes_received:40259443 segs_out:15681 segs_in:38726 data_segs_out:3169 data_segs_in:32076 send 4592407bps lastsnd:16584 lastrcv:16525 lastack:16525 pacing_rate 9184680bps delivery_rate 2483280bps delivered:3170 app_limited busy:196320ms rcv_rtt:594.712 rcv_space:247629 rcv_ssthresh:266777 minrtt:52.969 snd_wnd:6290432
0      0      [::ffff:10.7.0.2]:443   [::ffff:34.142.135.149]:44656
	 cubic wscale:7,7 rto:277 rtt:76.073/12.045 ato:40 mss:1408 pmtu:8500 rcvmss:536 advmss:8448 cwnd:10 bytes_sent:6110 bytes_acked:6110 bytes_received:1001 segs_out:13 segs_in:15 data_segs_out:5 data_segs_in:4 send 1480683bps lastsnd:80374 lastrcv:80377 lastack:4004 pacing_rate 2961336bps delivery_rate 444280bps delivered:6 app_limited busy:228ms rcv_space:57088 rcv_ssthresh:57088 minrtt:76.04 snd_wnd:78976
0      0      [::ffff:10.7.0.2]:443    [::ffff:38.150.33.234]:61656
	 cubic wscale:9,7 rto:309 rtt:103.404/9.289 ato:40 mss:1412 pmtu:8500 rcvmss:1412 advmss:8448 cwnd:10 bytes_sent:3016 bytes_acked:3016 bytes_received:3327 segs_out:12 segs_in:15 data_segs_out:7 data_segs_in:5 send 1092414bps lastsnd:18657 lastrcv:18255 lastack:3145 pacing_rate 2184808bps delivery_rate 382464bps delivered:8 app_limited busy:251ms rcv_rtt:104 rcv_space:57088 rcv_ssthresh:57088 minrtt:103.278 snd_wnd:37888
0      0      [::ffff:10.7.0.2]:443    [::ffff:38.150.33.234]:20518
	 cubic wscale:9,7 rto:304 rtt:103.845/0.046 ato:40 mss:1412 pmtu:8500 rcvmss:1412 advmss:8448 cwnd:14 bytes_sent:17267 bytes_acked:17267 bytes_received:9168 segs_out:279 segs_in:281 data_segs_out:112 data_segs_in:83 send 1522885bps lastsnd:12124 lastrcv:11683 lastack:11683 pacing_rate 3045768bps delivery_rate 592880bps delivered:113 app_limited busy:5470ms rcv_rtt:104 rcv_space:57088 rcv_ssthresh:78780 minrtt:103.738 snd_wnd:73216
--- exit=0
```

## 4. 多节点测速详情
### Cloudflare_10MB
```text
URL=https://speed.cloudflare.com/__down?bytes=10000000
bytes_limit=0
http_code=200
remote_ip=162.159.140.220
time_connect=0.004934
time_appconnect=0.024909
time_starttransfer=0.050393
time_total=0.191270
size_download=10000000
speed_download_Bps=52282114
curl_exit=0
```
### Cloudflare_50MB
```text
URL=https://speed.cloudflare.com/__down?bytes=50000000
bytes_limit=0
http_code=200
remote_ip=172.66.0.218
time_connect=0.002439
time_appconnect=0.022028
time_starttransfer=0.057994
time_total=3.330317
size_download=50000000
speed_download_Bps=15013585
curl_exit=0
```
### Google_ChromeDeb_50MB
```text
URL=https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
bytes_limit=50000000
http_code=206
remote_ip=142.251.24.91
time_connect=0.004439
time_appconnect=0.023222
time_starttransfer=0.066889
time_total=3.529980
size_download=50000000
speed_download_Bps=14164386
curl_exit=0
```
### GitHub_Release_50MB
```text
URL=https://github.com/cli/cli/releases/download/v2.75.0/gh_2.75.0_linux_amd64.tar.gz
bytes_limit=50000000
http_code=206
remote_ip=185.199.110.133
time_connect=0.008053
time_appconnect=0.046171
time_starttransfer=0.292636
time_total=10.767589
size_download=13917837
speed_download_Bps=1292567
curl_exit=0
```
### HuggingFace_50MB
```text
URL=https://huggingface.co/bert-base-uncased/resolve/main/pytorch_model.bin
bytes_limit=50000000
http_code=206
remote_ip=47.131.129.243
time_connect=0.072850
time_appconnect=0.164455
time_starttransfer=0.636752
time_total=4.562084
size_download=50000000
speed_download_Bps=10959903
curl_exit=0
```
### Docker Hub 拉取速度
```text
$ set -e; img=hello-world:latest; start=$(date +%s.%N); sudo -n docker pull $img; end=$(date +%s.%N); awk -v s=$start -v e=$end 'BEGIN{printf "elapsed=%.3fs\n", e-s}'
---
latest: Pulling from library/hello-world
Digest: sha256:96498ffd522e70807ab6384a5c0485a79b9c7c08ca79ba08623edcad1054e62d
Status: Image is up to date for hello-world:latest
docker.io/library/hello-world:latest
elapsed=2.333s
--- exit=0
```

## 5. QoS / 共享带宽 / PPS / CPU 限制线索

Linux 系统无法直接读取腾讯云公网 QoS、共享带宽包、PPS 限额或实例套餐限速字段；下面是系统侧可见证据。
### CPU / Load
```text
$ nproc; lscpu | egrep 'Model name|CPU\(s\)|Thread|Core|MHz|Hypervisor|Virtualization'; echo; uptime; echo; mpstat 1 5 2>/dev/null || true; echo; top -b -n1 | head -30
---
2
CPU(s):                                  2
On-line CPU(s) list:                     0,1
Model name:                              AMD EPYC 9754 128-Core Processor
Thread(s) per core:                      2
Core(s) per socket:                      1
Hypervisor vendor:                       KVM
Virtualization type:                     full
NUMA node0 CPU(s):                       0,1

 15:44:35 up 1 day, 50 min,  1 user,  load average: 0.13, 0.05, 0.01

Linux 6.8.0-124-generic (VM-0-2-ubuntu) 	06/29/26 	_x86_64_	(2 CPU)

15:44:35     CPU    %usr   %nice    %sys %iowait    %irq   %soft  %steal  %guest  %gnice   %idle
15:44:36     all    1.50    0.00    0.00    0.50    0.00    0.00    0.00    0.00    0.00   98.00
15:44:37     all    1.51    0.00    1.01    0.00    0.00    0.00    0.00    0.00    0.00   97.49
15:44:38     all    1.52    0.00    0.51    0.00    0.00    0.00    0.00    0.00    0.00   97.97
15:44:39     all    1.01    0.00    1.01    0.00    0.00    0.00    0.00    0.00    0.00   97.99
15:44:40     all    1.01    0.00    0.50    0.00    0.00    0.00    0.00    0.00    0.00   98.49
Average:     all    1.31    0.00    0.60    0.10    0.00    0.00    0.00    0.00    0.00   97.99

top - 15:44:41 up 1 day, 50 min,  1 user,  load average: 0.12, 0.05, 0.01
Tasks: 131 total,   1 running, 130 sleeping,   0 stopped,   0 zombie
%Cpu(s):  0.0 us,  0.0 sy,  0.0 ni,100.0 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st
MiB Mem :   3659.9 total,    350.0 free,   1152.6 used,   2448.8 buff/cache
MiB Swap:   6144.0 total,   5996.2 free,    147.7 used.   2507.3 avail Mem

    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND
      1 root      20   0   22620  10480   7148 S   0.0   0.3   0:17.70 systemd
      2 root      20   0       0      0      0 S   0.0   0.0   0:00.03 kthreadd
      3 root      20   0       0      0      0 S   0.0   0.0   0:00.00 pool_wo+
      4 root       0 -20       0      0      0 I   0.0   0.0   0:00.00 kworker+
      5 root       0 -20       0      0      0 I   0.0   0.0   0:00.00 kworker+
      6 root       0 -20       0      0      0 I   0.0   0.0   0:00.00 kworker+
      7 root       0 -20       0      0      0 I   0.0   0.0   0:00.00 kworker+
      9 root       0 -20       0      0      0 I   0.0   0.0   0:00.00 kworker+
     12 root       0 -20       0      0      0 I   0.0   0.0   0:00.00 kworker+
     13 root      20   0       0      0      0 I   0.0   0.0   0:00.00 rcu_tas+
     14 root      20   0       0      0      0 I   0.0   0.0   0:00.00 rcu_tas+
     15 root      20   0       0      0      0 I   0.0   0.0   0:00.00 rcu_tas+
     16 root      20   0       0      0      0 S   0.0   0.0   0:16.48 ksoftir+
     17 root      20   0       0      0      0 I   0.0   0.0   0:27.36 rcu_pre+
     18 root      rt   0       0      0      0 S   0.0   0.0   0:00.59 migrati+
     19 root     -51   0       0      0      0 S   0.0   0.0   0:00.00 idle_in+
     20 root      20   0       0      0      0 S   0.0   0.0   0:00.00 cpuhp/0
     21 root      20   0       0      0      0 S   0.0   0.0   0:00.00 cpuhp/1
     22 root     -51   0       0      0      0 S   0.0   0.0   0:00.00 idle_in+
     23 root      rt   0       0      0      0 S   0.0   0.0   0:00.58 migrati+
     24 root      20   0       0      0      0 S   0.0   0.0   0:15.22 ksoftir+
     27 root      20   0       0      0      0 S   0.0   0.0   0:00.00 kdevtmp+
     28 root       0 -20       0      0      0 I   0.0   0.0   0:00.00 kworker+
--- exit=0
```
### tc / 本机队列策略 / 防火墙片段
```text
$ tc -s qdisc show; echo; iptables -S 2>/dev/null | head -80 || true; nft list ruleset 2>/dev/null | head -120 || true
---
qdisc noqueue 0: dev lo root refcnt 2
 Sent 0 bytes 0 pkt (dropped 0, overlimits 0 requeues 0)
 backlog 0b 0p requeues 0
qdisc mq 0: dev eth0 root
 Sent 1600203692 bytes 4193870 pkt (dropped 0, overlimits 0 requeues 0)
 backlog 0b 0p requeues 0
qdisc fq_codel 0: dev eth0 parent :2 limit 10240p flows 1024 quantum 8514 target 5ms interval 100ms memory_limit 32Mb ecn drop_batch 64
 Sent 793843650 bytes 2038683 pkt (dropped 0, overlimits 0 requeues 0)
 backlog 0b 0p requeues 0
  maxpacket 5912 drop_overlimit 0 new_flow_count 1 ecn_mark 0
  new_flows_len 0 old_flows_len 0
qdisc fq_codel 0: dev eth0 parent :1 limit 10240p flows 1024 quantum 8514 target 5ms interval 100ms memory_limit 32Mb ecn drop_batch 64
 Sent 806360042 bytes 2155187 pkt (dropped 0, overlimits 0 requeues 0)
 backlog 0b 0p requeues 0
  maxpacket 0 drop_overlimit 0 new_flow_count 0 ecn_mark 0
  new_flows_len 0 old_flows_len 0
qdisc noqueue 0: dev docker0 root refcnt 2
 Sent 0 bytes 0 pkt (dropped 0, overlimits 0 requeues 0)
 backlog 0b 0p requeues 0
qdisc noqueue 0: dev br-a3f6756bc94f root refcnt 2
 Sent 0 bytes 0 pkt (dropped 0, overlimits 0 requeues 0)
 backlog 0b 0p requeues 0
qdisc noqueue 0: dev veth62cb68b root refcnt 2
 Sent 0 bytes 0 pkt (dropped 0, overlimits 0 requeues 0)
 backlog 0b 0p requeues 0

--- exit=0
```
### conntrack
```text
$ cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null || true; cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null || true
---
201
65536
--- exit=0
```

## 6. 当前出口 / ASN / 路由 / RTT / 丢包
### 路由
```text
$ ip route show; echo; ip route get 1.1.1.1; ip route get 8.8.8.8; ip route get github.com 2>/dev/null || true; ip route get openai.com 2>/dev/null || true
---
default via 10.7.0.1 dev eth0 proto dhcp src 10.7.0.2 metric 100
10.7.0.0/22 dev eth0 proto kernel scope link src 10.7.0.2 metric 100
10.7.0.1 dev eth0 proto dhcp scope link src 10.7.0.2 metric 100
172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1 linkdown
172.18.0.0/16 dev br-a3f6756bc94f proto kernel scope link src 172.18.0.1
183.60.82.98 via 10.7.0.1 dev eth0 proto dhcp src 10.7.0.2 metric 100
183.60.83.19 via 10.7.0.1 dev eth0 proto dhcp src 10.7.0.2 metric 100

1.1.1.1 via 10.7.0.1 dev eth0 src 10.7.0.2 uid 1003
    cache
8.8.8.8 via 10.7.0.1 dev eth0 src 10.7.0.2 uid 1003
    cache
--- exit=0
```
### Ping 丢包
```text
$ for h in 1.1.1.1 8.8.8.8 github.com openai.com registry-1.docker.io huggingface.co; do echo ===$h; ping -c 20 -i 0.2 -W 2 $h; done
---
===1.1.1.1
PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.
64 bytes from 1.1.1.1: icmp_seq=1 ttl=58 time=2.23 ms
64 bytes from 1.1.1.1: icmp_seq=2 ttl=58 time=2.25 ms
64 bytes from 1.1.1.1: icmp_seq=3 ttl=58 time=2.21 ms
64 bytes from 1.1.1.1: icmp_seq=4 ttl=58 time=2.21 ms
64 bytes from 1.1.1.1: icmp_seq=5 ttl=58 time=2.21 ms
64 bytes from 1.1.1.1: icmp_seq=6 ttl=58 time=2.24 ms
64 bytes from 1.1.1.1: icmp_seq=7 ttl=58 time=2.25 ms
64 bytes from 1.1.1.1: icmp_seq=8 ttl=58 time=2.21 ms
64 bytes from 1.1.1.1: icmp_seq=9 ttl=58 time=2.24 ms
64 bytes from 1.1.1.1: icmp_seq=10 ttl=58 time=2.21 ms
64 bytes from 1.1.1.1: icmp_seq=11 ttl=58 time=2.20 ms
64 bytes from 1.1.1.1: icmp_seq=12 ttl=58 time=2.21 ms
64 bytes from 1.1.1.1: icmp_seq=13 ttl=58 time=2.21 ms
64 bytes from 1.1.1.1: icmp_seq=14 ttl=58 time=2.23 ms
64 bytes from 1.1.1.1: icmp_seq=15 ttl=58 time=2.22 ms
64 bytes from 1.1.1.1: icmp_seq=16 ttl=58 time=2.22 ms
64 bytes from 1.1.1.1: icmp_seq=17 ttl=58 time=2.28 ms
64 bytes from 1.1.1.1: icmp_seq=18 ttl=58 time=2.31 ms
64 bytes from 1.1.1.1: icmp_seq=19 ttl=58 time=2.21 ms
64 bytes from 1.1.1.1: icmp_seq=20 ttl=58 time=2.24 ms

--- 1.1.1.1 ping statistics ---
20 packets transmitted, 20 received, 0% packet loss, time 3811ms
rtt min/avg/max/mdev = 2.200/2.228/2.311/0.026 ms
===8.8.8.8
PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.
64 bytes from 8.8.8.8: icmp_seq=1 ttl=119 time=2.67 ms
64 bytes from 8.8.8.8: icmp_seq=2 ttl=119 time=2.69 ms
64 bytes from 8.8.8.8: icmp_seq=3 ttl=119 time=2.64 ms
64 bytes from 8.8.8.8: icmp_seq=4 ttl=119 time=2.65 ms
64 bytes from 8.8.8.8: icmp_seq=5 ttl=119 time=2.66 ms
64 bytes from 8.8.8.8: icmp_seq=6 ttl=119 time=2.67 ms
64 bytes from 8.8.8.8: icmp_seq=7 ttl=119 time=2.65 ms
64 bytes from 8.8.8.8: icmp_seq=8 ttl=119 time=2.66 ms
64 bytes from 8.8.8.8: icmp_seq=9 ttl=119 time=2.66 ms
64 bytes from 8.8.8.8: icmp_seq=10 ttl=119 time=2.64 ms
64 bytes from 8.8.8.8: icmp_seq=11 ttl=119 time=2.65 ms
64 bytes from 8.8.8.8: icmp_seq=12 ttl=119 time=2.65 ms
64 bytes from 8.8.8.8: icmp_seq=13 ttl=119 time=2.66 ms
64 bytes from 8.8.8.8: icmp_seq=14 ttl=119 time=2.66 ms
64 bytes from 8.8.8.8: icmp_seq=15 ttl=119 time=2.66 ms
64 bytes from 8.8.8.8: icmp_seq=16 ttl=119 time=2.66 ms
64 bytes from 8.8.8.8: icmp_seq=17 ttl=119 time=2.66 ms
64 bytes from 8.8.8.8: icmp_seq=18 ttl=119 time=2.67 ms
64 bytes from 8.8.8.8: icmp_seq=19 ttl=119 time=2.64 ms
64 bytes from 8.8.8.8: icmp_seq=20 ttl=119 time=2.68 ms

--- 8.8.8.8 ping statistics ---
20 packets transmitted, 20 received, 0% packet loss, time 3819ms
rtt min/avg/max/mdev = 2.635/2.657/2.687/0.012 ms
===github.com
PING github.com (20.205.243.166) 56(84) bytes of data.
64 bytes from 20.205.243.166: icmp_seq=1 ttl=113 time=70.6 ms
64 bytes from 20.205.243.166: icmp_seq=2 ttl=113 time=70.5 ms
64 bytes from 20.205.243.166: icmp_seq=3 ttl=113 time=70.6 ms
64 bytes from 20.205.243.166: icmp_seq=4 ttl=113 time=70.6 ms
64 bytes from 20.205.243.166: icmp_seq=5 ttl=113 time=70.6 ms
64 bytes from 20.205.243.166: icmp_seq=6 ttl=113 time=70.5 ms
64 bytes from 20.205.243.166: icmp_seq=7 ttl=113 time=70.6 ms
64 bytes from 20.205.243.166: icmp_seq=8 ttl=113 time=70.5 ms
64 bytes from 20.205.243.166: icmp_seq=9 ttl=113 time=70.5 ms
64 bytes from 20.205.243.166: icmp_seq=10 ttl=113 time=70.6 ms
64 bytes from 20.205.243.166: icmp_seq=11 ttl=113 time=70.6 ms
64 bytes from 20.205.243.166: icmp_seq=12 ttl=113 time=70.6 ms
64 bytes from 20.205.243.166: icmp_seq=13 ttl=113 time=70.6 ms
64 bytes from 20.205.243.166: icmp_seq=14 ttl=113 time=70.5 ms
64 bytes from 20.205.243.166: icmp_seq=15 ttl=113 time=70.5 ms
64 bytes from 20.205.243.166: icmp_seq=16 ttl=113 time=70.6 ms
64 bytes from 20.205.243.166: icmp_seq=17 ttl=113 time=70.5 ms
64 bytes from 20.205.243.166: icmp_seq=18 ttl=113 time=70.5 ms
64 bytes from 20.205.243.166: icmp_seq=19 ttl=113 time=70.5 ms
64 bytes from 20.205.243.166: icmp_seq=20 ttl=113 time=70.5 ms

--- github.com ping statistics ---
20 packets transmitted, 20 received, 0% packet loss, time 3814ms
rtt min/avg/max/mdev = 70.476/70.550/70.638/0.040 ms
===openai.com
PING openai.com (172.64.154.211) 56(84) bytes of data.
64 bytes from 172.64.154.211: icmp_seq=1 ttl=58 time=1.40 ms
64 bytes from 172.64.154.211: icmp_seq=2 ttl=58 time=1.47 ms
64 bytes from 172.64.154.211: icmp_seq=3 ttl=58 time=1.42 ms
64 bytes from 172.64.154.211: icmp_seq=4 ttl=58 time=1.46 ms
64 bytes from 172.64.154.211: icmp_seq=5 ttl=58 time=1.41 ms
64 bytes from 172.64.154.211: icmp_seq=6 ttl=58 time=1.41 ms
64 bytes from 172.64.154.211: icmp_seq=7 ttl=58 time=1.42 ms
64 bytes from 172.64.154.211: icmp_seq=8 ttl=58 time=1.42 ms
64 bytes from 172.64.154.211: icmp_seq=9 ttl=58 time=1.41 ms
64 bytes from 172.64.154.211: icmp_seq=10 ttl=58 time=1.41 ms
64 bytes from 172.64.154.211: icmp_seq=11 ttl=58 time=1.42 ms
64 bytes from 172.64.154.211: icmp_seq=12 ttl=58 time=1.46 ms
64 bytes from 172.64.154.211: icmp_seq=13 ttl=58 time=1.42 ms
64 bytes from 172.64.154.211: icmp_seq=14 ttl=58 time=1.41 ms
64 bytes from 172.64.154.211: icmp_seq=15 ttl=58 time=1.39 ms
64 bytes from 172.64.154.211: icmp_seq=16 ttl=58 time=1.41 ms
64 bytes from 172.64.154.211: icmp_seq=17 ttl=58 time=1.43 ms
64 bytes from 172.64.154.211: icmp_seq=18 ttl=58 time=1.51 ms
64 bytes from 172.64.154.211: icmp_seq=19 ttl=58 time=1.45 ms
64 bytes from 172.64.154.211: icmp_seq=20 ttl=58 time=1.44 ms

--- openai.com ping statistics ---
20 packets transmitted, 20 received, 0% packet loss, time 3814ms
rtt min/avg/max/mdev = 1.391/1.427/1.509/0.028 ms
===registry-1.docker.io
PING registry-1.docker.io (54.224.198.86) 56(84) bytes of data.

--- registry-1.docker.io ping statistics ---
20 packets transmitted, 0 received, 100% packet loss, time 3945ms

===huggingface.co
PING huggingface.co (3.164.110.77) 56(84) bytes of data.
64 bytes from server-3-164-110-77.nrt12.r.cloudfront.net (3.164.110.77): icmp_seq=1 ttl=249 time=2.37 ms
64 bytes from server-3-164-110-77.nrt12.r.cloudfront.net (3.164.110.77): icmp_seq=2 ttl=249 time=2.42 ms
64 bytes from server-3-164-110-77.nrt12.r.cloudfront.net (3.164.110.77): icmp_seq=3 ttl=249 time=2.40 ms
64 bytes from server-3-164-110-77.nrt12.r.cloudfront.net (3.164.110.77): icmp_seq=4 ttl=249 time=2.41 ms
64 bytes from server-3-164-110-77.nrt12.r.cloudfront.net (3.164.110.77): icmp_seq=5 ttl=249 time=2.37 ms
64 bytes from server-3-164-110-77.nrt12.r.cloudfront.net (3.164.110.77): icmp_seq=6 ttl=249 time=2.40 ms
64 bytes from server-3-164-110-77.nrt12.r.cloudfront.net (3.164.110.77): icmp_seq=7 ttl=249 time=2.38 ms
64 bytes from server-3-164-110-77.nrt12.r.cloudfront.net (3.164.110.77): icmp_seq=8 ttl=249 time=2.43 ms
64 bytes from server-3-164-110-77.nrt12.r.cloudfront.net (3.164.110.77): icmp_seq=9 ttl=249 time=2.39 ms
64 bytes from server-3-164-110-77.nrt12.r.cloudfront.net (3.164.110.77): icmp_seq=10 ttl=249 time=2.39 ms
64 bytes from server-3-164-110-77.nrt12.r.cloudfront.net (3.164.110.77): icmp_seq=11 ttl=249 time=2.37 ms
64 bytes from server-3-164-110-77.nrt12.r.cloudfront.net (3.164.110.77): icmp_seq=12 ttl=249 time=2.39 ms
64 bytes from server-3-164-110-77.nrt12.r.cloudfront.net (3.164.110.77): icmp_seq=13 ttl=249 time=2.42 ms
64 bytes from server-3-164-110-77.nrt12.r.cloudfront.net (3.164.110.77): icmp_seq=14 ttl=249 time=2.45 ms
64 bytes from server-3-164-110-77.nrt12.r.cloudfront.net (3.164.110.77): icmp_seq=15 ttl=249 time=2.42 ms
64 bytes from server-3-164-110-77.nrt12.r.cloudfront.net (3.164.110.77): icmp_seq=16 ttl=249 time=2.40 ms
64 bytes from server-3-164-110-77.nrt12.r.cloudfront.net (3.164.110.77): icmp_seq=17 ttl=249 time=2.40 ms
64 bytes from server-3-164-110-77.nrt12.r.cloudfront.net (3.164.110.77): icmp_seq=18 ttl=249 time=2.38 ms
64 bytes from server-3-164-110-77.nrt12.r.cloudfront.net (3.164.110.77): icmp_seq=19 ttl=249 time=2.38 ms
64 bytes from server-3-164-110-77.nrt12.r.cloudfront.net (3.164.110.77): icmp_seq=20 ttl=249 time=2.39 ms

--- huggingface.co ping statistics ---
20 packets transmitted, 20 received, 0% packet loss, time 3814ms
rtt min/avg/max/mdev = 2.374/2.398/2.454/0.020 ms
--- exit=0
```
### Traceroute
```text
$ for h in github.com openai.com registry-1.docker.io huggingface.co; do echo ===$h; traceroute -n -w 2 -q 1 -m 20 $h; done
---
===github.com
traceroute to github.com (20.27.177.113), 20 hops max, 60 byte packets
 1  *
 2  *
 3  *
 4  30.245.26.157  1.367 ms
 5  *
 6  104.44.235.98  1.619 ms
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
===openai.com
traceroute to openai.com (104.18.33.45), 20 hops max, 60 byte packets
 1  *
 2  29.4.49.42  4.084 ms
 3  *
 4  *
 5  101.203.88.62  3.207 ms
 6  103.22.201.125  3.827 ms
 7  104.18.33.45  1.727 ms
===registry-1.docker.io
traceroute to registry-1.docker.io (98.86.78.44), 20 hops max, 60 byte packets
 1  *
 2  *
 3  *
 4  30.245.26.177  1.392 ms
 5  27.85.110.89  1.398 ms
 6  27.86.32.1  3.827 ms
 7  106.139.193.22  3.154 ms
 8  106.187.13.42  115.114 ms
 9  111.87.3.114  115.219 ms
10  111.87.3.106  109.491 ms
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
===huggingface.co
traceroute to huggingface.co (3.164.110.77), 20 hops max, 60 byte packets
 1  *
 2  *
 3  10.162.71.165  1.505 ms
 4  *
 5  *
 6  *
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

## 7. UDP 与 TCP 吞吐能力

TCP 吞吐以多源 curl/Ookla/Docker 结果为准。UDP 方面，当前未安装 iperf3，且没有可信受控 UDP 测速端点；这里只做 UDP DNS 请求与 traceroute 侧证。不能把它等同于 UDP 大流量吞吐上限。
### UDP DNS
```text
$ for s in 1.1.1.1 8.8.8.8 208.67.222.222; do echo ===UDP DNS $s; for i in 1 2 3 4 5; do dig @$s github.com A +time=2 +tries=1 +stats | egrep 'Query time|SERVER|status'; done; done
---
===UDP DNS 1.1.1.1
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 13695
;; Query time: 1 msec
;; SERVER: 1.1.1.1#53(1.1.1.1) (UDP)
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 26483
;; Query time: 1 msec
;; SERVER: 1.1.1.1#53(1.1.1.1) (UDP)
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 26016
;; Query time: 2 msec
;; SERVER: 1.1.1.1#53(1.1.1.1) (UDP)
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 2529
;; Query time: 3 msec
;; SERVER: 1.1.1.1#53(1.1.1.1) (UDP)
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 18801
;; Query time: 2 msec
;; SERVER: 1.1.1.1#53(1.1.1.1) (UDP)
===UDP DNS 8.8.8.8
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 33679
;; Query time: 11 msec
;; SERVER: 8.8.8.8#53(8.8.8.8) (UDP)
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 6757
;; Query time: 9 msec
;; SERVER: 8.8.8.8#53(8.8.8.8) (UDP)
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 18344
;; Query time: 8 msec
;; SERVER: 8.8.8.8#53(8.8.8.8) (UDP)
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 35757
;; Query time: 2 msec
;; SERVER: 8.8.8.8#53(8.8.8.8) (UDP)
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 8811
;; Query time: 9 msec
;; SERVER: 8.8.8.8#53(8.8.8.8) (UDP)
===UDP DNS 208.67.222.222
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 34249
;; Query time: 3 msec
;; SERVER: 208.67.222.222#53(208.67.222.222) (UDP)
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 47617
;; Query time: 5 msec
;; SERVER: 208.67.222.222#53(208.67.222.222) (UDP)
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 24726
;; Query time: 6 msec
;; SERVER: 208.67.222.222#53(208.67.222.222) (UDP)
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 29011
;; Query time: 6 msec
;; SERVER: 208.67.222.222#53(208.67.222.222) (UDP)
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 20674
;; Query time: 6 msec
;; SERVER: 208.67.222.222#53(208.67.222.222) (UDP)
--- exit=0
```
### iperf3 状态
```text
$ echo iperf3 not installed; no controlled UDP/TCP throughput endpoint available
---
iperf3 not installed
bash: line 1: no: command not found
--- exit=127
```

## 8. 最终根因分析（按概率排序）

1. **Speedtest 节点/工具问题（最高概率）**：多源 curl 下载已经明显超过 30 Mbps，早前 speedtest-cli 的约 1 Mbps 不代表服务器真实公网带宽。speedtest 结果需要结合节点、工具版本和选路判断。
2. **目标 CDN/路由差异（中等概率）**：实例出口在东京，访问 Cloudflare、Google、GitHub、Hugging Face、Docker Hub 会走不同 CDN 和路由；单个目标低速不能代表整机公网带宽不足。
3. **腾讯云侧套餐/共享带宽限制（低到中等概率，仍需控制台确认）**：Linux metadata 不暴露公网带宽字段，无法从系统侧确认 30 Mbps 配置。但现有多源实测已经超过 30 Mbps，因此没有证据支持“云侧把出口限制到 1 Mbps”。若控制台显示 30 Mbps，当前多源数据反而说明公网出口可达标或超出标称峰值。
4. **TCP 参数问题（低概率）**：若拥塞控制为 cubic 而非 BBR，长 RTT 链路可能不够理想；但本机到常见目标 RTT 很低，且多源吞吐已超过 30 Mbps，TCP 参数不是 1 Mbps 级瓶颈主因。
5. **CPU 瓶颈（低概率）**：若测速时 CPU idle 充足、softirq 不高，则 CPU 不构成瓶颈。
6. **本地网卡错误/丢包/队列问题（低概率）**：如 eth0 RX/TX errors/drops 接近 0，qdisc 无异常，则本地虚拟网卡不是主要瓶颈。

## 9. 建议下一步

- 在腾讯云控制台截图或导出实例公网带宽配置，确认是否真为 30 Mbps、是否共享带宽、是否轻量实例峰值带宽而非保证带宽。
- 用腾讯云内网/同地域另一台机器做 iperf3 对照，可分离公网出口限速与实例内部性能。
- 当前更建议用 Cloudflare/Google/GitHub/Hugging Face 这类多源下载作为实际带宽验收，不要只看单次 speedtest-cli。若需要严格 Ookla 官方结果，应安装 Ookla 官方 speedtest CLI 后复测。
- 若未来多源公网下载也持续远低于 30 Mbps，再携带本报告中的低错误/低丢包、CPU 空闲证据向腾讯云提工单。
