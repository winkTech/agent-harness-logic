---
name: uvm-framework-architecture
description: UVM 验证框架架构决策记录 — 通用模板 + 工厂覆盖模式 + 统一 32-bit 接口
metadata:
  type: learning
  domain: verification
---

# UVM 验证框架架构决策

> 日期: 2026-06-05 | 关联: [[agent-evaluation-v3]], [[uvm-verification-framework]]

## 架构模式

### 分层结构 (从通用到专用)

```
docs/templates/uvm/               ← 通用可复用层
  ├── axi_stream_if.sv            ← 参数化接口 #(32)
  ├── axi_stream_driver.sv        ← 通用 driver (32-bit)
  ├── axi_stream_monitor.sv       ← 通用 monitor (32-bit)
  ├── axi_stream_sequencer.sv
  ├── axi_stream_seq_item.sv
  ├── reset_if.sv
  ├── generic_agent.sv            ← 通用 agent
  ├── generic_env.sv              ← 通用 env
  ├── generic_scoreboard.sv       ← 通用 scoreboard 基类
  └── generic_base_test.sv        ← 通用 base test

knowledge/primary/domains/comm/<algo>/uvm_tb/  ← 算法专用层
  ├── <algo>_scoreboard.sv        ← 继承 generic_scoreboard
  ├── <algo>_sequences.sv         ← 算法特定序列
  ├── <algo>_base_test.sv         ← 继承 + factory override
  ├── <algo>_basic_test.sv
  ├── <algo>_uvm_pkg.sv           ← 汇总所有组件
  ├── tb_<algo>_uvm_top.sv        ← DUT 例化 + config_db
  └── compile.tcl                  ← 编译脚本
```

### 关键决策

| 决策 | 方案 | 理由 |
|:----|:-----|:------|
| 接口位宽 | **统一 #(32)** | 所有算法 DUT 用 32-bit {Q,I} 打包格式，避免参数化 UVM 组件（Vivado UVM 1.2 兼容性） |
| 算法替换 | **Factory override** | `set_type_override(generic_scoreboard, algo_scoreboard)` 在 base_test::build_phase 中注册 |
| 数据格式 | **hex 32-bit per line** | `expected_tx.bin` = `{Q[15:0], I[15:0]}`，MATLAB `generate_vectors.m` 统一导出 |
| 比对公差 | **算法自定** | 每个 scoreboard 覆盖 `compare_item()` 方法，支持 ±1~2 LSB tolerance |
| 向量路径 | **config_db string** | `vec_dir` 通过 `uvm_config_db #(string)` 注入，base_test 设置默认值 |

### 覆盖算法

| 算法 | scoreboard | 比对方式 | 状态 |
|:----|:-----------|:---------|:----:|
| OFDM TX | `ofdm_scoreboard` | Q3.13, tol=±1 LSB | ✅ 已存在, 已适配 generic |
| RRC | `rrc_scoreboard` | Q2.14, tol=±1 LSB | ✅ |
| 信道估计 | `chEst_scoreboard` | Q2.14, tol=±2 LSB | ✅ |
| 同步 | `sync_scoreboard` | Pass-through, exact | ✅ (控制信号占位) |

## 为何不用参数化 UVM 组件

Vivado xsim 2023.1 UVM 1.2 对 `uvm_component_param_utils` 的支持有限，
编译时报语法错误。改为统一 `#(32)` + 驱动/DUT 连接处截断的方案，
降低了模板复杂度，且对验证功能无影响。

## 关联记忆

- [[uvm-verification-framework]] — OFDM UVM 实战踩坑
- [[agent-evaluation-v3]] — 评分与下一步行动
