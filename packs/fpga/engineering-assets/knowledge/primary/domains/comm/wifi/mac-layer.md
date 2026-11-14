---
name: mac-layer
title: "WiFi MAC 层 — CSMA/CA、帧聚合与 QoS"
tags: [comm, wifi, mac]
description: "DCF/EDCA → 退避 → RTS/CTS → 帧聚合 → Block Ack — CSMA/CA 全流程"
related: [wifi/overview.md, wifi/phy-layer.md]
---

# WiFi MAC 层 — CSMA/CA、帧聚合与 QoS

> 最后更新: 2026-06-06
> 关联: [[overview]], [[phy-layer]]

---

## 1. MAC 架构概览

```
802.11 MAC 包含两种协调功能:

┌────────────────────────────────┐
│         HCF (混合协调功能)       │
│  ┌────────────┐ ┌────────────┐  │
│  │   DCF      │ │   PCF      │  │  ← 基础 (DCF 强制, PCF 可选)
│  │ (EDCA)     │ │ (HCCA)     │  │  ← 增强 QoS (802.11e)
│  │ 竞争型     │ │ 无竞争轮询 │  │
│  └────────────┘ └────────────┘  │
│          │              │        │
│  ┌───────┴──────────────┴──────┐ │
│  │       帧保护协议              │ │
│  │   (CSMA/CA + ACK/BlockAck)  │ │
│  └─────────────────────────────┘ │
└────────────────────────────────┘
```

| 组件 | 全称 | 说明 |
|:----|:----|:-----|
| **DCF** | Distributed Coordination Function | 基础 CSMA/CA，所有 STA 必须实现 |
| **PCF** | Point Coordination Function | AP 轮询，无竞争期 (可选，未广泛部署) |
| **EDCA** | Enhanced DCF Channel Access | 802.11e QoS 增强，4 个 AC 队列 |
| **HCCA** | HCF Controlled Channel Access | 802.11e 参数化 QoS (可选，未广泛部署) |
| **HCF** | Hybrid Coordination Function | EDCA + HCCA 的统称 |

---

## 2. DCF — 基础 CSMA/CA

### 2.1 基本流程

```
   STA A  ┌─────┐
          │数据帧│
   -------└─────┴────────────────────────────→
              ↓
   STA B  ┌────────────────────────┐
          │  ACK (SIFS 后立即回复)  │
   -------┴────────────────────────┴─────────→

   帧间隔:
   │<─SIFS─>│ACK           (短帧间隔, 最高优先级)
   │<──PIFS──>│PCF 轮询     (点协调帧间隔)
   │<───DIFS───>│DCF 数据   (分布式帧间隔)
   │<─────EIFS─────>│       (错误帧间隔, 解码失败后)

   DIFS = SIFS + 2 × SlotTime
   EIFS = SIFS + DIFS + PreambleTime
```

### 2.2 退避算法 (Backoff)

```
   ┌──────────┐       ┌────────────────┐
   │ 检测信道忙      │ 退避计数器递减   │
   │ → 等待 DIFS     │ (每空闲 Slot)    │
   └──────┬──────────┘       │
          │                  ↓
          │         ┌────────────────┐
          │         │ 计数器=0?       │
          │         └───────┬────────┘
          │                 ↓
          │         ┌────────────────┐
          │         │ 发送数据帧      │
          │         └────────────────┘
          │                 │
          │         ┌───────┴────────┐
          │         │ 收到 ACK?       │
          │         └───────┬────────┘
          │            Y    ↓     N
          │         ┌────────────────┐  ┌────────────────┐
          │         │ CW = CWmin     │  │ CW = min(CW×2,  │
          │         │ 选随机 Backoff  │  │   CWmax)        │
          │         └────────────────┘  │ 选随机 Backoff  │
          │                             └────────────────┘
```

**关键参数**:

```
Backoff Counter = 随机整数 × SlotTime
                                  ┌─────┐
随机整数 ∈ [0, CW], 初始 CW = CWmin
CW 范围: CWmin ~ CWmax (指数退避)
成功 → CW = CWmin
失败 → CW = min(CW × 2 + 1, CWmax)
```

### 2.3 RTS/CTS 机制

**目的**: 解决隐藏节点问题，减少碰撞开销

