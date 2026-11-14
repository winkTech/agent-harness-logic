# Phase 5: 顶层集成 + 全链仿真 [MUST 硬约束]

> 所属工作流: `workflows/hdl-coding-workflow.md`
> 目标: 所有子模块验证通过后，搭建顶层模块，全链逐级对比 MATLAB golden model。
> [硬约束] 仅当 Phase 4 验证矩阵全 ✅ 才能进入本阶段。

---

## 1. Phase 4 验证矩阵检查

在开始任何顶层集成工作前，必须先检查 Phase 4 的验证矩阵：

- 所有模块必须标记为 ✅（通过）
- 有任何 ❌ → **返回 Phase 4 修复**，不可继续顶层集成
- 有缺失模块 → 返回 Phase 4 补充

这是防止"bug 堆叠"的关键门禁。跳过这一步，全链仿真发现问题时无法定位到具体模块。

---

## 2. 搭建顶层

### 2.1 顶层模块创建

创建 `top.sv`，例化所有子模块：

```systemverilog
module top #(
    parameter P_FFT_SIZE = 1024
) (
    // 系统接口
    input  logic i_clk,
    input  logic i_rst,
    // 数据接口
    input  logic [31:0] i_iq_data,
    output logic [31:0] o_iq_data
);

    // TX 链
    wire [7:0]  tx_scrambled;
    wire [7:0]  tx_encoded;
    wire [15:0] tx_interleaved;
    wire [31:0] tx_modulated;
    // ... 逐级连接

    // 例化子模块
    scrambler u_scrambler (...);
    fec_encoder u_fec (...);
    interleaver u_interleaver (...);
    modulator u_modulator (...);
    // ...
```

### 2.2 连接要求

- 按数据流方向连接：TX 链从前到后，RX 链从前到后
- 控制通路（帧头/帧尾传递、配置参数分发）必须完整
- AXI4-Stream 握手链完整（tvalid/tready/tdata/tlast/tuser 全部连接）
- `make compile` 通过

---

## 3. 全链仿真 — 逐级对比 MATLAB Golden

### 3.1 测试向量注入

从 MATLAB 生成全帧测试向量（覆盖典型帧 + 边界帧），注入顶层模块。

### 3.2 逐级捕获与对比

在顶层模块中引出所有子模块的输出接口，逐级与 MATLAB golden model 对比：

```
[MATLAB 全帧数据]
     │
     ▼
  ┌─ scrambler 输出 ─────── ↔ scrambler.m 输出
  │
  ┌─ interleaver 输出 ───── ↔ interleaver.m 输出
  │
  ┌─ modulator 输出 ─────── ↔ modulator.m Q16.9 星座点
  │
  ┌─ OFDM 调制输出 ──────── ↔ ofdmModulator.m 输出
  │
     ▼
  ┌─ 最终 I/Q 输出 ──────── ↔ 整体 golden model 输出
```

### 3.3 误差标准

| 模块类型 | 误差标准 | 说明 |
|:---------|:---------|:------|
| 定点模块（LFSR/交织/扰码） | 逐周期一致 (bit-true) | 0 误差容忍 |
| 算术模块（FIR/累加器） | 误差 ≤ 1LSB | 与定点报告一致 |
| 近似模块（除法/CORDIC） | 误差 ≤ 2LSB | 需在定点报告中说明 |

### 3.4 不匹配时的处理

如果有中间级不匹配：

1. **隔离根因模块** — 从第一个不匹配的中间级向下定位
2. **记录差异** — 预期值 vs 实际值、周期号、信号路径
3. **返回 Phase 4** — 修复该模块的 RTL
4. **重新编译 → 重新仿真 → 重新对比**

---

## 4. 全链 PASS 标准

```
✅ 所有中间级输出与 MATLAB golden model 一致
✅ 最终输出与 MATLAB golden model 一致
❌ 任何一级不一致 = FAIL，不可妥协
```

只有全部通过才能进入 Phase 6（回归覆盖率）。

---

## 输出

1. `top.sv` — 顶层模块
2. 全链仿真日志（含所有中间级对比结果）
3. 全链 PASS/FAIL 报告
4. 如有 FAIL → 隔离到具体模块的差异报告

**可执行检查点**:
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_phase_5
```
