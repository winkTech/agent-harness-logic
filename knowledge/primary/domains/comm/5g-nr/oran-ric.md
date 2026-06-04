# O-RAN RIC -- RAN Intelligent Controller & E2 接口

> 最后更新: 2026-06-04
> 关联: [[overview]], [[oran-interface]], [[lowphy-architecture]]

---

## 1. RIC 概述

### 1.1 RIC 在 O-RAN 架构中的位置

O-RAN 联盟在传统 3GPP NG-RAN 架构 (CU/DU/RU) 之上引入 RAN Intelligent Controller (RIC)，实现无线资源管理的智能化与开放化。RIC 分为两级：Non-RT RIC (非实时) 和 Near-RT RIC (近实时)。

```
                         ┌─────────────────────────────────┐
                         │          SMO / Non-RT RIC       │
                         │  (rApp / 策略管理 / ML训练)       │
                         └──┬──────────┬──────────┬────────┘
                            │ A1       │ O1       │ O1
              ┌─────────────┴──┐    ┌──┴──────┐    ┌──┴──────────┐
              │  Near-RT RIC   │    │         │    │             │
              │ (xApp / R-NIB) │    │  gNB-CU │    │  gNB-DU+RU  │
              └────────┬───────┘    └──┬──┬───┘    └──────┬──────┘
                       │ E2            │  │ F1            │
                       └───────────────┘  └───────────────┘
```

### 1.2 两级 RIC 对比

| 特性 | Near-RT RIC | Non-RT RIC |
|:----|:-----------|:-----------|
| **控制环路时延** | 10 ms ~ 1 s | > 1 s (分钟到天级) |
| **部署位置** | gNB 侧或边缘云 | 集中式 SMO (Service Management & Orchestration) |
| **应用类型** | xApp | rApp |
| **对外接口** | E2 (连接 CU/DU), A1 (接收策略), O1 (管理) | A1 (策略下发), O1 (网元管理), R1 (服务化) |
| **数据基础** | R-NIB (RIC Network Information Base) | 长期数据分析 / ML 训练 |
| **典型功能** | 实时负载均衡 / 干扰协调 / QoS 优化 / 波束管理 | 网络规划 / 策略优化 / ML 模型训练 / 节能策略 |

---

## 2. Near-RT RIC 架构

### 2.1 内部功能模块

```
┌───────────────────────────────────────────────────────────────┐
│                     Near-RT RIC Platform                       │
│                                                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │  xApp A  │  │  xApp B  │  │  xApp C  │  │   ...    │     │
│  │(流量导向) │  │(QoS优化) │  │(干扰协调) │  │          │     │
│  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └──┬───────┘     │
│        │              │              │           │             │
│        └──────────────┼──────────────┼───────────┘             │
│                       ▼              ▼                         │
│              ┌────────────────────────────┐                    │
│              │    Conflict Mitigation     │  ← 多 xApp 冲突检测  │
│              └────────────┬───────────────┘                    │
│                           ▼                                    │
│              ┌────────────────────────────┐                    │
│              │   R-NIB (Network Info Base)│  ← 实时网络拓扑数据库 │
│              │  - UE/RAN 上下文           │                    │
│              │  - 近实时 KPM 数据          │                    │
│              └────────────┬───────────────┘                    │
│                           ▼                                    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              E2 Termination (E2AP 协议栈)                │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐              │   │
│  │  │ E2SM-KPM │  │ E2SM-RC  │  │ E2SM-NI  │  ...         │   │
│  │  └──────────┘  └──────────┘  └──────────┘              │   │
│  │              │ E2AP │                                    │   │
│  │              │ SCTP │                                    │   │
│  │              │  IP  │                                    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                           │                                    │
└───────────────────────────┼────────────────────────────────────┘
                            │ E2 (SCTP)
              ┌─────────────┴─────────────┐
              │     E2 Node (CU / DU)      │
              └───────────────────────────┘
```

### 2.2 模块说明