```
  STA A          AP/STA B              其他 STA
    │                │                     │
    ├── RTS ────────→│                     │  (等待 RTS)
    │  (Duration)    │                     │  → 记 NAV
    │←──── CTS ──────┤                     │  (等待 CTS)
    │  (Duration-1)  │                     │  → 记 NAV
    ├──── Data ─────→│                     │
    │                │                     │  (NAV 保护期)
    │←───── ACK ─────┤                     │
    │                │                     │
    ↓                ↓                     ↓

  RTS: 20 字节 (OFDM: 1 个符号)
  CTS: 14 字节
  Threshold: 当 Data > RTS_Threshold (典型 256~512 字节) 时使用
```

> 小数据包不使用 RTS/CTS，直接发送。RTS/CTS 的开销对于大数据包值得。

---

## 3. 帧间间隔 (IFS)

| IFS 类型 | 时长 (OFDM) | 用途 |
|:---------|:-----------:|:-----|
| **SIFS** | 16 μs | ACK/CTS/轮询回复 (最高优先级) |
| **PIFS** | SIFS + Slot = 25 μs | PCF 轮询/AP 接入 |
| **DIFS** | SIFS + 2×Slot = 34 μs | DCF 数据帧 |
| **AIFS** | SIFS + n×Slot | EDCA QoS (n 因 AC 而异) |
| **EIFS** | SIFS + DIFS + Preamble | 帧解码失败后 |
| **Slot** | 9 μs | 退避时隙 (OFDM PHY) |

---

## 4. EDCA — QoS 增强 (802.11e)

### 4.1 4 个接入类别 (AC)

| AC | 名称 | 典型业务 | CWmin | CWmax | AIFSN | TXOP |
|:--:|:----|:---------|:-----:|:-----:|:----:|:----:|
| **AC_VO** | Voice | 语音 (VoWiFi) | 3 | 7 | 2 | 3.008 ms |
| **AC_VI** | Video | 视频流 | 7 | 15 | 2 | 6.016 ms |
| **AC_BE** | Best Effort | 普通数据 | 15 | 1023 | 3 | — |
| **AC_BK** | Background | 后台下载 | 15 | 1023 | 7 | — |

**EDCA 退避**:

```
AIFS[AC] = SIFS + AIFSN[AC] × SlotTime

退避值 ∈ [0, CW[AC]]
CW[AC] 范围: CWmin[AC] ~ CWmax[AC]
```

> 高优先级 AC (VO/VI) 有更小的 CWmin 和 AIFSN → 更短的平均退避 → 优先接入

### 4.2 TXOP (传输机会)

- **TXOP Limit**: STA 获得信道后可连续发送的最大时间
- 期间无需重新竞争 — 可发送多个帧 (帧聚合)
- AP 设置的 EDCA 参数通过 **Beacon 帧**广播

---

## 5. 帧聚合 (802.11n/ac/ax/be)

### 5.1 两类聚合

```
┌───────────────────────────────────────────────────────┐
│  A-MPDU (多 MAC 帧聚合) — 802.11n+                    │
│  一次信道竞争发送多个 MPDU (有分隔符 + CRC)            │
│  ┌──────┬──────┬──────┬──────┬─────────────────────┐  │
│  │MPDU 1│MPDU 2│MPDU 3│MPDU 4│    ...              │  │
│  │Delim │Delim │Delim │Delim │                      │  │
│  └──────┴──────┴──────┴──────┴─────────────────────┘  │
│  最大长度: 64kB (n), 256kB (ac), ~1MB (ax)             │
│                                                        │
│  A-MSDU (多 LLC 帧聚合) — 802.11n+                     │
│  一个 MAC 帧内封装多个 MSDU                            │
│  ┌──────┬──────┬──────┬────────────────────────────┐  │
│  │MSDU 1│MSDU 2│MSDU 3│     ...                    │  │
│  │     A-MSDU (最大 7935B, 可选 3839B)              │  │
│  └─────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────┘

聚合层次:
TCP包 ─→ MSDU ─→ (A-MSDU) ─→ MPDU ─→ (A-MPDU) ─→ PPDU
```

### 5.2 A-MPDU 和 Block Ack

