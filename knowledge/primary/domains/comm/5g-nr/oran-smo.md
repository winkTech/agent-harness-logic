---
title: "O-RAN SMO — 服务管理与编排 / A1-O1 接口"
tags: [comm, 5g-nr, oran, smo, o1, a1]
description: "SMO (Service Management and Orchestration) 是 O-RAN 架构中所有管理和编排功能的集合体。它负责管理 Non-RT RIC (非实时 RAN 智能控制器) 以及所有的 O-RAN 网元 (O-CU、O-DU、O-RU)。"
related: [5g-nr/bfp-compression.md, 5g-nr/dfe-architecture.md, 5g-nr/fr2-beam-management.md, 5g-nr/lowphy-architecture.md, 5g-nr/mimo-detection.md, 5g-nr/nr-frame-structure.md]
---
# O-RAN SMO — 服务管理与编排 / A1-O1 接口

> 最后更新: 2026-06-04
> 关联: [[oran-interface]], [[oran-ric]], [[lowphy-architecture]], [[bfp-compression]]

---

## 1. SMO 概述

### 1.1 SMO 在 O-RAN 架构中的定位

SMO (Service Management and Orchestration) 是 O-RAN 架构中所有管理和编排功能的集合体。它负责管理 Non-RT RIC (非实时 RAN 智能控制器) 以及所有的 O-RAN 网元 (O-CU、O-DU、O-RU)。

```
┌─────────────────────────────────────────────────────────────┐
│                         SMO                                 │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                    Non-RT RIC                        │   │
│  │  ┌─────────┐  ┌─────────┐  ┌──────────────────┐     │   │
│  │  │  rApp 1 │  │  rApp 2 │  │  A1 策略引擎     │     │   │
│  │  │ (ML训练) │  │ (策略优化)│  │  (Policy/Enrich) │     │   │
│  │  └─────────┘  └─────────┘  └──────────────────┘     │   │
│  └──────────────────────────────────────────────────────┘   │
│         │ A1                    │ O1              │ O2       │
└─────────┼──────────────────────┼─────────────────┼─────────┘
          │                      │                 │
    ┌─────┴─────┐    ┌───────────┼─────┬───────────┼──────┐
    │ Near-RT   │    │           │     │           │      │
    │   RIC     │    │   O-CU    │   O-DU         │ O-Cloud  │
    │  (xApp)   │    │           │     │           │  (Infra) │
    └─────┬─────┘    └─────┬─────┘     │           └──────────┘
          │ E2              │ F1        │
          │                 │           │ ORAN CUS (前传)
    ┌─────┴─────────────────┴───────────┴─────┐
    │                  O-RU                    │
    └──────────────────────────────────────────┘
```

### 1.2 SMO 框架

SMO 是 O-RAN 网络管理和编排的上层框架，包含以下核心功能模块：

| 模块 | 功能 | 接口 |
|:----|:-----|:-----|
| **Non-RT RIC** | 非实时 RAN 智能控制，rApp 托管，A1 策略生成 | A1 (→ Near-RT RIC) |
| **FCAPS 管理** | 故障/配置/计费/性能/安全管理 | O1 (→ 所有网元) |
| **O-Cloud 管理** | 基础设施编排，VNF/CNF 生命周期管理 | O2 (→ O-Cloud) |
| **切片管理** | NSSI 编排，SLA 保障 | NSMF/NSSMF 内部接口 |
| **安全框架** | 零信任安全，证书管理，接口加密 | WG11 安全规范 |

### 1.3 SMO 与 NFV MANO 的关系

SMO 与 ETSI NFV MANO 架构互补而非替代：

| 层面 | SMO 职责 | NFV MANO 职责 |
|:----|:---------|:--------------|
| **编排** | RAN 域业务编排 (FCAPS/切片/策略) | 通用 NFV 编排 (VNF/CNF 生命周期) |
| **管理对象** | O-RAN 网元 (O-CU/O-DU/O-RU) | 虚拟化资源 (计算/存储/网络) |
| **接口** | A1/O1/O2 (RAN 专用) | Os-Ma-nfvo/Ve-Vnfm/Nf-Vi (NFV 通用) |
| **关联** | SMO 通过 O2 接口调用 MANO 进行 VNF 部署 | MANO 向 SMO 暴露虚拟化资源状态 |

```
SMO (RAN 域编排)
  │
  │ O2 (基础设施管理)
  ▼
NFV MANO (NFVO → VNFM → VIM)
  │
  │ Nf-Vi
  ▼
NFVI (计算/存储/网络资源池)
```

---

## 2. O1 接口 — FCAPS 管理

### 2.1 接口定位

O1 是 SMO 与 O-RAN 网元 (O-CU、O-DU、O-RU) 之间的管理接口，承载 FCAPS 五大管理功能。O1 接口对应的南向协议是 NETCONF/YANG。

```
SMO (FCAPS Manager)
  │
  │ O1 (NETCONF/YANG over SSH/TLS)
  ▼
┌──────┬──────┬──────┐
│ O-CU │ O-DU │ O-RU │
└──────┴──────┴──────┘
```

### 2.2 FCAPS 五大管理功能

#### Fault Management (故障管理)