| 模块 | 功能 |
|:----|:----|
| **xApp** | 第三方开发的近实时应用，运行在 Near-RT RIC 平台上。通过 E2 接口订阅 E2 Node 数据，分析后下发控制指令 |
| **R-NIB** | RIC Network Information Base -- 实时网络拓扑与状态数据库，存储 UE 上下文、小区负载、KPM 指标，为 xApp 提供统一数据视图 |
| **E2 Termination** | E2AP 协议栈端点，负责 E2 连接的建立、维护、消息路由。承载多个 E2SM (Service Model) 模块 |
| **Conflict Mitigation** | 当多个 xApp 对同一资源 (如某 UE、某小区) 下发冲突的控制指令时，协调优先级、合并或拒绝请求 |
| **API / Framework** | 为 xApp 提供标准化的数据订阅接口 (Subscribe/Notify) 和控制下发接口 (Control Request/Confirm) |

### 2.3 xApp 类型举例

| xApp 类型 | 功能描述 | 使用的 E2SM |
|:---------|:--------|:----------|
| **流量导向 (Traffic Steering)** | 监测小区负载，调整切换偏移 (CIO)，引导 UE 到负载较轻的小区 | E2SM-KPM, E2SM-RC |
| **QoS 优化 (QoS Optimization)** | 监测每切片/每 QFI 的时延/吞吐量，动态调整调度权重 | E2SM-KPM, E2SM-RC |
| **切片保障 (Slice Assurance)** | 实时监控 SLA 指标，确保网络切片资源隔离与满足 | E2SM-KPM, E2SM-NI |
| **干扰协调 (Interference Mgmt)** | 监测 RSSI/SINR，协调 MU-MIMO 配对或动态调整功率分配 | E2SM-KPM, E2SM-RC |
| **波束优化 (Beam Optimization)** | 基于 UE RSRP 报告优化波束方向和宽度 | E2SM-KPM, E2SM-RC |

> xApp 通过 E2 接口执行两类核心操作：**RIC Subscription** (订阅事件/周期数据) 和 **RIC Control** (下发控制指令)。

---

## 3. E2 接口协议

### 3.1 协议栈

```
┌─────────────────────────────────────────────────┐
│                 E2 协议栈                          │
│                                                   │
│  ┌───────────────────────────────────────┐       │
│  │           E2SM (E2 Service Model)      │       │
│  │  E2SM-KPM │ E2SM-RC │ E2SM-NI │ MHO   │       │
│  │     (服务模型层 -- 定义 RAN Function 语义)   │       │
│  ├───────────────────────────────────────┤       │
│  │           E2AP (E2 Application Protocol)│       │
│  │     (控制面协议 -- 承载 E2 过程消息)       │       │
│  │  [E2 Setup / Subscription / Indication /│       │
│  │   Control / Service Update]             │       │
│  ├───────────────────────────────────────┤       │
│  │                SCTP                     │       │
│  │     (流控传输协议 -- 可靠/保序/多流)      │       │
│  ├───────────────────────────────────────┤       │
│  │                 IP                      │       │
│  └───────────────────────────────────────┘       │
│                                                   │
│  安全层: DTLS / TLS (可选，基于部署场景)            │
└─────────────────────────────────────────────────┘
```

### 3.2 E2AP 过程 (E2 Application Protocol)

#### 3.2.1 E2 Setup Procedure

RIC 与 E2 Node (CU/DU) 之间建立 E2 接口连接的第一步。

| 步骤 | 方向 | 消息 | 内容 |
|:---:|:----|:----|:----|
| 1 | E2 Node → RIC | `E2 SETUP REQUEST` | E2 Node ID, 支持的 RAN Function 列表 (含 E2SM 标识), 能力信息 |
| 2 | RIC → E2 Node | `E2 SETUP RESPONSE` | RIC ID, RIC 接受的 RAN Function 列表, 配置参数 |

**交互流程：**

```
E2 Node (CU/DU)                              Near-RT RIC
     │                                            │
     │  ═══ E2 SETUP REQUEST ═══════════════════→ │
     │     - Global E2 Node ID                    │
     │     - RAN Function List [KPM, RC, NI...]   │
     │     - E2 Node Component Config             │
     │                                            │
     │  ←═══ E2 SETUP RESPONSE ═══════════════════ │
     │     - Global RIC ID                        │
     │     - Accepted RAN Function List           │
     │                                            │
     ▼  (E2 接口就绪，可进行后续订阅/控制)            ▼
```

