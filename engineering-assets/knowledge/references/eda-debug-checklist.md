---
name: eda-debug-checklist
title: "EDA 调试 Checklist"
domain: verification
tags: [vivado, questa, debugging, eda]
created: 2026-06-14
updated: 2026-06-14
difficulty: intermediate
applies_to: logic-engineer
---

# EDA 调试 Checklist

> Vivado/Questa 仿真和综合的常见问题排查树。

---

## 1. lint 错误

### vlog -lint 报错

```
** Error: (vlog-13069) .../file.sv(42): near ";": syntax error
```

| 步骤 | 检查 | 原因 |
|:-----|:-----|:------|
| 1 | 行号附近是否缺少 `endmodule` | 模块未闭合 |
| 2 | 前一行是否漏分号 | SV 语句需要 `;` 结尾 |
| 3 | 是否混用 `wire`/`reg`/`logic` | SV 推荐统一用 `logic` |
| 4 | 位宽声明是否正确 `[N:0]` vs `[N-1:0]` | off-by-one |
| 5 | `always_ff`/`always_comb` 使用是否正确 | 组合逻辑用 `always_comb` |

### 常见 lint 错误速查

| 错误码 | 含义 | 常见原因 |
|:-------|:-----|:---------|
| vlog-13069 | 语法错误 | 漏分号/括号不匹配 |
| vlog-2388 | 信号未声明 | 拼写错误/未定义 |
| vlog-12110 | 位宽不匹配 | 赋值 LHS/RHS 位宽不同 |
| vlog-13214 | 组合环路 | `always_comb` 中读了自己的输出 |
| vlog-2571 | 多驱动 | 同一信号在多个 always 中被赋值 |

---

## 2. 仿真错误

### 2.1 X (unknown) 传播

观察波形中红色 `X` 信号：

| 检查 | 方法 | 修复 |
|:-----|:------|:------|
| 复位是否释放 | 看 rst_n 在仿真 100ns 后是否为 1 | 加复位序列 |
| 输入是否驱动 | 看 TB 是否驱动了所有输入 | 检查 TB force/drive |
| 多驱动源 | `$error("multiple drivers")` 出现 | 检查信号赋值范围 |
| 未初始化 reg | `reg` 初值为 X | TB 初始赋值 = 0 |
| 跨时钟域未同步 | CDC 信号直接使用 | 加 2 级同步器 |

### 2.2 仿真挂死（时间不前进）

| 检查 | 原因 | 修复 |
|:-----|:------|:------|
| `#10` vs `#10ns` | 无 `timescale` 导致时间单位不识别 | 加 `` `timescale 1ns/1ps `` |
| `@(posedge clk)` 永不触发 | 时钟未产生 | 加 `always #5 clk = ~clk;` |
| 死循环 | `while(1)` 无 `@` 或 `#` | 加时序控制 |
| 信号在 #0 赋值 | 竞争 | 加 `#1` 或 `#0` 对齐 |

### 2.3 仿真结果不符合预期

```
对比 golden 发现 RTL 输出与 MATLAB 不一致
```

| 步骤 | 方法 |
|:-----|:------|
| 1 | 输出 RTL 各中间节点到仿真日志 |
| 2 | 在 MATLAB 中用相同输入跑分段 Golden |
| 3 | 逐级对比找到偏差第一步 |
| 4 | 常见：位宽截断位置错误 / 符号位处理反 / 时序没对齐 |

---

## 3. Vivado 综合错误

### 3.1 资源超限

```
[Synth 8-439] Design uses 120% of available LUTs
```

| 步骤 | 方法 |
|:-----|:------|
| 1 | `report_utilization` 看哪个模块吃资源 |
| 2 | 检查是否有大型 `case`/`if-else` 树 |
| 3 | 检查是否有未例化的 mega-function |
| 4 | 检查位宽是否等于 `fixed_point_report` 中的预算 |

### 3.2 时序违规

```
[Timing 38-282] Setup violation: -0.345ns
```

| 步骤 | 方法 |
|:-----|:------|
| 1 | `report_timing_summary` 看最差路径 |
| 2 | 最长路径是否跨多级组合逻辑 | 加 pipeline register |
| 3 | 是否跨时钟域 | 加同步器 |
| 4 | 扇出是否过大 | 复制寄存器 |
| 5 | 是否为 DSP48 Cascade | 检查配置 |

### 3.3 综合比仿真慢

| 原因 | 方法 |
|:-----|:------|
| Block Design 层次深 | `set_param bd.altRenameRpts 1` |
| 大 BRAM 阵列初始化 | 用 `.coe` 而不是随机值 |

---

## 4. 调试工作流

### 4.1 Questa 调试

```tcl
# do/debug.tcl
log -r /*
add wave -r /*
run -all
# 导出 VCD 供 Check 脚本分析
vcd file sim.vcd
vcd add /tb_top/dut/*
run -all
vcd flush
```

### 4.2 Vivado 调试

```tcl
# debug.tcl - 综合后检查
open_run synth_1
report_utilization -file utilization.rpt
report_timing_summary -file timing.rpt
report_power -file power.rpt

# 查看扇出 > 256 的信号
report_high_fanout_nets -fanout_greater_than 256 -file fanout.rpt
```

### 4.3 ChipScope / ILA 调试

| 步骤 | 方法 |
|:-----|:------|
| 1 | 确定要抓的内部信号（不被优化掉） |
| 2 | `(* mark_debug = "true" *)` 标记信号 |
| 3 | 综合后 `set_property MARK_DEBUG true [get_nets ...]` |
| 4 | 实现后 Open Hardware Manager → 添加 ILA |
| 5 | 设置触发条件 → 下载 → 抓波形 |

---

## 5. 拔高：仿真性能调优

| 问题 | 方法 |
|:-----|:------|
| 仿真太慢 | 缩小数据量（1000 样点足够验证功能） |
| VCD 文件太大 | 只 dump 关键模块，用 `vcd file` + `vcd add` 指定 |
| regress 跑太久 | 并行运行独立模块仿真（make -j） |
| need debug 更快 | 用 `-novopt` 关闭优化（Questa） |
