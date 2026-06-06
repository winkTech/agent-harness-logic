---
name: hdl-coding-workflow
description: RTL 开发全流程 — 参考模型→Testbench-First→增量仿真→透明调试
version: 2.0.0
agents: [developer, qa, code-reviewer]
phases: 5
complexity: medium-high
triggers:
  - new RTL module
  - testbench creation
  - lint cleanup
  - code review prep
---

# HDL Coding Workflow (v2)

RTL 开发流程。核心原则：**验证左移，每层有检查点，仿真日志实时可读**。

把 "写完再看对不对" 改成 "写一点就验证一点，每一步都知道对错"。

---

## Phase 1: 规格 + Golden Reference Model

**目标**: 在设计 RTL 之前，先用 MATLAB/Python 产生可验证的预期输出。

1. **接口确定** — 模块端口列表（时钟/复位/数据/控制）
2. **时序规划** — 流水线级数、时钟域、握手协议
3. **状态机设计** — 状态转移图
4. **量化分析** — 位宽、资源估算、时序余量
5. **Reference Model** — MATLAB/Python 编写功能参考模型：
   - 产生 `expected_output.hex` / `.bin`
   - 包含多个测试用例（正常/边界/错误）
   - 供后续 RTL 仿真自动比对

**检查点**: 参考模型运行通过，预期数据已保存。

---

## Phase 2: Testbench-First（自检框架 + SVA 断言）

**目标**: 先写能自动判断对错的 testbench，再写 RTL。

### 2.1 自检 Testbench 模板

```systemverilog
module tb_module;
  // 时钟/复位生成
  // DUT 例化
  // 激励产生
  // 预期输出加载（来自 Phase 1 的 .hex）
  
  integer cycle_count;
  always @(posedge clk) begin
    if (compare_enable) begin
      if (dout !== expected_dout) begin
        $display("[FAIL] cycle=%0d dout=%h expected=%h", 
                 cycle_count, dout, expected_dout);
        error_count++;
      end else begin
        $display("[PASS] cycle=%0d dout=%h", cycle_count, dout);
      end
      cycle_count++;
    end
  end
  
  initial begin
    $display("=== Test Start ===");
    // 运行测试
    #1000;
    $display("=== Test End: %0d errors ===", error_count);
    $finish;
  end
endmodule
```

### 2.2 SVA 断言嵌入

```systemverilog
// 每个关键属性都作为仿真时的实时检查点
assert property (@(posedge clk) valid |-> ##[1:3] ready);
assert property (@(posedge clk) fifo_full |-> !fifo_wr);
```

### 2.3 结构化日志宏

```systemverilog
`define LOG(lvl, msg) \
  $display("[%t] [%s] %s", $time, lvl, msg)

// 使用
`LOG("PHASE", "Layer 0: 端口连通性测试")
`LOG("CHECK", "data_in=%h data_out=%h", din, dout)
`LOG("PASS", "FIFO 读写测试通过")
`LOG("FAIL", "状态机预期状态=%s 实际=%s", EXPECTED, current)
```

**检查点**: testbench 编译通过，自检逻辑完整，SVA 无编译错误。

---

## Phase 3: 增量式 RTL 编码（分层验证）

**目标**: 从最小可验证单元开始，每层仿真绿灯后再推进。

```
Layer 0: 端口连通性         ← 每个 port 能正确读写
Layer 1: 寄存器/配置通路     ← CSR 读写、配置生效
Layer 2: 控制逻辑           ← 状态机跳转、握手协议
Layer 3: 数据通路           ← 单笔数据 → 流水线满负荷
Layer 4: 边界条件           ← 空/满/溢出/错误处理
```

### 运行方式（实时输出到对话框）

**短仿真（< 30s 每层）** — 直接 run，输出一次返回：

```bash
# vsim 输出 $display 日志到 stdout，Bash 工具捕获后显示在对话框
vsim -c tb_top -do "run -all; exit" 2>&1
# 输出示例:
#   [100ns] [PHASE] Layer 0: 端口连通性测试
#   [150ns] [PASS] data_in=32'hA5 正确通过
#   [200ns] [FAIL] ready 信号未在 3 周期内拉高
#   [300ns] === Test End: 1 errors ===
```

**长仿真** — 后台运行 + 轮询输出文件：

```bash
# 启动后台仿真
Bash({
  run_in_background: true,
  command: "vsim -c tb_top -do \"run -all; exit\" > sim_output.log 2>&1"
})

# 每隔一段时间读取日志
Read("sim_output.log")  →  对话框中看到：
#   === Layer 1: 寄存器读写测试 === 
#   [PASS] CSR_CTRL 写 0x3 读回 0x3
#   [PASS] CSR_STATUS 写 0x5 读回 0x5
#   Layer 1 完成，进入 Layer 2...
```

### 层推进规则

| 层 | 通过条件 | 失败处理 |
|:--|---------|---------|
| Layer 0 | 所有 port 连通 | 检查例化/信号名 |
| Layer 1 | CSR 读写匹配 | 检查地址译码 |
| Layer 2 | 状态机按预期跳转 | 检查 next-state 逻辑 |
| Layer 3 | 数据输出与 golden model 一致 | 检查数据通路组合逻辑 |
| Layer 4 | 边界处理不挂死 | 检查错误处理路径 |

**检查点**: Layer 0-4 依次通过，日志中无 FAIL。

---

## Phase 4: 回归 + 覆盖率

**目标**: 确保改动不破坏已有功能。

1. **回归测试** — 全量运行所有已通过的 Layer
2. **覆盖率收集** — 功能覆盖点（covergroup）触发率
3. **红线规则**:
   - 已有 PASS 的 case 回归不能变 FAIL
   - 功能覆盖率 < 90% 不能进审查

**检查点**: 回归全绿 + 覆盖率达标。

---

## Phase 5: 代码审查

**目标**: 确认代码质量和风格。

1. **自审查清单**:
   - [ ] 无组合环路
   - [ ] 多驱动检查
   - [ ] CDC 同步器（两级 reg / 握手 / FIFO）
   - [ ] 复位极性一致性
   - [ ] 无 lint warning
   - [ ] 所有 SVA 断言已启用
   - [ ] 参考模型对比通过
2. **提交 code-review** — 用 `code-review` 的 quality 模式

**输出**: 审查通过的 RTL + 完整仿真日志

---

## 仿真调试透明化对照表

| 传统方式 | v2 方式 | 区别 |
|---------|--------|------|
| 写完再仿真 | 写一段仿一段 | 故障定位从小时级→分钟级 |
| 人工看波形 | 自动比对 golden model | 发现错误从"感觉不对"→"第 N 个 cycle 数据不匹配" |
| testbench 一次性写 | Testbench-First 分层写 | 每层是独立检查点，不互相阻塞 |
| 仿真沉默运行 | `$display` 结构化日志 | `Bash` 捕获输出，对话框实时可读 |
| 最终 PASS/FAIL 一行 | 逐层进度 + 每 cycle 比对 | 看到"走到哪了、哪一步错了" |

## 关联资源

- [HDL 编码规范](../skills/hdl-coding/SKILL.md) — 详细命名规则和 lint 门禁
- [TDD Skill](../skills/tdd/SKILL.md) — Testbench-First 方法论
- [Code Review Workflow](../workflows/code-review-workflow.md) — 审查环节
- [MATLAB MCP](../CLAUDE.md) — 参考模型验证用 MATLAB 生成 golden data