#### 3.2.2 E2 Node Configuration Update

E2 Node 在配置变更时通知 RIC，或 RIC 主动查询。

| 变体 | 方向 | 描述 |
|:----|:----|:----|
| `RIC SUBSCRIPTION` 触发 | RIC → E2 Node | RIC 订阅 E2 Node 的配置变更通知 |
| **E2 NODE CONFIGURATION UPDATE** | E2 Node → RIC | E2 Node 主动上报配置变更 (小区增加/删除, 能力变化) |
| `E2 NODE CONFIGURATION UPDATE ACKNOWLEDGE` | RIC → E2 Node | RIC 确认收到 |

#### 3.2.3 RIC Subscription (订阅)

xApp 通过 RIC Subscription 从 E2 Node 获取数据，是 E2 接口最核心的数据通路。

| 步骤 | 方向 | 消息 |
|:---:|:----|:----|
| 1 | RIC → E2 Node | `RIC SUBSCRIPTION REQUEST` |
| 2 | E2 Node → RIC | `RIC SUBSCRIPTION RESPONSE` |
| 3 | E2 Node → RIC | `RIC SUBSCRIPTION FAILURE` (如果失败) |
| 4 | RIC → E2 Node | `RIC SUBSCRIPTION DELETE REQUEST` (取消订阅) |

**订阅参数：**

| 参数 | 描述 |
|:----|:----|
| RAN Function ID | 指定服务模型 (如 KPM = 1) |
| E2SM-specific Action | 服务模型具体动作定义 |
| E2SM-specific Trigger | 触发条件 (周期 / 事件驱动) |
| Subsequent Action | 后续动作类型 |

**两种订阅模式：**

| 模式 | 触发方式 | 典型场景 |
|:----|:--------|:--------|
| **Event-Triggered** | 事件触发 (阈值越界/状态变化) | UE 切换成功/失败, RRC 连接建立, PRB 利用率越界 |
| **Periodic** | 周期上报 | 每 100ms 上报小区 KPM, 每 1s 上报 UE 测量 |

#### 3.2.4 RIC Indication (上行数据)

E2 Node 按照订阅配置，向 RIC 发送测量数据或事件通知。

```
E2 Node (CU/DU)                              Near-RT RIC
     │                                            │
     │  ═══ RIC INDICATION ════════════════════→  │
     │     - RIC Request ID (关联订阅)             │
     │     - RAN Function ID                      │
     │     - E2SM-specific Indication Data        │
     │     - Indication Type (Report/Insert)      │
     │                                            │
```

| Indication 类型 | 说明 |
|:---------------|:----|
| **Report** | 响应 RIC Subscription Request，上报请求的数据 |
| **Insert** | E2 Node 主动插入的额外信息 (如紧急告警, 异常事件) |

#### 3.2.5 RIC Control (下行控制)

RIC 向 E2 Node 下发控制指令，是闭环控制的关键。

```
Near-RT RIC                                 E2 Node (CU/DU)
     │                                            │
     │  ═══ RIC CONTROL REQUEST ════════════════→ │
     │     - RIC Request ID                       │
     │     - RAN Function ID                      │
     │     - RIC Control Action (E2SM 定义)        │
     │     - Control Parameters                   │
     │                                            │
     │  ←═══ RIC CONTROL ACKNOWLEDGE ═════════════ │
     │     - 执行结果 (Success/Failure/Cause)       │
     │     - 可选的 Output Data                    │
```

| 控制场景 | E2SM | 控制动作示例 |
|:--------|:----|:-----------|
| 切换偏移调整 | E2SM-RC | 修改某 UE 或某小区的 CIO (Cell Individual Offset) |
| 负载均衡 | E2SM-RC | 调整切换门限 (A3 offset) |
| QoS 参数 | E2SM-RC | 修改某 QFI 的调度权重/优先级 |
| 载波管理 | E2SM-RC | 激活/去激活辅载波 (SCell) |

#### 3.2.6 RIC Service Update

更新 RIC 侧支持的服务 (RAN Function)，通常在 RIC 能力变化或 xApp 安装/卸载时触发。