| 功能 | 描述 | 典型操作 |
|:----|:-----|:---------|
| 告警上报 | 网元主动推送告警通知 | `notification` (NETCONF) |
| 告警同步 | SMO 主动查询当前活跃告警 | `get-alarm-list` |
| 故障定位 | 关联分析多个网元告警 | 根因分析 → 隔离故障网元 |
| 告警分级 | Critical/Major/Minor/Warning | 按 O-RAN 定义阈值 |
| 心跳检测 | 周期性检测网元连通性 | NETCONF `keep-alive` |

**O-RU 典型告警项**：

| 告警 | 级别 | 触发条件 | 处理动作 |
|:----|:----|:---------|:---------|
| VSWR 过高 | Critical | VSWR > 3.0 | 关闭 PA，上报 SMO |
| 温度过高 | Major | 结温 > 105°C | 降功率运行 |
| PLL 失锁 | Critical | 参考时钟丢失 | 切换 Holdover 模式 |
| 前传链路断 | Critical | eCPRI 链路 LOS | 触发保护倒换 |
| CPR 压缩饱和 | Minor | BFP exponent == 0 | 上报 PM 计数器 |

#### Configuration Management (配置管理)

| 配置类别 | 参数示例 | 配置方式 |
|:---------|:---------|:---------|
| **射频参数** | 中心频率 (NR-ARFCN)、带宽 (BW)、发射功率 (dBm) | NETCONF `edit-config` |
| **物理层参数** | SCS (15/30/60/120kHz)、CP 类型、FFT 尺寸 | YANG 模型下发 |
| **TDD 配置** | TDD 时隙模式 (pattern period/direction)、GP 长度 | O-RAN TDD YANG |
| **PRACH 参数** | PRACH 配置索引、根序列、零相关区配置 | `prach-configuration` |
| **波束配置** | 波束 ID、方位角/倾角、波束权值矩阵 | `beam-config` |
| **压缩参数** | BFP 位宽 (6/8/10/12/14 bit)、压缩方法 (block-floating/modulation) | `compression-config` |
| **载波聚合** | CC 列表、带宽组合、SCS 组合 | `ca-config` |

**NETCONF 配置操作示例**：

```
<rpc message-id="101">
  <edit-config>
    <target><running/></target>
    <config>
      <o-ran-hardware xmlns="urn:o-ran:hardware:1.0">
        <tx-array-carrier>
          <name>TX0</name>
          <center-of-channel-bandwidth>645008</center-of-channel-bandwidth>
          <channel-bandwidth>100000000</channel-bandwidth>
          <power>33.0</power>
        </tx-array-carrier>
      </o-ran-hardware>
    </config>
  </edit-config>
</rpc>
```

#### Accounting Management (计费管理)

| 统计项 | 粒度 | 用途 |
|:-------|:----|:-----|
| 单用户流量 (UL/DL) | 每 UE/每 QFI | 计费记录生成 |
| PRB 占用量 | 每 UE/每切片 | 资源使用审计 |
| 连接时长 | 每 PDU 会话 | 按时长计费 |
| QoS Flow 统计 | 每 5QI | SLA 合规验证 |

#### Performance Management (性能管理)

**PM 计数器采集**：

| 分类 | KPI | 采集周期 | 定义 |
|:----|:----|:--------:|:-----|
| **接入类** | RRC 连接成功率 | 5min/15min | RRC Setup Success / Attempt |
| **保持类** | RRC 连接掉线率 | 5min/15min | 异常释放数 / 平均用户数 |
| **移动类** | 切换成功率 (同频/异频/Inter-gNB) | 5min/15min | HO Success / HO Attempt |
| **可用性** | 小区可用性 (%) | 15min | 可用时间 / 总时间 |
| **流量** | DL/UL PRB 利用率 (%) | 5min | 已用 PRB / 可用 PRB |
| **吞吐量** | 用户面 DL/UL 吞吐量 (Mbps) | 5min | PDCP 层 SDU 吞吐量 |
| **时延** | 用户面单向时延 (ms) | 15min | gNB-DU 入口 → 空口 |
| **DRB** | DRB 建立成功率 | 5min | DRB Setup Success / Attempt |
| **RF** | RSSI/RSRP/RSRQ/SINR 分布 | 15min | 按区间分桶统计 |

**PM 数据流**：

```
O-RU/O-DU/O-CU ──(O1 PM streaming)──→ SMO 性能采集
    → 聚合/关联 → KPI 计算 → 阈值监控 → 触发优化策略
```

#### Security Management (安全管理)

| 安全功能 | 机制 | 实现位置 |
|:---------|:----|:---------|
| **设备认证** | X.509 证书 + IEEE 802.1x | O-RU 上电认证 |
| **用户鉴权** | OAuth 2.0 / JWT | SMO 北向 API |
| **传输加密** | TLS 1.3 (O1 接口) | NETCONF over TLS |
| **数据完整性** | HMAC-SHA256 | YANG 数据存储 |
| **访问控制** | RBAC (基于角色的访问控制) | SMO 管理面 |
| **安全审计** | Syslog + 审计日志 | 所有管理操作 |
| **安全启动** | Secure Boot + TPM | O-RU 固件验证 |

