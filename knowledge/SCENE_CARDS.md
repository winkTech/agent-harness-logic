# 场景入口卡

> 按设计意图导航知识库。每张卡片对应一个常见任务场景，列出该场景下需要加载的核心文档及阅读顺序。
> 加载策略：先读本卡片（前 24 行）→ 按需展开具体文档，避免盲目全文加载。

---

## 场景总览

<!--- 行号索引 (Read 用 offset/limit 精准加载, 勿全量读全文) --->
```yaml
行号映射:
  场景总览:      L8-L24    (~480 tok)
  场景 01:       L25-L50   (~900 tok)  设计通信算法全链路
  场景 02:       L51-L76   (~900 tok)  调试 FPGA 硬件
  场景 03:       L77-L103  (~900 tok)  集成高速接口
  场景 04:       L104-L131 (~900 tok)  学习 5G NR / ORAN
  场景 05:       L132-L167 (~900 tok)  MATLAB→RTL 贯通
  场景 06:       L168-L196 (~900 tok)  UVM 验证
  场景 07:       L197-L219 (~900 tok)  时序收敛
  场景 08:       L220-L242 (~900 tok)  Tcl 自动化构建
  场景 09:       L243-L268 (~900 tok)  设计 LDPC 编解码器
  场景 10:       L269-L291 (~900 tok)  技术选型对比
  场景 11:       L292-L314 (~900 tok)  WiFi/802.11 系统设计
  使用说明:      L315-L333 (~500 tok)
```

| 编号 | 场景 | 核心标签 | 文档数 | Token 预估 |
|:----:|:-----|:---------|:------:|:---------:|
| 01 | 设计通信算法全链路 | `spec` `rtl` `fixed-point` `uvm` | 5-7 | ~3,000 |
| 02 | 调试 FPGA 硬件 | `debug` `timing` `python` | 3-4 | ~2,500 |
| 03 | 集成高速接口 | `high-speed-io` `jesd204b` `pcie` `aurora` | 3 | ~4,500 |
| 04 | 学习 5G NR / ORAN | `5g-nr` `oran` `overview` | 3-5 | ~3,000 |
| 05 | MATLAB→RTL 贯通 | `cosim` `matlab` `spec` | 4 | ~2,000 |
| 06 | UVM 验证 | `uvm` `spec` `testbench` | 4 | ~2,500 |
| 07 | 时序收敛 | `timing` `vivado` | 2 | ~3,000 |
| 08 | Tcl 自动化构建 | `tcl` `vivado` | 2 | ~2,000 |
| 09 | 设计 LDPC 编解码器 | `ldpc` `spec` `rtl` `5g-nr` | 6 | ~4,000 |
| 10 | 技术选型对比 | `guide` `overview` | 多 | 按需 |
| 11 | WiFi/802.11 系统设计 | `wifi` `phy` `mac` `impl` | 5 | ~3,000 |

---

## 01 🎯 设计通信算法全链路

**适用**: 新算法从概念到 FPGA 实现的全流程

```
加载顺序:
  1. algorithm_spec.md                      ← 算法规格（必读）
  2. fixed_point_report.md                  ← 定点量化
  3. rtl_architecture.md (或 rtl/ 目录)     ← RTL 架构
  4. resource_estimate.md                   ← 资源评估
  5. report_*_fpga_implementation.md        ← 实现报告
  6. uvm_tb/                                ← UVM 验证框架
  7. golden_model/src/                      ← 黄金向量

参考模板:
  docs/templates/algorithm_spec_template.md
  docs/templates/rtl_module_template.v
  docs/templates/tb_template.sv
```

**标签**: `spec` + `fixed-point` + `rtl` + `resource` + `impl` + `uvm`

**跨链**: → 场景 06 (UVM), 场景 05 (cosim)

---

## 02 🎯 调试 FPGA 硬件

**适用**: ILA 抓波、时序违例、仿真失败、功能错误

```
调试策略:
  ├─ 功能错误 → comm/*/algorithm_spec → testbench_plan → tb_*.sv
  ├─ 时序违例 → timing-constraints-guide → timing-convergence-cases
  ├─ 仿真不通过 → run_rtl_cosim.m → generate_vectors.m
  └─ ILA 抓波 → vivado-guide → skills/python-hardware-debug/templates/

工具包:
  skills/python-hardware-debug/templates/
  ├─ constellation.py      — 星座图绘制
  ├─ evm_calc.py           — EVM 测量
  ├─ freq_offset_est.py    — 频偏估计
  ├─ iq_capture_analyze.py — IQ 数据分析
  └─ oran_analysis.py      — eCPRI/ORAN 前传分析
```

**标签**: `debug` + `timing` + `python` + `cosim`

**跨链**: → 场景 05 (cosim), 场景 07 (时序)

---

## 03 🎯 集成高速接口

**适用**: RFSoC 天线阵列需要对接外部数据通路

