# FIFO Generator — 基于 PG057 v13.2

**参考手册**: `[TEMPLATES_DIR]\fifo\pg057-fifo-generator.pdf`（已转 `pg057-fifo.md`）

---

## 手册架构概要（PG057）

### 支持的内存类型
| 类型 | 性能 | 资源 | 适用场景 |
|:----|:----|:-----|:---------|
| **Block RAM** | 最高 500 MHz | 块 RAM 资源 | 大深度 FIFO（推荐） |
| **Distributed RAM** | 中等 | LUT 资源 | 小深度 FIFO（≤64） |
| **Built-in FIFO** | 最高 | 专用 FIFO 原语 | UltraScale 器件专用 |
| **Shift Register** | 中等 | 移位寄存器 | 仅同步浅 FIFO |

### 两种操作模式
| 模式 | 特点 |
|:----|:------|
| **Standard** | `rd_en` 有效后下一周期 `dout` 输出有效 |
| **First Word Fall-Through (FWFT)** | 读请求前 `dout` 即预取首字，低延迟输出 |

### 时钟域配置
| 类型 | 适用内存 |
|:----|:---------|
| **Common Clock** | Block RAM / Distributed RAM / Built-in FIFO / Shift Register |
| **Independent Clocks** | Block RAM / Distributed RAM / Built-in FIFO |

### 状态标志
| 标志 | 说明 |
|:----|:------|
| `full` / `empty` | 满/空标志（核心必须） |
| `almost_full` / `almost_empty` | 几乎满/空（可配阈值） |
| `prog_full` / `prog_empty` | 可编程满/空（可配阈值） |
| `wr_data_count` / `rd_data_count` | 写/读侧数据计数 |
| `overflow` / `underflow` | 溢出/欠载标志 |
| `valid` | 读数据有效标志（FWFT 模式） |

### Native FIFO 端口
```
i_clk            → 公共时钟（同步）/ wr_clk（异步）     i_rst          → 同步复位
i_wr_en          → 写使能                               i_din[N-1:0]   → 写数据
i_rd_en          → 读使能                               o_dout[M-1:0]  → 读数据
o_full           → 满标志                               o_empty        → 空标志
o_almost_full    → 几乎满（可选）                        o_almost_empty → 几乎空（可选）
o_prog_full      → 可编程满（可选）                      o_prog_empty   → 可编程空（可选）
o_wr_data_count  → 写数据计数（可选）                    o_rd_data_count → 读数据计数（可选）
o_overflow       → 写溢出（可选）                        o_underflow    → 读欠载（可选）
o_valid          → 读数据有效（可选）
```

### 架构框图（同步 Block RAM FIFO）
```
  写侧                             读侧
  i_din ──────┐                   ┌── o_dout
  i_wr_en ──┐ │   ┌───────────┐   │ ┌── o_empty
  i_clk ────┼─┼──→│ 双端口 RAM│──→┼─┼── o_valid
  i_rst   ─→│ │   │(Block RAM)│   │ │
            ▼ │   └───────────┘   ▼ │
  ┌──────────┐       ▲    ▲    ┌──────────┐
  │写指针管理 ├──→格雷码─→格雷码←──┤读指针管理 │
  │(binary)  │   同步器 同步器   │(binary)  │
  └──────────┘                  └──────────┘
       │                            │
  满空比较器 ←────────── 格雷码比较 ──→ 满空比较器
       │                            │
   o_full                      o_empty
```

### 异步 FIFO 架构
```
  写时钟域                          读时钟域
  wr_clk ──┐                     ┌── rd_clk
  i_din ──→│   双端口 RAM        │──→ o_dout
  i_wr_en →│  (Block RAM)        │←── i_rd_en
           ▼                     ▼
  wr_ptr(bin)──→格雷码──同步──→格雷码──→rd_ptr(bin)
       │                       │
  full 生成 ←── 格雷码比较 ──→ empty 生成
  (写侧采样同步后的读指针)    (读侧采样同步后的写指针)
```

---

## 参数表

| 参数 | 默认值 | 类型 | 说明 | 查询方式 |
|:----|:-------|:-----|:-----|:---------|
| `DATA_WIDTH` | 8 | int | **数据位宽**（1~1024，建议 8/16/32/64） | **询问用户** |
| `FIFO_DEPTH` | 16 | int | **FIFO 深度**（必须是 2^n，≥4） | **询问用户** |
| `CLOCK_TYPE` | "sync" | enum | `sync` 同步 / `async` 异步（独立时钟） | **询问用户** |
| `MEMORY_TYPE` | "block_ram" | enum | `block_ram` / `distributed_ram` / `builtin_fifo` / `shift_reg` | **询问用户** |
| `OPERATING_MODE` | "standard" | enum | `standard` / `fwft`（First Word Fall Through） | **询问用户** |
| `ALMOST_FULL_VAL` | 0 | int | **几乎满阈值**（0=不使用该功能） | **询问用户** |
| `ALMOST_EMPTY_VAL` | 0 | int | **几乎空阈值**（0=不使用该功能） | **询问用户** |
| `OUTPUT_REG` | true | bool | 输出增加一级寄存器改善时序 | **询问用户** |
| `ENABLE_ECC` | false | bool | 启用在硬 ECC（仅 Block RAM，位宽≥64） | **询问用户** |

