# Block Memory Generator — 基于 PG058 v8.4

**参考手册**: `D:\Project_Files\templates\bram\pg058-blk-mem-gen.pdf`（已转 `pg058-bram.md`）

---

## 手册架构概要（PG058）

### 支持的存储器类型

| 类型 | 端口 A | 端口 B | 适用场景 |
|:----|:-------|:-------|:---------|
| **Single-port RAM** | R/W | — | 处理器 Scratch RAM、LUT |
| **Simple Dual-port RAM (SDP)** | 只写 | 只读 | FIFO、数据缓冲（最常用） |
| **True Dual-port RAM (TDP)** | R/W | R/W | 双处理器共享存储 |
| **Single-port ROM** | 只读 | — | 程序代码、初始化 ROM |
| **Dual-port ROM** | 只读 | 只读 | 双系统共享 ROM |

### 三种操作模式（每端口独立选择）

| 模式 | 行为 |
|:----|:------|
| **WRITE_FIRST** | 写数据同时更新输出（写透传），读操作正常读 | 
| **READ_FIRST** | 写操作时输出保持上一次读数据，先读后写 |
| **NO_CHANGE** | 写操作时输出锁存不变，读操作正常读 |

### Native 接口端口（Simple Dual-port RAM）

```
                    ┌─────────────────────┐
    i_clka ─────────┤                     ├─────── o_doutb
    i_rst   ────────┤  Block Memory       │
                    │  Generator          │
    // Port A (写)  │  (Block RAM-based)  │
    i_ena ─────────┤                     │
    i_wea ─────────┤                     │
    i_addra ───────┤                     │
    i_dina ────────┤                     │
    │              │                     │
    // Port B (读) │                     │
    i_clkb ────────┤                     │
    i_enb ─────────┤                     │
    i_addrb ───────┤                     │
                    └─────────────────────┘
```

### 完整端口描述

| 端口 | 方向 | 说明 | 可用配置 |
|:----|:----|:------|:---------|
| `clka` / `clkb` | I | 端口 A/B 时钟 | 所有配置 |
| `rsta` / `rstb` | I | 输出复位（可选） | 所有配置 |
| `ena` / `enb` | I | 时钟使能（可选） | 所有配置 |
| `wea` / `web` | I | 写使能（位宽 =1 或字节使能位宽） | RAM 配置 |
| `addra` / `addrb` | I | 地址总线（位宽由深度决定） | 所有配置 |
| `dina` / `dinb` | I | 写数据总线 | RAM 配置 |
| `douta` / `doutb` | O | 读数据总线 | 除 SDP 外全支持 |
| `regcea` / `regceb` | I | 最后一级输出寄存器使能（可选） | 有输出寄存器时 |
| `sbiterr` | O | 单比特错误标志（ECC） | ECC 配置 |
| `dbiterr` | O | 双比特错误标志（ECC） | ECC 配置 |

### 关键特性
- **字节使能**: 8 位（无校验）或 9 位（带校验）粒度写使能
- **输出寄存器**: 2 级可选流水线寄存器，改善时序
- **ECC**: 内建汉明纠错（Simple Dual-port RAM，位宽 ≥64），Soft ECC（位宽 <64）
- **端口宽高比**: A/B 端口数据位宽可不同（比例 1:1, 1:2, 1:4, 1:8, 1:16, 1:32）
- **初始化**: COE 文件或默认值

---

## 参数表