```
接口选型:
  ┌──────────────┬──────────┬──────────────┬──────────┐
  │ 接口          │ 场景      │ 速率           │ 参考文档  │
  ├──────────────┼──────────┼──────────────┼──────────┤
  │ JESD204B     │ ADC/DAC  │ 12.5+ Gbps   │ jesd204b-guide
  │ PCIe         │ 上位机    │ Gen3 x8=64GT/s│ pcie-guide
  │ Aurora       │ 板间/芯片 │ 6.25-25Gbps  │ aurora-guide
  │ SelectMap    │ 配置      │ 50-400MB/s   │ selectmap-guide
  └──────────────┴──────────┴──────────────┴──────────┘

集成注意事项:
  - 时钟架构：GTY refclk → CPLL/QPLL → channel bonding
  - PCB 要求：100Ω 差分、≤5mil intra-pair skew
  - 调试：IBERT → ILA → 协议分析仪
```

**标签**: `high-speed-io` + `jesd204b` + `pcie` + `aurora` + `selectmap`

**跨链**: → `fpga/rfsoc-guide.md`, 场景 02 (调试)

---

## 04 🎯 学习 5G NR / ORAN

**适用**: 从零理解 5G NR 系统或 O-RAN 前传架构

```
NR 学习路径:
  1. overview                           ← 系统架构
  2. nr-frame-structure                 ← 帧结构 + Numerology
  3. nr-ldpc → polar-code              ← 信道编码
  4. pdsch → pusch                     ← 数据信道
  5. pdcch → nr-prach                  ← 控制/随机接入
  6. mimo-detection                     ← MIMO
  7. fr2-beam-management               ← FR2 波束

ORAN 学习路径:
  1. oran-interface                     ← C/U/S/M 四平面
  2. lowphy-architecture                ← Low-PHY 分割
  3. bfp-compression                    ← 块浮点压缩
  4. dfe-architecture                   ← DFE
  5. oran-ric → oran-smo               ← RIC/SMO
```

**标签**: `5g-nr` + `oran` + `overview`

**跨链**: → 场景 01 (实现), 场景 09 (LDPC)

---

## 05 🎯 MATLAB → RTL 贯通 (Cosimulation)

**适用**: 写完 RTL 后用 MATLAB golden model 验证正确性

```
流程:
  Phase 1: 生成测试向量
    golden_model/src/generate_vectors.m → rx_*.bin, expected_*.bin

  Phase 2: RTL 仿真
    run_rtl_cosim.m → vsim/xsim → DUT 输出 rtl_*.bin

  Phase 3: 对比
    run_rtl_cosim.m → MSE / 逐比特对比 → PASS/FAIL

支持算法:
  ┌─────────────┬────────────┬──────────────┬──────────┐
  │ 算法         │ 向量生成   │ cosim 脚本   │ 状态     │
  ├─────────────┼────────────┼──────────────┼──────────┤
  │ OFDM TX     │ ✅         │ ✅           │ 可用     │
  │ RRC         │ ✅         │ ❌           │ 需补齐   │
  │ ChEst       │ ✅         │ ✅           │ 可用     │
  │ Sync        │ ✅         │ ❌           │ 需补齐   │
  │ LDPC        │ ✅(不同命名)│ ❌           │ 需标准化 │
  └─────────────┴────────────┴──────────────┴──────────┘

跨链工具:
  matlab_cosim.py (Python↔MATLAB 双引擎)
```

**标签**: `cosim` + `matlab` + `spec`

**跨链**: → 场景 01 (RTL 实现), 场景 06 (UVM)

---

## 06 🎯 UVM 验证

**适用**: 为 RTL 模块建立 UVM testbench

```
模板化 UVM 架构 (5 算法复用):

  uvm_tb/
  ├── <algo>_uvm_pkg.sv        <- 组件包
  ├── <algo>_scoreboard.sv      <- 算法特化得分板
  ├── <algo>_sequences.sv       <- 测试序列
  ├── <algo>_base_test.sv       <- 基础测试
  ├── <algo>_basic_test.sv      <- 具体测试用例
  ├── tb_<algo>_uvm_top.sv     <- 顶层
  └── compile.tcl               <- 编译脚本

通用框架: docs/templates/uvm/
  generic_agent, generic_scoreboard, generic_env, generic_base_test

已覆盖:
  OFDM(17文件) ✅  RRC(6) ✅  ChEst(6) ✅  Sync(6) ✅  LDPC(6) ✅
```

**标签**: `uvm` + `spec` + `testbench`

**跨链**: → `fpga/uvm-verification-guide.md`, 场景 01

---

## 07 🎯 时序收敛

**适用**: Place & Route 后 setup/hold 违例修复

```
收敛流程:
  1. 分析违例路径 → timing-constraints-guide
  2. 查找修复案例 → timing-convergence-cases

实战案例覆盖:
  ├─ IFFT 64点定点 → 插入流水线
  ├─ 全局复位扇出  → 局部复位
  ├─ CDC 同步器    → 2-flop/async FIFO
  ├─ GTY 高速收发  → 多周期路径
  └─ BRAM 读写时序  → register BRAM output
```