### 参数校验规则
- `FIFO_DEPTH` 必须是 2^n：校验，若不是则向上取整到最近的 2^n
- `CLOCK_TYPE=async` 时，`MEMORY_TYPE` 不能是 `shift_reg`
- `MEMORY_TYPE=builtin_fifo` 时，仅 `fwft` 模式
- `ENABLE_ECC=true` 要求 `MEMORY_TYPE=block_ram` 且 `DATA_WIDTH≥64`

---

## 交互流程

### Step 1: 需求收集

按参数表顺序依次询问，**已经通过 args 提供的参数直接确认勿重复提问**。

**话术示例**（仅作参考，自然对话即可）:
```
1. "FIFO 数据位宽是多少？（默认 8）"
2. "FIFO 深度是多少？需要是 2 的幂。（默认 16）"
3. "同步 FIFO 还是异步 FIFO（独立时钟）？（默认 同步）"
4. "使用哪种存储器资源？Block RAM / Distributed RAM / Built-in FIFO / Shift Register（默认 Block RAM）"
5. "Standard 模式还是 First Word Fall-Through 模式？（默认 Standard）"
6. "是否需要 Almost Full 标志？阈值设为多少？（0=不使用）"
7. "是否需要 Almost Empty 标志？阈值设为多少？（0=不使用）"
8. "输出增加一级寄存器改善时序？（默认 是）"
9. "是否启用 ECC 纠错？（仅 Block RAM 且位宽≥64 时可用, 默认 否）"
```

### Step 2: 参数确认汇总

生成确认表：

| 参数 | 值 |
|:----|:----|
| DATA_WIDTH | 16 |
| FIFO_DEPTH | 512 |
| CLOCK_TYPE | 同步 |
| MEMORY_TYPE | Block RAM |
| OPERATING_MODE | Standard |
| ALMOST_FULL_VAL | 480 |
| ... | ... |

"以上参数是否正确？（Y/N）"

### Step 3: RTL 代码生成

严格按以下模板结构生成 SystemVerilog 代码：

#### 同步 FIFO 代码模板结构

```systemverilog
//=============================================================================
// Module Name: fifo_<depth>_<width>
// Description: 同步 FIFO（基于 PG057 FIFO Generator 架构）
//              - Block RAM 实现
//              - Standard / FWFT 模式
// References:  PG057 FIFO Generator v13.2
//=============================================================================
module fifo_#(
    parameter  int P_DATA_W       = 8,           // 数据位宽
    parameter  int P_DEPTH        = 16,          // FIFO 深度
    parameter  int P_ALMOST_FULL  = 0,           // 几乎满阈值（0=不用）
    parameter  int P_ALMOST_EMPTY = 0,           // 几乎空阈值（0=不用）
    parameter  int P_OUTPUT_REG   = 1,           // 输出寄存器
    parameter  int P_FWFT         = 0            // FWFT 模式
) (
    input  logic                i_clk,
    input  logic                i_rst,
    // 写接口
    input  logic                i_wr_en,
    input  logic [P_DATA_W-1:0] i_din,
    output logic                o_full,
    // 读接口
    input  logic                i_rd_en,
    output logic [P_DATA_W-1:0] o_dout,
    output logic                o_empty,
    // 状态标志（可选）
    output logic                o_almost_full,
    output logic                o_almost_empty,
    output logic                o_valid
);

    // 位宽与深度
    localparam int P_ADDR_W = $clog2(P_DEPTH);
    // ......
```

### 异步 FIFO 代码模板（关键不同点）

- 两个时钟域: `i_wr_clk`, `i_rd_clk`
- 写指针和读指针在各自时钟域独立计数
- **写侧**: 写指针(gray) + 同步读指针(gray) → 满比较
- **读侧**: 读指针(gray) + 同步写指针(gray) → 空比较
- FIFO 深度必须是 2^n（格雷码环绕特性需要）

### 生成规则

1. `$clog2()` 计算地址位宽
2. 指针用二进制递增，转换为格雷码跨时钟域同步
3. 同步 FIFO 读/写指针直接在同一个时钟域比较
4. `full` 条件: 写指针追赶读指针（格雷码比较 + 最高位取反）
5. `empty` 条件: 读指针等于写指针
6. FWFT 模式: 用额外的数据寄存器预取数据，`o_valid` 指示有效

### Step 4: 语法检查

```bash
vlog -lint fifo_<depth>_<width>.sv   || \
iverilog -g2012 -t null -s fifo_<depth>_<width> fifo_<depth>_<width>.sv
```

### Step 5: 询问 Testbench

"是否需要生成对应的 Testbench？（Y/N）"
- 如是，生成包含基本写/读/满/空测试的 TB

---

## 引用

| 资源 | 路径 |
|:----|:------|
| PG057 FIFO Generator 原始 PDF | `[TEMPLATES_DIR]\fifo\pg057-fifo-generator.pdf` |
| PG057 转换 Markdown | `[TEMPLATES_DIR]\fifo\pg057-fifo.md` |
| 生产级 RTL 规范 | `../references/rtl-production-standards.md` |
| HDL 编码规范 | `../../hdl-coding/SKILL.md` |
| 存储器和 FIFO 参考 | `../../hdl-coding/references/memory-templates.md` |
