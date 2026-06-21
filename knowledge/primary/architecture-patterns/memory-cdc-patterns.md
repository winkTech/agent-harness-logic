# 存储/CDC/背压 架构模式

> FIFO 深度选型、跨时钟域同步方案、AXI-Stream 背压链设计的
> **定量对比数据**和选型决策依据。

---

## 1. FIFO / 缓冲

### 存储介质选型

| 深度范围 | 推荐介质 | LUT | BRAM | Fmax | 位宽无关性 | 适用场景 |
|:---------|:---------|:----|:-----|:-----|:-----------|:---------|
| 1-16 | **Register (FF)** | ~4×depth×width | 0 | 最高 | 无 | 流水线级间缓冲、skid buffer |
| 16-64 | **Distributed RAM (LUTRAM)** | ~2.5×depth×width/6 | 0 | 高 | 位宽<18 最优 | 小 FIFO、系数表、状态缓冲 |
| 64-36K | **Block RAM (BRAM18/36)** | ~100 (控制) | ceil(depth×width/18Kb) | 中 | 宽位宽<36 最优 | 主数据 FIFO、大缓冲 |
| >36K | **UltraRAM (URAM)** | ~150 (控制) | ceil(depth×width/288Kb) | 中 | 任意 | 大数据帧缓冲、图像行缓冲 |

### 资源估算公式

```
Register-based FIFO (depth=D, width=W):
  LUT  ≈ 4 × D × W / W_per_LUT   (D×W 个寄存器 + 控制逻辑)
  FF   ≈ D × W + 50               (数据 + 地址寄存器)
  
  注: D≤16 时每 bit 约 4 LUT (含读/写地址+空满判断)
  W_per_LUT ≈ 6 (6-input LUT 的典型效率)

LUTRAM FIFO (depth=D, width=W, D≤64):
  LUT  ≈ ceil(D×W / 6) + 100      (存储 + 地址/空满)
  BRAM = 0
  
  注: Xilinx LUTRAM 可配置为 64×1 或 32×2 等

BRAM FIFO (depth=D, width=W):
  LUT  ≈ 100                      (地址/空满/使能控制)
  BRAM = ceil(D × W / 18K)        (用 BRAM18K 计算)
  
  BRAM18K 可配置:
    16384×1, 8192×2, 4096×4, 2048×9, 1024×18
  BRAM36K 可配置 (2× BRAM18K):
    32768×1, 16384×2, 8192×4, 4096×9, 2048×18, 1024×36
```

### FIFO 深度决策

```
需求: 连续背压下不丢数据的最大 burst = B, 读写频率差 = Δf

FIFO 最小深度 = B × (1 - f_rd/f_wr) + safety_margin
  
safety_margin ≈ 2-4 (地址同步延迟 + 格雷码安全)

典型值:
├─ AXI-Stream 速率匹配 (同频): 深度=16 (寄存器)
├─ 跨时钟域 (f_wr > f_rd): B × (1 - f_rd/f_wr) + 4
├─ 包缓冲 (最大包长 N): N × 1.5 (BRAM, 留头尾余量)
└─ 异步 FIFO (最小安全): 深度≥4 (格雷码要求)
```

---

## 2. CDC (Clock Domain Crossing)

### 架构选项

| CDC 方案 | 单/多 bit | 吞吐 | 延迟(cyc) | LUT | 适用场景 |
|:---------|:-----------|:-----|:----------|:----|:---------|
| **2 级同步器** | 单 bit | 1/cyc | 2 | ~8 | 慢→快 控制信号 |
| **3 级同步器** | 单 bit | 1/cyc | 3 | ~12 | 快→慢 / 高可靠性 |
| **4 级同步器** | 单 bit | 1/cyc | 4 | ~16 | 极高辐射环境 (星载) |
| **MUX 隔离** | 单 bit | N/A | 0 | ~5 | 门控时钟/静态选择 |
| **握手续同步** | 多 bit | 1/2 cyc | 4-6 | ~30 | 低速多 bit 控制字 |
| **DMUX 同步** | 多 bit | 3 cyc/word | 3 | ~20 | 慢→快多 bit |
| **异步 FIFO** | 多 bit | 1/cyc | 2+4 | ~100+BRAM | 高速数据流 |
| **AXI-Stream 跨时钟** | 多 bit | 1/cyc | 2+5 | ~150+BRAM | AXI-Stream CDC |