### 2.3 NETCONF/YANG 协议栈

O1 接口的南向协议栈：

```
┌─────────────────────────────────┐
│           O-RAN YANG 模型        │
│  ┌──────────┐ ┌──────────┐      │
│  │ O-RAN    │ │ O-RAN    │ ...  │
│  │ Hardware │ │ Software │      │
│  └──────────┘ └──────────┘      │
├─────────────────────────────────┤
│            NETCONF              │
│  (get/get-config/edit-config/   │
│   notification/delete-config)   │
├─────────────────────────────────┤
│            SSH / TLS            │
├─────────────────────────────────┤
│            TCP/IP               │
└─────────────────────────────────┘
```

**NETCONF 核心操作**：

| 操作 | 描述 | 方向 |
|:----|:-----|:-----|
| `<get>` | 获取运行状态数据 | SMO → 网元 |
| `<get-config>` | 获取配置数据 | SMO → 网元 |
| `<edit-config>` | 修改配置 (创建/更新/删除) | SMO → 网元 |
| `<delete-config>` | 删除整个配置数据库 | SMO → 网元 |
| `<lock>` / `<unlock>` | 锁定/解锁配置 (防并发冲突) | SMO → 网元 |
| `<notification>` | 事件/告警上报 | 网元 → SMO |

**O-RAN 定义的 YANG 模型分类**：

| YANG 模块 | 管理对象 | 参考规范 |
|:----------|:---------|:---------|
| `o-ran-hardware` | O-RU 硬件 (射频/天线/PA) | O-RAN.WG4.MP |
| `o-ran-software-management` | 软件版本/固件升级 | O-RAN.WG4.MP |
| `o-ran-operations` | O-RU 运维 (告警/PM) | O-RAN.WG4.MP |
| `o-ran-sync` | 同步配置 (PTP/SyncE) | O-RAN.WG4.MP |
| `o-ran-module-cap` | O-RU 能力声明 | O-RAN.WG4.MP |
| `o-ran-compression` | IQ 压缩参数 | O-RAN.WG4.MP |
| `o-ran-trace` | MDT/追踪功能 | O-RAN.WG4.MP |
| `o-ran-beamforming` | 波束赋形权值 | O-RAN.WG4.MP |
| `o-ran-shared-cell` | 共享小区 (多 O-RU) | O-RAN O1-Interface |
| `o-ran-mplane-int` | M-plane 互通接口 | O-RAN O1-Interface |
| `o-ran-fan` | 风扇/散热管理 | O-RAN O1-Interface |
| `o-ran-energy-saving` | 节能策略 | O-RAN O1-Interface |

### 2.4 O1 接口实现栈

```
┌──────────────────────────────────────────────────┐
│ SMO / O1-Proxy                                   │
│                                                  │
│  ┌──────────────────────────────────────────────┐│
│  │  O1 Mediator (YANG 模型适配 + 数据聚合)       ││
│  └──────────────────────────────────────────────┘│
│                      │                           │
│                      │ NETCONF                   │
│                      ▼                           │
│  ┌──────────────────────────────────────────────┐│
│  │  NETCONF Client (SSH/TLS transport)           ││
│  └──────────────────────────────────────────────┘│
└──────────────────────┬───────────────────────────┘
                       │
          ═════════════╪══════════════
           O1 (NETCONF over TLS)
          ═════════════╪══════════════
                       │
┌──────────────────────┴───────────────────────────┐
│ 网元 (O-CU / O-DU / O-RU)                        │
│  ┌──────────────────────────────────────────────┐│
│  │  NETCONF Server (TLS 终结)                    ││
│  └──────────────────────────────────────────────┘│
│  ┌──────────────────────────────────────────────┐│
│  │  YANG Datastore (配置/状态 数据库)            ││
│  └──────────────────────────────────────────────┘│
└──────────────────────────────────────────────────┘
```

---

## 3. A1 接口 — 策略与 ML

### 3.1 接口定位

A1 是 Non-RT RIC (位于 SMO 内) 与 Near-RT RIC 之间的策略接口，用于下发 RAN 优化策略和机器学习模型。

```
┌──────────────────────────────────────────┐
│              SMO / Non-RT RIC             │
│                                          │
│  ┌────────┐  ┌────────┐  ┌───────────┐   │
│  │ rApp 1 │  │ rApp N │  │ A1 终端   │   │
│  │(流量预测)│  │(ML训练) │  │(策略生成) │   │
│  └────────┘  └────────┘  └─────┬─────┘   │
└────────────────────────────────┼─────────┘
                                 │
                    A1 (REST/HTTP2)
                    Policy / EI / ML
                                 │
┌────────────────────────────────┼─────────┐
│           Near-RT RIC          │         │
│  ┌─────────────────────────────┴─────┐   │
│  │     A1 终端 (策略接收+冲突解决)     │   │
│  └───────────────────────────────────┘   │
│  ┌──────┐ ┌──────┐ ┌──────┐            │
│  │ xApp │ │ xApp │ │ xApp │            │
│  │(QoE) │ │(调度)│ │(ML推理)│            │
│  └──────┘ └──────┘ └──────┘            │
└──────────────────────────────────────────┘
```

### 3.2 A1 策略类型