| 步骤 | 方向 | 消息 |
|:---:|:----|:----|
| 1 | RIC → E2 Node | `RIC SERVICE UPDATE` (新增/删除/修改 RAN Function) |
| 2 | E2 Node → RIC | `RIC SERVICE UPDATE ACKNOWLEDGE` |

### 3.3 E2SM (E2 Service Model) 详解

E2SM 定义了特定 RAN Function 的语义和过程，是 E2 接口的"领域语言"。不同 E2SM 编号 (OID) 对应不同 RAN 功能领域。

| E2SM | OID | 全称 | 功能领域 | 典型数据结构 |
|:----|:---|:----|:--------|:-----------|
| **E2SM-KPM** | 1.3.6.1.4.1.53148.1.2.2.2 | Key Performance Metrics | 性能指标采集 | 小区/UE 级 KPM (吞吐量/时延/PRB利用率/丢包率) |
| **E2SM-RC** | 1.3.6.1.4.1.53148.1.2.2.3 | Radio Resource Control | 无线资源控制 | RRC 配置参数 (CIO/切换门限/载波管理/调度权重) |
| **E2SM-NI** | 1.3.6.1.4.1.53148.1.2.2.4 | Network Interface | 网络接口管理 | 接口状态/IP 路由/隧道/QoS Flow 管理 |
| **E2SM-MHO** | 1.3.6.1.4.1.53148.1.2.2.5 | Mobility Handover Optimization | 移动性切换优化 | UE 移动性参数/A3-A5 事件配置/切换失败原因 |
| **E2SM-CC** | 待定 | Carrier Control | 载波控制 | 载波激活/去激活, CA 配置 |

#### E2SM-KPM -- 关键性能指标

最常用的 E2SM，提供全面的网络性能数据。

| KPM 指标类别 | 示例指标 | 粒度 |
|:-----------|:--------|:---:|
| **接入类** | RRC 连接建立成功率, ERAB 建立成功率 | 小区级 |
| **保持类** | 掉话率, RRC 连接异常释放率 | 小区级 |
| **移动性** | 切换成功率 (同频/异频/异系统), 切换时延 | 小区/UE级 |
| **负载类** | DL/UL PRB 利用率, PDCCH CCE 占用率, 激活 UE 数 | 小区级 |
| **吞吐量** | DL/UL 吞吐量 (per UE, per QFI, per Slice) | UE/切片级 |
| **时延类** | DL/UL 空口时延, Xn/F1 回传时延 | UE/接口级 |

#### E2SM-RC -- 无线资源控制

允许 RIC 直接控制和修改 RAN 的无线资源配置。

| 控制类别 | 控制元 | 可调参数 |
|:--------|:------|:--------|
| **切换控制** | Handover Control | CIO (Cell Individual Offset), A3 offset, TTT (Time To Trigger) |
| **QoS 控制** | QoS Control | 调度权重, 保证比特率 (GBR), 最大比特率 (MBR) |
| **载波控制** | Carrier Control | 载波激活/去激活, SCell 管理 |
| **调度控制** | Scheduling Control | 调度类型 (PF/RR/MaxCQI), 优先级 |
| **功率控制** | Power Control | P0 值, Alpha 因子 |

---

## 4. E2 节点与接口

### 4.1 E2 Node 类型

E2 Node 是实现 E2AP 协议端点的 O-RAN 网元。根据 3GPP/ORAN 架构拆分，E2 Node 可以是：

| E2 Node 类型 | 包含功能 | 接口场景 |
|:------------|:--------|:--------|
| **gNB** | 完整的 CU+DU (不拆分) | 单一 E2 接口连接 |
| **gNB-CU-CP** | RRC, E1AP, F1AP-C, E2AP | 带 CP-UP 分离的 CU 控制面 |
| **gNB-CU-UP** | SDAP, PDCP-U, GTP-U | 带 CP-UP 分离的 CU 用户面 |
| **gNB-DU** | RLC, MAC, High-PHY, F1AP | DU 通过 F1 连 CU，E2 直连 RIC |
| **en-gNB** | EN-DC 中的辅助 gNB | MR-DC 场景 |

### 4.2 E2 接口特性