| 参数 | 默认值 | 类型 | 说明 | 查询方式 |
|:----|:-------|:-----|:-----|:---------|
| `MEMORY_TYPE` | "simple_dual" | enum | **存储器类型**: `single_port` / `simple_dual` / `true_dual` / `sp_rom` / `dp_rom` | **询问用户** |
| `DATA_WIDTH_A` | 16 | int | **端口 A 数据位宽** | **询问用户** |
| `DATA_WIDTH_B` | 16 | int | **端口 B 数据位宽**（仅 dual-port 配置） | **询问用户** |
| `MEM_DEPTH` | 1024 | int | **存储深度**（字数） | **询问用户** |
| `OP_MODE_A` | "write_first" | enum | **端口 A 操作模式**: `write_first` / `read_first` / `no_change` | **询问用户** |
| `OP_MODE_B` | "write_first" | enum | **端口 B 操作模式**（仅 TDP 配置） | **询问用户** |
| `BYTE_WRITE_EN` | false | bool | **字节写使能**（8-bit 粒度） | **询问用户** |
| `OUTPUT_REG_A` | true | bool | **端口 A 输出寄存器**（改善时序） | **询问用户** |
| `OUTPUT_REG_B` | true | bool | **端口 B 输出寄存器** | **询问用户** |
| `PIPELINE_STAGES` | 0 | int | **额外流水线级数**（0~3，需输出寄存器已使能） | **询问用户** |
| `ENABLE_ECC` | false | bool | **启用 ECC 纠错**（仅 SDP，位宽≥64 硬 ECC，<64 软 ECC） | **询问用户** |
| `INIT_FILE` | "" | string | **初始化 COE 文件路径**（空=全零初始化） | **询问用户** |

### 参数校验规则
- `MEMORY_TYPE=sp_rom` / `dp_rom` → `wea`/`web` 不可用
- `MEMORY_TYPE=single_port` → `DATA_WIDTH_B` 不适用
- `MEMORY_TYPE=simple_dual` → 端口 A=写，端口 B=读
- `OP_MODE` 在 SDP 模式下不可选择（固定为 WRITE_FIRST 行为）
- `ENABLE_ECC=true` 需要 `MEMORY_TYPE=simple_dual`
- `PIPELINE_STAGES>0` 要求 `OUTPUT_REG_A=true`（或 B）

---

## 交互流程

### Step 1: 需求收集

按参数表顺序依次询问，**已经通过 args 提供的参数直接确认勿重复提问**。

**话术示例**:
```
1. "需要哪种存储器类型？（Single-port RAM / Simple Dual-port RAM / True Dual-port RAM / Single-port ROM / Dual-port ROM）"
2. "端口 A 数据位宽是多少？（默认 16）"
   （如果是 dual-port）"端口 B 数据位宽是多少？（默认 16）"
3. "存储深度是多少？（默认 1024 个地址）"
4. "操作模式选哪个？WRITE_FIRST / READ_FIRST / NO_CHANGE"
5. "需要字节写使能吗？（默认 否）"
6. "输出加寄存器改善时序？（默认 是）"
7. "需要额外流水线级数？（0~3 级，默认 0）"
8. "需要 ECC 纠错功能吗？（默认 否）"
9. "需要初始化文件（COE）吗？还是全零初始化？"
```

### Step 2: 参数确认汇总

生成确认表，标注存储器类型和端口配置。

### Step 3: RTL 代码生成

严格按以下模板结构生成 SystemVerilog 代码：

#### Single-port RAM 模板

```systemverilog
//=============================================================================
// Module Name: bram_sp_<depth>_<width>
// Description: Single-Port Block RAM（基于 PG058 Block Memory Generator v8.4）
//              - 操作模式: <OP_MODE>
//              - Block RAM 实现
// References:  PG058 Block Memory Generator v8.4
//=============================================================================
module bram_sp_#(
    parameter  int P_DATA_W      = 16,
    parameter  int P_DEPTH       = 1024,
    parameter  int P_OP_MODE     = 0,    // 0=WRITE_FIRST, 1=READ_FIRST, 2=NO_CHANGE
    parameter  int P_OUTPUT_REG  = 1,
    parameter  int P_BYTE_WEN    = 0
) (
    input  logic                    i_clk,
    input  logic                    i_rst,
    input  logic                    i_en,
    input  logic                    i_we,
    input  logic [P_ADDR_W-1:0]     i_addr,
    input  logic [P_DATA_W-1:0]     i_din,
    output logic [P_DATA_W-1:0]     o_dout
);

    localparam int P_ADDR_W = $clog2(P_DEPTH);
    // ...
```