| 策略类型 | 英文 | 描述 | 执行方式 | 示例 |
|:--------|:----|:-----|:---------|:-----|
| **A1-P** | Policy | 声明式策略：定义优化目标/约束/条件 | Near-RT RIC 自主决策执行 | "PRB 利用率 >80% 时触发负载均衡" |
| **A1-EI** | Enrichment Information | 丰富信息：提供外部数据辅助 Near-RT RIC 决策 | Near-RT RIC 消费 | UE 历史轨迹/预测负载/频谱占用图 |
| **A1-En** | Enforcement | 强制策略：硬性配置，Near-RT RIC 必须执行 | Near-RT RIC 强制执行 | 最大发射功率限制/频段锁定 |

**A1-P 策略结构**：

```
┌─────────────────────────────────────────┐
│            A1 Policy                    │
├─────────────────────────────────────────┤
│  - Policy ID (全局唯一)                  │
│  - Scope (作用域: Cell/Slice/UE Group)   │
│  - Policy Statement:                    │
│    ┌─ Target (目标): 最小化 X            │
│    ├─ Constraint (约束): Y < Z           │
│    └─ Condition (条件): 当 A 满足时      │
│  - Priority (优先级, 冲突时使用)          │
│  - Validity Period (有效期)             │
└─────────────────────────────────────────┘
```

### 3.3 A1 EI (Enrichment Information)

Non-RT RIC 向 Near-RT RIC 提供的外部丰富信息：

| EI 类型 | 数据来源 | 消费方 | 用途 |
|:--------|:---------|:-------|:-----|
| **UE 移动轨迹预测** | Non-RT RIC ML 模型 | xApp (移动性管理) | 预判切换目标小区 |
| **负载预测** | SMO 历史 KPI 分析 | xApp (负载均衡) | 提前调整资源分配 |
| **频谱占用图** | 外部频谱感知/数据库 | xApp (频谱管理) | 动态频谱共享 |
| **天气/环境数据** | 外部数据源 | xApp (覆盖优化) | 雨衰补偿/波束调整 |
| **邻区关系建议** | ANR 自动邻区关系 | xApp (SON) | PCI 冲突避免 |
| **UE 能力画像** | 历史 UE 能力统计 | xApp (调度器) | 调度策略适配 |

### 3.4 A1-ML (R17+) — 机器学习模型管理

ML 模型生命周期：

```
Non-RT RIC (SMO 内)
  │
  │ 1. 数据采集: O1 PM 计数器, E2 测量报告, 外部数据
  ├─ 2. 模型训练: 离线训练 (TensorFlow/PyTorch → ONNX)
  │
  │ 3. A1-ML: 模型分发 (Model Package + Metadata)
  ▼
Near-RT RIC
  │
  │ 4. 模型部署: 加载到推理引擎
  ├─ 5. 模型推理: xApp 消费推理结果做实时决策
  │
  │ 6. E2/A1: 推理反馈 (推理准确度/决策效果)
  ▼
Non-RT RIC (模型更新/重训练)
```

**ML 模型管理功能**：

| 功能 | 描述 |
|:----|:-----|
| **模型注册** | 模型 ID/版本/类型/输入输出格式定义 |
| **模型部署** | 模型文件分发到 Near-RT RIC |
| **模型激活** | 切换到指定模型版本 |
| **模型回退** | 推理效果下降时回退到前版本 |
| **模型监控** | 推理延迟/准确度/资源占用 |
| **模型终止** | 停止推理，释放资源 |

**典型 ML 用例**：

| 用例 | 模型类型 | 推理位置 | 优化目标 |
|:----|:---------|:---------|:---------|
| 流量预测 | LSTM/Transformer | Near-RT RIC | 预调度、节能 |
| UE 移动预测 | Seq2Seq | Near-RT RIC | 切换优化、预加载 |
| 频谱感知 | CNN/DNN | Near-RT RIC / O-DU | 频谱共享决策 |
| KPI 异常检测 | Autoencoder | Near-RT RIC | 故障预测 |
| QoS 预测 | Gradient Boosting | Near-RT RIC | 切片 SLA 保障 |
| 信道预测 | RNN/Transformer | O-DU | MCS 选择、预编码 |

### 3.5 A1 策略目标

| 策略目标 | 描述 | 涉及网元 |
|:---------|:-----|:---------|
| **QoS 保障** | 确保每 5QI 的时延/丢包/吞吐满足 SLA | xApp (QoE) + O-DU 调度器 |
| **切片 SLA** | 每 NSSI 的 PRB/吞吐按比例分配 | xApp (切片管理) + O-CU |
| **负载均衡** | 用户分布不均时触发切换/重选 | xApp (移动性) + gNB |
| **干扰协调** | 邻区干扰检测 → 功率/频域/时域协调 | xApp (ICIC) + O-DU |
| **节能** | 低负载时小区关断/符号关断/通道关断 | xApp (ES) + O-RU |
| **覆盖优化** | 自动调整下倾角/波束权值 | xApp (覆盖) + O-RU |
| **RACH 优化** | PRACH 参数动态调整 | xApp + O-CU |

---

## 4. O-RAN 闭环自动化

### 4.1 闭环分层

