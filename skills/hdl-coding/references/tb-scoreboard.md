# Scoreboard Testbench 使用指南

> AXI-Stream VIP + Scoreboard 自动比对的 TB 模板与迁移指南。
> 配合 `axi_stream_if.sv` 和 `axi-stream-vip.sv` 使用。

---

## 目录

- [1. AXI-Stream VIP 基本用法](#1-axi-stream-vip-基本用法)
- [2. 完整 Scoreboard TB 模板](#2-完整-scoreboard-tb-模板)
- [3. 从 $display 模式迁移](#3-从-display-模式迁移)
- [4. JSON 证据格式规范 (Phase 4.5)](#4-json-证据格式规范-phase-45)
- [5. 常见场景示例](#5-常见场景示例)
- [6. 工作流集成](#6-工作流集成)

---

## 1. AXI-Stream VIP 基本用法

### 1.1 文件依赖

```systemverilog
`include "axi_stream_if.sv"
`include "axi-stream-vip.sv"      // 包含整个 axi_stream_vip_pkg
```

### 1.2 实例化接口

在 TB 顶层实例化 AXI-Stream 接口，连接到 DUT 的 AXI-Stream 端口：

```systemverilog
// 参数化接口，数据位宽与 DUT 一致
axi_stream_if #(.DW(32)) axis_in  (.clk(i_clk), .rst(i_rst));
axi_stream_if #(.DW(32)) axis_out (.clk(i_clk), .rst(i_rst));

// 连接到 DUT
my_dut u_dut (
  .clk       (i_clk),
  .rst       (i_rst),
  .s_axis_tvalid (axis_in.tvalid),
  .s_axis_tready (axis_in.tready),
  .s_axis_tdata  (axis_in.tdata),
  .s_axis_tlast  (axis_in.tlast),
  .s_axis_tkeep  (axis_in.tkeep),
  .m_axis_tvalid (axis_out.tvalid),
  .m_axis_tready (axis_out.tready),
  .m_axis_tdata  (axis_out.tdata),
  .m_axis_tlast  (axis_out.tlast),
  .m_axis_tkeep  (axis_out.tkeep)
);
```

### 1.3 配置 VIP 对象

在 TB 的 initial block 中创建并配置 Driver/Monitor/Scoreboard：

```systemverilog
import axi_stream_vip_pkg::*;

// 创建驱动、监视器和记分板
axis_driver   #(.DW(32))  drv_in;
axis_monitor  #(.DW(32))  mon_out;
axis_scoreboard #(.DW(32)) sb;

initial begin
  drv_in  = new(axis_in);           // 传 master modport
  mon_out = new(axis_out);          // 传 monitor modport
  sb      = new("my_module");

  // 可选：启用日志
  // drv_in.enable_logging("drv_in.log");
  // mon_out.enable_logging("mon_out.log");

  // 复位
  drv_in.reset_dut(4);
  @(posedge i_clk);
end
```

### 1.4 发送数据并比对

```systemverilog
initial begin
  bit [31:0] test_data[];
  bit [31:0] captured_data[];

  // 准备测试数据
  test_data = new[8];
  for (int i = 0; i < 8; i++) test_data[i] = i * 16 + 8;

  // 将期望值推入记分板
  sb.push_expected_array(test_data);

  // 发送 burst
  drv_in.send_burst(test_data);

  // 等待 DUT 处理完成
  repeat (10) @(posedge i_clk);

  // 从监视器获取实际输出
  mon_out.get_all_data(captured_data);
  sb.push_actual_array(captured_data);

  // 比对并输出结果
  if (sb.compare())
    $display("=== ALL TESTS PASSED ===");
  else
    $display("=== TEST FAILED ===");

  // 输出 JSON 证据文件
  sb.dump_json("evidence_my_module.json");

  $finish;
end
```

---

## 2. 完整 Scoreboard TB 模板

以下是一个完整的 Scoreboard 风格 Testbench 模板，替代传统的 `$display` 手动验证方式。

```systemverilog
//-----------------------------------------------------------------
// tb_<module>_scoreboard.sv — Scoreboard 自动比对 Testbench
//-----------------------------------------------------------------
// 功能描述: 使用 AXI-Stream VIP 自动验证 <module>
// 测试场景:
//   1. 基础功能 — 发送典型序列，比对 all match
//   2. 背压测试 — 使能 RANDOM_BACKPRESSURE，验证握手健壮性
//   3. 边界条件 — 单拍 tlast、空数据、tkeep 非全 1
//   4. 异常测试 — 复位中数据不采样、中断后恢复
//-----------------------------------------------------------------

`timescale 1ns / 1ps

`include "axi_stream_if.sv"
`include "axi-stream-vip.sv"

module tb_<module>;

  //-----------------------------------------------------------------
  // 参数
  //-----------------------------------------------------------------
  parameter int DW       = 32;
  parameter int CLK_PERIOD = 10;   // ns

  //-----------------------------------------------------------------
  // 信号
  //-----------------------------------------------------------------
  logic clk;
  logic rst;

  // AXI-Stream 接口
  axi_stream_if #(.DW(DW)) axis_in  (.clk(clk), .rst(rst));
  axi_stream_if #(.DW(DW)) axis_out (.clk(clk), .rst(rst));

  //-----------------------------------------------------------------
  // 时钟生成
  //-----------------------------------------------------------------
  initial clk = 0;
  always #(CLK_PERIOD / 2) clk = ~clk;

  //-----------------------------------------------------------------
  // DUT 例化
  //-----------------------------------------------------------------
  <module> #(
    .DW (DW)
  ) u_dut (
    .clk            (clk),
    .rst            (rst),
    .s_axis_tvalid  (axis_in.tvalid),
    .s_axis_tready  (axis_in.tready),
    .s_axis_tdata   (axis_in.tdata),
    .s_axis_tlast   (axis_in.tlast),
    .s_axis_tkeep   (axis_in.tkeep),
    .m_axis_tvalid  (axis_out.tvalid),
    .m_axis_tready  (axis_out.tready),
    .m_axis_tdata   (axis_out.tdata),
    .m_axis_tlast   (axis_out.tlast),
    .m_axis_tkeep   (axis_out.tkeep)
  );

  //-----------------------------------------------------------------
  // VIP 对象
  //-----------------------------------------------------------------
  import axi_stream_vip_pkg::*;

  axis_driver       #(.DW(DW)) drv;
  axis_monitor      #(.DW(DW)) mon;
  axis_scoreboard   #(.DW(DW)) sb;

  //-----------------------------------------------------------------
  // 测试主流程
  //-----------------------------------------------------------------
  initial begin
    bit [DW-1:0] golden_data[];
    bit [DW-1:0] dut_data[];

    // 创建 VIP 对象
    drv = new(axis_in);         // master modport: 驱动输入
    mon = new(axis_out);        // monitor modport: 监视输出
    sb  = new("<module>");

    // 打开波形 (可选: 调试时启用)
    $dumpfile("tb_<module>.vcd");
    $dumpvars(0, tb_<module>);

    //-----------------------------------------------------------------
    // Test 1: 基本功能
    //-----------------------------------------------------------------
    $display("=== Test 1: Basic Function ===");
    begin
      int n = 16;
      golden_data = new[n];
      for (int i = 0; i < n; i++)
        golden_data[i] = i;

      // 推入期望值
      sb.push_expected_array(golden_data);

      // 发送激励
      drv.send_burst(golden_data);

      // 等待 DUT 处理完成
      repeat (20) @(posedge clk);

      // 获取 DUT 输出
      mon.get_all_data(dut_data);
      sb.push_actual_array(dut_data);

      // 比对
      if (!sb.compare(1)) begin
        $display("FAIL: Test 1 — Basic Function");
        sb.dump_json("evidence_<module>_t1.json");
        $finish(1);
      end
      sb.clear();
      mon.clear();
    end

    //-----------------------------------------------------------------
    // Test 2: 背压测试
    //-----------------------------------------------------------------
    $display("=== Test 2: Backpressure Test ===");
    begin
      int n = 32;
      golden_data = new[n];
      for (int i = 0; i < n; i++)
        golden_data[i] = $urandom;

      // 在输入侧设定随机背压
      drv.set_ready_mode(RANDOM_BACKPRESSURE, 0);
      drv.set_backpressure_range(1, 4);

      sb.push_expected_array(golden_data);
      drv.send_burst(golden_data);

      repeat (30) @(posedge clk);

      mon.get_all_data(dut_data);
      sb.push_actual_array(dut_data);

      if (!sb.compare(1)) begin
        $display("FAIL: Test 2 — Backpressure");
        sb.dump_json("evidence_<module>_t2.json");
        $finish(1);
      end
      sb.clear();
      mon.clear();
    end

    //-----------------------------------------------------------------
    // 所有测试通过
    //-----------------------------------------------------------------
    $display("=== ALL TESTS PASSED ===");
    sb.dump_json("evidence_<module>.json");
    $finish(0);
  end

  //-----------------------------------------------------------------
  // 超时保护
  //-----------------------------------------------------------------
  initial begin
    #(CLK_PERIOD * 5000);
    $display("FAIL: Simulation timeout");
    sb.dump_json("evidence_<module>_timeout.json");
    $finish(1);
  end

endmodule
```

---

## 3. 从 $display 模式迁移

### 3.1 原有模式的问题

原始 `tb-templates.md` 中每个测试用例依赖手动 `$display` 和肉眼检查：

```systemverilog
// 旧模式: 手动检查，容易漏检
$display("=== Test 1: ===");
// 发送激励...
// 等待...
if (result != expected)
  $display("FAIL at %0d", i);
// 容易遗漏的错误: 只检查了一个点就继续
```

### 3.2 迁移步骤

**Step 1** — 在 TB 文件头添加 include 和 import：

```systemverilog
`include "axi_stream_if.sv"
`include "axi-stream-vip.sv"
import axi_stream_vip_pkg::*;
```

**Step 2** — 用 AXI-Stream 接口替换原始端口信号声明：

```diff
- reg [31:0] s_axis_tdata;
- reg        s_axis_tvalid;
- wire       s_axis_tready;
+ axi_stream_if #(.DW(32)) axis_in (.clk(clk), .rst(rst));
```

**Step 3** — 用 scoreboard 替代 `$display` 手动比对：

```diff
- $display("=== Test 1 ===");
- for (int i = 0; i < N; i++) begin
-   if (out_data[i] !== exp_data[i])
-     $display("Mismatch at %0d", i);
- end
+ sb.push_expected_array(exp_data);
+ // ... 运行仿真 ...
+ mon.get_all_data(dut_data);
+ sb.push_actual_array(dut_data);
+ if (!sb.compare()) $finish(1);
```

**Step 4** — 在测试末尾调用 `sb.dump_json()` 生成证据文件。

### 3.3 迁移清单

| 项目 | 旧模式 | Scoreboard 模式 |
|:-----|:-------|:----------------|
| 激励生成 | 手写 `initial` 块时序 | `drv.send_vector()` / `drv.send_burst()` |
| 输出捕获 | 手写 `@(posedge clk)` 采样 | `mon.capture()` / `mon.get_all_data()` |
| 结果比对 | `$display` + 肉眼 | `sb.compare()` 自动 PASS/FAIL |
| 覆盖率 | 手动列举检查点 | `compared_points` 自动统计 |
| 证据 | 无 / transcript 文本 | `dump_json()` 输出结构化 JSON |
| 背压测试 | 需额外逻辑 | `set_ready_mode(RANDOM_BACKPRESSURE)` 一行切换 |
| 协议合规 | 无自动检查 | `axi_stream_if` 内建断言 |

---

## 4. JSON 证据格式规范 (Phase 4.5)

### 4.1 格式定义

Scoreboard 输出的 JSON 文件与 Phase 4.5 证据门禁严格兼容：

```json
{
  "module": "<module_name>",
  "status": "PASS|FAIL",
  "compared_points": <int>,
  "max_error_lsb": <int|null>,
  "first_fail_at": <int|null>
}
```

### 4.2 字段说明

| 字段 | 类型 | 说明 |
|:-----|:-----|:------|
| `module` | string | 被测模块名，构造时传入 |
| `status` | string | `"PASS"` = 所有点全部匹配；`"FAIL"` = 存在不匹配 |
| `compared_points` | int | 实际参与比对的数据点数 |
| `max_error_lsb` | int / null | 最大误差位位置（LSB 0）。全部通过时为 null |
| `first_fail_at` | int / null | 第一个失败的索引。全部通过时为 null |

### 4.3 生成方式

```systemverilog
// 在每个测试场景之后，或整个仿真结束时调用
sb.dump_json("evidence_<module>.json");
```

### 4.4 与 Phase 4.5 门禁集成

HDL 编码工作流的 Phase 4.5 门禁检查脚本会扫描 `evidence_*.json`：

```
evidence_<module>.json          # 最终汇总
evidence_<module>_t1.json       # 可选: 各子用例
evidence_<module>_t2.json
```

门禁判断逻辑：

```bash
# 伪代码
for f in evidence_*.json; do
  status=$(jq -r '.status' "$f")
  if [ "$status" = "FAIL" ]; then
    echo "证据门禁 FAIL: $f"
    exit 1
  fi
done
echo "证据门禁 PASS"
```

---

## 5. 常见场景示例

### 5.1 流式处理模块 (流水线)

适用于 FIR 滤波器、FFT、 scrambler 等逐拍流水线输出的模块：

```systemverilog
initial begin
  bit [DW-1:0] golden[];
  bit [DW-1:0] actual[];

  // Step 1: Golden Model 生成期望
  golden = new[100];
  for (int i = 0; i < 100; i++)
    golden[i] = reference_model(i);   // 调用 golden model

  // Step 2: 推入期望值
  sb.push_expected_array(golden);

  // Step 3: 连续发送激励（无间隙流水）
  drv.send_burst(golden, 0);     // gap=0: 背靠背

  // Step 4: 等待 DUT 流水延迟 + 输出完成
  repeat (110) @(posedge clk);

  // Step 5: 获取实际值并比对
  mon.get_all_data(actual);
  sb.push_actual_array(actual);
  sb.compare();
  sb.dump_json("evidence_fir.json");
end
```

### 5.2 背压健壮性测试

验证 DUT 在输入/输出背压下的行为是否正确：

```systemverilog
initial begin
  // 配置 DUT 输出端背压 (slave 模式)
  // 注意: 需要在 DUT 输出侧例化另一个 AXI-Stream 接口作 sink
  // axi_stream_if #(.DW(DW)) axis_sink (.clk(clk), .rst(rst));
  // axis_driver #(.DW(DW)) sink;  // slave 模式: 驱动 tready

  // 设置随机背压: 每笔事务 1~5 周期随机延迟
  drv.set_ready_mode(RANDOM_BACKPRESSURE);
  drv.set_backpressure_range(1, 5);

  // 发送数据
  drv.send_burst(test_data);

  // ... 比对 ...
end
```

### 5.3 异常条件测试

```systemverilog
initial begin
  // 复位中发送 → DUT 应忽略
  drv.send_idle(2);
  rst = 1;
  repeat (5) @(posedge clk);

  // 复位中不应有 valid
  axis_in.tvalid = 1;   // 这会在仿真中触发断言错误 (符合预期)
  @(posedge clk);
  axis_in.tvalid = 0;

  rst = 0;
  repeat (3) @(posedge clk);

  // 复位后恢复正常
  drv.send_burst(normal_data);
end
```

### 5.4 多通道 / 聚合 VIP

当 DUT 有多个 AXI-Stream 端口时，例化多组 VIP：

```systemverilog
// 输入端口
axi_stream_if #(.DW(16)) axis_in0  (.clk(clk), .rst(rst));
axi_stream_if #(.DW(16)) axis_in1  (.clk(clk), .rst(rst));

// 输出端口
axi_stream_if #(.DW(32)) axis_out  (.clk(clk), .rst(rst));

// VIP 对象
axis_driver   #(.DW(16)) drv0, drv1;
axis_monitor  #(.DW(32)) mon;
axis_scoreboard #(.DW(32)) sb;

initial begin
  drv0 = new(axis_in0);
  drv1 = new(axis_in1);
  mon  = new(axis_out);
  sb   = new("multi_channel_dut");
end
```

---

## 6. 工作流集成

### 6.1 文件清单

创建以下文件后即可被 hdl-coding 工作流引用：

| 文件 | 路径 | 说明 |
|:-----|:-----|:------|
| `axi_stream_if.sv` | `references/axi_stream_if.sv` | AXI-Stream 接口定义 |
| `axi-stream-vip.sv` | `references/axi-stream-vip.sv` | VIP 包 (driver+monitor+scoreboard) |
| `tb-scoreboard.md` | `references/tb-scoreboard.md` | 本指南 |

### 6.2 在 TB 中的引用方式

**方式 A: 直接 include** (推荐)

```systemverilog
`include "axi_stream_if.sv"
`include "axi-stream-vip.sv"
```

适用于独立仿真的 TB 文件。

**方式 B: 编译列表**

在仿真脚本 (`02_sim/sim.do`) 中：

```tcl
vlog -sv +incdir+$SKILL_DIR/references axi_stream_if.sv
vlog -sv +incdir+$SKILL_DIR/references axi-stream-vip.sv
vlog -sv tb_<module>.sv
```

### 6.3 与原始 tb-templates.md 的关系

- `tb-templates.md` 保持基础模板不变，适用于简单模块和无 AXI-Stream 接口的场景。
- `tb-scoreboard.md` 是 AXI-Stream 场景的扩展和升级，两者互补。
- 迁移建议：新项目直接使用 Scoreboard 模板；旧项目优先迁移关键模块的 TB。

---

> 参考: `axi_stream_if.sv` — 接口定义; `axi-stream-vip.sv` — VIP 源码; `tb-templates.md` — 基础 TB 模板