| 特性 | 规范 |
|:----|:----|
| **传输协议** | SCTP (Stream Control Transmission Protocol) |
| **安全** | DTLS (Datagram TLS) 或 TLS (基于部署场景和运营商策略) |
| **时延要求** | < 10 ms (近实时控制环路) |
| **可靠性** | SCTP 多宿主 + 多流，保证 E2AP 消息的可靠有序传输 |
| **寻址** | 基于 IP 地址 + SCTP 端口 |
| **QoS** | 可通过 DSCP 标记区分 E2AP 消息优先级 |

### 4.3 E2 接口部署拓扑

```
场景 A: 单 E2 Node (gNB 不拆分)
┌──────────┐  E2/SCTP  ┌────────────────────┐
│ Near-RT  │←──────────→│        gNB         │
│   RIC    │            │  (CU+DU 合一)       │
└──────────┘            └────────────────────┘

场景 B: 分离式 gNB (CU+DU 均连 RIC)
┌──────────┐  E2/SCTP  ┌────────────────────┐
│          │←──────────→│     gNB-CU-CP      │
│ Near-RT  │            └────────────────────┘
│   RIC    │  E2/SCTP  ┌────────────────────┐
│          │←──────────→│     gNB-DU         │
└──────────┘            └────────────────────┘

场景 C: 多 E2 Node (RIC 管理多站)
                    ┌────────────────────┐
              ┌────→│     gNB-DU #1      │
┌──────────┐  │     └────────────────────┘
│ Near-RT  │──┼──→  ┌────────────────────┐
│   RIC    │  ├────→│     gNB-DU #2      │
└──────────┘  │     └────────────────────┘
              └────→┌────────────────────┐
                    │     gNB-CU         │
                    └────────────────────┘
```

---

## 5. Non-RT RIC 架构

### 5.1 架构概览

Non-RT RIC 运行在 SMO (Service Management & Orchestration) 框架内，负责非实时的网络优化、策略管理和机器学习模型训练。

```
┌─────────────────────────────────────────────────────────────────┐
│                    SMO (Service Management & Orchestration)       │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                     Non-RT RIC Framework                     │ │
│  │                                                               │ │
│  │  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐            │ │
│  │  │ rApp A │  │ rApp B │  │ rApp C │  │   ...  │            │ │
│  │  │(策略优化)│  │(ML训练) │  │(网络规划)│  │        │            │ │
│  │  └───┬────┘  └───┬────┘  └───┬────┘  └──┬─────┘            │ │
│  │      │           │           │          │                   │ │
│  │      └───────────┼───────────┼──────────┘                   │ │
│  │                  ▼           ▼                               │ │
│  │          ┌────────────────────────┐                          │ │
│  │          │    R1 服务化接口        │                          │ │
│  │          └───────────┬────────────┘                          │ │
│  │                      ▼                                       │ │
│  │          ┌────────────────────────┐                          │ │
│  │          │  Non-RT RIC Framework  │                          │ │
│  │          │  - 数据分析引擎        │                          │ │
│  │          │  - ML 训练/推理引擎     │                          │ │
│  │          │  - 策略管理引擎        │                          │ │
│  │          └───────────┬────────────┘                          │ │
│  └──────────────────────┼──────────────────────────────────────┘ │
│                         │                                         │
└─────────────────────────┼──────────────────────┬─────────────────┘
                          │ A1 (策略)            │ O1 (FCAPS 管理)
              ┌───────────┴───────────┐  ┌───────┴──────────────┐
              │    Near-RT RIC        │  │  O-RAN 网元 (CU/DU/RU)│
              └───────────────────────┘  └──────────────────────┘
```

### 5.2 接口说明

| 接口 | 端点 | 协议 | 功能 |
|:----|:----|:----|:----|
| **A1** | Non-RT RIC → Near-RT RIC | A1AP (基于 HTTP/2 + JSON) | 策略下发、ML 模型部署、近实时控制引导 |
| **O1** | SMO/Non-RT RIC → O-RAN 网元 | NETCONF/YANG | FCAPS 管理 (故障/配置/计费/性能/安全) |
| **R1** | rApp ↔ Non-RT RIC Framework | RESTful API (服务化) | rApp 注册/发现/数据获取/策略注册 |