O-RAN 定义了四层闭环控制，从 O-RU 内部的亚毫秒级控制到 SMO 内的秒级以上策略优化：

| 层级 | 控制对象 | 响应时间 | 控制环 | 实现位置 | 示例 |
|:----|:---------|:--------:|:------|:---------|:-----|
| **L1 (RF/PHY)** | 射频链路 | < 1ms | 内环 | O-RU 内部 | AGC (自动增益控制)、DPD (数字预失真) 自适应、CFR 峰值检测 |
| **L2 (MAC/RLC)** | 调度/链路适配 | 1-10ms | 中环 | O-DU 调度器 | PRB 调度、MCS 选择、HARQ 重传、波束选择 |
| **L3 (RIC)** | RAN 优化 | 10ms-1s | 近实时 | Near-RT RIC (xApp) | 负载均衡、QoE 优化、干扰协调、移动性优化 |
| **L4 (SMO)** | 策略/编排 | > 1s | 非实时 | Non-RT RIC (rApp) | 网络切片编排、ML 模型训练、覆盖优化、节能策略 |

**关键区别**：

- L1/L2 是**网元内部**闭环，响应最快，处理 PHY/MAC 层实时操作。
- L3 是 **RIC 近实时**闭环，xApp 通过 E2 接口控制 O-DU/O-CU 行为。
- L4 是 **SMO 非实时**闭环，rApp 通过 A1 策略指导 Near-RT RIC，通过 O1 收集 PM 数据。

### 4.2 闭环自动化流程示例

以**干扰协调**为例，展示四层闭环协作：

```
时间轴 →

L1 (O-RU):     [──────── 持续 AGC/DPD 调整 ────────]
                             │
L2 (O-DU):     [─── 每 TTI 调度/链路适配 ───]
                             │  ↑ 检测到邻区干扰
                             │  │ (RSSI 异常上升)
                             ▼  │
L3 (Near-RT):       ┌─────────────────────┐
                    │ xApp (ICIC)          │
                    │ - 调整功率/PRB 分配   │──→ E2 → O-DU
                    │ - 上报异常到 SMO      │
                    └─────────┬───────────┘
                              │ A1 (上报干扰事件)
                              ▼
L4 (SMO):             ┌─────────────────────────────────┐
                      │ rApp (覆盖/干扰分析)              │
                      │ 1. 聚合多小区 O1 PM 数据          │
                      │ 2. 分析干扰根因 (模型/频谱)        │
                      │ 3. 生成 A1-P 策略 (功率模板)      │
                      │ 4. 下发策略到 Near-RT RIC         │
                      └──────────────┬──────────────────┘
                                     │ A1-P 策略
                                     ▼
L3 (Near-RT):       ┌─────────────────────┐
                    │ xApp 执行策略:       │
                    │ - 长期功率约束       │
                    │ - 频域资源隔离方案   │
                    └──────────┬──────────┘
                               │ E2 (控制)
                               ▼
L2 (O-DU):     [─── 调整后的调度策略 ───]
                               │
                               │ O1 (PM 反馈: 干扰改善)
                               ▼
L4 (SMO):             ┌─────────────────────┐
                      │ rApp 验证策略效果    │
                      │ → 闭环完成          │
                      └─────────────────────┘
```

### 4.3 闭环关键指标

| 指标 | L1/L2 (实时) | L3 (近实时) | L4 (非实时) |
|:----|:-----------:|:----------:|:----------:|
| **采集周期** | 每符号/每 TTI | 10ms-1s | 5min-1h |
| **决策延迟** | <1ms / <10ms | 10ms-1s | 1s-数分钟 |
| **作用范围** | 单 O-RU / 单小区 | 单 gNB / 局部区域 | 全网 / 多 gNB |
| **优化目标** | 瞬时性能 | 短期用户体验 | 长期网络效率 |
| **数据量** | 极高 (每样本) | 中等 (流式) | 大 (批量) |

---

## 5. O-Cloud

### 5.1 O-Cloud 定义

O-Cloud 是 O-RAN 网元的云化部署平台，提供虚拟化基础设施承载 O-CU、O-DU (可选)、Near-RT RIC 等网元功能。