```
传统: 每帧 ACK → 效率低

┌────┐       ┌────┐       ┌────┐
│数据│       │数据│       │数据│      ┌───┐
│帧1 │→ ACK→│帧2 │→ ACK→│帧3 │→ ...│ACK│ (信道浪费)
└────┘       └────┘       └────┘      └───┘

A-MPDU + Block Ack: 批量发送 + 批量确认

┌──────────────────────────┐
│    A-MPDU (N 个子帧)     │  ← SIFS →  ┌─────────┐
│ 帧1 │ 帧2 │ ... │ 帧N    │  ────────→  │BlockAck │
└──────────────────────────┘             │Bitmap:N │
                                         └─────────┘
```

**BlockAck 流程**:

1. 发送方发 **ADDBA Request** → 接收方回 **ADDBA Response**
2. 建立 Block Ack 会话 (协商窗口大小 16/32/64/256)
3. 发送 A-MPDU (含多个 MPDU) → 接收方用 BlockAck 位图确认
4. 重传失败 MPDU (可选选择性重传)

### 5.3 各代聚合能力

| 代 | A-MSDU 最大 | A-MPDU 最大 | BlockAck 窗口 |
|:--:|:----------:|:-----------:|:-------------:|
| n (HT) | 3839/7935 B | 64 kB | 64 |
| ac (VHT) | 3839/7935 B | 1 MB (8 位 MPDU 长度) | 64 |
| ax (HE) | 同前 | 2 MB (多 TID) | 256 |
| be (EHT) | 同前 | 2 MB+ | 256/1024 |

---

## 6. 帧格式

### 6.1 MAC 帧通用格式

```
字节:  2        2        6        6        6        2        0-2304      4
┌────────┬────────┬────────┬────────┬────────┬────────┬───────────┬────────┐
│ Frame  │Duration│  Address 1  │  Address 2  │Address 3│ Sequence │  Frame │  FCS  │
│ Control│  /ID   │ (DA/RA)   │ (SA/TA)   │ (BSSID) │ Control │   Body  │  (CRC)│
└────────┴────────┴────────┴────────┴────────┴────────┴───────────┴────────┘

  Frame Control (2 字节):
  ┌──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┐
  │Protocol│Type│Subtype│To │Fr │More│Pwr│More│Pro│Order│
  │Version │   │       │DS │DS │Frag│Mgt│Data│tect│     │
  │ 2 bits │2b │4b     │1  │1  │1   │1  │1   │1   │1    │
  └──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┘
```

### 6.2 帧类型

| Type | 名称 | Subtype 示例 |
|:----:|:----|:------------|
| 00 | Management | Association Request/Response, Probe Request/Response, Beacon, Authentication |
| 01 | Control | RTS, CTS, ACK, BlockAck, PS-Poll |
| 10 | Data | Data, Null Data, QoS Data |
| 11 | Extension (802.11ad) | DMG Beacon, SSW |

**常见管理帧**:

| 帧 | 用途 | 方向 |
|:---|:-----|:----|
| **Beacon** | AP 宣告 BSS 存在 (100ms 典型间隔) | AP → 广播 |
| **Probe Request/Response** | STA 扫描可用网络 | STA ↔ AP |
| **Authentication** | 开放/共享密钥/SAE 认证 | STA ↔ AP |
| **Association Request/Response** | STA 关联到 AP | STA ↔ AP |
| **Disassociation** | 断开关联 | 任意方向 |

**常见控制帧**:

| 帧 | 用途 | 长度 |
|:---|:-----|:----:|
| **RTS** | 信道预约 (4 地址) | 20 B |
| **CTS** | 信道确认 (2 地址) | 14 B |
| **ACK** | 单帧确认 | 14 B |
| **BlockAck (BA)** | A-MPDU 批量确认 | 可变 |
| **BlockAckReq (BAR)** | 请求 BlockAck | 可变 |

### 6.3 地址字段解释

| 含义 | To DS | From DS | Address 1 | Address 2 | Address 3 | Address 4 |
|:---:|:-----:|:-------:|:----------|:----------|:----------|:----------|
| STA→AP | 1 | 0 | BSSID | SA | DA | — |
| AP→STA | 0 | 1 | DA | BSSID | SA | — |
| AP→AP | 1 | 1 | RA | TA | DA | SA |
| IBSS | 0 | 0 | DA | SA | BSSID | — |