### 5.3 A1 接口 -- 策略下发的核心桥梁

A1 接口是 Non-RT RIC 引导 Near-RT RIC 行为的关键通道。

| A1 消息类型 | 方向 | 说明 |
|:-----------|:----|:----|
| **A1 Policy Create** | Non-RT → Near-RT | 创建策略 (如：保证切片 SLA 在 99.9%) |
| **A1 Policy Update** | Non-RT → Near-RT | 更新策略参数 |
| **A1 Policy Delete** | Non-RT → Near-RT | 撤销策略 |
| **A1 Policy Status** | Near-RT → Non-RT | 上报策略执行状态 |
| **A1 EI (Enrichment Info)** | Non-RT → Near-RT | 提供补充信息 (如：UE 轨迹预测、负载预测) |
| **A1 ML Model Deploy** | Non-RT → Near-RT | 部署 ML 模型到 Near-RT RIC |

### 5.4 rApp 类型举例

| rApp 类型 | 功能描述 | 执行周期 |
|:---------|:--------|:---------|
| **覆盖优化** | 分析 MDT (Minimization of Drive Tests) 数据，调整天线倾角/方位角 | 数小时/天 |
| **容量规划** | 基于历史流量数据预测网络瓶颈，提前扩容建议 | 天/周 |
| **节能策略** | 分析流量潮汐模式，生成小区关断/唤醒策略，通过 A1 下发 | 分钟/小时 |
| **切片 SLA 管理** | 定义网络切片的 SLA 目标 (时延/吞吐/可用性) | 策略级 (长期) |
| **ML 模型训练** | 使用历史数据训练推理模型 (如负载预测/异常检测)，部署到 Near-RT RIC | 离线/周期性 |

---

## 6. 典型 xApp / rApp 用例

### 6.1 负载均衡 (Load Balancing)

**目标**：均衡小区间负载，减少高负载小区拥塞，提升用户体验。

```
测量阶段 (E2SM-KPM)                  决策阶段                     执行阶段 (E2SM-RC)
┌──────────┐  PRB利用率    ┌──────────────┐  CIO调整    ┌──────────────┐
│ E2 Node  │──────────────→│ Near-RT RIC  │────────────→│   E2 Node    │
│ (gNB-DU) │  RIC Indication│  (xApp)      │RIC Control  │ (gNB-CU-CP)  │
│          │  (Periodic)   │              │             │              │
└──────────┘               │ 1. 计算各小区│             │ 修改小区CIO  │
                           │    负载差值  │             └──────┬───────┘
                           │ 2. 确定需要  │                    │
                           │    切换的UE  │                    ▼
                           │ 3. 计算新CIO │             UE 执行 A3 测量
                           └──────────────┘            → 切换至低负载小区

反馈: E2 Node 继续上报更新后的 PRB 利用率 → 形成闭环
```

| 阶段 | 动作 | 协议/接口 |
|:---:|:----|:---------|
| **测量** | xApp 通过 E2SM-KPM 周期性订阅 (如 500ms) 每小区的 DL/UL PRB 利用率 | E2 Subscription + Indication |
| **决策** | 比较相邻小区负载：若 Cell_A 利用率 > 80% 且 Cell_B < 50%，触发负载均衡。计算 CIO 调整量 | xApp 内部逻辑 |
| **执行** | xApp 通过 E2SM-RC 下发 RIC Control，将 Cell_A → Cell_B 的 CIO 从 0dB 调整为 +3dB | E2 Control Request |
| **反馈** | 监测 UE 切换成功率与新小区负载变化，验证效果 | E2 Indication (持续) |

### 6.2 干扰协调 (Interference Coordination)

**目标**：在 MU-MIMO / 密集部署场景中，通过智能配对与功率控制降低同频干扰。

| 阶段 | 动作 | 协议/接口 |
|:---:|:----|:---------|
| **测量** | xApp 订阅每 UE 的 RSRP/SINR/CQI 报告，以及小区上行 RSSI | E2SM-KPM |
| **决策** | 分析 UE 间空间隔离度。若两 UE 空间信道相关性高，降低其 MU-MIMO 配对优先级或降低其中低优先级 UE 的发射功率 | xApp 内部算法 |
| **执行** | 通过 E2SM-RC 调整 MU-MIMO 配对策略 (配对 UE ID 白名单/黑名单) 和功率分配策略 (P0, Alpha) | E2 Control Request |
| **反馈** | 持续监测干扰后的 SINR/CQI 变化，若改善则保持，否则回退 | E2 Indication |