```
┌──────────────────────────────────────────────────┐
│                    SMO                           │
│  ┌────────────────────────────────────────────┐  │
│  │         O-Cloud Manager (O2 接口)           │  │
│  │   - 资源编排  - 容量规划  - 故障管理        │  │
│  └────────────────────┬───────────────────────┘  │
└───────────────────────┼──────────────────────────┘
                        │ O2
┌───────────────────────┼──────────────────────────┐
│                 O-Cloud                           │
│  ┌────────────────────┴───────────────────────┐  │
│  │        虚拟化基础设施层 (NFVI)              │  │
│  │                                            │  │
│  │  ┌──────────┬──────────┬──────────────┐    │  │
│  │  │ VNF/CNF  │ VNF/CNF  │   VNF/CNF    │    │  │
│  │  │ (O-CU)   │ (O-DU)   │ (Near-RT RIC)│    │  │
│  │  └──────────┴──────────┴──────────────┘    │  │
│  │  ┌──────────────────────────────────────┐  │  │
│  │  │       虚拟化平台 (Kubernetes/OpenStack)│  │  │
│  │  └──────────────────────────────────────┘  │  │
│  │  ┌──────────────────────────────────────┐  │  │
│  │  │   硬件层 (x86/ARM/FPGA/eGPU/智能网卡)  │  │  │
│  │  └──────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

### 5.2 O2 接口

O2 是 SMO 与 O-Cloud 之间的基础设施管理接口：

| 管理域 | 功能 | 描述 |
|:-------|:----|:-----|
| **资源编排** | VNF/CNF 部署/伸缩/终止 | SMO 通过 O2 触发 VNF 生命周期操作 |
| **容量管理** | 资源预留/超分配监控 | 确保各 VNF 获取承诺的计算/存储/网络资源 |
| **故障管理** | 基础设施告警/事件 | 服务器故障/磁盘满/网络中断 → SMO |
| **性能管理** | 资源利用率 (CPU/内存/存储/网络) | 虚拟化层 KPI 上报 |
| **镜像管理** | VNF/CNF 镜像仓库 | 镜像上传/版本管理/分发 |

### 5.3 虚拟化部署形态

| 部署形态 | 英文 | 描述 | 适用场景 |
|:---------|:----|:-----|:---------|
| **VNF** | Virtual Network Function | VM 形式，运行在 OpenStack/VMware | 传统演进、O-CU |
| **CNF** | Cloud-native Network Function | 容器形式，运行在 Kubernetes | 云原生、微服务架构 |
| **HNF** | Hybrid Network Function | 部分容器+部分裸机加速 | O-DU L1 加速 |

### 5.4 加速抽象层 (AAL)

AAL (Acceleration Abstraction Layer) 是 O-Cloud 中的硬件加速资源管理层，用于管理 FPGA、eGPU、智能网卡等加速器资源。

```
┌───────────────────────────────────────────┐
│              VNF / CNF (O-DU)              │
│   L2/L3 处理 (软件)     L1 处理 (需加速)    │
└──────────┬────────────────────┬───────────┘
           │                    │ AAL API
           ▼                    ▼
┌──────────────────────────────────────────┐
│    加速抽象层 (AAL)                       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│  │ FPGA     │ │ eGPU     │ │ 智能网卡  │ │
│  │ Manager  │ │ Manager  │ │ Manager  │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ │
└───────┼────────────┼────────────┼───────┘
        ▼            ▼            ▼
   ┌────────┐  ┌────────┐  ┌────────┐
   │  FPGA  │  │  eGPU  │  │  Smart │
   │ 加速卡 │  │ 加速卡 │  │   NIC  │
   └────────┘  └────────┘  └────────┘
```

**AAL 加速资源类型**：

| 加速器 | 典型加速任务 | 接口 |
|:-------|:------------|:-----|
| **FPGA** | FFT/IFFT、前传编解码、BFP 压缩/解压、LDPC 编解码 | PCIe Gen4/5、直接寄存器映射 |
| **eGPU** | MIMO 检测、信道估计矩阵运算、ML 推理 | PCIe + CUDA/OpenCL |
| **智能网卡** | 前传 eCPRI 终止、数据面加速、时间同步 | 以太网端口 + PCIe |
| **ASIC** | 专用加解密、安全加速 | PCIe |

---

## 6. RAN 切片 (Network Slicing)

### 6.1 切片概念

| 概念 | 全称 | 描述 |
|:----|:-----|:-----|
| **S-NSSAI** | Single Network Slice Selection Assistance Information | 单一网络切片标识 |
| **SST** | Slice/Service Type | 切片服务类型 (eMBB/URLLC/mIoT/V2X) |
| **SD** | Slice Differentiator | 切片区分符 (同 SST 内的进一步细分) |
| **NSSI** | Network Slice Subnet Instance | 网络切片子网实例 (RAN/Core/TN 各域切片) |
| **NSI** | Network Slice Instance | 端到端网络切片实例 |
| **NSMF** | Network Slice Management Function | 网络切片管理功能 (跨域编排) |
| **NSSMF** | Network Slice Subnet Management Function | 网络切片子网管理功能 (域内编排) |

### 6.2 标准 SST 值

| SST | 服务类型 | 典型 5QI | 特性 |
|:---:|:---------|:--------|:-----|
| 1 | eMBB | 6/7/8/9 | 高吞吐、大带宽 |
| 2 | URLLC | 3/4/5/65/66/67 | 低时延、高可靠 |
| 3 | MIoT | 70/71/72/73 | 大连接、低功耗 |
| 4 | V2X | 1/2/3 | 车联网、高移动性 |
| 5 | HMTC | 70/71 | 高清视频监控 |

### 6.3 SMO 中的切片管理

```
┌──────────────────────────────────────────────────┐
│                    SMO                           │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │           NSMF (跨域切片编排)                │  │
│  │   端到端 NSI 生命周期管理                    │  │
│  └──────┬──────────────────┬───────────────────┘  │
│         │                  │                      │
│    ┌────┴────┐      ┌──────┴──────┐              │
│    │ NSSMF   │      │   NSSMF    │              │
│    │ (RAN)   │      │   (Core)   │              │
│    └────┬────┘      └────────────┘              │
└─────────┼────────────────────────────────────────┘
          │
          │ 切片配置 (A1/O1)
          ▼
