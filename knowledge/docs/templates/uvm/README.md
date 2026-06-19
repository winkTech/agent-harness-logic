---
name: uvm
title: "UVM Verification Template"
description: "UVM verification template for AXI4-Stream based DUTs with agent, scoreboard, environment, testbench, and compilation scripts"
---

# UVM 验证模板

## 文件清单

| 文件 | 说明 |
|:----|:-----|
| `axi_stream_if.sv` | AXI4-Stream 虚接口 (参数化位宽) |
| `axi_stream_seq_item.sv` | 序列项 (transaction) |
| `axi_stream_sequencer.sv` | Sequencer |
| `axi_stream_driver.sv` | Driver (tvalid/tready 握手) |
| `axi_stream_monitor.sv` | Monitor (采样 tvalid && tready) |
| `ofdm_scoreboard.sv` | Scoreboard (MATLAB golden 比对) |
| `ofdm_agent.sv` | Agent (sqr + drv + mon) |
| `ofdm_env.sv` | Environment (agent + scoreboard) |
| `ofdm_base_test.sv` | 基类测试 (config_db + phase 管理) |
| `ofdm_basic_test.sv` | 基础测试用例 (QPSK 定向) |
| `ofdm_uvm_pkg.sv` | 汇总包 (包含所有组件) |
| `tb_ofdm_uvm_top.sv` | 顶层 (时钟/接口/DUT/run_test) |
| `compile.tcl` | Vivado xsim 编译脚本 |

## 适配新 DUT

1. 复制本目录到新项目
2. 修改 `axi_stream_if #(DATA_WIDTH)` 实例化，匹配 DUT 接口位宽
3. 修改 `axi_stream_driver.sv` 中的 `DATA_WIDTH` 参数
4. 修改 `tb_ofdm_uvm_top.sv` 中的 DUT 例化和连接
5. 修改 `ofdm_scoreboard.sv` 的 golden 文件路径
6. 运行 `source compile.tcl` → `xsim tb_ofdm_uvm_top --testname ...`

## 运行

```tcl
cd docs/templates/uvm
source compile.tcl
xsim tb_ofdm_uvm_top --runall --testname ofdm_basic_test
```

## 添加新测试用例

```systemverilog
class ofdm_16qam_test extends ofdm_base_test;
    `uvm_component_utils(ofdm_16qam_test)
    function new(string name, uvm_component parent);
        super.new(name, parent);
    endfunction
    task run_phase(uvm_phase phase);
        // 重写激励逻辑
        phase.raise_objection(this);
        // 16QAM 数据
        ...
        phase.drop_objection(this);
    endtask
endclass
```

然后在 `ofdm_uvm_pkg.sv` 中加入 include，运行:
```bash
xsim tb_ofdm_uvm_top --runall --testname ofdm_16qam_test
```