### 2 级 vs 3 级同步器

| 条件 | 推荐级数 | 原因 |
|:-----|:---------|:-----|
| f_slow < f_fast / 2 | 2 级 | 慢时钟信号有足够裕度被快时钟采样 |
| f_slow ≈ f_fast | 3 级 | 亚稳态窗口重叠可能性大 |
| f_slow > f_fast | 3 级 + 边沿检测 | 快→慢需展宽 + 同步 + 边沿恢复 |
| 高能粒子环境 | 3-4 级 | MTBF 与级数指数相关 |
| 复位信号 | 3 级 (Async Release) | 必须 3 级确保可预测释放 |

### 异步 FIFO 深度计算

```
f_wr = 写时钟频率, f_rd = 读时钟频率
B = 最大连续写 burst 长度

最坏情况: 写连续 burst B, 读慢
深度 ≥ B × (1 - f_rd/f_wr) + 4    (4 为安全裕度)

示例:
├─ f_wr=200MHz, f_rd=100MHz, B=8 → 深度 ≥ 8×(1-0.5) + 4 = 8 → 取 16
├─ f_wr=100MHz, f_rd=200MHz, B=16 → 深度 ≥ 16×(1-2) + 4 = 负数 → 深度 8 (无背压风险)
└─ f_wr ≈ f_rd, B=100 → 深度 ≥ 100×(1-0.99) + 4 ≈ 5 → 深度 8
```

### 格雷码 vs 二进制地址

| 特性 | 格雷码 | 二进制 |
|:-----|:-------|:-------|
| 相邻跳变 bit 数 | 1 | 平均 N/2 |
| 同步后出现错误值概率 | 极低 | 高 (多 bit 同时跳变) |
| 读地址→写时钟域 | ✅ 必须 | ❌ 禁止 |
| 加法器效率 | 低 (需转换) | 高 (直接加) |
| 额外 LUT | ~10 (bin→gray + gray→bin) | 0 |
| 最大深度限制 | 2^N (N 为地址位宽) | 无限制 |

**结论**: 异步 FIFO 的读写指针跨时钟域**必须用格雷码**。

---

## 3. 背压管理 (Backpressure)

### 架构选项

| 架构 | LUT+FF | BRAM | 延迟(cyc) | 吸收容量 | 适用场景 |
|:-----|:--------|:-----|:----------|:---------|:---------|
| **寄存器切片 (Reg Slice)** | ~30 | 0 | 1 | 0 (仅 1 级) | 时序断裂、短距离 |
| **Skid Buffer** | ~80 | 0 | 1 | 2 | 时序收敛 |
| **同步 FIFO** | ~100 (depth×width) | 0/1 | 1-2 | depth | 背压吸收、速率匹配 |
| **FWFT FIFO** | ~120 | 0/1 | 0 | depth | 零延迟转发 |

### 对 throughput 的影响

```
设计: 深度 D 的 FIFO, 反压从下游模块生效到上游感知需 N 级 pipeline

FIFO 有效容量 = D - N
├─ D > N: FIFO 正常工作, 可吸收 N 级 pipeline 的反压延迟
├─ D = N: FIFO 无实际缓冲能力, 几乎是直通
└─ D < N: 背压到达前 FIFO 已满 → 数据溢出

N 的估算:
├─ 跨时钟 FIFO: N = CDC 同步延迟 (3~5 cyc)
├─ 同频 AXI-Stream 链: N ≈ 级数 × 1 (每级 reg slice 1 cyc 延迟)
└─ 含握手非流水的模块: N = 模块处理延迟
```

### Pipeline 寄存器权衡