#### Simple Dual-port RAM 模板

```systemverilog
//=============================================================================
// Module Name: bram_sdp_<depth>_<width>
// Description: Simple Dual-Port Block RAM（基于 PG058 Block Memory Generator v8.4）
//              - Port A: 只写, Port B: 只读
//              - 可选字节使能
//              - 可选 ECC
// References:  PG058 Block Memory Generator v8.4
//=============================================================================
module bram_sdp_#(
    parameter  int P_DATA_W_A    = 16,
    parameter  int P_DATA_W_B    = 16,
    parameter  int P_DEPTH       = 1024,
    parameter  int P_OUTPUT_REG  = 1,
    parameter  int P_PIPE_STAGES = 0,
    parameter  int P_ECC         = 0
) (
    // Port A（写端口）
    input  logic                    i_clka,
    input  logic                    i_ena,
    input  logic                    i_wea,
    input  logic [P_ADDR_W-1:0]     i_addra,
    input  logic [P_DATA_W_A-1:0]   i_dina,
    // Port B（读端口）
    input  logic                    i_clkb,
    input  logic                    i_enb,
    input  logic [P_ADDR_W-1:0]     i_addrb,
    output logic [P_DATA_W_B-1:0]   o_doutb,
    // ECC（可选）
    output logic                    o_sbiterr,
    output logic                    o_dbiterr
);

    localparam int P_ADDR_W = $clog2(P_DEPTH);
    // ...
```

#### True Dual-port RAM 模板
- 端口 A 和 B 各有完整 R/W 接口
- 需要处理写冲突问题

#### 生成规则

1. 使用 `logic [P_DEPTH-1:0][P_DATA_W-1:0]` 声明存储阵列（或综合工具推断 BRAM）
2. `WRITE_FIRST`: `always_ff` 中先写后读 `dout <= din`（写透传）
3. `READ_FIRST`: `always_ff` 中先读后写 `dout <= mem[addr]`
4. `NO_CHANGE`: 写操作期间 `dout` 保持
5. 输出寄存器级联: 嵌入式 BRAM 寄存器 + 切片寄存器
6. 字节使能: `wea` 扩展为 `P_DATA_W/8` 位宽的向量，每比特控制一个字节
7. ECC: 额外生成校验位（汉明码），检测/纠正单比特错误

#### 读时序示例（WRITE_FIRST 模式）

```
        __   __   __   __   __   __
i_clk    |__| |__| |__| |__| |__| |__
         ___
i_addr  XXX_A___XXX_B___XXX_C________
         _______
i_we              |_________
         _______
i_din    XXX_D1___XXX_____________
         _______________          _____
o_dout   XXXXXXXXXXXXXXX_R(addrA)_____R(addrC)
                      ^ 写 addrA 透传读输出
```

### Step 4: 语法检查

```bash
vlog -lint bram_<type>_<depth>_<width>.sv   || \
iverilog -g2012 -t null -s bram_<type>_<depth>_<width> bram_<type>_<depth>_<width>.sv
```

### Step 5: 询问 Testbench

"是否需要生成对应的 Testbench？"
- 包含: 写/读测试、操作模式验证、字节使能测试

---

## 引用

| 资源 | 路径 |
|:----|:------|
| PG058 Block Memory Generator 原始 PDF | `D:\Project_Files\templates\bram\pg058-blk-mem-gen.pdf` |
| PG058 转换 Markdown | `D:\Project_Files\templates\bram\pg058-bram.md` |
| 生产级 RTL 规范 | `../references/rtl-production-standards.md` |
| HDL 编码规范 | `../../hdl-coding/SKILL.md` |
| 存储器参考 | `../../hdl-coding/references/memory-templates.md` |