### 6.3 切片保障 (Slice Assurance)

**目标**：确保不同网络切片 (eMBB/URLLC/mMTC) 的 SLA 得到满足。

```
Non-RT RIC (rApp)                        Near-RT RIC (xApp)              E2 Node
      │                                        │                            │
      │ ═══ A1 Policy Create ═══════════════→  │                            │
      │    SLA: URLLC切片时延<1ms, 丢包<10^-5    │                            │
      │                                        │                            │
      │                                        │ ═══ RIC Subscription ═══→ │
      │                                        │    E2SM-KPM: 每切片时延/丢包│
      │                                        │                            │
      │                                        │ ←═══ RIC Indication ═════  │
      │                                        │    时延=1.5ms (超SLA!)      │
      │                                        │                            │
      │                                        │ ═══ RIC Control ════════→ │
      │                                        │   调整URLLC切片调度权重+20%│
      │                                        │                            │
      │                                        │ ←═══ RIC Indication ═════  │
      │                                        │    时延=0.8ms (达标)        │
      │                                        │                            │
      │ ←═══ A1 Policy Status (OK) ═══════════ │                            │
```

| 阶段 | 动作 | 协议/接口 |
|:---:|:----|:---------|
| **策略定义** | rApp 通过 A1 接口下发切片 SLA 策略：URLLC 切片时延 < 1ms，丢包率 < 10^-5 | A1 Policy Create |
| **近实时监测** | xApp 通过 E2SM-KPM 订阅每切片/每 QFI 的时延、丢包率、吞吐量指标 | E2 Subscription |
| **闭环调整** | 当检测到 SLA 违例时，xApp 通过 E2SM-RC 调整该切片的调度优先级/权重、保证比特率 (GBR) | E2 Control Request |
| **反馈验证** | xApp 持续监测 SLA 指标，确认恢复后维持。若持续违例，升级告警至 Non-RT RIC | E2 Indication + A1 Status |

### 6.4 节能 (Energy Saving)

**目标**：在保证覆盖和容量的前提下，降低网络能耗。

| 阶段 | 动作 | 协议/接口 |
|:---:|:----|:---------|
| **分析** | rApp 分析历史流量数据，识别流量潮汐模式 (如：夜间小区负载长期 < 10%) | O1 数据采集 |
| **策略制定** | rApp 生成节能策略：指定时段内将低负载小区进入睡眠模式，并将覆盖区域 UE 引导至邻近小区 | rApp 内部 |
| **策略下发** | rApp 通过 A1 将节能策略部署到 Near-RT RIC | A1 Policy Create |
| **实时执行** | xApp 按照策略，在指定时段通过 E2SM-RC 发送载波去激活/小区关断指令 | E2 Control Request |
| **唤醒** | 当邻近小区负载上升或 UE 测量到覆盖空洞时，xApp 通过 E2SM-RC 唤醒原小区 | E2 Control Request |

### 6.5 波束优化 (Beam Optimization)

**目标**：基于 UE 测量上报 (如 SSB-RSRP / CSI-RSRP) 精化波束方向和宽度。

| 阶段 | 动作 | 协议/接口 |
|:---:|:----|:---------|
| **测量** | xApp 订阅每 UE 的 SSB-RSRP 和 CSI-RSRP (多波束) 报告 | E2SM-KPM |
| **决策** | 分析 UE 分布热力图。若某 UE 组持续在波束边缘 (RSRP 波动大)，调整波束方向指向该区域或增加波束宽度 | xApp 内部 |
| **执行** | 通过 E2SM-RC 调整波束赋形权值 (Beamforming Weight) 和波束宽度参数 | E2 Control Request |
| **反馈** | 监测调整后 UE RSRP 改善情况 | E2 Indication |

---

## 7. RIC 相关标准

### 7.1 O-RAN 工作组与规范