```
Reg Slice (valid-ready pipeline register):
  插入位置: 长组合逻辑链中间
  代价: 每级 +1 cycle 延迟
  好处: 可提升 Fmax (每级等效 ~5 LUT delay)
  估算: keep_b = false (registered)

Skid Buffer (2-entry FIFO 用于时序):
  插入位置: 时序紧张的模块输出
  特性:
    - 在 ready 撤销时还能吸收 1 个 beat
    - 避免组合逻辑直通 (timing path)
  代价: ~80 LUT + ~2×W FF, 零额外延迟 (first word 直通)
  适用: 模块出口的最后一个寄存器

FIFO (多级缓冲):
  插入位置: 模块间 (速率匹配 / 背压隔离)
  特性:
    - 深度=8-16 时可吸收短时拥塞
    - FWFT: 零延迟第一拍
  代价: 深度×位宽 LUT 或 1 BRAM
```

---

## 4. AXI-Stream 连接模式

### valid-ready 时序

```
模式 1 — 正向 valid, 反向 ready (标准):
  ────────────────
  发送方驱动 valid
  接收方驱动 ready
  当 valid=1 & ready=1 → 传输完成
  ────────────────

模式 2 — ready 前向传递 (skid buffer):
  ────────────────
  每级 reg slice 有 local ready
  反压从后向前逐级传播
  ────────────────

模式 3 — 预取 (prefetch):
  ────────────────
  ready 上升沿即视为握手 (避免 critical path)
  接收方在一拍后给出数据占用信号
  ────────────────
```

### 多条 pipeline 集成

```
N 级 pipeline, 每级延迟 1 cyc, 每级间用 reg slice:
├─ 总延迟: N cyc
├─ 有效吞吐: 1 beat/cyc (无背压)
├─ 反压传播到源端: 2N cyc (反向遍历所有 reg slice)
└─ 满状态恢复至空: 2N cyc (逐级 draining)

反压滞后的影响:
├─ 总反压延迟 L = 2N (去程 + 回程)
├─ FIFO 需要额外 L 的缓冲深度吸收反压延迟期间的持续输入
└─ 建议: 在反压传播路径的入口端加深度 ≥ 2N 的 FIFO
```

### 资源速查表

| 组件 | LUT | FF | BRAM | 延迟 |
|:-----|:----|:---|:-----|:-----|
| Reg slice (W=32) | ~30 | ~70 | 0 | 1 |
| Skid buffer (W=32) | ~80 | ~100 | 0 | 0-1 |
| Sync FIFO (D=16, W=32) | ~120 | ~160 | 0 | 1 |
| Sync FIFO (D=512, W=32) | ~100 | ~50 | 1 | 1-2 |
| Async FIFO (D=16, W=32) | ~200 | ~180 | 0 | 3-4 |
| Async FIFO (D=512, W=32) | ~150 | ~80 | 1 | 3-4 |
| CDC 2-stage | ~8 | ~8 | 0 | 2 |
| CDC 3-stage | ~12 | ~12 | 0 | 3 |

---

## 附录：存储/CDC 模式对比速查

| 模式 | BRAM | LUT | 延迟 | 典型 Fmax | 关键约束 |
|:-----|:-----|:----|:-----|:----------|:---------|
| Reg FIFO (D≤16) | 0 | 4D×W | 0-1 | 最高 | 深度 |
| LUTRAM FIFO (D≤64) | 0 | 2.5D×W/6 | 1 | 高 | 深度+位宽 |
| BRAM FIFO | ceil(D×W/18K) | 100 | 1-2 | 中 | BRAM 数量 |
| CDC 2-stage | 0 | 8 | 2 | 最高 | 仅单 bit |
| CDC 3-stage | 0 | 12 | 3 | 最高 | 仅单 bit |
| Async FIFO | 0/1 | ~150 | 3-5 | 中 | CDC 可靠 |
| Reg slice | 0 | 30 | 1 | 最高 | 仅 1 级 |
| Skid buffer | 0 | 80 | 0-1 | 高 | 容量 2 |

> Fmax 判定: 最高(>400MHz@28nm), 高(>300MHz), 中(150-300MHz)