---

## 7. 省电机制

### 7.1 PS-Poll (传统省电)

```
STA: ──→ AP (设置 Power Management bit)
AP:  缓存发往 STA 的数据
STA: ──→ PS-Poll (唤醒后) ──→ AP 回复数据
      │                        │
      │←──── 数据帧 (或 TIM) ──│
```

**TIM (Traffic Indication Map)**: AP 在 Beacon 帧中指示哪些 STA 有待收数据
**DTIM (Delivery TIM)**: 每 N 个 Beacon 发送一个 DTIM，指示广播/组播数据

### 7.2 目标唤醒时间 (TWT — 802.11ax)

```
STA 与 AP 协商约好的唤醒时间:

STA: ──→ TWT Setup Request ──→ AP
AP:  ──→ TWT Setup Response ──→ STA
                                  (双方同意唤醒时间表)
STA: [休眠] ─── 到达 TWT ─── [唤醒, 收/发数据]
                                      ↓
                          可协商下个 TWT (单次/周期)

TWT 优势: 非竞争 (AP 在约定时间集中服务), 大幅降低功耗
```

---

## 8. 安全与认证

| 协议 | 算法 | 说明 |
|:----|:-----|:------|
| **WEP** (废止) | RC4 | 已被破解，不应使用 |
| **WPA** (802.11i) | TKIP(MIC)+RC4 | 过渡方案，已不推荐 |
| **WPA2** (802.11i) | AES-CCMP | 当前最低要求 |
| **WPA3** (2018) | SAE (初始握手), AES-GCMP (加密) | 替代 WPA2, 抗离线字典攻击 |
| **OWE** (Opportunistic) | 无密码加密 | 公共 WiFi 透明加密 |

**关联与认证流程**:

```
STA                                    AP
 │                                      │
 ├── Probe Request ────────────────────→│  扫描
 │←──── Probe Response ────────────────┤
 │                                      │
 ├── Authentication (Open/SAE) ────────→│  认证
 │←──── Authentication ────────────────┤
 │                                      │
 ├── Association Request ──────────────→│  关联
 │←──── Association Response ──────────┤
 │                                      │
 ├── 4-Way Handshake (EAPOL-Key) ─────→│  密钥协商
 │←────────────────────────────────────┤  (WPA2/WPA3)
 │                                      │
 │  ─── 802.1x/EAP (可选, 企业网络) ──→│
 │                                      │
 └── 加密通信 (CCMP/GCMP) ────────────→┘
```

---

## 9. FPGA 实现要点

### 9.1 MAC 发送加速

- **TX FIFO 深度**: 至少 64 kB (A-MPDU 最大 64 kB HT / 1 MB VHT)
- **A-MSDU 拆解**: 检查 MSDU 边界 (DA/SA/Length), 转发到更高层
- **BlockAck 管理**: 维护 BA 位图 + 超时重传窗口 (scoreboarding)
- **NAV 更新**: 每条接收帧解析 Duration 字段 → 更新信道状态

### 9.2 MAC 接收处理

```
接收路径 (FPGA 加速点):
───────────────────────────────────────
 ① FCS 校验 (CRC-32) — 每个 MPDU 边界
 ② MPDU Delimiter 解析 — 边界检测 + CRC8
 ③ A-MPDU 帧解析 — 拆 MPDU 子帧序列
 ④ Address Filtering — MAC 地址白名单
 ⑤ Sequence Number 检测 — 去重
 ⑥ BlockAck 生成 — 位图构建 + 立即/延迟回复
```

### 9.3 实时性考虑

| 要求 | 值 | 说明 |
|:----|:---|:-----|
| SIFS 精确性 | 16 μs ± 10% | ACK/CTS 必须在 SIFS 内回应 |
| 时隙精度 | 9 μs | 退避到时同步 AP 时钟 |
| TXOP 计时 | 微秒级 | 传输机会超时释放 |
| TSF 同步 | 1 μs | Beacon 中的时间戳修正 |

---

## 参考

- IEEE Std 802.11-2020, Part 11, Ch. 9-10 (MAC)
- 802.11e-2005 (QoS EDCA)
- 802.11ax-2021 §26-27 (HE MAC)
- 802.11be/D5.0 §35-36 (EHT MAC)