| 工作组 | 规范编号 | 名称 | 版本示例 |
|:------|:--------|:----|:--------|
| **WG1** | O-RAN.WG1.OAM-Interface | OAM Interface Specification (O1 接口) | v06.00 |
| **WG2** | O-RAN.WG2.E2AP | E2 Application Protocol (E2AP) | v04.00 |
| **WG2** | O-RAN.WG2.E2SM-KPM | E2 Service Model -- Key Performance Metrics | v04.00 |
| **WG2** | O-RAN.WG2.E2SM-RC | E2 Service Model -- Radio Resource Control | v04.00 |
| **WG2** | O-RAN.WG2.E2SM-NI | E2 Service Model -- Network Interface | v02.00 |
| **WG2** | O-RAN.WG2.E2SM-MHO | E2 Service Model -- Mobility Handover | v01.00 |
| **WG3** | O-RAN.WG3.RICAP | Near-RT RIC Architecture & APIs | v04.00 |
| **WG3** | O-RAN.WG3.Non-RT-RIC | Non-RT RIC Architecture | v03.00 |
| **WG4** | O-RAN.WG4.CUS-Plane | CU-Plane / S-Plane / M-Plane (前传) | v10.00 |
| **WG5** | O-RAN.WG5.O1-Interface | O1 Interface for O-CU/O-DU | v05.00 |
| **WG6** | O-RAN.WG6.Cloudification | Cloudification & Orchestration | v04.00 |

### 7.2 关键规范要点

| 规范 | 要点 |
|:----|:----|
| **E2AP (WG2)** | 定义 E2 接口所有过程: Setup, Subscription, Indication, Control, Service Update, Configuration Update |
| **E2SM-KPM (WG2)** | 定义 200+ 标准化的性能测量指标 (3GPP TS 28.552 对齐)，支持事件触发和周期上报 |
| **E2SM-RC (WG2)** | 定义 RIC 可控制的 RRC/RRM 参数集: Handover Control, QoS Control, Carrier Control, Scheduling Control |
| **RICAP (WG3)** | 定义 Near-RT RIC 内部架构: xApp API, R-NIB, Conflict Mitigation, Subscription Management, Security |
| **Non-RT RIC (WG3)** | 定义 rApp 框架, A1 接口, R1 服务化接口, 数据管道 (Data Pipeline) |
| **OAM (WG1)** | 定义 O1 接口: NETCONF/YANG 模型用于 FCAPS 管理, 配置 VNF/PNF 网元 |

### 7.3 与其他 3GPP 规范的关系

| 3GPP 规范 | 关联内容 |
|:---------|:--------|
| TS 38.300 | NR 整体架构 (gNB 拆分, 接口定义) |
| TS 38.401 | NG-RAN 架构 (CU/DU, F1, E1, Xn, NG 接口) |
| TS 38.413 | NGAP (NG Application Protocol) |
| TS 38.473 | F1AP (F1 Application Protocol) |
| TS 28.552 | 5G KPI 定义 (与 E2SM-KPM 对齐) |
| TS 28.554 | 5G KPI 测量 (与 E2SM-KPM 对齐) |

---

## 附录 A: 缩略语

| 缩略语 | 全称 |
|:------|:----|
| **RIC** | RAN Intelligent Controller |
| **Near-RT RIC** | Near-Real-Time RIC (近实时 RIC) |
| **Non-RT RIC** | Non-Real-Time RIC (非实时 RIC) |
| **SMO** | Service Management & Orchestration |
| **xApp** | Near-RT RIC Application |
| **rApp** | Non-RT RIC Application |
| **R-NIB** | RIC Network Information Base |
| **E2AP** | E2 Application Protocol |
| **E2SM** | E2 Service Model |
| **KPM** | Key Performance Metrics |
| **RC** | Radio Resource Control (E2SM-RC) |
| **NI** | Network Interface (E2SM-NI) |
| **MHO** | Mobility Handover Optimization |
| **SCTP** | Stream Control Transmission Protocol |
| **FCAPS** | Fault, Configuration, Accounting, Performance, Security |
| **CIO** | Cell Individual Offset |
| **SLA** | Service Level Agreement |
| **QFI** | QoS Flow Identifier |