┌──────────────────────────────────────────────────┐
│               RAN 域 (gNB)                        │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │          切片资源隔离                       │  │
│  │  ┌───────┐  ┌───────┐  ┌───────┐          │  │
│  │  │Slice A│  │Slice B│  │Slice C│          │  │
│  │  │(eMBB) │  │(URLLC)│  │(mIoT) │          │  │
│  │  └───┬───┘  └───┬───┘  └───┬───┘          │  │
│  │      │          │          │               │  │
│  │   ┌──┴──────────┴──────────┴──┐            │  │
│  │   │    共享资源池 (RAN 资源)    │            │  │
│  │   └───────────────────────────┘            │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

### 6.4 O-RAN 中的切片资源隔离

| 隔离机制 | 实现方式 | 隔离粒度 |
|:---------|:---------|:---------|
| **PRB 预留** | 每切片分配最小/最大 PRB 占比 | 频域 |
| **调度优先级** | 不同切片配置不同调度权重 | 时域+频域 |
| **QoS 映射** | S-NSSAI → 5QI → DRB 映射 | 每 UE 每 Flow |
| **RLC 缓冲区隔离** | 每切片独立 RLC buffer，防止 Head-of-Line Blocking | 缓冲 |
| **前传资源分配** | 不同切片映射到不同的前传流分类 | 传输 |

**切片策略下发流程**：

```
SMO (NSMF) 创建 NSI
  → SMO (RAN NSSMF) 创建 RAN NSSI
    → A1-P: 切片 SLA 目标 (PRB 占比/最大时延/最小吞吐)
      → Near-RT RIC (xApp 切片管理)
        → E2: 切片级调度策略 → O-DU
          → O-DU 调度器按切片优先级分配资源
            → O1 PM: 每切片 KPI 上报 → SMO
              → SMO 验证切片 SLA → 调整策略 (闭环)
```

---

## 7. SMO 与 O-RAN 安全

### 7.1 O-RAN 安全架构原则

O-RAN 安全架构基于**零信任 (Zero Trust)** 原则：

| 原则 | 实现 |
|:----|:-----|
| **永不信任，始终验证** | 每次访问均需认证/授权 |
| **最小权限** | RBAC + 基于声明的访问控制 |
| **深度防御** | 多层安全防护 (传输/应用/平台) |
| **持续监控** | 安全事件实时审计 |
| **安全自动化** | 证书自动轮换/威胁自动响应 |

### 7.2 接口安全

| 接口 | 安全协议 | 加密 | 认证 | 完整性 |
|:----|:--------|:----|:-----|:------|
| **CUS-plane (前传)** | IPSec / MACsec | AES-256-GCM | 证书/PSK | HMAC-SHA256 |
| **O1 (管理)** | TLS 1.3 | AES-256-GCM | X.509 证书 | HMAC-SHA256 |
| **A1 (策略)** | TLS 1.3 / mTLS | AES-256-GCM | 双向 X.509 | HMAC-SHA256 |
| **E2 (RIC)** | TLS 1.3 / IPSec | AES-256-GCM | X.509 证书 | HMAC-SHA256 |
| **O2 (云)** | TLS 1.3 | AES-256-GCM | X.509 / OAuth 2.0 | HMAC-SHA256 |
| **F1 (CU-DU)** | IPSec / DTLS | AES-256-GCM | 证书/PSK | HMAC-SHA256 |

**安全协议选择逻辑**：

- **前传/中传 (CUS/F1)**：优先 IPSec (低延迟)，可选 MACsec (L2 加密)。
- **管理/控制面 (O1/A1/E2/O2)**：使用 TLS 1.3 (应用层安全)。

### 7.3 O-RAN SC (Security Component)

O-RAN 安全架构定义了以下安全组件：

| 组件 | 功能 | 部署位置 |
|:----|:-----|:---------|
| **PKI/CA** | 证书颁发/撤销/更新 | SMO 内 |
| **AAA** | 认证/授权/计费 | SMO 内 |
| **SecGW** | IPSec 网关 (前传/中传) | O-DU ↔ O-RU 之间 |
| **API Gateway** | API 认证/速率限制/审计 | SMO 北向 |
| **HMS** | 硬件安全模块 (密钥存储) | SMO / O-Cloud |
| **SIEM** | 安全事件关联分析 | SMO 内 |

### 7.4 安全协商流程

以 O-RU 上电安全接入为例：

```
O-RU 上电启动
  │
  │ 1. DHCP: 获取 IP 地址 + SMO/Auth 服务器地址
  ▼
  │ 2. Secure Boot: 验证固件签名 (TPM + 信任链)
  ▼
  │ 3. 设备认证: IEEE 802.1x (EAP-TLS) → 网络准入
  ▼
  │ 4. 证书注册: EST (Enrollment over Secure Transport)
  │    - 向 CA 申请 O-RU 操作证书
  │    - CA 验证设备身份后签发
  ▼
  │ 5. NETCONF Call Home: O-RU 主动连接 SMO
  │    - TLS 1.3 双向认证 (mTLS)
  │    - NETCONF over TLS 建立
  ▼
  │ 6. 配置下发: SMO 通过 O1 下发 O-RU 运行配置
  ▼
  │ 7. 正常运行: 定期证书检查 + 安全审计
```