**标签**: `timing` + `vivado`

**跨链**: → `fpga/vivado-guide.md`, 场景 02 (调试)

---

## 08 🎯 Tcl 自动化构建

**适用**: 非工程模式构建、CI/CD 集成、批量仿真

```
脚本模板:
  vivado-automation-guide.md
  ├─ 非工程模式 Tcl 构建脚本
  ├─ 综合策略对比表 (AREA_DEFAULT vs EFFORT_HIGH)
  ├─ 仿真编译脚本 (xsim/vivado xsim Tcl)
  └─ CI 集成示例 (gitlab-ci.yml)

UC 框架:
  各算法 uvm_tb/compile.tcl
  └─ 统一模式: xvlog UVM lib → interfaces → pkg → RTL → tb_top → xelab
```

**标签**: `tcl` + `vivado`

**跨链**: → `fpga/vivado-guide.md`, 场景 06 (UVM compile)

---

## 09 🎯 设计 LDPC 编解码器

**适用**: 802.11n QC-LDPC 或 5G NR BG1/BG2

```
加载顺序:
  1. algorithm_spec               ← QC-LDPC 基础、H 矩阵
  2. encoding_spec                ← 双对角编码架构
  3. stage3_fixed_point_report    ← 量化策略 (6-bit 协议)
  4. stage4_resource_estimation   ← BRAM/DSP 预算
  5. rtl/01_rtl/                  ← RTL 源文件 (~12 模块)
  6. stage7_fpga_implementation   ← 实现报告
  7. uvm_tb/                      ← UVM 验证 (1-bit 译码输出)
  8. nr-ldpc                      ← 5G NR LDPC 对比

关键 RTL 模块:
  ldpc_controller, cn_update, early_term, h_matrix_addr,
  llr_buffer, msg_buffer, ldpc_decoder_top
```

**标签**: `ldpc` + `spec` + `rtl` + `5g-nr`

**跨链**: → 场景 01 (全链路), 场景 04 (NR), 场景 06 (UVM)

---

## 10 🎯 技术选型对比

**适用**: 为系统选择合适的技术方案

```
常用对比表:
  ┌────────────────┬─────────────────────────────────────┐
  │ 需求            │ 查阅文档                            │
  ├────────────────┼─────────────────────────────────────┤
  │ 高速接口选型    │ fpga/pcie-guide → fpga/aurora-guide │
  │                │ → fpga/jesd204b-guide               │
  │ FPGA vs ASIC   │ fpga/fpga-design-guide              │
  │ 配置方案选择    │ fpga/selectmap-guide (对比 JTAG/BPI)│
  │ 编码方案选择    │ 5g-nr/nr-ldpc → 5g-nr/polar-code   │
  │ 前传方案选择    │ 5g-nr/oran-interface → bfp-compression│
  │ 同步方案选择    │ comm/synch/algorithm_spec           │
  └────────────────┴─────────────────────────────────────┘
```

**标签**: `guide` + `overview`

---

## 11 🎯 WiFi/802.11 系统设计与分析

**适用**: 理解 802.11a/b/g/n/ac/ax/be 标准、WiFi PHY/MAC 实现、编码方案选择

```
加载顺序:
  1. wifi/overview                    ← 标准演进、频段、系统架构（必读）
  2. wifi/phy-layer                   ← Preamble、编码、调制、OFDM 参数
  3. wifi/phy-implementation          ← 包检测/CFO/FFT/均衡/LLR 硬件流水线 (NEW ✦)
  4. wifi/mac-layer                   ← CSMA/CA、帧聚合、EDCA QoS
  5. wifi/ldpc-bcc-encoding           ← 加扰、BCC/LDPC 编码链、编码选择

跨链参考:
  ├── comm/ofdm/algorithm_spec        ← OFDM 核心算法 (WiFi 各代参数对比)
  ├── comm/ldpc/algorithm_spec        ← QC-LDPC 码设计 (802.11n 矩阵)
  ├── comm/ldpc/encoding_spec         ← 双对角编码架构
  └── comm/5g-nr/mimo-detection       ← MIMO 检测对比 (WiFi vs NR)
```

**标签**: `wifi` + `phy` + `mac`

**跨链**: → 场景 01 (算法全链路), 场景 09 (LDPC 编解码)

---

## 使用说明

1. 识别用户任务 → 匹配上述 11 个场景之一
2. 仅加载该场景的**必要文档**（场景卡片中列出的核心文档）
3. 用标签交叉细化:`tag:X + tag:Y`
4. 仍不满足 → 回退到 TAG_INDEX.md 或 grep 全文
5. 禁止一次加载全部卡片；仅加载匹配场景的 1-2 张

```yaml
场景加载预算:
  L0: 本卡片 (SCENE_CARDS.md)         ~1,500 tok
  L1: 匹配场景的文档引用               ~200 tok  
  L2: 按需展开的具体文档               视文档大小
```