---

## 8. 相关标准

### 8.1 O-RAN 联盟规范

| 规范编号 | 标题 | 版本 (参考) | 内容 |
|:--------|:-----|:-----------|:-----|
| **O-RAN.WG1.OAM-Architecture** | OAM Architecture and Requirements | v06.00 | SMO 框架、O1/O2 接口架构 |
| **O-RAN.WG1.O1-Interface** | O1 Interface Specification | v05.00 | NETCONF/YANG 模型定义、FCAPS 流程 |
| **O-RAN.WG3.RICAP** | RIC A1 Policy (RICAP) | v03.00 | A1 策略模型、A1-P/A1-EI 格式 |
| **O-RAN.WG3.E2SM** | E2 Service Models | v03.00 | E2 接口服务模型 (KPM/RC/NI) |
| **O-RAN.WG4.MP** | Management Plane (M-Plane) | v07.00 | O-RU 管理面 YANG 模型 |
| **O-RAN.WG6.O-Cloud** | O-Cloud Reference Design | v04.00 | O-Cloud 架构、AAL 加速抽象 |
| **O-RAN.WG11.Security** | Security Requirements and Controls | v05.00 | 零信任安全、接口安全 |
| **O-RAN.WG11.Security-TLS** | TLS Security Protocol Profiles | v03.00 | TLS 1.3 配置 Profile |

### 8.2 关联标准组织

| 标准组织 | 关联规范 | 涉及 O-RAN 模块 |
|:---------|:---------|:---------------|
| **3GPP** | TS 28.530/TS 28.531 (切片管理)、TS 38.xxx (NR PHY/MAC/RLC) | 切片/NR 协议栈 |
| **ETSI NFV** | GS NFV-MAN 001 (MANO)、GS NFV-IFA (接口架构) | O-Cloud/VNF 管理 |
| **IETF** | RFC 6241 (NETCONF)、RFC 7950 (YANG)、RFC 8446 (TLS 1.3) | O1/A1 协议栈 |
| **IEEE** | 1588-2019 (PTP)、802.1x (网络准入) | S-plane 同步 + 安全 |

### 8.3 规范阅读建议

```
入门路径:
  O-RAN.WG1.OAM-Architecture → O-RAN.WG3.RICAP → O-RAN.WG1.O1-Interface

深入路径:
  O-RAN.WG4.MP + YANG 模型文件 → O-RAN.WG6.O-Cloud → O-RAN.WG11.Security

实现路径:
  O-RAN.WG1.O1-Interface (NETCONF call flows) → O-RAN.WG3.E2SM → O-RAN.WG4.MP
```

---

## 附录 A: 缩略语表

| 缩写 | 全称 | 中文 |
|:----|:-----|:-----|
| A1 | — | Non-RT RIC 与 Near-RT RIC 间策略接口 |
| A1-EI | A1 Enrichment Information | A1 丰富信息 |
| A1-P | A1 Policy | A1 策略 |
| AAL | Acceleration Abstraction Layer | 加速抽象层 |
| CNF | Cloud-native Network Function | 云原生网络功能 |
| eCPRI | enhanced Common Public Radio Interface | 增强型通用公共无线电接口 |
| FCAPS | Fault/Configuration/Accounting/Performance/Security | 故障/配置/计费/性能/安全管理 |
| gNB | next Generation Node B | 下一代基站 |
| MANO | Management and Orchestration | 管理与编排 |
| NETCONF | Network Configuration Protocol | 网络配置协议 |
| NFV | Network Functions Virtualisation | 网络功能虚拟化 |
| NFVI | NFV Infrastructure | NFV 基础设施 |
| NFVO | NFV Orchestrator | NFV 编排器 |
| NSI | Network Slice Instance | 网络切片实例 |
| NSMF | Network Slice Management Function | 网络切片管理功能 |
| NSSI | Network Slice Subnet Instance | 网络切片子网实例 |
| NSSMF | Network Slice Subnet Management Function | 网络切片子网管理功能 |
| O-CU | O-RAN Central Unit | O-RAN 中央单元 |
| O-DU | O-RAN Distributed Unit | O-RAN 分布式单元 |
| O-RU | O-RAN Radio Unit | O-RAN 射频单元 |
| O1 | — | SMO 与 O-RAN 网元间管理接口 |
| O2 | — | SMO 与 O-Cloud 间基础设施管理接口 |
| rApp | non-real-time RAN Application | 非实时 RAN 应用 |
| RIC | RAN Intelligent Controller | RAN 智能控制器 |
| SMO | Service Management and Orchestration | 服务管理与编排 |
| S-NSSAI | Single Network Slice Selection Assistance Information | 单一网络切片选择辅助信息 |
| SST | Slice/Service Type | 切片/服务类型 |
| VNF | Virtual Network Function | 虚拟网络功能 |
| VNFM | VNF Manager | VNF 管理器 |
| xApp | near-real-time RAN Application | 近实时 RAN 应用 |
| YANG | Yet Another Next Generation | 数据建模语言 (IETF) |

